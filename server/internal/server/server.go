package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/skys-mission/dual-read/server/internal/admin"
	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/handler"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/observe"
	"github.com/skys-mission/dual-read/server/internal/runtime"
)

// Server wraps the HTTP server and its dependencies.
type Server struct {
	httpServer *http.Server
	logger     *slog.Logger
	local      *cache.Local
	valkey     *cache.Valkey
	chain      *cache.Chain
	store      *config.Store
	snapshot   *runtime.Snapshot
	metrics    *metrics.Collector
	health     *observe.Health
	applyMu    sync.Mutex
	cacheMu    sync.Mutex
	closed     bool
}

// New builds a configured Server from a config Store.
func New(store *config.Store) (*Server, error) {
	cfg, err := store.Effective()
	if err != nil {
		return nil, err
	}

	logger, err := newLogger(cfg.Log.Level)
	if err != nil {
		return nil, err
	}

	if cfg.PublicListen() {
		allowInsecure := parseBoolEnv("DUAL_READ_ALLOW_INSECURE_PUBLIC")
		var insecure []string
		if !cfg.Auth.Enabled {
			insecure = append(insecure, "auth.enabled is false (anyone can spend your upstream quota)")
		}
		if cfg.Admin.Enabled && cfg.Admin.Token == "" && cfg.Admin.TokenHMAC == "" {
			insecure = append(insecure, "admin UI is enabled without admin.token")
		}
		if len(insecure) > 0 {
			if !allowInsecure {
				return nil, fmt.Errorf(
					"refusing to start on public bind %q: %s. "+
						"Set auth.enabled + admin.token, bind to 127.0.0.1, "+
						"or set DUAL_READ_ALLOW_INSECURE_PUBLIC=true to override",
					cfg.Server.Host, strings.Join(insecure, "; "))
			}
			for _, msg := range insecure {
				logger.Warn("insecure public bind (override active)", "issue", msg)
			}
		}
		if !cfg.Limits.Enabled {
			cfg.Limits.Enabled = true
		}
	}

	var localCache *cache.Local
	if cfg.Cache.Local.Enabled {
		localCache, err = cache.NewLocal(cfg.LocalTTL(), cfg.Cache.Local.MaxMB, logger)
		if err != nil {
			return nil, err
		}
		logger.Info("local cache enabled", "ttl", cfg.LocalTTL(), "max_mb", cfg.Cache.Local.MaxMB)
	}

	valkeyWanted := cfg.Cache.Valkey.Enabled
	var valkeyCache *cache.Valkey
	if cfg.Cache.Valkey.Enabled {
		valkeyCache = cache.NewValkey(
			cfg.Cache.Valkey.Addr,
			cfg.Cache.Valkey.Password,
			cfg.Cache.Valkey.DB,
			cfg.Cache.Valkey.KeyPrefix,
			cfg.ValkeyTTL(),
			logger,
		)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := valkeyCache.Ping(ctx); err != nil {
			logger.Error("valkey unavailable; shared cache will retry in background", "addr", cfg.Cache.Valkey.Addr, "error", err)
		} else {
			logger.Info("valkey cache enabled", "addr", cfg.Cache.Valkey.Addr, "ttl", cfg.ValkeyTTL())
		}
		valkeyCache.StartMonitor(5 * time.Second)
	}

	if localCache == nil && valkeyCache == nil {
		logger.Info("cache disabled, forwarding all requests to upstream")
	}

	chain := cache.NewChain(localCache, valkeyCache)
	chain.SetLoadTimeout(cfg.UpstreamTimeout())
	rev := store.RuntimeSnapshot().Revision
	snapshot := runtime.NewSnapshot(cfg, store.Pepper(), rev)
	metricsCol := metrics.New()
	if valkeyWanted && valkeyCache != nil {
		valkeyCache.SetStatusCallback(metricsCol.SetValkeyUp)
	}

	started := time.Now().UTC()
	chatHandler := handler.NewChat(chain, snapshot, metricsCol, logger)
	adminHandler := admin.New(store, snapshot, chain, metricsCol, logger)
	adminHandler.SetApplier(nil)

	health := &observe.Health{
		Store:        store,
		Cache:        chain,
		Metrics:      metricsCol,
		ValkeyWanted: valkeyWanted,
		Started:      started,
	}

	mux := http.NewServeMux()
	health.Register(mux)
	chatHandler.Register(mux)
	adminHandler.Register(mux)

	if cfg.Metrics.Enabled {
		if cfg.PublicListen() && cfg.Metrics.Token == "" {
			logger.Warn("prometheus /metrics enabled on public bind without metrics.token")
		}
		mux.Handle(cfg.Metrics.Path, &observe.MetricsHandler{
			Collector: metricsCol,
			Token:     cfg.Metrics.Token,
		})
		logger.Info("prometheus metrics enabled", "path", cfg.Metrics.Path, "token_required", cfg.Metrics.Token != "")
	}

	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	root := observe.Middleware(loggingMiddleware(logger, mux))
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           root,
		ReadTimeout:       cfg.ServerReadTimeout(),
		WriteTimeout:      cfg.ServerWriteTimeout(),
		IdleTimeout:       cfg.ServerIdleTimeout(),
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	srv := &Server{
		httpServer: httpServer,
		logger:     logger,
		local:      localCache,
		valkey:     valkeyCache,
		chain:      chain,
		store:      store,
		snapshot:   snapshot,
		metrics:    metricsCol,
		health:     health,
	}
	adminHandler.SetApplier(srv)
	if cfg.Admin.Enabled {
		logger.Info("admin UI enabled", "url", fmt.Sprintf("http://%s%s", addr, cfg.Admin.Path))
	}
	if cfg.Auth.Enabled {
		logger.Info("server auth enabled", "keys", len(cfg.Auth.Keys))
	}
	logger.Info("runtime config", "path", store.RuntimePath())

	return srv, nil
}

