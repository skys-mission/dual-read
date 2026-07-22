package cache

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"
)

func TestValkeyIntegration(t *testing.T) {
	addr := os.Getenv("DUAL_READ_TEST_VALKEY_ADDR")
	if addr == "" {
		t.Skip("set DUAL_READ_TEST_VALKEY_ADDR to run the Valkey integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	prefix := fmt.Sprintf("dual-read:test:%d:", time.Now().UnixNano())
	valkey := NewValkey(addr, "", 0, prefix, 2*time.Second, slog.Default())
	t.Cleanup(func() {
		_ = valkey.client.Del(context.Background(), prefix+"present").Err()
		_ = valkey.Close()
	})

	if err := valkey.Ping(ctx); err != nil {
		t.Fatalf("ping Valkey at %s: %v", addr, err)
	}

	if got, ok := valkey.Get(ctx, "missing"); ok || got != nil {
		t.Fatalf("missing key returned ok=%t value=%q", ok, got)
	}

	valkey.Set(ctx, "present", []byte("cached-response"))
	got, ok := valkey.Get(ctx, "present")
	if !ok || string(got) != "cached-response" {
		t.Fatalf("round trip returned ok=%t value=%q", ok, got)
	}

	exists, err := valkey.client.Exists(ctx, prefix+"present").Result()
	if err != nil {
		t.Fatalf("inspect prefixed key: %v", err)
	}
	if exists != 1 {
		t.Fatalf("expected prefixed key %q to exist", prefix+"present")
	}

	ttl, err := valkey.client.TTL(ctx, prefix+"present").Result()
	if err != nil {
		t.Fatalf("inspect key TTL: %v", err)
	}
	if ttl <= 0 || ttl > 2*time.Second {
		t.Fatalf("unexpected TTL %s", ttl)
	}
}

func TestValkeyAvailabilityState(t *testing.T) {
	valkey := NewValkey("127.0.0.1:1", "", 0, "test:", time.Minute, nil)
	t.Cleanup(func() { _ = valkey.Close() })

	testErr := errors.New("WRONGPASS invalid username-password pair")
	valkey.setStatus(testErr)
	if valkey.Available() {
		t.Fatal("Valkey should be unavailable after an error")
	}
	if got := valkey.LastError(); got != testErr.Error() {
		t.Fatalf("last error=%q, want %q", got, testErr.Error())
	}

	valkey.setStatus(nil)
	if !valkey.Available() || valkey.LastError() != "" {
		t.Fatal("successful health check should clear the previous error")
	}
}

func TestUnavailableValkeyKeepsCacheChainEnabled(t *testing.T) {
	valkey := NewValkey("127.0.0.1:1", "", 0, "test:", time.Minute, nil)
	t.Cleanup(func() { _ = valkey.Close() })
	valkey.setStatus(errors.New("unavailable"))

	chain := NewChain(nil, valkey)
	calls := 0
	body, outcome, err := chain.GetOrLoad(context.Background(), "key", func(context.Context) ([]byte, error) {
		calls++
		return []byte("response"), nil
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != OutcomeMISS {
		t.Fatalf("outcome=%s, want MISS (not BYPASS)", outcome)
	}
	if string(body) != "response" || calls != 1 {
		t.Fatalf("body=%q calls=%d", body, calls)
	}
}

func TestChainReplaceValkey(t *testing.T) {
	first := NewValkey("127.0.0.1:1", "", 0, "one:", time.Minute, nil)
	second := NewValkey("127.0.0.1:1", "", 0, "two:", time.Minute, nil)
	t.Cleanup(func() {
		_ = first.Close()
		_ = second.Close()
	})

	chain := NewChain(nil, first)
	if old := chain.ReplaceValkey(second); old != first {
		t.Fatal("expected previous Valkey connection")
	}
	if chain.Valkey() != second {
		t.Fatal("replacement Valkey was not installed")
	}
}
