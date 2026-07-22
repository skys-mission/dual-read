package metrics

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// Collector tracks lightweight in-process server metrics.
type Collector struct {
	startedAt time.Time

	requests       atomic.Int64
	cacheHits      atomic.Int64
	cacheMiss      atomic.Int64
	cacheCoalesced atomic.Int64
	upstreamOK     atomic.Int64
	upstreamErr    atomic.Int64
	authFail       atomic.Int64
	rateLimited    atomic.Int64
	latencySum     atomic.Int64 // nanoseconds
	inFlight       atomic.Int64
	valkeyUp       atomic.Int64 // 1/0

	mu             sync.Mutex
	statusCounts   map[int]int64
	recent         []RecentRequest
	maxRecent      int
	latencyBuckets []atomic.Int64 // cumulative-style counts per bucket index
}

// Latency bucket upper bounds in seconds (Prometheus histogram le labels).
var latencyBounds = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// RecentRequest is a ring-buffer entry for the admin UI.
type RecentRequest struct {
	Time          time.Time `json:"time"`
	RequestID     string    `json:"request_id,omitempty"`
	Method        string    `json:"method"`
	Path          string    `json:"path"`
	Status        int       `json:"status"`
	Cache         string    `json:"cache,omitempty"`
	ClientModel   string    `json:"client_model,omitempty"`
	UpstreamModel string    `json:"upstream_model,omitempty"`
	AuthName      string    `json:"auth_name,omitempty"`
	DurationMs    float64   `json:"duration_ms"`
	BytesOut      int       `json:"bytes_out,omitempty"`
	Error         string    `json:"error,omitempty"`
}

// New creates a metrics collector.
func New() *Collector {
	c := &Collector{
		startedAt:      time.Now().UTC(),
		statusCounts:   make(map[int]int64),
		recent:         make([]RecentRequest, 0, 100),
		maxRecent:      100,
		latencyBuckets: make([]atomic.Int64, len(latencyBounds)+1), // +Inf
	}
	return c
}

// Begin marks a request as in-flight.
func (c *Collector) Begin() {
	c.inFlight.Add(1)
}

// SetValkeyUp updates the Valkey availability gauge.
func (c *Collector) SetValkeyUp(up bool) {
	if up {
		c.valkeyUp.Store(1)
	} else {
		c.valkeyUp.Store(0)
	}
}

