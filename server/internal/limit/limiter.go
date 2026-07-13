package limit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Config controls request rate and in-flight concurrency gates.
type Config struct {
	Enabled              bool
	PerIPPerMinute       int
	PerClientPerMinute   int
	MaxInFlightPerClient int
	MaxInFlightUpstream  int
	// TrustedProxies lists proxy CIDRs whose X-Forwarded-For / X-Real-IP
	// headers may be believed for per-IP limiting (e.g. "172.16.0.0/12"
	// for a Docker reverse proxy). Empty = trust RemoteAddr only.
	TrustedProxies []string
}

// DefaultConfig returns Shared-mode defaults (disabled on loopback by caller).
func DefaultConfig() Config {
	return Config{
		Enabled:              true,
		PerIPPerMinute:       60,
		PerClientPerMinute:   120,
		MaxInFlightPerClient: 6,
		MaxInFlightUpstream:  16,
	}
}

// Decision is the result of a limit check.
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
	Reason     string
}

type bucket struct {
	tokens   float64
	last     time.Time
	capacity float64
	rate     float64 // tokens per second
}

// Bucket maps are bounded: at maxBuckets a new entry first evicts idle
// buckets, and if the map is still full the request fails closed (429)
// instead of growing memory without bound under IP-rotation attacks.
const (
	maxBuckets       = 10_000
	bucketIdleExpiry = 10 * time.Minute
)

type Limiter struct {
	mu  sync.Mutex
	cfg Config

	ip      map[string]*bucket
	client  map[string]*bucket
	clientN map[string]int
	upN     int

	trusted []*net.IPNet
}

// New creates a limiter. Zero quotas fall back to DefaultConfig values when enabled.
func New(cfg Config) *Limiter {
	d := DefaultConfig()
	if cfg.PerIPPerMinute <= 0 {
		cfg.PerIPPerMinute = d.PerIPPerMinute
	}
	if cfg.PerClientPerMinute <= 0 {
		cfg.PerClientPerMinute = d.PerClientPerMinute
	}
	if cfg.MaxInFlightPerClient <= 0 {
		cfg.MaxInFlightPerClient = d.MaxInFlightPerClient
	}
	if cfg.MaxInFlightUpstream <= 0 {
		cfg.MaxInFlightUpstream = d.MaxInFlightUpstream
	}
	var trusted []*net.IPNet
	for _, raw := range cfg.TrustedProxies {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(raw); err == nil {
			trusted = append(trusted, n)
		}
	}
	return &Limiter{
		cfg:     cfg,
		ip:      map[string]*bucket{},
		client:  map[string]*bucket{},
		clientN: map[string]int{},
		trusted: trusted,
	}
}

// Enabled reports whether limiting is active.
func (l *Limiter) Enabled() bool {
	return l != nil && l.cfg.Enabled
}

// AllowIP consumes one IP token. Call before auth.
func (l *Limiter) AllowIP(ip string, now time.Time) Decision {
	if !l.Enabled() {
		return Decision{Allowed: true}
	}
	ip = normalizeIP(ip)
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.ip[ip]
	if b == nil {
		if len(l.ip) >= maxBuckets {
			evictIdle(l.ip, now)
			if len(l.ip) >= maxBuckets {
				// All buckets hot (likely IP-rotation attack): fail closed
				// rather than grow memory without bound.
				return Decision{Allowed: false, RetryAfter: time.Minute, Reason: "rate_ip"}
			}
		}
		b = newBucket(float64(l.cfg.PerIPPerMinute), now)
		l.ip[ip] = b
	}
	if !b.take(now) {
		return Decision{Allowed: false, RetryAfter: b.retryAfter(now), Reason: "rate_ip"}
	}
	return Decision{Allowed: true}
}

