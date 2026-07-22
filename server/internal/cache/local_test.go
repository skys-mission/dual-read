package cache

import (
	"testing"
	"time"
)

func TestLocalCacheGetSet(t *testing.T) {
	c, err := NewLocal(5*time.Minute, 16)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	defer c.Close()

	c.Set("key", []byte("value"))

	val, ok := c.Get("key")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if string(val) != "value" {
		t.Fatalf("expected value, got %s", string(val))
	}
}

func TestLocalCacheMiss(t *testing.T) {
	c, err := NewLocal(5*time.Minute, 16)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	defer c.Close()

	if _, ok := c.Get("missing"); ok {
		t.Fatal("expected cache miss")
	}
}

func TestLocalCacheStoresMaximumUpstreamSizedResponse(t *testing.T) {
	c, err := NewLocal(5*time.Minute, 16)
	if err != nil {
		t.Fatalf("create cache: %v", err)
	}
	defer c.Close()

	value := make([]byte, 8<<20)
	c.Set("large", value)
	got, ok := c.Get("large")
	if !ok {
		t.Fatal("expected 8 MiB response to fit in local cache")
	}
	if len(got) != len(value) {
		t.Fatalf("cached response size=%d, want %d", len(got), len(value))
	}
}

func TestLocalShardCountKeepsPerShardCapacity(t *testing.T) {
	tests := []struct {
		maxMB int
		want  int
	}{
		{maxMB: 16, want: 1},
		{maxMB: 64, want: 4},
		{maxMB: 256, want: 16},
	}
	for _, tt := range tests {
		if got := localShardCount(tt.maxMB); got != tt.want {
			t.Fatalf("maxMB=%d: shards=%d, want %d", tt.maxMB, got, tt.want)
		}
	}
}
