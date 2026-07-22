package admin

import (
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/skys-mission/dual-read/server/internal/auth"
	"github.com/skys-mission/dual-read/server/internal/buildinfo"
	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/observe"
	"github.com/skys-mission/dual-read/server/internal/runtime"
)

// RuntimeApplier applies persisted runtime changes.
type RuntimeApplier interface {
	ApplyRuntime() error
}

// Handler serves the monitor UI and JSON APIs.
type Handler struct {
	store    *config.Store
	snapshot *runtime.Snapshot
	cache    *cache.Chain
	metrics  *metrics.Collector
	logger   *slog.Logger
	applier  RuntimeApplier
	started  time.Time
	basePath string
	sessions *sessionStore
}

// New creates an admin handler.
func New(
	store *config.Store,
	snapshot *runtime.Snapshot,
	c *cache.Chain,
	metricsCol *metrics.Collector,
	logger *slog.Logger,
) *Handler {
	cfg, _ := store.Effective()
	basePath := "/admin"
	if cfg != nil {
		basePath = cfg.Admin.Path
	}
	return &Handler{
		store:    store,
		snapshot: snapshot,
		cache:    c,
		metrics:  metricsCol,
		logger:   logger,
		started:  time.Now().UTC(),
		basePath: basePath,
		sessions: newSessionStore(),
	}
}

// SetApplier wires runtime reload after config saves.
func (h *Handler) SetApplier(applier RuntimeApplier) {
	h.applier = applier
}

// Register mounts UI and API under the configured admin path.
func (h *Handler) Register(mux *http.ServeMux) {
	cfg, err := h.store.Effective()
	if err != nil || cfg == nil || !cfg.Admin.Enabled {
		return
	}
	h.basePath = cfg.Admin.Path

	base := h.basePath
	// UI shell + static assets are public so the browser can render a login form.
	// JSON APIs remain authenticated.
	mux.HandleFunc(base, h.withSecurityHeaders(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == base {
			http.Redirect(w, r, base+"/", http.StatusFound)
			return
		}
		h.handleIndex(w, r)
	}))
	mux.HandleFunc(base+"/", h.withSecurityHeaders(h.handleIndex))
	mux.HandleFunc(base+"/api/login", h.withSecurityHeaders(h.handleLogin))
	mux.HandleFunc(base+"/api/logout", h.withSecurityHeaders(h.requireAuth(h.requireCSRF(h.handleLogout))))
	mux.HandleFunc(base+"/api/overview", h.withSecurityHeaders(h.requireAuth(h.handleOverview)))
	mux.HandleFunc(base+"/api/metrics", h.withSecurityHeaders(h.requireAuth(h.handleMetrics)))
	mux.HandleFunc(base+"/api/health", h.withSecurityHeaders(h.requireAuth(h.handleHealth)))
	mux.HandleFunc(base+"/api/config", h.withSecurityHeaders(h.requireAuth(h.requireCSRF(h.handleConfig))))
	mux.HandleFunc(base+"/api/config/validate", h.withSecurityHeaders(h.requireAuth(h.requireCSRF(h.handleConfigValidate))))

	staticFS, err := fs.Sub(distFS, "static")
	if err != nil {
		h.logger.Error("admin static fs", "error", err)
		return
	}
	fileServer := http.FileServer(http.FS(staticFS))
	mux.Handle(base+"/static/", h.withSecurityHeaders(http.StripPrefix(base+"/static/", fileServer).ServeHTTP))
}

func (h *Handler) adminConfigured() bool {
	if h.snapshot != nil && h.snapshot.AdminTokenConfigured() {
		return true
	}
	cfg, err := h.store.Effective()
	if err != nil || cfg == nil {
		return false
	}
	return strings.TrimSpace(cfg.Admin.Token) != "" || strings.TrimSpace(cfg.Admin.TokenHMAC) != ""
}

func (h *Handler) verifyAdminPresented(presented string) bool {
	presented = strings.TrimSpace(presented)
	if presented == "" {
		return false
	}
	if h.snapshot != nil && h.snapshot.AdminTokenConfigured() {
		return h.snapshot.VerifyAdmin(presented)
	}
	cfg, err := h.store.Effective()
	if err != nil || cfg == nil {
		return false
	}
	if cfg.Admin.TokenHMAC != "" {
		return false // snapshot should own pepper; treat as not verified
	}
	return tokenEqual(presented, cfg.Admin.Token)
}