// End records a completed request.
func (c *Collector) End(rec RecentRequest) {
	c.inFlight.Add(-1)
	c.requests.Add(1)
	c.latencySum.Add(int64(rec.DurationMs * float64(time.Millisecond)))
	c.observeLatency(rec.DurationMs)

	switch rec.Cache {
	case "HIT":
		c.cacheHits.Add(1)
	case "MISS":
		c.cacheMiss.Add(1)
	case "COALESCED":
		c.cacheCoalesced.Add(1)
	}

	if rec.Status == 401 || rec.Status == 403 {
		c.authFail.Add(1)
	}
	if rec.Status == 429 {
		c.rateLimited.Add(1)
	}
	if rec.Path == "/v1/chat/completions" {
		switch {
		case rec.Cache == "MISS" && rec.Status >= 200 && rec.Status < 300:
			c.upstreamOK.Add(1)
		case rec.Cache == "MISS" && (rec.Status >= 400 || rec.Error != ""):
			c.upstreamErr.Add(1)
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.statusCounts[rec.Status]++
	c.recent = append(c.recent, rec)
	if len(c.recent) > c.maxRecent {
		c.recent = c.recent[len(c.recent)-c.maxRecent:]
	}
}

func (c *Collector) observeLatency(ms float64) {
	sec := ms / 1000.0
	for i, bound := range latencyBounds {
		if sec <= bound {
			c.latencyBuckets[i].Add(1)
			return
		}
	}
	c.latencyBuckets[len(latencyBounds)].Add(1)
}

// Snapshot is a JSON-serializable metrics view.
type Snapshot struct {
	StartedAt      time.Time        `json:"started_at"`
	UptimeSeconds  float64          `json:"uptime_seconds"`
	Requests       int64            `json:"requests"`
	InFlight       int64            `json:"in_flight"`
	CacheHits      int64            `json:"cache_hits"`
	CacheMisses    int64            `json:"cache_misses"`
	CacheCoalesced int64            `json:"cache_coalesced"`
	CacheHitRate   float64          `json:"cache_hit_rate"`
	UpstreamOK     int64            `json:"upstream_ok"`
	UpstreamErrors int64            `json:"upstream_errors"`
	AuthFailures   int64            `json:"auth_failures"`
	RateLimited    int64            `json:"rate_limited"`
	ValkeyUp       bool             `json:"valkey_up"`
	AvgLatencyMs   float64          `json:"avg_latency_ms"`
	StatusCounts   map[string]int64 `json:"status_counts"`
	Recent         []RecentRequest  `json:"recent"`
}

// Snapshot builds a point-in-time view.
func (c *Collector) Snapshot() Snapshot {
	reqs := c.requests.Load()
	hits := c.cacheHits.Load()
	miss := c.cacheMiss.Load()
	coalesced := c.cacheCoalesced.Load()
	cacheTotal := hits + miss
	var hitRate float64
	if cacheTotal > 0 {
		hitRate = float64(hits) / float64(cacheTotal)
	}
	var avgMs float64
	if reqs > 0 {
		avgMs = float64(c.latencySum.Load()) / float64(reqs) / float64(time.Millisecond)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	status := make(map[string]int64, len(c.statusCounts))
	for code, n := range c.statusCounts {
		status[itoa(code)] = n
	}
	recent := make([]RecentRequest, len(c.recent))
	copy(recent, c.recent)
	for i, j := 0, len(recent)-1; i < j; i, j = i+1, j-1 {
		recent[i], recent[j] = recent[j], recent[i]
	}

	return Snapshot{
		StartedAt:      c.startedAt,
		UptimeSeconds:  time.Since(c.startedAt).Seconds(),
		Requests:       reqs,
		InFlight:       c.inFlight.Load(),
		CacheHits:      hits,
		CacheMisses:    miss,
		CacheCoalesced: coalesced,
		CacheHitRate:   hitRate,
		UpstreamOK:     c.upstreamOK.Load(),
		UpstreamErrors: c.upstreamErr.Load(),
		AuthFailures:   c.authFail.Load(),
		RateLimited:    c.rateLimited.Load(),
		ValkeyUp:       c.valkeyUp.Load() == 1,
		AvgLatencyMs:   avgMs,
		StatusCounts:   status,
		Recent:         recent,
	}
}

// WritePrometheus writes OpenMetrics/Prometheus text exposition.
func (c *Collector) WritePrometheus(w io.Writer) error {
	snap := c.Snapshot()
	p := func(format string, args ...interface{}) {
		_, _ = fmt.Fprintf(w, format, args...)
	}

	p("# HELP dual_read_requests_total Total completed HTTP requests tracked by the chat handler.\n")
	p("# TYPE dual_read_requests_total counter\n")
	p("dual_read_requests_total %d\n", snap.Requests)

	p("# HELP dual_read_inflight Current in-flight chat requests.\n")
	p("# TYPE dual_read_inflight gauge\n")
	p("dual_read_inflight %d\n", snap.InFlight)

	p("# HELP dual_read_cache_hits_total Cache HIT responses.\n")
	p("# TYPE dual_read_cache_hits_total counter\n")
	p("dual_read_cache_hits_total %d\n", snap.CacheHits)

	p("# HELP dual_read_cache_misses_total Cache MISS responses.\n")
	p("# TYPE dual_read_cache_misses_total counter\n")
	p("dual_read_cache_misses_total %d\n", snap.CacheMisses)

	p("# HELP dual_read_cache_coalesced_total Cache COALESCED waiter responses.\n")
	p("# TYPE dual_read_cache_coalesced_total counter\n")
	p("dual_read_cache_coalesced_total %d\n", snap.CacheCoalesced)

	p("# HELP dual_read_upstream_ok_total Successful upstream fetches (MISS + 2xx).\n")
	p("# TYPE dual_read_upstream_ok_total counter\n")
	p("dual_read_upstream_ok_total %d\n", snap.UpstreamOK)

	p("# HELP dual_read_upstream_errors_total Failed upstream fetches.\n")
	p("# TYPE dual_read_upstream_errors_total counter\n")
	p("dual_read_upstream_errors_total %d\n", snap.UpstreamErrors)

	p("# HELP dual_read_auth_failures_total Auth failures (401/403).\n")
	p("# TYPE dual_read_auth_failures_total counter\n")
	p("dual_read_auth_failures_total %d\n", snap.AuthFailures)

	p("# HELP dual_read_rate_limited_total Rate / concurrency rejections (429).\n")
	p("# TYPE dual_read_rate_limited_total counter\n")
	p("dual_read_rate_limited_total %d\n", snap.RateLimited)

	p("# HELP dual_read_valkey_up Whether Valkey is reachable (1) when required.\n")
	p("# TYPE dual_read_valkey_up gauge\n")
	up := 0
	if snap.ValkeyUp {
		up = 1
	}
	p("dual_read_valkey_up %d\n", up)

	p("# HELP dual_read_requests_by_status_total Requests by HTTP status.\n")
	p("# TYPE dual_read_requests_by_status_total counter\n")
	for code, n := range snap.StatusCounts {
		p("dual_read_requests_by_status_total{status=%q} %d\n", code, n)
	}

	p("# HELP dual_read_request_duration_seconds Request latency histogram.\n")
	p("# TYPE dual_read_request_duration_seconds histogram\n")
	var cumulative int64
	for i, bound := range latencyBounds {
		cumulative += c.latencyBuckets[i].Load()
		p("dual_read_request_duration_seconds_bucket{le=\"%g\"} %d\n", bound, cumulative)
	}
	cumulative += c.latencyBuckets[len(latencyBounds)].Load()
	p("dual_read_request_duration_seconds_bucket{le=\"+Inf\"} %d\n", cumulative)
	p("dual_read_request_duration_seconds_sum %g\n", float64(c.latencySum.Load())/float64(time.Second))
	p("dual_read_request_duration_seconds_count %d\n", snap.Requests)

	return nil
}

// MarshalJSON for convenience.
func (c *Collector) MarshalJSON() ([]byte, error) {
	return json.Marshal(c.Snapshot())
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
