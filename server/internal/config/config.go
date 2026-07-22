package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// Config holds the full server configuration.
type Config struct {
	Server   ServerConfig   `toml:"server"`
	Upstream UpstreamConfig `toml:"upstream"`
	Auth     AuthConfig     `toml:"auth"`
	Models   ModelsConfig   `toml:"models"`
	Admin    AdminConfig    `toml:"admin"`
	Cache    CacheConfig    `toml:"cache"`
	Log      LogConfig      `toml:"log"`
	Limits   LimitsConfig   `toml:"limits"`
	Metrics  MetricsConfig  `toml:"metrics"`
}

// ServerConfig describes the HTTP server binding and timeouts.
type ServerConfig struct {
	Host         string `toml:"host" json:"host"`
	Port         int    `toml:"port" json:"port"`
	ReadTimeout  string `toml:"read_timeout" json:"read_timeout"`
	WriteTimeout string `toml:"write_timeout" json:"write_timeout"`
	IdleTimeout  string `toml:"idle_timeout" json:"idle_timeout"`
}

// UpstreamConfig describes the default OpenAI-compatible upstream.
type UpstreamConfig struct {
	BaseURL            string            `toml:"base_url" json:"base_url"`
	APIKey             string            `toml:"api_key" json:"api_key"`
	Timeout            string            `toml:"timeout" json:"timeout"`
	PassthroughHeaders []string          `toml:"passthrough_headers" json:"passthrough_headers"`
	ExtraHeaders       map[string]string `toml:"extra_headers" json:"extra_headers"`
}

// AuthConfig controls server-issued API keys.
type AuthConfig struct {
	Enabled bool      `toml:"enabled" json:"enabled"`
	Keys    []AuthKey `toml:"keys" json:"keys"`
}

// AuthKey is a client-facing credential with optional upstream overrides.
type AuthKey struct {
	Name            string            `toml:"name" json:"name"`
	Key             string            `toml:"key" json:"key"` // plaintext only when issuing; empty at rest
	KeyHMAC         string            `toml:"-" json:"key_hmac,omitempty"`
	KeyHint         string            `toml:"-" json:"key_hint,omitempty"`
	UpstreamAPIKey  string            `toml:"upstream_api_key" json:"upstream_api_key"`
	UpstreamBaseURL string            `toml:"upstream_base_url" json:"upstream_base_url"`
	DefaultModel    string            `toml:"default_model" json:"default_model"`
	Models          map[string]string `toml:"models" json:"models"`
}

// ModelsConfig maps client model names to upstream model ids.
type ModelsConfig struct {
	Default string            `toml:"default" json:"default"`
	Map     map[string]string `toml:"map" json:"map"`
}

// AdminConfig controls the embedded monitor UI.
type AdminConfig struct {
	Enabled   bool   `toml:"enabled" json:"enabled"`
	Path      string `toml:"path" json:"path"`
	Token     string `toml:"token" json:"token"` // plaintext transient
	TokenHMAC string `toml:"-" json:"token_hmac,omitempty"`
}

// LimitsConfig controls API rate and concurrency gates.
type LimitsConfig struct {
	Enabled              bool `toml:"enabled" json:"enabled"`
	PerIPPerMinute       int  `toml:"per_ip_per_minute" json:"per_ip_per_minute"`
	PerClientPerMinute   int  `toml:"per_client_per_minute" json:"per_client_per_minute"`
	MaxInFlightPerClient int  `toml:"max_inflight_per_client" json:"max_inflight_per_client"`
	MaxInFlightUpstream  int  `toml:"max_inflight_upstream" json:"max_inflight_upstream"`
	// TrustedProxies lists proxy CIDRs (e.g. ["172.16.0.0/12"] for a Docker
	// reverse proxy) whose X-Forwarded-For / X-Real-IP headers are believed
	// for per-IP limiting. Empty = trust RemoteAddr only.
	TrustedProxies []string `toml:"trusted_proxies" json:"trusted_proxies,omitempty"`
}