// AllowClient consumes one per-client token and acquires an in-flight slot.
func (l *Limiter) AllowClient(name string, now time.Time) Decision {
	if !l.Enabled() {
		return Decision{Allowed: true}
	}
	if name == "" {
		name = "anonymous"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.client[name]
	if b == nil {
		// Evict-only, no fail-closed (unlike AllowIP): AllowClient runs after
		// authentication, so the map is bounded by configured keys — an
		// attacker cannot mint client buckets without valid credentials, and
		// a freshly-seen legitimate client must never be 429'd over map size.
		if len(l.client) >= maxBuckets {
			evictIdle(l.client, now)
		}
		b = newBucket(float64(l.cfg.PerClientPerMinute), now)
		l.client[name] = b
	}
	if !b.take(now) {
		return Decision{Allowed: false, RetryAfter: b.retryAfter(now), Reason: "rate_client"}
	}
	if l.clientN[name] >= l.cfg.MaxInFlightPerClient {
		b.refund()
		return Decision{Allowed: false, RetryAfter: time.Second, Reason: "inflight_client"}
	}
	l.clientN[name]++
	return Decision{Allowed: true}
}

// evictIdle drops buckets unused for bucketIdleExpiry. Caller holds l.mu.
func evictIdle(m map[string]*bucket, now time.Time) {
	for k, b := range m {
		if now.Sub(b.last) > bucketIdleExpiry {
			delete(m, k)
		}
	}
}

// ReleaseClient releases a per-client in-flight slot.
func (l *Limiter) ReleaseClient(name string) {
	if !l.Enabled() {
		return
	}
	if name == "" {
		name = "anonymous"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.clientN[name] > 0 {
		l.clientN[name]--
	}
}

// AcquireUpstream reserves a global upstream in-flight slot.
func (l *Limiter) AcquireUpstream() Decision {
	if !l.Enabled() {
		return Decision{Allowed: true}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.upN >= l.cfg.MaxInFlightUpstream {
		return Decision{Allowed: false, RetryAfter: time.Second, Reason: "inflight_upstream"}
	}
	l.upN++
	return Decision{Allowed: true}
}

// ReleaseUpstream releases a global upstream slot.
func (l *Limiter) ReleaseUpstream() {
	if !l.Enabled() {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.upN > 0 {
		l.upN--
	}
}

func newBucket(perMinute float64, now time.Time) *bucket {
	if perMinute < 1 {
		perMinute = 1
	}
	return &bucket{
		tokens:   perMinute,
		last:     now,
		capacity: perMinute,
		rate:     perMinute / 60.0,
	}
}

func (b *bucket) refill(now time.Time) {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed <= 0 {
		return
	}
	b.tokens += elapsed * b.rate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now
}

func (b *bucket) take(now time.Time) bool {
	b.refill(now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (b *bucket) refund() {
	if b.tokens < b.capacity {
		b.tokens++
	}
}

func (b *bucket) retryAfter(now time.Time) time.Duration {
	b.refill(now)
	need := 1 - b.tokens
	if need <= 0 {
		return time.Second
	}
	sec := need / b.rate
	d := time.Duration(sec * float64(time.Second))
	if d < time.Second {
		d = time.Second
	}
	return d.Round(time.Second)
}

// ClientIP extracts a best-effort client IP (no proxy trust by default).
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		return strings.TrimSpace(r.RemoteAddr)
	}
	return host
}

// ClientIP resolves the client IP, honoring X-Forwarded-For / X-Real-IP only
// when RemoteAddr falls inside a configured trusted-proxy CIDR. Behind a
// reverse proxy without this, every request shares the proxy's bucket.
func (l *Limiter) ClientIP(r *http.Request) string {
	remote := ClientIP(r)
	if l == nil || len(l.trusted) == 0 {
		return remote
	}
	ip := net.ParseIP(remote)
	if ip == nil {
		return remote
	}
	trusted := false
	for _, n := range l.trusted {
		if n.Contains(ip) {
			trusted = true
			break
		}
	}
	if !trusted {
		return remote
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// First hop is the original client as seen by the trusted proxy.
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	return remote
}

func normalizeIP(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "unknown"
	}
	return ip
}
