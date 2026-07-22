package observe_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/observe"
)

func TestRequestIDMiddleware(t *testing.T) {
	var got string
	h := observe.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = observe.FromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(observe.HeaderRequestID, "client-req-1")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if got != "client-req-1" {
		t.Fatalf("context id=%q", got)
	}
	if rr.Header().Get(observe.HeaderRequestID) != "client-req-1" {
		t.Fatalf("response header=%q", rr.Header().Get(observe.HeaderRequestID))
	}

	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if !strings.HasPrefix(rr2.Header().Get(observe.HeaderRequestID), "dr-") {
		t.Fatalf("expected generated id, got %q", rr2.Header().Get(observe.HeaderRequestID))
	}
}

func TestRedactError(t *testing.T) {
	if observe.RedactError("unauthorized") != "unauthorized" {
		t.Fatal("known code")
	}
	if observe.RedactError(`Bearer sk-secret {"messages":[]}`) != observe.ErrInternal {
		t.Fatal("secrets must redact")
	}
	if observe.RedactError("upstream HTTP 502: boom") != observe.ErrUpstreamError {
		t.Fatal("upstream class")
	}
}

func TestLivezReadyz(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENAI_API_KEY", "test-key")
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatal(err)
	}
	local, err := cache.NewLocal(time.Minute, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Close() })
	chain := cache.NewChain(local, nil)
	col := metrics.New()
	h := &observe.Health{
		Store:        store,
		Cache:        chain,
		Metrics:      col,
		ValkeyWanted: false,
		Started:      time.Now().UTC(),
	}
	mux := http.NewServeMux()
	h.Register(mux)

	live := httptest.NewRecorder()
	mux.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/livez", nil))
	if live.Code != 200 {
		t.Fatalf("livez=%d", live.Code)
	}

	ready := httptest.NewRecorder()
	mux.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != 200 {
		t.Fatalf("readyz=%d body=%s", ready.Code, ready.Body.String())
	}

	// Valkey required but missing → 503
	h.ValkeyWanted = true
	ready2 := httptest.NewRecorder()
	mux.ServeHTTP(ready2, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready2.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when valkey wanted missing, got %d", ready2.Code)
	}

	health := httptest.NewRecorder()
	mux.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != 200 {
		t.Fatalf("health diagnostic should stay 200, got %d", health.Code)
	}
}

func TestMetricsHandlerAuth(t *testing.T) {
	col := metrics.New()
	col.Begin()
	col.End(metrics.RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 200, Cache: "MISS", DurationMs: 12,
	})

	h := &observe.MetricsHandler{Collector: col, Token: "secret-metrics"}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer secret-metrics")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req)
	if rr2.Code != 200 {
		t.Fatalf("expected 200, got %d", rr2.Code)
	}
	body, _ := io.ReadAll(rr2.Body)
	if !strings.Contains(string(body), "dual_read_requests_total") {
		t.Fatalf("missing prometheus metric: %s", body)
	}
	if !strings.Contains(string(body), "dual_read_request_duration_seconds_bucket") {
		t.Fatal("missing histogram")
	}
}

func TestValidRequestIDRejectsControl(t *testing.T) {
	if observe.ValidRequestID("a\nb") {
		t.Fatal("newline rejected")
	}
	if observe.ValidRequestID(strings.Repeat("x", 200)) {
		t.Fatal("too long rejected")
	}
	_ = context.Background()
}