// MetricsConfig controls the Prometheus /metrics endpoint (bootstrap / immutable).
type MetricsConfig struct {
	Enabled bool   `toml:"enabled" json:"enabled"`
	Path    string `toml:"path" json:"path"`
	Token   string `toml:"token" json:"token"` // optional bearer / X-Metrics-Token
}

// CacheConfig groups local and Valkey cache settings.
type CacheConfig struct {
	Local  LocalCacheConfig  `toml:"local" json:"local"`
	Valkey ValkeyCacheConfig `toml:"valkey" json:"valkey"`
}

// LocalCacheConfig describes the in-memory BigCache layer.
type LocalCacheConfig struct {
	Enabled bool   `toml:"enabled" json:"enabled"`
	TTL     string `toml:"ttl" json:"ttl"`
	MaxMB   int    `toml:"max_mb" json:"max_mb"`
}

// ValkeyCacheConfig describes the shared Valkey/Redis cache.
type ValkeyCacheConfig struct {
	Enabled   bool   `toml:"enabled" json:"enabled"`
	Addr      string `toml:"addr" json:"addr"`
	Password  string `toml:"password" json:"password"`
	DB        int    `toml:"db" json:"db"`
	KeyPrefix string `toml:"key_prefix" json:"key_prefix"`
	TTL       string `toml:"ttl" json:"ttl"`
}

// LogConfig describes logging settings.
type LogConfig struct {
	Level string `toml:"level" json:"level"`
}

// Duration helpers for string fields.
func (c *Config) ServerReadTimeout() time.Duration {
	return mustDuration(c.Server.ReadTimeout, 30*time.Second)
}
func (c *Config) ServerWriteTimeout() time.Duration {
	return mustDuration(c.Server.WriteTimeout, 120*time.Second)
}
func (c *Config) ServerIdleTimeout() time.Duration {
	return mustDuration(c.Server.IdleTimeout, 120*time.Second)
}
func (c *Config) UpstreamTimeout() time.Duration {
	return mustDuration(c.Upstream.Timeout, 60*time.Second)
}
func (c *Config) LocalTTL() time.Duration  { return mustDuration(c.Cache.Local.TTL, 10*time.Minute) }
func (c *Config) ValkeyTTL() time.Duration { return mustDuration(c.Cache.Valkey.TTL, 24*time.Hour) }

// Load reads TOML when path is set, then applies environment overrides.
func Load(path string) (*Config, error) {
	cfg := defaultConfig()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read config file %q: %w", path, err)
		}
		expanded := os.ExpandEnv(string(data))
		if err := toml.Unmarshal([]byte(expanded), cfg); err != nil {
			return nil, fmt.Errorf("parse config file %q: %w", path, err)
		}
	}

	cfg.applyEnv()
	cfg.normalize()

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return cfg, nil
}

func defaultConfig() *Config {
	return &Config{
		Server: ServerConfig{
			Host:         "127.0.0.1",
			Port:         8080,
			ReadTimeout:  "30s",
			WriteTimeout: "120s",
			IdleTimeout:  "120s",
		},
		Upstream: UpstreamConfig{
			BaseURL: "https://api.deepseek.com",
			Timeout: "60s",
			PassthroughHeaders: []string{
				"X-Request-Id",
				"OpenAI-Organization",
				"OpenAI-Project",
			},
			ExtraHeaders: map[string]string{},
		},
		Auth: AuthConfig{Enabled: false},
		Models: ModelsConfig{
			Default: "deepseek-v4-flash",
			Map:     map[string]string{},
		},
		Admin: AdminConfig{
			Enabled: true,
			Path:    "/admin",
		},
		Limits: LimitsConfig{
			Enabled:              false, // enabled automatically on public bind in server.New
			PerIPPerMinute:       60,
			PerClientPerMinute:   120,
			MaxInFlightPerClient: 6,
			MaxInFlightUpstream:  16,
		},
		Metrics: MetricsConfig{
			Enabled: true,
			Path:    "/metrics",
		},
		Cache: CacheConfig{
			Local: LocalCacheConfig{
				Enabled: true,
				TTL:     "10m",
				MaxMB:   256,
			},
			Valkey: ValkeyCacheConfig{
				Enabled:   false,
				Addr:      "127.0.0.1:6379",
				DB:        0,
				KeyPrefix: "dual_read:",
				TTL:       "24h",
			},
		},
		Log: LogConfig{Level: "info"},
	}
}

