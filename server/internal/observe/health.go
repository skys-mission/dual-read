package observe

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/metrics"
)

// Health serves /livez, /readyz, and a diagnostic /health.
type Health struct {
	Store        *config.Store
	Cache        *cache.Chain
	Metrics      *metrics.Collector
	ValkeyWanted bool
	Started      time.Time
	mu           sync.RWMutex
}

// SetValkeyWanted updates whether readiness should require Valkey.
func (h *Health) SetValkeyWanted(wanted bool) {
	h.mu.Lock()
	h.ValkeyWanted = wanted
	h.mu.Unlock()
}

func (h *Health) wantsValkey() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.ValkeyWanted
}

// Register mounts health endpoints on mux.
func (h *Health) Register(mux *http.ServeMux) {
	mux.HandleFunc("/livez", h.handleLivez)
	mux.HandleFunc("/readyz", h.handleReadyz)
	mux.HandleFunc("/health", h.handleHealth)
}

func (h *Health) handleLivez(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
	})
}

func (h *Health) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ready, checks := h.readiness(r.Context())
	status := http.StatusOK
	body := map[string]interface{}{
		"status": "ok",
		"checks": checks,
	}
	if !ready {
		status = http.StatusServiceUnavailable
		body["status"] = "not_ready"
	}
	writeJSON(w, status, body)
}

// handleHealth remains a diagnostic always-200 endpoint for humans/compat.
// Orchestrators should use /livez and /readyz.
func (h *Health) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ready, checks := h.readiness(r.Context())
	statusLabel := "ok"
	if !ready {
		statusLabel = "degraded"
	}
	body := map[string]interface{}{
		"status":            statusLabel,
		"timestamp":         time.Now().UTC().Format(time.RFC3339),
		"uptime_seconds":    time.Since(h.Started).Seconds(),
		"ready":             ready,
		"checks":            checks,
		"local_cache":       h.Cache != nil && h.Cache.LocalEnabled(),
		"local_cache_items": 0,
		"valkey":            checks["valkey"],
	}
	if h.Cache != nil {
		body["local_cache_items"] = h.Cache.LocalLen()
	}
	writeJSON(w, http.StatusOK, body)
}

func (h *Health) readiness(ctx context.Context) (bool, map[string]string) {
	checks := map[string]string{
		"config": "ok",
		"valkey": "disabled",
	}
	ready := true

	if h.Store == nil {
		checks["config"] = "missing"
		ready = false
	} else if _, err := h.Store.Effective(); err != nil {
		checks["config"] = "invalid"
		ready = false
	}

	valkey := h.Cache.Valkey()
	if h.wantsValkey() && valkey == nil {
		checks["valkey"] = "unavailable"
		ready = false
		if h.Metrics != nil {
			h.Metrics.SetValkeyUp(false)
		}
	} else if valkey != nil {
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := valkey.Ping(pingCtx)
		cancel()
		if err != nil {
			checks["valkey"] = "unreachable"
			ready = false
			if h.Metrics != nil {
				h.Metrics.SetValkeyUp(false)
			}
		} else {
			checks["valkey"] = "ok"
			if h.Metrics != nil {
				h.Metrics.SetValkeyUp(true)
			}
		}
	} else if h.Metrics != nil {
		h.Metrics.SetValkeyUp(false)
	}

	return ready, checks
}

func writeJSON(w http.ResponseWriter, status int, body map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
