package metrics

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestEndCountsCacheOutcomes(t *testing.T) {
	c := New()
	c.Begin()
	c.End(RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 200, Cache: "MISS", DurationMs: 10,
	})
	c.Begin()
	c.End(RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 200, Cache: "HIT", DurationMs: 1,
	})
	c.Begin()
	c.End(RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 200, Cache: "COALESCED", DurationMs: 5,
	})
	c.Begin()
	c.End(RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 429, Cache: "", DurationMs: 2, Error: "rate_limited",
	})

	snap := c.Snapshot()
	if snap.Requests != 4 || snap.CacheMisses != 1 || snap.CacheHits != 1 || snap.CacheCoalesced != 1 {
		t.Fatalf("unexpected cache counters: %+v", snap)
	}
	if snap.UpstreamOK != 1 {
		t.Fatalf("upstream ok want 1 got %d", snap.UpstreamOK)
	}
	if snap.RateLimited != 1 {
		t.Fatalf("rate limited want 1 got %d", snap.RateLimited)
	}
	if snap.InFlight != 0 {
		t.Fatalf("inflight should be 0, got %d", snap.InFlight)
	}
	if len(snap.Recent) != 4 {
		t.Fatalf("recent len=%d", len(snap.Recent))
	}
}

func TestRecentRingTruncates(t *testing.T) {
	c := New()
	c.maxRecent = 3
	for i := 0; i < 5; i++ {
		c.Begin()
		c.End(RecentRequest{
			Time: time.Now().UTC(), Method: "GET", Path: "/x", Status: 200, DurationMs: 1,
			RequestID: string(rune('a' + i)),
		})
	}
	snap := c.Snapshot()
	if len(snap.Recent) != 3 {
		t.Fatalf("want 3 recent, got %d", len(snap.Recent))
	}
}

func TestWritePrometheus(t *testing.T) {
	c := New()
	c.SetValkeyUp(true)
	c.Begin()
	c.End(RecentRequest{
		Time: time.Now().UTC(), Method: "POST", Path: "/v1/chat/completions",
		Status: 200, Cache: "MISS", DurationMs: 25,
	})
	var buf bytes.Buffer
	if err := c.WritePrometheus(&buf); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, needle := range []string{
		"dual_read_requests_total 1",
		"dual_read_cache_misses_total 1",
		"dual_read_valkey_up 1",
		"dual_read_request_duration_seconds_bucket",
		"dual_read_request_duration_seconds_count 1",
	} {
		if !strings.Contains(out, needle) {
			t.Fatalf("missing %q in:\n%s", needle, out)
		}
	}
}