func (c *Config) applyEnv() {
	if v := os.Getenv("OPENAI_API_KEY"); v != "" {
		c.Upstream.APIKey = v
	}
	if v := os.Getenv("OPENAI_BASE_URL"); v != "" {
		c.Upstream.BaseURL = v
	}
	if v := os.Getenv("DUAL_READ_HOST"); v != "" {
		c.Server.Host = v
	}
	if v := os.Getenv("DUAL_READ_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil {
			c.Server.Port = port
		}
	}
	if v := os.Getenv("DUAL_READ_CACHE_LOCAL"); v != "" {
		c.Cache.Local.Enabled = parseBool(v)
	}
	if v := os.Getenv("DUAL_READ_CACHE_VALKEY"); v != "" {
		c.Cache.Valkey.Enabled = parseBool(v)
	}
	if v := os.Getenv("DUAL_READ_VALKEY_ADDR"); v != "" {
		c.Cache.Valkey.Addr = v
	}
	if v := os.Getenv("DUAL_READ_VALKEY_PASSWORD"); v != "" {
		c.Cache.Valkey.Password = v
	}
	if v := os.Getenv("DUAL_READ_LOG_LEVEL"); v != "" {
		c.Log.Level = v
	}
	if v := os.Getenv("DUAL_READ_ADMIN_TOKEN"); v != "" {
		c.Admin.Token = v
	}
	if v := os.Getenv("DUAL_READ_AUTH_ENABLED"); v != "" {
		c.Auth.Enabled = parseBool(v)
	}
	if v := os.Getenv("DUAL_READ_METRICS_ENABLED"); v != "" {
		c.Metrics.Enabled = parseBool(v)
	}
	if v := os.Getenv("DUAL_READ_METRICS_TOKEN"); v != "" {
		c.Metrics.Token = v
	}
	if v := os.Getenv("DUAL_READ_METRICS_PATH"); v != "" {
		c.Metrics.Path = v
	}
	if v := os.Getenv("DUAL_READ_LIMITS_TRUSTED_PROXIES"); v != "" {
		var proxies []string
		for _, cidr := range strings.Split(v, ",") {
			if cidr = strings.TrimSpace(cidr); cidr != "" {
				proxies = append(proxies, cidr)
			}
		}
		c.Limits.TrustedProxies = proxies
	}
}

