package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/upstream"
)

func TestSnapshotReloadBumpsGenerationAndAuth(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	cfg := &config.Config{
		Upstream: config.UpstreamConfig{
			BaseURL: "https://api.example.com",
			APIKey:  "sk-global",
			Timeout: "5s",
		},
		Auth: config.AuthConfig{
			Enabled: true,
			Keys:    []config.AuthKey{{Name: "alice", Key: "sk-alice"}},
		},
		Models: config.ModelsConfig{Default: "m1", Map: map[string]string{"flash": "m1"}},
		Limits: config.LimitsConfig{Enabled: false},
	}
	s := NewSnapshot(cfg, pepper, 1)
	if s.ConfigGeneration() != 1 {
		t.Fatalf("gen=%d", s.ConfigGeneration())
	}
	id, ok := s.Authenticate("Bearer sk-alice")
	if !ok || id.Name != "alice" {
		t.Fatalf("auth failed: ok=%v id=%+v", ok, id)
	}
	up, client := s.ResolveModel("flash", id)
	if up != "m1" || client != "flash" {
		t.Fatalf("model map up=%q client=%q", up, client)
	}

	cfg2 := *cfg
	cfg2.Upstream.BaseURL = "https://other.example.com"
	cfg2.Upstream.ExtraHeaders = map[string]string{"X-A": "1"}
	s.Reload(&cfg2, pepper, 9)
	if s.ConfigGeneration() != 9 {
		t.Fatalf("gen after reload=%d", s.ConfigGeneration())
	}
	if s.BaseURL() != "https://other.example.com" {
		t.Fatalf("base=%q", s.BaseURL())
	}
	in := s.CacheKeyInput([]byte(`{}`), id, http.Header{}, upstream.ChatOptions{})
	if in.ConfigGeneration != 9 || in.ExtraHeadersFP == "" {
		t.Fatalf("cache input %+v", in)
	}
}

func TestSnapshotUpstreamBusy(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	t.Cleanup(up.Close)

	cfg := &config.Config{
		Upstream: config.UpstreamConfig{BaseURL: up.URL, APIKey: "k", Timeout: "2s"},
		Limits: config.LimitsConfig{
			Enabled:              true,
			MaxInFlightUpstream:  1,
			PerIPPerMinute:       1000,
			PerClientPerMinute:   1000,
			MaxInFlightPerClient: 100,
		},
	}
	s := NewSnapshot(cfg, []byte("0123456789abcdef"), 1)

	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		_, err := s.ChatCompletion(context.Background(), []byte(`{}`), http.Header{}, upstream.ChatOptions{})
		done <- err
	}()
	<-started
	time.Sleep(10 * time.Millisecond)
	_, err := s.ChatCompletion(context.Background(), []byte(`{}`), http.Header{}, upstream.ChatOptions{})
	if !errors.Is(err, ErrUpstreamBusy) {
		t.Fatalf("expected ErrUpstreamBusy, got %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("leader failed: %v", err)
	}
}

func TestSnapshotVerifyAdmin(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	token := "admin-secret-token"
	cfg := &config.Config{
		Upstream: config.UpstreamConfig{BaseURL: "https://api.example.com", APIKey: "k", Timeout: "5s"},
		Admin:    config.AdminConfig{Token: token},
	}
	s := NewSnapshot(cfg, pepper, 1)
	if !s.AdminTokenConfigured() || !s.VerifyAdmin(token) {
		t.Fatal("admin should verify")
	}
	if s.VerifyAdmin("wrong") {
		t.Fatal("wrong token must fail")
	}
}