// ApplyRuntime reloads hot-reloadable components from the store.
func (s *Server) ApplyRuntime() error {
	s.applyMu.Lock()
	defer s.applyMu.Unlock()

	cfg, err := s.store.Effective()
	if err != nil {
		return err
	}
	if cfg.PublicListen() && !cfg.Limits.Enabled {
		cfg.Limits.Enabled = true
	}
	var replacement *cache.Valkey
	if cfg.Cache.Valkey.Enabled {
		replacement = cache.NewValkey(
			cfg.Cache.Valkey.Addr,
			cfg.Cache.Valkey.Password,
			cfg.Cache.Valkey.DB,
			cfg.Cache.Valkey.KeyPrefix,
			cfg.ValkeyTTL(),
			s.logger,
		)
		if s.metrics != nil {
			replacement.SetStatusCallback(s.metrics.SetValkeyUp)
		}
		pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		pingErr := replacement.Ping(pingCtx)
		cancel()
		if pingErr != nil {
			s.logger.Warn("runtime Valkey configuration is unavailable; retrying in background",
				"addr", cfg.Cache.Valkey.Addr,
				"error", pingErr,
			)
		}
		replacement.StartMonitor(5 * time.Second)
	}

	s.cacheMu.Lock()
	if s.closed {
		s.cacheMu.Unlock()
		if replacement != nil {
			_ = replacement.Close()
		}
		return fmt.Errorf("server is shutting down")
	}
	oldValkey := s.chain.ReplaceValkey(replacement)
	s.valkey = replacement
	s.cacheMu.Unlock()
	if oldValkey != nil && oldValkey != replacement {
		oldValkey.SetStatusCallback(nil)
		_ = oldValkey.Close()
	}
	if s.metrics != nil {
		s.metrics.SetValkeyUp(replacement != nil && replacement.Available())
	}
	if s.health != nil {
		s.health.SetValkeyWanted(cfg.Cache.Valkey.Enabled)
	}

	rev := s.store.RuntimeSnapshot().Revision
	s.snapshot.Reload(cfg, s.store.Pepper(), rev)
	if s.chain != nil {
		s.chain.SetLoadTimeout(cfg.UpstreamTimeout())
		s.chain.ResetLocal()
	}
	return nil
}

// Run starts the HTTP server and blocks until it is stopped.
func (s *Server) Run() error {
	s.logger.Info("dual-read-server listening", "addr", s.httpServer.Addr)
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("shutting down dual-read-server")
	s.cacheMu.Lock()
	s.closed = true
	valkey := s.chain.ReplaceValkey(nil)
	s.valkey = nil
	s.cacheMu.Unlock()
	if valkey != nil {
		valkey.SetStatusCallback(nil)
		if err := valkey.Close(); err != nil {
			s.logger.Warn("failed to close valkey client", "error", err)
		}
	}
	if s.local != nil {
		if err := s.local.Close(); err != nil {
			s.logger.Warn("failed to close local cache", "error", err)
		}
	}
	return s.httpServer.Shutdown(ctx)
}

func parseBoolEnv(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func newLogger(level string) (*slog.Logger, error) {
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(level)); err != nil {
		return nil, fmt.Errorf("invalid log level %q", level)
	}
	handler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv})
	return slog.New(handler), nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func loggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)

		path := r.URL.Path
		quiet := path == "/livez" || path == "/readyz" || path == "/health" ||
			strings.HasSuffix(path, "/metrics") || path == "/metrics"
		attrs := []any{
			"request_id", observe.FromContext(r.Context()),
			"method", r.Method,
			"path", path,
			"status", sw.status,
			"duration_ms", time.Since(start).Milliseconds(),
		}
		if quiet {
			logger.Debug("request", attrs...)
			return
		}
		attrs = append(attrs,
			"bytes", sw.bytes,
			"cache", sw.Header().Get("X-Cache"),
		)
		logger.Info("request", attrs...)
	})
}
