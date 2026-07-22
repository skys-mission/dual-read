package observe

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/skys-mission/dual-read/server/internal/metrics"
)

// MetricsHandler serves Prometheus text at a configured path.
type MetricsHandler struct {
	Collector *metrics.Collector
	Token     string // if non-empty, require Bearer or X-Metrics-Token
}

func (h *MetricsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.Token != "" && !metricsAuthorized(r, h.Token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if h.Collector == nil {
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_ = h.Collector.WritePrometheus(w)
}

func metricsAuthorized(r *http.Request, token string) bool {
	if tok := strings.TrimSpace(r.Header.Get("X-Metrics-Token")); tok != "" {
		return subtle.ConstantTimeCompare([]byte(tok), []byte(token)) == 1
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if len(auth) >= len(prefix) && strings.EqualFold(auth[:len(prefix)], prefix) {
		got := strings.TrimSpace(auth[len(prefix):])
		return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
	}
	return false
}
