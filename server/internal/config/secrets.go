package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/skys-mission/dual-read/server/internal/tokenmac"
)

// SecretsFile holds recoverable secrets + HMAC digests outside runtime overlay JSON.
// Mode 0600 on disk. Never returned by GET /admin/api/config as plaintext.
type SecretsFile struct {
	SchemaVersion  int            `json:"schema_version"`
	LLMAPIKey      string         `json:"llm_api_key,omitempty"`
	AdminToken     string         `json:"admin_token,omitempty"`      // legacy plaintext; cleared after hash
	AdminTokenHMAC string         `json:"admin_token_hmac,omitempty"` // HMAC-SHA256 hex
	ValkeyPassword string         `json:"valkey_password,omitempty"`
	Clients        []ClientSecret `json:"clients,omitempty"`
}

// ClientSecret stores per-client credential material keyed by name.
type ClientSecret struct {
	Name           string `json:"name"`
	Key            string `json:"key,omitempty"`      // legacy plaintext; cleared after hash
	KeyHMAC        string `json:"key_hmac,omitempty"` // HMAC-SHA256 hex
	KeyHint        string `json:"key_hint,omitempty"`
	UpstreamAPIKey string `json:"upstream_api_key,omitempty"` // recoverable upstream override
}

func defaultSecrets() *SecretsFile {
	return &SecretsFile{SchemaVersion: SupportedRuntimeSchema, Clients: []ClientSecret{}}
}

func secretsPath(dataDir string) string {
	return filepath.Join(dataDir, "secrets.json")
}

func loadSecretsFile(path string) (*SecretsFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultSecrets(), nil
		}
		return nil, err
	}
	sec := defaultSecrets()
	if err := json.Unmarshal(data, sec); err != nil {
		return nil, fmt.Errorf("parse secrets file %q: %w", path, err)
	}
	if sec.SchemaVersion == 0 {
		sec.SchemaVersion = SupportedRuntimeSchema
	}
	if sec.Clients == nil {
		sec.Clients = []ClientSecret{}
	}
	return sec, nil
}

func saveSecretsFile(path string, sec *SecretsFile) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create secrets dir: %w", err)
	}
	if sec == nil {
		sec = defaultSecrets()
	}
	if sec.SchemaVersion == 0 {
		sec.SchemaVersion = SupportedRuntimeSchema
	}
	if sec.Clients == nil {
		sec.Clients = []ClientSecret{}
	}
	data, err := json.MarshalIndent(sec, "", "  ")
	if err != nil {
		return fmt.Errorf("encode secrets: %w", err)
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write secrets temp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit secrets: %w", err)
	}
	return nil
}

// extractSecretsFromRuntime copies secret material out of a runtime overlay.
func extractSecretsFromRuntime(rt *RuntimeConfig) *SecretsFile {
	sec := defaultSecrets()
	if rt == nil {
		return sec
	}
	sec.LLMAPIKey = rt.LLM.APIKey
	sec.AdminToken = rt.Admin.Token
	sec.AdminTokenHMAC = rt.Admin.TokenHMAC
	sec.ValkeyPassword = rt.Cache.Valkey.Password
	sec.Clients = make([]ClientSecret, 0, len(rt.Clients.Items))
	for _, item := range rt.Clients.Items {
		sec.Clients = append(sec.Clients, ClientSecret{
			Name:           item.Name,
			Key:            item.Key,
			KeyHMAC:        item.KeyHMAC,
			KeyHint:        item.KeyHint,
			UpstreamAPIKey: item.UpstreamAPIKey,
		})
	}
	return sec
}

