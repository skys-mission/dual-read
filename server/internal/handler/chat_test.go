package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/skys-mission/dual-read/server/internal/auth"
	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/runtime"
	"github.com/skys-mission/dual-read/server/internal/upstream"
)

func testKey(body []byte, authName, base, apiKey string, gen int64, passthroughVal string) string {
	return cache.KeyV2(cache.KeyInput{
		Body:                body,
		ProviderID:          cache.ProviderID,
		ResolvedBaseURL:     base,
		UpstreamSecretFP:    cache.SecretFingerprint(apiKey),
		PassthroughValuesFP: passthroughVal,
		AuthScope:           authName,
		ConfigGeneration:    gen,
	})
}

func TestCacheKeyIncludesGenerationFieldsAndAuth(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.3,"max_tokens":100}`)
	body2 := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.3,"max_tokens":200}`)

	k1 := testKey(body, "a", "https://api.example.com", "sk", 1, "")
	k2 := testKey(body2, "a", "https://api.example.com", "sk", 1, "")
	if k1 == k2 {
		t.Fatal("expected different keys for different max_tokens")
	}
	k3 := testKey(body, "b", "https://api.example.com", "sk", 1, "")
	if k1 == k3 {
		t.Fatal("expected different keys for different auth names")
	}
	k4 := testKey(body, "a", "https://api.example.com", "sk", 2, "")
	if k1 == k4 {
		t.Fatal("expected different keys for different config generation")
	}
}

func TestCacheKeyCoversUnenumeratedFields(t *testing.T) {
	base := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	withPenalty := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"frequency_penalty":1.5}`)
	withUser := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"user":"alice"}`)

	k0 := testKey(base, "a", "https://x", "sk", 1, "")
	if k0 == testKey(withPenalty, "a", "https://x", "sk", 1, "") {
		t.Fatal("frequency_penalty must change the cache key")
	}
	if k0 == testKey(withUser, "a", "https://x", "sk", 1, "") {
		t.Fatal("user field must change the cache key")
	}
}

func TestCacheKeyIsolatesPerKeyUpstream(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)

	def := testKey(body, "a", "https://default.example.com", "sk-default", 1, "")
	otherBase := testKey(body, "a", "https://alt.example.com", "sk-default", 1, "")
	otherKey := testKey(body, "a", "https://default.example.com", "sk-per-key-secret", 1, "")

	if def == otherBase {
		t.Fatal("different upstream base_url must not share cache")
	}
	if def == otherKey {
		t.Fatal("different upstream api key must not share cache")
	}
	if otherBase == otherKey {
		t.Fatal("base_url and api key dimensions must be independent")
	}
}

