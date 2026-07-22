package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/skys-mission/dual-read/server/internal/config"
)

func TestServerHTTPIntegration(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"1","choices":[{"message":{"content":"hi"}}]}`))
	}))
	t.Cleanup(up.Close)

	t.Setenv("OPENAI_API_KEY", "upstream-key")
	t.Setenv("OPENAI_BASE_URL", up.URL)
	t.Setenv("DUAL_READ_ADMIN_TOKEN", "integration-admin")
	t.Setenv("DUAL_READ_METRICS_ENABLED", "true")
	t.Setenv("DUAL_READ_HOST", "127.0.0.1")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}

	srv, err := New(store)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	ts := httptest.NewServer(srv.httpServer.Handler)
	t.Cleanup(ts.Close)

	live, err := http.Get(ts.URL + "/livez")
	if err != nil {
		t.Fatal(err)
	}
	defer live.Body.Close()
	if live.StatusCode != 200 {
		t.Fatalf("livez=%d", live.StatusCode)
	}
	if live.Header.Get("X-Request-Id") == "" {
		t.Fatal("expected X-Request-Id on livez")
	}

	ready, err := http.Get(ts.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer ready.Body.Close()
	if ready.StatusCode != 200 {
		body, _ := io.ReadAll(ready.Body)
		t.Fatalf("readyz=%d %s", ready.StatusCode, body)
	}

	body := `{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}`
	req1, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(body))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("X-Request-Id", "integ-req-1")
	res1, err := http.DefaultClient.Do(req1)
	if err != nil {
		t.Fatal(err)
	}
	defer res1.Body.Close()
	if res1.StatusCode != 200 {
		b, _ := io.ReadAll(res1.Body)
		t.Fatalf("chat1=%d %s", res1.StatusCode, b)
	}
	if res1.Header.Get("X-Cache") != "MISS" {
		t.Fatalf("cache1=%s", res1.Header.Get("X-Cache"))
	}
	if res1.Header.Get("X-Request-Id") != "integ-req-1" {
		t.Fatalf("request id=%q", res1.Header.Get("X-Request-Id"))
	}

	req2, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat/completions", strings.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Request-Id", "integ-req-1") // same passthrough value → same cache key
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.Header.Get("X-Cache") != "HIT" {
		t.Fatalf("cache2=%s", res2.Header.Get("X-Cache"))
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream calls=%d", calls.Load())
	}

	met, err := http.Get(ts.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer met.Body.Close()
	raw, _ := io.ReadAll(met.Body)
	if !strings.Contains(string(raw), "dual_read_cache_hits_total") {
		t.Fatalf("metrics missing hits: %s", raw)
	}
}

func TestServerPublicBindRequiresAuthOrOverride(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "k")
	t.Setenv("OPENAI_BASE_URL", "https://api.example.com")
	t.Setenv("DUAL_READ_HOST", "0.0.0.0")
	t.Setenv("DUAL_READ_ADMIN_TOKEN", "")
	t.Setenv("DUAL_READ_AUTH_ENABLED", "false")
	t.Setenv("DUAL_READ_ALLOW_INSECURE_PUBLIC", "")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatal(err)
	}
	_, err = New(store)
	if err == nil {
		t.Fatal("expected refusal on insecure public bind")
	}
	if !strings.Contains(err.Error(), "refusing to start on public bind") {
		t.Fatalf("unexpected err: %v", err)
	}
}

func TestServerRetainsUnavailableValkeyForDiagnosticsAndRetry(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer conn.Close()
				buf := make([]byte, 4096)
				for {
					if _, readErr := conn.Read(buf); readErr != nil {
						return
					}
					if _, writeErr := conn.Write([]byte("-WRONGPASS invalid username-password pair\r\n")); writeErr != nil {
						return
					}
				}
			}()
		}
	}()

	t.Setenv("OPENAI_API_KEY", "k")
	t.Setenv("OPENAI_BASE_URL", "https://api.example.com")
	t.Setenv("DUAL_READ_ADMIN_TOKEN", "tok")
	t.Setenv("DUAL_READ_CACHE_LOCAL", "false")
	t.Setenv("DUAL_READ_CACHE_VALKEY", "true")
	t.Setenv("DUAL_READ_VALKEY_ADDR", listener.Addr().String())
	t.Setenv("DUAL_READ_VALKEY_PASSWORD", "wrong")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	valkey := srv.chain.Valkey()
	if valkey == nil {
		t.Fatal("configured but unavailable Valkey must remain attached")
	}
	if valkey.Available() {
		t.Fatal("wrong password must mark Valkey unavailable")
	}
	if !strings.Contains(valkey.LastError(), "WRONGPASS") {
		t.Fatalf("expected safe authentication error, got %q", valkey.LastError())
	}
}

func TestServerGracefulShutdown(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(up.Close)

	t.Setenv("OPENAI_API_KEY", "k")
	t.Setenv("OPENAI_BASE_URL", up.URL)
	t.Setenv("DUAL_READ_ADMIN_TOKEN", "tok")
	t.Setenv("DUAL_READ_HOST", "127.0.0.1")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.httpServer.Addr = listener.Addr().String()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.httpServer.Serve(listener) }()

	deadline := time.Now().Add(3 * time.Second)
	for {
		res, err := http.Get("http://" + srv.httpServer.Addr + "/livez")
		if err == nil {
			_ = res.Body.Close()
			if res.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not become ready")
		}
		time.Sleep(20 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("run err: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after Shutdown")
	}
}

func TestApplyRuntimeReloadsGeneration(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(up.Close)

	t.Setenv("OPENAI_API_KEY", "k")
	t.Setenv("OPENAI_BASE_URL", up.URL)
	t.Setenv("DUAL_READ_ADMIN_TOKEN", "tok")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	before := srv.snapshot.ConfigGeneration()
	rt := store.RuntimeSnapshot()
	rt.Log.Level = "debug"
	raw, err := json.Marshal(rt)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.UpdateRuntime(raw); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := srv.ApplyRuntime(); err != nil {
		t.Fatal(err)
	}
	after := srv.snapshot.ConfigGeneration()
	if after <= before {
		t.Fatalf("generation did not advance: before=%d after=%d", before, after)
	}
}