// applySecretsToRuntime merges secrets into an in-memory runtime (not for disk).
func applySecretsToRuntime(rt *RuntimeConfig, sec *SecretsFile) {
	if rt == nil || sec == nil {
		return
	}
	if sec.LLMAPIKey != "" {
		rt.LLM.APIKey = sec.LLMAPIKey
	}
	if sec.AdminTokenHMAC != "" {
		rt.Admin.TokenHMAC = sec.AdminTokenHMAC
	}
	if sec.AdminToken != "" {
		rt.Admin.Token = sec.AdminToken
	}
	if sec.ValkeyPassword != "" {
		rt.Cache.Valkey.Password = sec.ValkeyPassword
	}
	byName := make(map[string]ClientSecret, len(sec.Clients))
	for _, c := range sec.Clients {
		byName[c.Name] = c
	}
	for i := range rt.Clients.Items {
		name := rt.Clients.Items[i].Name
		if c, ok := byName[name]; ok {
			if c.KeyHMAC != "" {
				rt.Clients.Items[i].KeyHMAC = c.KeyHMAC
			}
			if c.KeyHint != "" {
				rt.Clients.Items[i].KeyHint = c.KeyHint
			}
			if c.Key != "" {
				rt.Clients.Items[i].Key = c.Key
			}
			if c.UpstreamAPIKey != "" {
				rt.Clients.Items[i].UpstreamAPIKey = c.UpstreamAPIKey
			}
			delete(byName, name)
		}
	}
}

// stripSecretsForDisk returns a deep copy safe to marshal into runtime.json.
func stripSecretsForDisk(rt *RuntimeConfig) *RuntimeConfig {
	out := cloneRuntime(rt)
	out.LLM.APIKey = ""
	out.Admin.Token = ""
	out.Admin.TokenHMAC = ""
	out.Cache.Valkey.Password = ""
	for i := range out.Clients.Items {
		out.Clients.Items[i].Key = ""
		out.Clients.Items[i].KeyHMAC = ""
		out.Clients.Items[i].KeyHint = ""
		out.Clients.Items[i].UpstreamAPIKey = ""
	}
	return &out
}

// runtimeContainsSecrets reports whether an on-disk runtime still embeds secrets.
func runtimeContainsSecrets(rt *RuntimeConfig) bool {
	if rt == nil {
		return false
	}
	if rt.LLM.APIKey != "" || rt.Admin.Token != "" || rt.Admin.TokenHMAC != "" || rt.Cache.Valkey.Password != "" {
		return true
	}
	for _, item := range rt.Clients.Items {
		if item.Key != "" || item.KeyHMAC != "" || item.UpstreamAPIKey != "" {
			return true
		}
	}
	return false
}

// hashAuthSecrets converts any plaintext client/admin tokens into HMAC digests.
// Returns true when the secrets file should be rewritten.
func hashAuthSecrets(pepper []byte, sec *SecretsFile) bool {
	if sec == nil || len(pepper) == 0 {
		return false
	}
	changed := false
	if plain := strings.TrimSpace(sec.AdminToken); plain != "" {
		sec.AdminTokenHMAC = tokenmac.HashTokenHex(pepper, plain)
		sec.AdminToken = ""
		changed = true
	}
	for i := range sec.Clients {
		c := &sec.Clients[i]
		if plain := strings.TrimSpace(c.Key); plain != "" {
			c.KeyHMAC = tokenmac.HashTokenHex(pepper, plain)
			if c.KeyHint == "" {
				c.KeyHint = tokenmac.Hint(plain)
			}
			c.Key = ""
			changed = true
		}
	}
	return changed
}

// hashRuntimeAuth hashes plaintext tokens on the in-memory runtime before persist.
func hashRuntimeAuth(pepper []byte, rt *RuntimeConfig) {
	if rt == nil || len(pepper) == 0 {
		return
	}
	if plain := strings.TrimSpace(rt.Admin.Token); plain != "" {
		rt.Admin.TokenHMAC = tokenmac.HashTokenHex(pepper, plain)
		rt.Admin.Token = ""
	}
	for i := range rt.Clients.Items {
		item := &rt.Clients.Items[i]
		if plain := strings.TrimSpace(item.Key); plain != "" {
			item.KeyHMAC = tokenmac.HashTokenHex(pepper, plain)
			if item.KeyHint == "" {
				item.KeyHint = tokenmac.Hint(plain)
			}
			item.Key = ""
		}
	}
}

// secretsContainPlaintextAuth reports leftover plaintext tokens in secrets.json.
func secretsContainPlaintextAuth(sec *SecretsFile) bool {
	if sec == nil {
		return false
	}
	if strings.TrimSpace(sec.AdminToken) != "" {
		return true
	}
	for _, c := range sec.Clients {
		if strings.TrimSpace(c.Key) != "" {
			return true
		}
	}
	return false
}