func (h *Handler) withSecurityHeaders(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Cache-Control", "no-store")
		next(w, r)
	}
}

func (h *Handler) authenticated(r *http.Request) bool {
	if !h.adminConfigured() {
		return true
	}
	if h.sessions.valid(readCookie(r, sessionCookieName)) {
		return true
	}
	got := r.Header.Get("X-Admin-Token")
	if got == "" {
		if authz := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(authz), "bearer ") {
			got = strings.TrimSpace(authz[7:])
		}
	}
	// Query tokens are intentionally rejected (history / Referer leakage).
	return h.verifyAdminPresented(got)
}

func (h *Handler) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.authenticated(r) {
			next(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, h.basePath+"/api/") {
			writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}

func (h *Handler) requireCSRF(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next(w, r)
			return
		}
		// Header-token auth (automation) does not need the double-submit cookie.
		if r.Header.Get("X-Admin-Token") != "" || strings.HasPrefix(strings.ToLower(r.Header.Get("Authorization")), "bearer ") {
			next(w, r)
			return
		}
		cookie := readCookie(r, csrfCookieName)
		header := r.Header.Get(csrfHeaderName)
		if cookie == "" || header == "" || !tokenEqual(cookie, header) {
			writeJSONError(w, http.StatusForbidden, "csrf validation failed")
			return
		}
		next(w, r)
	}
}