func TestCacheKeyIncludesHeaderFingerprint(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}],"temperature":0.3}`)

	keyWithout := testKey(body, "anonymous", "https://x", "sk", 1, "")
	keyWith := testKey(body, "anonymous", "https://x", "sk", 1, "OpenAI-Organization=org-a")
	if keyWithout == keyWith {
		t.Fatal("expected different cache keys when header fingerprint differs")
	}
}

func TestSnapshotCacheKeyUsesResolvedGlobalUpstream(t *testing.T) {
	cfg := &config.Config{
		Upstream: config.UpstreamConfig{
			BaseURL: "https://global.example.com",
			APIKey:  "global-secret",
			Timeout: "5s",
			ExtraHeaders: map[string]string{
				"X-Custom": "1",
			},
			PassthroughHeaders: []string{"OpenAI-Organization"},
		},
	}
	snap := runtime.NewSnapshot(cfg, []byte("0123456789abcdef"), 7)
	id := &auth.Identity{Name: "anon"}
	body := []byte(`{"model":"m"}`)
	in := snap.CacheKeyInput(body, id, http.Header{}, upstream.ChatOptions{})
	if in.ResolvedBaseURL != "https://global.example.com" {
		t.Fatalf("resolved base=%q", in.ResolvedBaseURL)
	}
	if in.UpstreamSecretFP != cache.SecretFingerprint("global-secret") {
		t.Fatal("expected global secret fingerprint")
	}
	if in.ExtraHeadersFP == "" || in.PassthroughConfigFP == "" {
		t.Fatal("expected config fingerprints")
	}
	if in.ConfigGeneration != 7 {
		t.Fatalf("generation=%d", in.ConfigGeneration)
	}
	override := snap.CacheKeyInput(body, id, http.Header{}, upstream.ChatOptions{
		BaseURL: "https://per-key.example.com",
		APIKey:  "per-key",
	})
	if cache.KeyV2(in) == cache.KeyV2(override) {
		t.Fatal("per-key upstream override must change cache key")
	}
}

func TestHandleRejectsStream(t *testing.T) {
	h := newTestChat(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	})).URL, false)

	body := `{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()
	h.handleChatCompletions(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestHandleValidatesHTTPContract(t *testing.T) {
	h := newTestChat(t, httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("upstream should not be called")
	})).URL, false)

	tests := []struct {
		name   string
		method string
		body   string
		status int
		code   string
	}{
		{name: "method", method: http.MethodGet, status: http.StatusMethodNotAllowed, code: "method_not_allowed"},
		{name: "invalid json", method: http.MethodPost, body: `{`, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "missing messages", method: http.MethodPost, body: `{"model":"m"}`, status: http.StatusBadRequest, code: "invalid_request"},
		{
			name:   "payload too large",
			method: http.MethodPost,
			body:   strings.Repeat("x", maxBodyBytes+1),
			status: http.StatusRequestEntityTooLarge,
			code:   "payload_too_large",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/v1/chat/completions", strings.NewReader(tt.body))
			rr := httptest.NewRecorder()
			h.handleChatCompletions(rr, req)
			if rr.Code != tt.status {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), `"`+tt.code+`"`) {
				t.Fatalf("expected error code %q in %s", tt.code, rr.Body.String())
			}
		})
	}
}

func TestHandlePassesThroughUpstreamHTTPError(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "30")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"quota exceeded"}}`))
	}))
	defer up.Close()

	h := newTestChat(t, up.URL, false)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/chat/completions",
		strings.NewReader(`{"model":"flash","messages":[{"role":"user","content":"hi"}]}`),
	)
	rr := httptest.NewRecorder()
	h.handleChatCompletions(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "quota exceeded") {
		t.Fatalf("upstream body not preserved: %s", rr.Body.String())
	}
	if rr.Header().Get("Retry-After") != "30" {
		t.Fatalf("Retry-After not preserved: %q", rr.Header().Get("Retry-After"))
	}
	if rr.Header().Get("X-RateLimit-Remaining") != "0" {
		t.Fatalf("rate-limit metadata not preserved: %q", rr.Header().Get("X-RateLimit-Remaining"))
	}
}

func TestHandleModelMappingAndCacheHit(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var m map[string]interface{}
		_ = json.Unmarshal(raw, &m)
		if m["model"] != "deepseek-v4-flash" {
			t.Errorf("expected mapped model, got %v", m["model"])
		}
		thinking, ok := m["thinking"].(map[string]interface{})
		if !ok || thinking["type"] != "disabled" {
			t.Errorf("expected server to disable DeepSeek thinking, got %v", m["thinking"])
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"1","choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer up.Close()

	h := newTestChat(t, up.URL, false)
	body := `{"model":"flash","messages":[{"role":"user","content":"hi"}],"temperature":0.3}`

	req1 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	rr1 := httptest.NewRecorder()
	h.handleChatCompletions(rr1, req1)
	if rr1.Code != 200 {
		t.Fatalf("first call: %d %s", rr1.Code, rr1.Body.String())
	}
	if rr1.Header().Get("X-Cache") != "MISS" {
		t.Fatalf("expected MISS, got %s", rr1.Header().Get("X-Cache"))
	}
	if rr1.Header().Get("X-Dual-Read-Model") != "deepseek-v4-flash" {
		t.Fatalf("expected mapped model header")
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	rr2 := httptest.NewRecorder()
	h.handleChatCompletions(rr2, req2)
	if rr2.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("expected HIT, got %s", rr2.Header().Get("X-Cache"))
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 upstream call, got %d", calls.Load())
	}
}

func TestSingleflightDedupesConcurrentMiss(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer up.Close()

	h := newTestChat(t, up.URL, false)
	body := `{"model":"flash","messages":[{"role":"user","content":"same"}],"temperature":0.3}`

	var (
		wg        sync.WaitGroup
		mu        sync.Mutex
		coalesced int
		miss      int
	)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
			rr := httptest.NewRecorder()
			h.handleChatCompletions(rr, req)
			if rr.Code != 200 {
				t.Errorf("status %d", rr.Code)
			}
			mu.Lock()
			switch rr.Header().Get("X-Cache") {
			case "COALESCED":
				coalesced++
			case "MISS":
				miss++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected 1 upstream call with coalescer, got %d", calls.Load())
	}
	if miss < 1 || coalesced < 1 {
		t.Fatalf("expected MISS+COALESCED mix, miss=%d coalesced=%d", miss, coalesced)
	}
}

func TestAuthRequired(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer up.Close()
	h := newTestChat(t, up.URL, true)

	body := `{"model":"flash","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()
	h.handleChatCompletions(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}

	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	req2.Header.Set("Authorization", "Bearer sk-proxy-test")
	rr2 := httptest.NewRecorder()
	h.handleChatCompletions(rr2, req2)
	if rr2.Code != 200 {
		t.Fatalf("expected 200 with key, got %d %s", rr2.Code, rr2.Body.String())
	}
}

