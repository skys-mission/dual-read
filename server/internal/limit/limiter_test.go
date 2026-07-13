package limit

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAllowIPExhausts(t *testing.T) {
	l := New(Config{
		Enabled:        true,
		PerIPPerMinute: 2,
	})
	now := time.Now()
	if d := l.AllowIP("1.2.3.4", now); !d.Allowed {
		t.Fatal("first should allow")
	}
	if d := l.AllowIP("1.2.3.4", now); !d.Allowed {
		t.Fatal("second should allow")
	}
	d := l.AllowIP("1.2.3.4", now)
	if d.Allowed || d.Reason != "rate_ip" {
		t.Fatalf("expected rate_ip deny, got %+v", d)
	}
	if d.RetryAfter < time.Second {
		t.Fatalf("retry after too small: %v", d.RetryAfter)
	}
}

func TestAllowClientInflight(t *testing.T) {
	l := New(Config{
		Enabled:              true,
		PerClientPerMinute:   100,
		MaxInFlightPerClient: 1,
	})
	now := time.Now()
	if d := l.AllowClient("alice", now); !d.Allowed {
		t.Fatal("first should allow")
	}
	d := l.AllowClient("alice", now)
	if d.Allowed || d.Reason != "inflight_client" {
		t.Fatalf("expected inflight_client, got %+v", d)
	}
	l.ReleaseClient("alice")
	if d := l.AllowClient("alice", now); !d.Allowed {
		t.Fatal("after release should allow")
	}
}

func TestAcquireUpstream(t *testing.T) {
	l := New(Config{
		Enabled:             true,
		MaxInFlightUpstream: 1,
	})
	if d := l.AcquireUpstream(); !d.Allowed {
		t.Fatal("first upstream slot")
	}
	d := l.AcquireUpstream()
	if d.Allowed || d.Reason != "inflight_upstream" {
		t.Fatalf("expected inflight_upstream, got %+v", d)
	}
	l.ReleaseUpstream()
	if d := l.AcquireUpstream(); !d.Allowed {
		t.Fatal("after release")
	}
}

func TestDisabledAllows(t *testing.T) {
	l := New(Config{Enabled: false, PerIPPerMinute: 1})
	now := time.Now()
	for i := 0; i < 5; i++ {
		if d := l.AllowIP("9.9.9.9", now); !d.Allowed {
			t.Fatal("disabled should allow")
		}
	}
}

func TestAllowIPEvictsIdleBucketsAtCap(t *testing.T) {
	l := New(Config{Enabled: true, PerIPPerMinute: 1})
	now := time.Now()
	// Fill the map with stale buckets (last use beyond idle expiry).
	stale := now.Add(-bucketIdleExpiry - time.Minute)
	l.mu.Lock()
	for i := 0; i < maxBuckets; i++ {
		l.ip[fmt.Sprintf("10.0.%d.%d", i/256, i%256)] = newBucket(1, stale)
	}
	l.mu.Unlock()

	// A fresh IP must trigger eviction instead of failing closed.
	if d := l.AllowIP("203.0.113.7", now); !d.Allowed {
		t.Fatalf("expected eviction to admit fresh IP, got %+v", d)
	}
	l.mu.Lock()
	n := len(l.ip)
	l.mu.Unlock()
	if n >= maxBuckets {
		t.Fatalf("expected eviction to shrink map, still %d buckets", n)
	}
}

func TestAllowIPFailsClosedWhenAllBucketsHot(t *testing.T) {
	l := New(Config{Enabled: true, PerIPPerMinute: 1})
	now := time.Now()
	l.mu.Lock()
	for i := 0; i < maxBuckets; i++ {
		l.ip[fmt.Sprintf("10.1.%d.%d", i/256, i%256)] = newBucket(1, now)
	}
	l.mu.Unlock()

	d := l.AllowIP("203.0.113.9", now)
	if d.Allowed || d.Reason != "rate_ip" {
		t.Fatalf("expected fail-closed rate_ip at hot cap, got %+v", d)
	}
}

func TestClientIPTrustedProxy(t *testing.T) {
	req := func(remote, xff string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}

	plain := New(Config{Enabled: true})
	if got := plain.ClientIP(req("172.18.0.2:1234", "203.0.113.5")); got != "172.18.0.2" {
		t.Fatalf("no trusted proxies: expected RemoteAddr, got %q", got)
	}

	l := New(Config{Enabled: true, TrustedProxies: []string{"172.16.0.0/12"}})
	if got := l.ClientIP(req("172.18.0.2:1234", "203.0.113.5, 172.18.0.2")); got != "203.0.113.5" {
		t.Fatalf("trusted proxy: expected first XFF hop, got %q", got)
	}
	if got := l.ClientIP(req("8.8.8.8:1234", "203.0.113.5")); got != "8.8.8.8" {
		t.Fatalf("untrusted proxy: XFF must be ignored, got %q", got)
	}
	if got := l.ClientIP(req("172.18.0.2:1234", "")); got != "172.18.0.2" {
		t.Fatalf("trusted proxy without XFF: expected RemoteAddr, got %q", got)
	}
}
