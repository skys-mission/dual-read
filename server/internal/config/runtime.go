package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SecretKeep is sent by the admin UI to retain an existing secret field.
const SecretKeep = "__KEEP__"

// RuntimeConfig holds UI-managed settings. Secret material is held in memory
// after load/merge, but never written to runtime.json (see secrets.json).
type RuntimeConfig struct {
	SchemaVersion int            `json:"schema_version"`
	Revision      int64          `json:"revision"`
	LLM           UpstreamConfig `json:"llm"`
	Clients       ClientsConfig  `json:"clients"`
	Models        ModelsConfig   `json:"models"`
	Cache         CacheConfig    `json:"cache"`
	Log           LogConfig      `json:"log"`
	Admin         RuntimeAdmin   `json:"admin"`
	Limits        LimitsConfig   `json:"limits"`
}

// ClientsConfig lists client-facing API keys that share one LLM account.
type ClientsConfig struct {
	Enabled bool        `json:"enabled"`
	Items   []ClientKey `json:"items"`
}

// ClientKey is a user/client credential. By default all clients share the global LLM key.
type ClientKey struct {
	Name         string            `json:"name"`
	Key          string            `json:"key"` // plaintext only when issuing
	KeyHMAC      string            `json:"key_hmac,omitempty"`
	KeyHint      string            `json:"key_hint,omitempty"`
	DefaultModel string            `json:"default_model,omitempty"`
	Models       map[string]string `json:"models,omitempty"`
	// Advanced overrides — leave empty to use shared LLM credentials.
	UpstreamAPIKey  string `json:"upstream_api_key,omitempty"`
	UpstreamBaseURL string `json:"upstream_base_url,omitempty"`
}

// RuntimeAdmin holds admin settings managed at runtime.
type RuntimeAdmin struct {
	Token     string `json:"token"`
	TokenHMAC string `json:"token_hmac,omitempty"`
}

func defaultRuntime() *RuntimeConfig {
	base := defaultConfig()
	return &RuntimeConfig{
		SchemaVersion: SupportedRuntimeSchema,
		Revision:      1,
		LLM:           base.Upstream,
		Clients:       ClientsConfig{Enabled: false, Items: []ClientKey{}},
		Models:        base.Models,
		Cache:         base.Cache,
		Log:           base.Log,
		Admin: RuntimeAdmin{
			Token: base.Admin.Token,
		},
		Limits: base.Limits,
	}
}

func (c ClientsConfig) toAuthConfig() AuthConfig {
	keys := make([]AuthKey, 0, len(c.Items))
	for _, item := range c.Items {
		keys = append(keys, AuthKey{
			Name:            item.Name,
			Key:             item.Key,
			KeyHMAC:         item.KeyHMAC,
			KeyHint:         item.KeyHint,
			UpstreamAPIKey:  item.UpstreamAPIKey,
			UpstreamBaseURL: item.UpstreamBaseURL,
			DefaultModel:    item.DefaultModel,
			Models:          item.Models,
		})
	}
	return AuthConfig{Enabled: c.Enabled, Keys: keys}
}

func clientsFromAuth(auth AuthConfig) ClientsConfig {
	items := make([]ClientKey, 0, len(auth.Keys))
	for _, k := range auth.Keys {
		items = append(items, ClientKey{
			Name:            k.Name,
			Key:             k.Key,
			KeyHMAC:         k.KeyHMAC,
			KeyHint:         k.KeyHint,
			DefaultModel:    k.DefaultModel,
			Models:          k.Models,
			UpstreamAPIKey:  k.UpstreamAPIKey,
			UpstreamBaseURL: k.UpstreamBaseURL,
		})
	}
	return ClientsConfig{Enabled: auth.Enabled, Items: items}
}

func normalizeRuntime(rt *RuntimeConfig) {
	if rt == nil {
		return
	}
	if rt.SchemaVersion == 0 {
		rt.SchemaVersion = SupportedRuntimeSchema
	}
	if rt.Revision <= 0 {
		rt.Revision = 1
	}
	if rt.Models.Map == nil {
		rt.Models.Map = map[string]string{}
	}
	for i := range rt.Clients.Items {
		if rt.Clients.Items[i].Models == nil {
			rt.Clients.Items[i].Models = map[string]string{}
		}
		if rt.Clients.Items[i].Name == "" {
			rt.Clients.Items[i].Name = fmt.Sprintf("user-%d", i+1)
		}
	}
	if rt.LLM.ExtraHeaders == nil {
		rt.LLM.ExtraHeaders = map[string]string{}
	}
	if rt.Cache.Local.MaxMB <= 0 {
		rt.Cache.Local.MaxMB = 256
	}
	if rt.Cache.Valkey.KeyPrefix == "" {
		rt.Cache.Valkey.KeyPrefix = "dual_read:"
	}
	if rt.Log.Level == "" {
		rt.Log.Level = "info"
	}
	if len(rt.Clients.Items) > 0 {
		rt.Clients.Enabled = true
	}
}

// unmarshalRuntimeLegacy accepts current (llm/clients) and legacy (upstream/auth) shapes.
// Only used by migration — serve path rejects v1.
func unmarshalRuntimeLegacy(data []byte, rt *RuntimeConfig) error {
	type rawRuntime RuntimeConfig
	aux := struct {
		rawRuntime
		Upstream json.RawMessage `json:"upstream"`
		Auth     json.RawMessage `json:"auth"`
	}{}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*rt = RuntimeConfig(aux.rawRuntime)
	if len(aux.Upstream) > 0 {
		var up UpstreamConfig
		if err := json.Unmarshal(aux.Upstream, &up); err != nil {
			return err
		}
		rt.LLM = up
	}
	if len(aux.Auth) > 0 {
		var auth AuthConfig
		if err := json.Unmarshal(aux.Auth, &auth); err != nil {
			return err
		}
		rt.Clients = clientsFromAuth(auth)
	}
	normalizeRuntime(rt)
	return nil
}

// loadRuntimeFileRaw loads v2 runtime without merging secrets.
func loadRuntimeFileRaw(path string) (*RuntimeConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	rt := defaultRuntime()
	if err := json.Unmarshal(data, rt); err != nil {
		return nil, fmt.Errorf("parse runtime config %q: %w", path, err)
	}
	normalizeRuntime(rt)
	return rt, nil
}

// loadRuntimeFileLegacy parses v1/legacy shapes for migration only.
func loadRuntimeFileLegacy(path string) (*RuntimeConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	rt := defaultRuntime()
	if err := unmarshalRuntimeLegacy(data, rt); err != nil {
		return nil, fmt.Errorf("parse legacy runtime config %q: %w", path, err)
	}
	return rt, nil
}

func saveRuntimeFile(path string, rt *RuntimeConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create runtime dir: %w", err)
	}
	disk := stripSecretsForDisk(rt)
	disk.SchemaVersion = SupportedRuntimeSchema
	normalizeRuntime(disk)
	data, err := json.MarshalIndent(disk, "", "  ")
	if err != nil {
		return fmt.Errorf("encode runtime config: %w", err)
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write runtime temp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit runtime config: %w", err)
	}
	return nil
}

func cloneRuntime(rt *RuntimeConfig) RuntimeConfig {
	if rt == nil {
		return *defaultRuntime()
	}
	data, _ := json.Marshal(rt)
	var out RuntimeConfig
	_ = json.Unmarshal(data, &out)
	return out
}

func cloneRuntimePtr(rt *RuntimeConfig) *RuntimeConfig {
	out := cloneRuntime(rt)
	return &out
}