func (h *Handler) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tokenRequired := h.adminConfigured()
	if tokenRequired {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "read body failed")
			return
		}
		var req struct {
			Token string `json:"token"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if !h.verifyAdminPresented(req.Token) {
			writeJSONError(w, http.StatusUnauthorized, "invalid token")
			return
		}
	}
	sid, exp, err := h.sessions.create()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "session create failed")
		return
	}
	csrf, err := newRandomToken()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "csrf create failed")
		return
	}
	setSessionCookie(w, r, sessionCookieName, sid, exp)
	// CSRF cookie is readable by JS for double-submit.
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    csrf,
		Path:     "/",
		HttpOnly: false,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.TLS != nil,
		Expires:  exp,
	})
	writeJSON(w, map[string]interface{}{"ok": true, "auth_required": tokenRequired})
}

func (h *Handler) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h.sessions.revoke(readCookie(r, sessionCookieName))
	clearCookie(w, r, sessionCookieName)
	clearCookie(w, r, csrfCookieName)
	writeJSON(w, map[string]interface{}{"ok": true})
}

func (h *Handler) handleIndex(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, h.basePath)
	if path != "" && path != "/" {
		http.NotFound(w, r)
		return
	}
	data, err := distFS.ReadFile("static/index.html")
	if err != nil {
		http.Error(w, "admin ui missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func (h *Handler) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		view, err := h.store.View(h.store.BootstrapPath())
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, view)
	case http.MethodPut:
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "read body failed")
			return
		}
		_, result, err := h.store.UpdateRuntime(body)
		if err != nil {
			if config.IsRevisionConflict(err) {
				writeJSONError(w, http.StatusConflict, err.Error())
				return
			}
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		if h.applier != nil {
			if err := h.applier.ApplyRuntime(); err != nil {
				writeJSONError(w, http.StatusInternalServerError, err.Error())
				return
			}
		} else if h.snapshot != nil {
			cfg, err := h.store.Effective()
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, err.Error())
				return
			}
			h.snapshot.Reload(cfg, h.store.Pepper(), h.store.RuntimeSnapshot().Revision)
			if h.cache != nil {
				h.cache.SetLoadTimeout(cfg.UpstreamTimeout())
				h.cache.ResetLocal()
			}
		}
		warning := ""
		if h.cache != nil {
			if valkey := h.cache.Valkey(); valkey != nil && !valkey.Available() {
				warning = "Redis / Valkey 连接失败：" + valkey.LastError()
			}
		}
		h.logger.Info("runtime config updated", "restart_needed", result.RestartNeeded)
		writeJSON(w, map[string]interface{}{
			"ok":      true,
			"result":  result,
			"warning": warning,
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) handleConfigValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "read body failed")
		return
	}
	var incoming config.RuntimeConfig
	if err := json.Unmarshal(body, &incoming); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	current := h.store.RuntimeSnapshot()
	merged := mergeRuntimeForValidate(&current, &incoming)
	cfg, err := h.store.BuildEffectiveFromRuntime(merged)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := cfg.Validate(); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"ok": true})
}

func mergeRuntimeForValidate(current, incoming *config.RuntimeConfig) *config.RuntimeConfig {
	out := *incoming
	if isKeep(out.LLM.APIKey) {
		out.LLM.APIKey = current.LLM.APIKey
	}
	if isKeep(out.Admin.Token) {
		out.Admin.Token = current.Admin.Token
		out.Admin.TokenHMAC = current.Admin.TokenHMAC
	}
	if isKeep(out.Cache.Valkey.Password) {
		out.Cache.Valkey.Password = current.Cache.Valkey.Password
	}
	out.Clients.Items = make([]config.ClientKey, len(incoming.Clients.Items))
	for i := range incoming.Clients.Items {
		out.Clients.Items[i] = incoming.Clients.Items[i]
		if isKeep(out.Clients.Items[i].Key) && i < len(current.Clients.Items) {
			out.Clients.Items[i].Key = current.Clients.Items[i].Key
		}
		if isKeep(out.Clients.Items[i].UpstreamAPIKey) && i < len(current.Clients.Items) {
			out.Clients.Items[i].UpstreamAPIKey = current.Clients.Items[i].UpstreamAPIKey
		}
	}
	return &out
}

func isKeep(v string) bool {
	return strings.TrimSpace(v) == "" || strings.TrimSpace(v) == config.SecretKeep
}

func (h *Handler) handleOverview(w http.ResponseWriter, r *http.Request) {
	snap := redactMetricsSnapshot(h.metrics.Snapshot())
	valkey := "disabled"
	valkeyError := ""
	if valkeyClient := h.cache.Valkey(); valkeyClient != nil {
		if valkeyClient.Available() {
			valkey = "ok"
		} else {
			valkey = "unreachable"
			valkeyError = valkeyClient.LastError()
		}
	}
	h.metrics.SetValkeyUp(valkey == "ok")

	keys := h.snapshot.AuthSummaries()
	if keys == nil {
		keys = []auth.KeySummary{}
	}

	cfg, _ := h.store.Effective()
	listen := ""
	if cfg != nil {
		listen = cfg.Server.Host + ":" + itoa(cfg.Server.Port)
	}

	out := map[string]interface{}{
		"version":        buildinfo.Version,
		"commit":         buildinfo.Commit,
		"build_date":     buildinfo.Date,
		"listen":         listen,
		"started_at":     h.started.Format(time.RFC3339),
		"uptime_seconds": time.Since(h.started).Seconds(),
		"upstream": map[string]interface{}{
			"base_url": h.snapshot.BaseURL(),
		},
		"auth": map[string]interface{}{
			"enabled": h.snapshot.AuthEnabled(),
			"keys":    keys,
		},
		"models": map[string]interface{}{
			"default": h.snapshot.DefaultModel(),
			"map":     h.snapshot.GlobalModelMap(),
		},
		"cache": map[string]interface{}{
			"local_enabled": h.cache.LocalEnabled(),
			"local_items":   h.cache.LocalLen(),
			"valkey":        valkey,
			"valkey_error":  valkeyError,
		},
		"admin": map[string]interface{}{
			"path":        h.basePath,
			"token_set":   h.adminConfigured(),
			"public_bind": cfg != nil && cfg.PublicListen(),
		},
		"runtime_path": h.store.RuntimePath(),
		"metrics":      snap,
	}
	writeJSON(w, out)
}

func (h *Handler) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, redactMetricsSnapshot(h.metrics.Snapshot()))
}

func (h *Handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	valkey := "disabled"
	valkeyError := ""
	status := "ok"
	if valkeyClient := h.cache.Valkey(); valkeyClient != nil {
		if !valkeyClient.Available() {
			valkey = "unreachable"
			valkeyError = valkeyClient.LastError()
			status = "degraded"
		} else {
			valkey = "ok"
		}
	}
	writeJSON(w, map[string]interface{}{
		"status":            status,
		"local_cache_items": h.cache.LocalLen(),
		"valkey":            valkey,
		"valkey_error":      valkeyError,
		"timestamp":         time.Now().UTC().Format(time.RFC3339),
	})
}

func redactMetricsSnapshot(snap metrics.Snapshot) metrics.Snapshot {
	for i := range snap.Recent {
		snap.Recent[i].Error = observe.RedactError(snap.Recent[i].Error)
	}
	return snap
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    false,
		"error": msg,
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
