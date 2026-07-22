package runtime

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/skys-mission/dual-read/server/internal/auth"
	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/limit"
	"github.com/skys-mission/dual-read/server/internal/models"
	"github.com/skys-mission/dual-read/server/internal/upstream"
)

// ErrUpstreamBusy is returned when global upstream concurrency is exhausted.
var ErrUpstreamBusy = errors.New("upstream concurrency limit exceeded")

// Snapshot holds hot-reloadable runtime dependencies.
type Snapshot struct {
	mu sync.RWMutex

	auth             *auth.Registry
	models           *models.Resolver
	client           *upstream.Client
	adminTokenHMAC   string
	pepper           []byte
	limiter          *limit.Limiter
	configGeneration int64
	upstreamTimeout  time.Duration
}

// NewSnapshot builds dependencies from an effective config + pepper + generation.
func NewSnapshot(cfg *config.Config, pepper []byte, generation int64) *Snapshot {
	s := &Snapshot{}
	s.Reload(cfg, pepper, generation)
	return s
}

// Reload replaces hot-reloadable components from cfg.
func (s *Snapshot) Reload(cfg *config.Config, pepper []byte, generation int64) {
	if s == nil || cfg == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(pepper) > 0 {
		s.pepper = append([]byte(nil), pepper...)
	}
	s.auth = auth.NewRegistry(cfg.Auth, s.pepper)
	s.models = models.NewResolver(cfg.Models)
	s.upstreamTimeout = cfg.UpstreamTimeout()
	s.client = upstream.NewClient(
		cfg.Upstream.BaseURL,
		cfg.Upstream.APIKey,
		s.upstreamTimeout,
		cfg.Upstream.PassthroughHeaders,
		cfg.Upstream.ExtraHeaders,
	)
	s.adminTokenHMAC = cfg.Admin.TokenHMAC
	if s.adminTokenHMAC == "" && cfg.Admin.Token != "" && len(s.pepper) > 0 {
		s.adminTokenHMAC = auth.HashTokenHex(s.pepper, cfg.Admin.Token)
	}
	if generation > 0 {
		s.configGeneration = generation
	} else if s.configGeneration == 0 {
		s.configGeneration = 1
	}
	limCfg := limit.Config{
		Enabled:              cfg.Limits.Enabled,
		PerIPPerMinute:       cfg.Limits.PerIPPerMinute,
		PerClientPerMinute:   cfg.Limits.PerClientPerMinute,
		MaxInFlightPerClient: cfg.Limits.MaxInFlightPerClient,
		MaxInFlightUpstream:  cfg.Limits.MaxInFlightUpstream,
		TrustedProxies:       cfg.Limits.TrustedProxies,
	}
	s.limiter = limit.New(limCfg)
}

// ConfigGeneration returns the cache generation (runtime revision).
func (s *Snapshot) ConfigGeneration() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.configGeneration <= 0 {
		return 1
	}
	return s.configGeneration
}

// UpstreamTimeout returns the configured upstream request timeout.
func (s *Snapshot) UpstreamTimeout() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.upstreamTimeout <= 0 {
		return 60 * time.Second
	}
	return s.upstreamTimeout
}

// CacheKeyInput builds cache key material for a chat request.
func (s *Snapshot) CacheKeyInput(forwardBody []byte, id *auth.Identity, incoming http.Header, opts upstream.ChatOptions) cache.KeyInput {
	s.mu.RLock()
	defer s.mu.RUnlock()
	in := cache.KeyInput{
		Body:             forwardBody,
		ProviderID:       cache.ProviderID,
		AuthScope:        "anonymous",
		ConfigGeneration: s.configGeneration,
	}
	if in.ConfigGeneration <= 0 {
		in.ConfigGeneration = 1
	}
	if id != nil {
		in.AuthScope = id.Name
	}
	if s.client != nil {
		in.ResolvedBaseURL = s.client.ResolveBaseURL(opts)
		in.UpstreamSecretFP = cache.SecretFingerprint(s.client.ResolveAPIKey(opts))
		in.ExtraHeadersFP = s.client.ExtraHeadersFingerprint()
		in.PassthroughConfigFP = s.client.PassthroughAllowlistFingerprint()
		in.PassthroughValuesFP = s.client.PassthroughFingerprint(incoming)
	} else {
		in.ResolvedBaseURL = strings.TrimRight(opts.BaseURL, "/")
		in.UpstreamSecretFP = cache.SecretFingerprint(opts.APIKey)
	}
	return in
}

// VerifyAdmin checks a presented admin token against the stored HMAC.
func (s *Snapshot) VerifyAdmin(presented string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return auth.VerifyAdminToken(s.pepper, s.adminTokenHMAC, presented)
}

// AdminTokenConfigured reports whether an admin token HMAC is present.
func (s *Snapshot) AdminTokenConfigured() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.adminTokenHMAC != ""
}

// Limiter returns the request limiter (may be disabled).
func (s *Snapshot) Limiter() *limit.Limiter {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.limiter
}

// Authenticate delegates to the auth registry.
func (s *Snapshot) Authenticate(authorization string) (*auth.Identity, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.auth == nil {
		return &auth.Identity{Name: "anonymous", KeyHint: "anon"}, true
	}
	return s.auth.Authenticate(authorization)
}

// AuthEnabled reports whether auth is required.
func (s *Snapshot) AuthEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.auth == nil {
		return false
	}
	return s.auth.Enabled()
}

// AuthSummaries returns key metadata for admin.
func (s *Snapshot) AuthSummaries() []auth.KeySummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.auth == nil {
		return nil
	}
	return s.auth.Summaries()
}

// ResolveModel maps client model names.
func (s *Snapshot) ResolveModel(requested string, id *auth.Identity) (upstreamModel, clientModel string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.models == nil {
		return requested, requested
	}
	return s.models.Resolve(requested, id)
}

// DefaultModel returns configured default model.
func (s *Snapshot) DefaultModel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.models == nil {
		return ""
	}
	return s.models.Default()
}

// GlobalModelMap returns global model mappings.
func (s *Snapshot) GlobalModelMap() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.models == nil {
		return map[string]string{}
	}
	return s.models.GlobalMap()
}

// BaseURL returns upstream base URL.
func (s *Snapshot) BaseURL() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.client == nil {
		return ""
	}
	return s.client.BaseURL()
}

// PassthroughFingerprint returns forwarded header fingerprint for cache keys.
func (s *Snapshot) PassthroughFingerprint(incoming http.Header) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.client == nil {
		return ""
	}
	return s.client.PassthroughFingerprint(incoming)
}

// ChatCompletion forwards a chat request to upstream under the global concurrency gate.
func (s *Snapshot) ChatCompletion(ctx context.Context, body []byte, incoming http.Header, opts upstream.ChatOptions) ([]byte, error) {
	s.mu.RLock()
	client := s.client
	limiter := s.limiter
	s.mu.RUnlock()
	if client == nil {
		return nil, context.Canceled
	}
	if limiter != nil && limiter.Enabled() {
		d := limiter.AcquireUpstream()
		if !d.Allowed {
			return nil, ErrUpstreamBusy
		}
		defer limiter.ReleaseUpstream()
	}
	return client.ChatCompletion(ctx, body, incoming, opts)
}

// UpstreamBusyRetryAfter returns a suggested Retry-After when busy (1s default).
func UpstreamBusyRetryAfter() time.Duration { return time.Second }