func (c *Config) normalize() {
	c.Server.Host = strings.TrimSpace(c.Server.Host)
	c.Upstream.BaseURL = strings.TrimRight(strings.TrimSpace(c.Upstream.BaseURL), "/")
	c.Upstream.APIKey = strings.TrimSpace(c.Upstream.APIKey)
	c.Admin.Path = strings.TrimSpace(c.Admin.Path)
	if c.Admin.Path == "" {
		c.Admin.Path = "/admin"
	}
	if !strings.HasPrefix(c.Admin.Path, "/") {
		c.Admin.Path = "/" + c.Admin.Path
	}
	c.Admin.Path = strings.TrimRight(c.Admin.Path, "/")
	if c.Admin.Path == "" {
		c.Admin.Path = "/admin"
	}

	c.Metrics.Path = strings.TrimSpace(c.Metrics.Path)
	if c.Metrics.Path == "" {
		c.Metrics.Path = "/metrics"
	}
	if !strings.HasPrefix(c.Metrics.Path, "/") {
		c.Metrics.Path = "/" + c.Metrics.Path
	}
	c.Metrics.Token = strings.TrimSpace(c.Metrics.Token)

	if c.Models.Map == nil {
		c.Models.Map = map[string]string{}
	}
	for i := range c.Auth.Keys {
		c.Auth.Keys[i].Name = strings.TrimSpace(c.Auth.Keys[i].Name)
		c.Auth.Keys[i].Key = strings.TrimSpace(c.Auth.Keys[i].Key)
		if c.Auth.Keys[i].Name == "" {
			c.Auth.Keys[i].Name = fmt.Sprintf("key-%d", i+1)
		}
		if c.Auth.Keys[i].Models == nil {
			c.Auth.Keys[i].Models = map[string]string{}
		}
	}

	if c.Cache.Local.MaxMB <= 0 {
		c.Cache.Local.MaxMB = 256
	}
	if c.Cache.Valkey.KeyPrefix == "" {
		c.Cache.Valkey.KeyPrefix = "dual_read:"
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
}

func parseBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func mustDuration(raw string, fallback time.Duration) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

// Validate checks required fields.
func (c *Config) Validate() error {
	if c.Server.Port <= 0 || c.Server.Port > 65535 {
		return fmt.Errorf("invalid server.port: %d", c.Server.Port)
	}
	if _, err := parsePositiveDuration("server.read_timeout", c.Server.ReadTimeout, "30s"); err != nil {
		return err
	}
	writeTimeout, err := parsePositiveDuration("server.write_timeout", c.Server.WriteTimeout, "120s")
	if err != nil {
		return err
	}
	if _, err := parsePositiveDuration("server.idle_timeout", c.Server.IdleTimeout, "120s"); err != nil {
		return err
	}
	upstreamTimeout, err := parsePositiveDuration("upstream.timeout", c.Upstream.Timeout, "60s")
	if err != nil {
		return err
	}
	if writeTimeout <= upstreamTimeout {
		return fmt.Errorf(
			"server.write_timeout (%s) must be greater than upstream.timeout (%s)",
			writeTimeout, upstreamTimeout)
	}
	if _, err := parsePositiveDuration("cache.local.ttl", c.Cache.Local.TTL, "10m"); err != nil {
		return err
	}
	if _, err := parsePositiveDuration("cache.valkey.ttl", c.Cache.Valkey.TTL, "24h"); err != nil {
		return err
	}
	if c.Upstream.BaseURL == "" {
		return fmt.Errorf("upstream.base_url is required")
	}
	if err := validateUpstreamURL(c.Upstream.BaseURL); err != nil {
		return fmt.Errorf("upstream.base_url: %w", err)
	}
	if c.Upstream.APIKey == "" && !c.hasKeyWithUpstreamAPIKey() {
		return fmt.Errorf("upstream.api_key is required (set OPENAI_API_KEY or config upstream.api_key)")
	}
	if c.Auth.Enabled {
		if len(c.Auth.Keys) == 0 {
			return fmt.Errorf("auth.enabled=true requires at least one [[auth.keys]] entry")
		}
		seen := map[string]struct{}{}
		for _, k := range c.Auth.Keys {
			cred := strings.TrimSpace(k.KeyHMAC)
			if cred == "" {
				cred = strings.TrimSpace(k.Key)
			}
			if cred == "" {
				return fmt.Errorf("auth key %q has empty key", k.Name)
			}
			if _, ok := seen[cred]; ok {
				return fmt.Errorf("duplicate auth key value for %q", k.Name)
			}
			seen[cred] = struct{}{}
			if c.Upstream.APIKey == "" && strings.TrimSpace(k.UpstreamAPIKey) == "" {
				return fmt.Errorf("auth key %q needs upstream_api_key when upstream.api_key is empty", k.Name)
			}
			if base := strings.TrimSpace(k.UpstreamBaseURL); base != "" {
				if err := validateUpstreamURL(base); err != nil {
					return fmt.Errorf("auth key %q upstream_base_url: %w", k.Name, err)
				}
			}
		}
	}
	return nil
}

func parsePositiveDuration(name, raw, fallback string) (time.Duration, error) {
	d, err := time.ParseDuration(orDefault(raw, fallback))
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", name, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("invalid %s: must be greater than zero", name)
	}
	return d, nil
}

func (c *Config) hasKeyWithUpstreamAPIKey() bool {
	for _, k := range c.Auth.Keys {
		if strings.TrimSpace(k.UpstreamAPIKey) != "" {
			return true
		}
	}
	return false
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

// PublicListen reports whether the bind address is likely reachable beyond localhost.
func (c *Config) PublicListen() bool {
	host := strings.ToLower(c.Server.Host)
	return host == "0.0.0.0" || host == "::" || host == "[::]" || host == ""
}
