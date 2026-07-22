package config

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestViewNoDeadlock is a C2 regression: View() previously called Meta() while
// already holding s.mu.RLock(), which deadlocks under a concurrent writer
// because sync.RWMutex is not reentrant. This test must complete quickly.
func TestViewNoDeadlock(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENAI_API_KEY", "k")

	store, err := Open(OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := 0; i < 200; i++ {
			wg.Add(2)
			go func() { defer wg.Done(); _, _ = store.View("") }()
			go func() { defer wg.Done(); _ = store.Meta() }()
		}
		wg.Wait()
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("View/Meta deadlocked (C2 regression)")
	}
}

// TestConcurrentViewAndUpdate is a C2/C3 regression exercised under -race:
// concurrent readers (View/BuildEffectiveFromRuntime) must not race with
// writers (UpdateRuntime), and BuildEffectiveFromRuntime must not mutate
// shared state while holding only a read lock.
func TestConcurrentViewAndUpdate(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("OPENAI_API_KEY", "k")

	store, err := Open(OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	update := []byte(`{
  "llm": { "base_url": "https://api.example.com", "api_key": "__KEEP__", "timeout": "60s", "passthrough_headers": [], "extra_headers": {} },
  "clients": { "enabled": false, "items": [] },
  "models": { "default": "deepseek-v4-flash", "map": { "flash": "deepseek-v4-flash" } },
  "cache": {
    "local": { "enabled": true, "ttl": "10m", "max_mb": 256 },
    "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "password": "", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" }
  },
  "log": { "level": "info" },
  "admin": { "token": "__KEEP__" }
}`)

	// A cancelled context's Done() channel is observable by ALL goroutines,
	// unlike time.After whose single value is consumed by one receiver.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				_, _ = store.View("")
				snap := store.RuntimeSnapshot()
				_, _ = store.BuildEffectiveFromRuntime(&snap)
			}
		}()
	}

	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				_, _, _ = store.UpdateRuntime(update)
			}
		}()
	}

	wg.Wait()
}
