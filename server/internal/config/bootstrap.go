package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// BootstrapFile is the only content meant for bootstrap TOML (listen + admin shell).
// Legacy full-config TOML is still parsed for one-time runtime seeding.
type BootstrapFile struct {
	Server   ServerConfig    `toml:"server"`
	Admin    AdminConfig     `toml:"admin"`
	Upstream *UpstreamConfig `toml:"upstream"`
	Auth     *AuthConfig     `toml:"auth"`
	Models   *ModelsConfig   `toml:"models"`
	Cache    *CacheConfig    `toml:"cache"`
	Log      *LogConfig      `toml:"log"`
	Limits   *LimitsConfig   `toml:"limits"`
	Metrics  *MetricsConfig  `toml:"metrics"`
}

func loadBootstrapFile(path string) (*BootstrapFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read bootstrap config %q: %w", path, err)
	}
	bs := &BootstrapFile{}
	expanded := os.ExpandEnv(string(data))
	if err := toml.Unmarshal([]byte(expanded), bs); err != nil {
		return nil, fmt.Errorf("parse bootstrap config %q: %w", path, err)
	}
	normalizeBootstrap(bs)
	return bs, nil
}

func normalizeBootstrap(bs *BootstrapFile) {
	if bs == nil {
		return
	}
	def := defaultConfig()
	if bs.Server.Host == "" {
		bs.Server.Host = def.Server.Host
	}
	if bs.Server.Port == 0 {
		bs.Server.Port = def.Server.Port
	}
	if bs.Server.ReadTimeout == "" {
		bs.Server.ReadTimeout = def.Server.ReadTimeout
	}
	if bs.Server.WriteTimeout == "" {
		bs.Server.WriteTimeout = def.Server.WriteTimeout
	}
	if bs.Server.IdleTimeout == "" {
		bs.Server.IdleTimeout = def.Server.IdleTimeout
	}
	if bs.Admin.Path == "" {
		bs.Admin.Path = def.Admin.Path
	}
	if !strings.HasPrefix(bs.Admin.Path, "/") {
		bs.Admin.Path = "/" + bs.Admin.Path
	}
	bs.Admin.Path = strings.TrimRight(bs.Admin.Path, "/")
	if bs.Admin.Path == "" {
		bs.Admin.Path = "/admin"
	}
}

func (bs *BootstrapFile) seedRuntime(base *RuntimeConfig) *RuntimeConfig {
	if base == nil {
		base = defaultRuntime()
	}
	if bs == nil {
		return base
	}
	if bs.Upstream != nil {
		base.LLM = *bs.Upstream
	}
	if bs.Auth != nil {
		base.Clients = clientsFromAuth(*bs.Auth)
	}
	if bs.Models != nil {
		base.Models = *bs.Models
	}
	if bs.Cache != nil {
		base.Cache = *bs.Cache
	}
	if bs.Log != nil {
		base.Log = *bs.Log
	}
	if bs.Limits != nil {
		base.Limits = *bs.Limits
	}
	if bs.Admin.Token != "" {
		base.Admin.Token = bs.Admin.Token
	}
	return base
}

func (bs *BootstrapFile) adminEnabled() bool {
	if bs == nil {
		return defaultConfig().Admin.Enabled
	}
	return bs.Admin.Enabled
}

func (bs *BootstrapFile) adminPath() string {
	if bs == nil {
		return defaultConfig().Admin.Path
	}
	return bs.Admin.Path
}
