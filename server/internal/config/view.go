package config

// ConfigResponse is returned by GET /admin/api/config.
type ConfigResponse struct {
	Runtime   RuntimeView   `json:"runtime"`
	Bootstrap BootstrapView `json:"bootstrap"`
	Meta      StoreMeta     `json:"meta"`
}

// BootstrapView exposes read-only bootstrap fields.
type BootstrapView struct {
	Server ServerConfig `json:"server"`
	Admin  struct {
		Enabled bool   `json:"enabled"`
		Path    string `json:"path"`
	} `json:"admin"`
}

// RuntimeView is the admin-editable runtime config with redacted secrets.
type RuntimeView struct {
	SchemaVersion int          `json:"schema_version"`
	Revision      int64        `json:"revision"`
	LLM           LLMView      `json:"llm"`
	Clients       ClientsView  `json:"clients"`
	Models        ModelsConfig `json:"models"`
	Cache         CacheView    `json:"cache"`
	Log           LogConfig    `json:"log"`
	Admin         AdminView    `json:"admin"`
	Limits        LimitsConfig `json:"limits"`
}

type LLMView struct {
	BaseURL   string `json:"base_url"`
	APIKey    string `json:"api_key"`
	APIKeySet bool   `json:"api_key_set"`
	Timeout   string `json:"timeout"`
}

type ClientsView struct {
	Enabled bool            `json:"enabled"`
	Items   []ClientKeyView `json:"items"`
}

type ClientKeyView struct {
	Name         string            `json:"name"`
	Key          string            `json:"key"`
	KeySet       bool              `json:"key_set"`
	KeyHint      string            `json:"key_hint,omitempty"`
	DefaultModel string            `json:"default_model,omitempty"`
	Models       map[string]string `json:"models,omitempty"`
	// Advanced per-client upstream overrides round-trip through the UI so a
	// save never silently drops them (the secret itself stays server-side).
	UpstreamBaseURL   string `json:"upstream_base_url,omitempty"`
	UpstreamAPIKeySet bool   `json:"upstream_api_key_set,omitempty"`
}

type CacheView struct {
	Local  LocalCacheConfig `json:"local"`
	Valkey ValkeyCacheView  `json:"valkey"`
}

type ValkeyCacheView struct {
	Enabled     bool   `json:"enabled"`
	Addr        string `json:"addr"`
	Password    string `json:"password"`
	PasswordSet bool   `json:"password_set"`
	DB          int    `json:"db"`
	KeyPrefix   string `json:"key_prefix"`
	TTL         string `json:"ttl"`
}

type AdminView struct {
	Token    string `json:"token"`
	TokenSet bool   `json:"token_set"`
}

// View builds the admin config API response.
func (s *Store) View(bootstrapPath string) (*ConfigResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	cfg, err := s.effectiveLocked()
	if err != nil {
		return nil, err
	}

	meta := s.metaLocked()
	meta.BootstrapPath = bootstrapPath

	resp := &ConfigResponse{
		Runtime: runtimeToView(s.runtime, cfg),
		Bootstrap: BootstrapView{
			Server: cfg.Server,
		},
		Meta: meta,
	}
	resp.Bootstrap.Admin.Enabled = cfg.Admin.Enabled
	resp.Bootstrap.Admin.Path = cfg.Admin.Path
	return resp, nil
}

func runtimeToView(rt *RuntimeConfig, effective *Config) RuntimeView {
	if rt == nil {
		rt = defaultRuntime()
	}
	items := make([]ClientKeyView, 0, len(rt.Clients.Items))
	for _, k := range rt.Clients.Items {
		items = append(items, ClientKeyView{
			Name:              k.Name,
			Key:               maskSecret(k.KeyHMAC),
			KeySet:            k.KeyHMAC != "" || k.Key != "",
			KeyHint:           k.KeyHint,
			DefaultModel:      k.DefaultModel,
			Models:            copyStringMap(k.Models),
			UpstreamBaseURL:   k.UpstreamBaseURL,
			UpstreamAPIKeySet: k.UpstreamAPIKey != "",
		})
	}

	llmKeySet := rt.LLM.APIKey != ""
	if effective != nil && effective.Upstream.APIKey != "" {
		llmKeySet = true
	}

	return RuntimeView{
		SchemaVersion: rt.SchemaVersion,
		Revision:      rt.Revision,
		LLM: LLMView{
			BaseURL:   rt.LLM.BaseURL,
			APIKey:    maskSecret(rt.LLM.APIKey),
			APIKeySet: llmKeySet,
			Timeout:   rt.LLM.Timeout,
		},
		Clients: ClientsView{
			Enabled: rt.Clients.Enabled,
			Items:   items,
		},
		Models: rt.Models,
		Cache: CacheView{
			Local: rt.Cache.Local,
			Valkey: ValkeyCacheView{
				Enabled:     rt.Cache.Valkey.Enabled,
				Addr:        rt.Cache.Valkey.Addr,
				Password:    maskSecret(rt.Cache.Valkey.Password),
				PasswordSet: rt.Cache.Valkey.Password != "",
				DB:          rt.Cache.Valkey.DB,
				KeyPrefix:   rt.Cache.Valkey.KeyPrefix,
				TTL:         rt.Cache.Valkey.TTL,
			},
		},
		Log: rt.Log,
		Admin: AdminView{
			Token:    maskSecret(rt.Admin.TokenHMAC),
			TokenSet: rt.Admin.TokenHMAC != "" || rt.Admin.Token != "",
		},
		Limits: rt.Limits,
	}
}

func maskSecret(v string) string {
	if v == "" {
		return ""
	}
	return SecretKeep
}

func copyStringMap(in map[string]string) map[string]string {
	if in == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