func newTestChat(t *testing.T, upstreamURL string, authEnabled bool) *Chat {
	t.Helper()
	return newTestChatWithTimeout(t, upstreamURL, authEnabled, 5*time.Second)
}

func newTestChatWithTimeout(t *testing.T, upstreamURL string, authEnabled bool, timeout time.Duration) *Chat {
	t.Helper()
	local, err := cache.NewLocal(time.Minute, 16)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Close() })

	authCfg := config.AuthConfig{Enabled: authEnabled}
	if authEnabled {
		authCfg.Keys = []config.AuthKey{{
			Name: "test",
			Key:  "sk-proxy-test",
			Models: map[string]string{
				"flash": "deepseek-v4-flash",
			},
		}}
	}

	cfg := &config.Config{
		Upstream: config.UpstreamConfig{
			BaseURL: upstreamURL,
			APIKey:  "upstream-key",
			Timeout: timeout.String(),
		},
		Auth: authCfg,
		Models: config.ModelsConfig{
			Default: "deepseek-v4-flash",
			Map:     map[string]string{"flash": "deepseek-v4-flash"},
		},
	}

	chain := cache.NewChain(local, nil)
	chain.SetLoadTimeout(timeout)
	return NewChat(
		chain,
		runtime.NewSnapshot(cfg, []byte("0123456789abcdef"), 1),
		metrics.New(),
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
}

func TestExplicitThinkingSettingIsPreserved(t *testing.T) {
	body := []byte(`{"model":"alias","messages":[],"thinking":{"type":"enabled"}}`)
	rewritten, err := rewriteModel(body, "deepseek-v4-flash", true)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(rewritten, &payload); err != nil {
		t.Fatal(err)
	}
	thinking, ok := payload["thinking"].(map[string]interface{})
	if !ok || thinking["type"] != "enabled" {
		t.Fatalf("explicit thinking setting was overwritten: %v", payload["thinking"])
	}
}

func TestInvalidSuccessResponseIsNotCached(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":""}}]}`))
	}))
	defer up.Close()

	h := newTestChat(t, up.URL, false)
	body := `{"model":"flash","messages":[{"role":"user","content":"hi"}]}`
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
		rr := httptest.NewRecorder()
		h.handleChatCompletions(rr, req)
		if rr.Code != http.StatusBadGateway {
			t.Fatalf("attempt %d: expected 502, got %d %s", i+1, rr.Code, rr.Body.String())
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("invalid responses must not be cached, upstream calls=%d", calls.Load())
	}
}

// Regression: a load-side timeout must surface as 504 with a body — returning
// without writing made net/http emit a bare 200 with an empty body.
func TestUpstreamTimeoutReturnsGatewayTimeout(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer up.Close()

	h := newTestChatWithTimeout(t, up.URL, false, 50*time.Millisecond)
	body := `{"model":"flash","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(body))
	rr := httptest.NewRecorder()
	h.handleChatCompletions(rr, req)

	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d (body %q)", rr.Code, rr.Body.String())
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte("upstream_timeout")) {
		t.Fatalf("expected upstream_timeout body, got %q", rr.Body.String())
	}
}
