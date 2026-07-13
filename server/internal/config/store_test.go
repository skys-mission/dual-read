package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/skys-mission/dual-read/server/internal/tokenmac"
)

func TestOpenSeedsRuntimeJSON(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")

	_ = os.Setenv("OPENAI_API_KEY", "seed-key")
	defer os.Unsetenv("OPENAI_API_KEY")

	store, err := Open(OpenOptions{DataDir: dataDir})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}

	runtimePath := filepath.Join(dataDir, "runtime.json")
	if _, err := os.Stat(runtimePath); err != nil {
		t.Fatalf("expected seeded runtime file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "secrets.json")); err != nil {
		t.Fatalf("expected seeded secrets file: %v", err)
	}

	raw, err := os.ReadFile(runtimePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "seed-key") || strings.Contains(string(raw), `"api_key": "`) {
		// defaultRuntime may have empty api_key field; ensure no env key leaked.
		if strings.Contains(string(raw), "seed-key") {
			t.Fatalf("runtime.json must not contain env api key: %s", raw)
		}
	}

	cfg, err := store.Effective()
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if cfg.Upstream.APIKey != "seed-key" {
		t.Fatalf("expected env api key, got %q", cfg.Upstream.APIKey)
	}
	snap := store.RuntimeSnapshot()
	if snap.SchemaVersion != SupportedRuntimeSchema || snap.Revision < 1 {
		t.Fatalf("expected v2 schema/revision, got %+v", snap)
	}
}

func TestUpdateRuntimeKeepsSecrets(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")

	_ = os.Setenv("OPENAI_API_KEY", "real-upstream-key")
	defer os.Unsetenv("OPENAI_API_KEY")

	store, err := Open(OpenOptions{DataDir: dataDir})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	rev := store.RuntimeSnapshot().Revision
	raw := []byte(`{
  "revision": ` + itoa64(rev) + `,
  "llm": {
    "base_url": "https://api.example.com",
    "api_key": "__KEEP__",
    "timeout": "60s",
    "passthrough_headers": [],
    "extra_headers": {}
  },
  "clients": { "enabled": false, "items": [] },
  "models": { "default": "deepseek-v4-flash", "map": { "flash": "deepseek-v4-flash" } },
  "cache": {
    "local": { "enabled": true, "ttl": "10m", "max_mb": 256 },
    "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "password": "", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" }
  },
  "log": { "level": "info" },
  "admin": { "token": "" }
}`)

	out, result, err := store.UpdateRuntime(raw)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !result.Applied || result.Revision != rev+1 {
		t.Fatalf("expected applied revision bump, got %+v", result)
	}
	if out.Revision != rev+1 {
		t.Fatalf("expected out revision %d, got %d", rev+1, out.Revision)
	}

	cfg, err := store.Effective()
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if cfg.Upstream.BaseURL != "https://api.example.com" {
		t.Fatalf("expected updated base url, got %q", cfg.Upstream.BaseURL)
	}
	if cfg.Upstream.APIKey != "real-upstream-key" {
		t.Fatalf("expected kept api key from env, got %q", cfg.Upstream.APIKey)
	}

	disk, _ := os.ReadFile(filepath.Join(dataDir, "runtime.json"))
	if strings.Contains(string(disk), "real-upstream-key") {
		t.Fatal("runtime.json must not embed upstream key")
	}
}

func TestUpdateRuntimeRevisionConflict(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	_ = os.Setenv("OPENAI_API_KEY", "k")
	defer os.Unsetenv("OPENAI_API_KEY")

	store, err := Open(OpenOptions{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{
  "revision": 999,
  "llm": { "base_url": "https://api.example.com", "api_key": "__KEEP__", "timeout": "60s" },
  "clients": { "enabled": false, "items": [] },
  "models": { "default": "m", "map": {} },
  "cache": { "local": { "enabled": true, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" }
}`)
	_, _, err = store.UpdateRuntime(raw)
	if !IsRevisionConflict(err) {
		t.Fatalf("expected revision conflict, got %v", err)
	}
}

func TestOpenImportsBootstrapIntoRuntime(t *testing.T) {
	dir := t.TempDir()
	bootstrap := filepath.Join(dir, "bootstrap.toml")
	dataDir := filepath.Join(dir, "data")

	content := `
[upstream]
base_url = "https://api.example.com"
api_key = "bootstrap-key"

[models]
default = "model-a"
[models.map]
flash = "model-a"

[auth]
enabled = true
[[auth.keys]]
name = "alice"
key = "dr-alice"
`
	if err := os.WriteFile(bootstrap, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	store, err := Open(OpenOptions{
		BootstrapPath: bootstrap,
		DataDir:       dataDir,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	cfg, err := store.Effective()
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if cfg.Models.Map["flash"] != "model-a" {
		t.Fatalf("expected imported model map, got %+v", cfg.Models.Map)
	}
	if !cfg.Auth.Enabled || len(cfg.Auth.Keys) != 1 || cfg.Auth.Keys[0].Name != "alice" {
		t.Fatalf("expected imported client keys, got %+v", cfg.Auth)
	}
	if cfg.Upstream.APIKey != "bootstrap-key" {
		t.Fatalf("expected bootstrap key in memory, got %q", cfg.Upstream.APIKey)
	}
	disk, _ := os.ReadFile(filepath.Join(dataDir, "runtime.json"))
	if strings.Contains(string(disk), "bootstrap-key") || strings.Contains(string(disk), "dr-alice") {
		t.Fatalf("secrets leaked into runtime.json: %s", disk)
	}
	sec, _ := os.ReadFile(filepath.Join(dataDir, "secrets.json"))
	if !strings.Contains(string(sec), "bootstrap-key") {
		t.Fatalf("expected secrets.json to hold bootstrap key: %s", sec)
	}
}

func TestOpenFailsOnV1Runtime(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{
  "upstream": { "base_url": "https://legacy.example.com", "api_key": "k", "timeout": "60s" },
  "auth": { "enabled": true, "keys": [{ "name": "bob", "key": "dr-bob" }] },
  "models": { "default": "m", "map": {} },
  "cache": { "local": { "enabled": true, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" }
}`)
	if err := os.WriteFile(filepath.Join(dataDir, "runtime.json"), legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Open(OpenOptions{DataDir: dataDir})
	if !IsSchemaV1(err) {
		t.Fatalf("expected schema v1 error, got %v", err)
	}
}

func TestMigrateV1ToV2(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := []byte(`{
  "llm": { "base_url": "https://legacy.example.com", "api_key": "secret-key", "timeout": "60s" },
  "clients": { "enabled": true, "items": [{ "name": "bob", "key": "dr-bob" }] },
  "models": { "default": "m", "map": {} },
  "cache": { "local": { "enabled": true, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "admin-tok" }
}`)
	rtPath := filepath.Join(dataDir, "runtime.json")
	if err := os.WriteFile(rtPath, legacy, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := MigrateV1ToV2(MigrateOptions{DataDir: dataDir})
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if res.Revision < 1 {
		t.Fatalf("expected revision, got %+v", res)
	}
	if _, err := os.Stat(rtPath + ".v1.bak"); err != nil {
		t.Fatalf("expected backup: %v", err)
	}

	store, err := Open(OpenOptions{DataDir: dataDir})
	if err != nil {
		t.Fatalf("open after migrate: %v", err)
	}
	cfg, err := store.Effective()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Upstream.BaseURL != "https://legacy.example.com" {
		t.Fatal("base url lost")
	}
	if cfg.Upstream.APIKey != "secret-key" {
		t.Fatalf("api key not restored from secrets.json: %q", cfg.Upstream.APIKey)
	}
	if len(cfg.Auth.Keys) != 1 || cfg.Auth.Keys[0].Name != "bob" || cfg.Auth.Keys[0].KeyHMAC == "" {
		t.Fatalf("client key HMAC not restored: %+v", cfg.Auth)
	}
	if cfg.Auth.Keys[0].Key != "" {
		t.Fatalf("client plaintext key must not remain after migrate: %q", cfg.Auth.Keys[0].Key)
	}
	if cfg.Admin.Token != "" {
		t.Fatalf("admin plaintext must not remain: %q", cfg.Admin.Token)
	}
	if cfg.Admin.TokenHMAC == "" {
		t.Fatal("admin token HMAC missing")
	}
	// Auth digests must still match the original plaintext.
	want := tokenmac.HashTokenHex(store.Pepper(), "dr-bob")
	if cfg.Auth.Keys[0].KeyHMAC != want {
		t.Fatalf("HMAC mismatch: got %s want %s", cfg.Auth.Keys[0].KeyHMAC, want)
	}
	adminWant := tokenmac.HashTokenHex(store.Pepper(), "admin-tok")
	if cfg.Admin.TokenHMAC != adminWant {
		t.Fatalf("admin HMAC mismatch: got %s want %s", cfg.Admin.TokenHMAC, adminWant)
	}
	disk, _ := os.ReadFile(rtPath)
	if strings.Contains(string(disk), "secret-key") || strings.Contains(string(disk), "dr-bob") {
		t.Fatalf("secrets still in runtime.json: %s", disk)
	}
}

func TestCheckDataDirReportsV1(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	_ = os.MkdirAll(dataDir, 0o755)
	_ = os.WriteFile(filepath.Join(dataDir, "runtime.json"), []byte(`{"llm":{"base_url":"x"}}`), 0o600)
	res, err := CheckDataDir(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK || res.SchemaVersion != RuntimeSchemaV1 {
		t.Fatalf("expected v1 failure, got %+v", res)
	}
}

func TestUnmarshalRuntimeJSON(t *testing.T) {
	raw := []byte(`{
  "schema_version": 2,
  "revision": 3,
  "llm": { "base_url": "https://api.example.com", "api_key": "", "timeout": "60s" },
  "clients": { "enabled": true, "items": [{ "name": "alice", "key": "" }] },
  "models": { "default": "m", "map": {} },
  "cache": { "local": { "enabled": false, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" }
}`)
	var rt RuntimeConfig
	if err := json.Unmarshal(raw, &rt); err != nil {
		t.Fatal(err)
	}
	if rt.SchemaVersion != 2 || rt.Revision != 3 {
		t.Fatalf("unexpected schema/revision: %+v", rt)
	}
	if len(rt.Clients.Items) != 1 {
		t.Fatalf("expected 1 client, got %+v", rt.Clients)
	}
}

func TestMultiClientSharesLLM(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")

	_ = os.Setenv("OPENAI_API_KEY", "bootstrap-key")
	store, err := Open(OpenOptions{DataDir: dataDir})
	_ = os.Unsetenv("OPENAI_API_KEY")
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	rev := store.RuntimeSnapshot().Revision
	raw := []byte(`{
  "revision": ` + itoa64(rev) + `,
  "llm": { "base_url": "https://api.example.com", "api_key": "shared-llm-key", "timeout": "60s" },
  "clients": {
    "enabled": true,
    "items": [
      { "name": "alice", "key": "dr-alice" },
      { "name": "bob", "key": "dr-bob" }
    ]
  },
  "models": { "default": "flash-model", "map": {} },
  "cache": { "local": { "enabled": false, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" }
}`)
	if _, _, err := store.UpdateRuntime(raw); err != nil {
		t.Fatalf("update: %v", err)
	}
	cfg, err := store.Effective()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Auth.Keys) != 2 {
		t.Fatalf("expected 2 client keys, got %d", len(cfg.Auth.Keys))
	}
	if cfg.Auth.Keys[0].UpstreamAPIKey != "" || cfg.Auth.Keys[1].UpstreamAPIKey != "" {
		t.Fatal("client keys should not carry upstream keys by default")
	}
	if cfg.Upstream.APIKey != "shared-llm-key" {
		t.Fatalf("expected shared llm key, got %q", cfg.Upstream.APIKey)
	}
	disk, _ := os.ReadFile(filepath.Join(dataDir, "runtime.json"))
	if strings.Contains(string(disk), "shared-llm-key") || strings.Contains(string(disk), "dr-alice") {
		t.Fatalf("secrets in runtime.json: %s", disk)
	}
}

func itoa64(v int64) string {
	return strings.TrimSpace(strings.ReplaceAll(jsonNumber(v), "\n", ""))
}

func jsonNumber(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// Regression: an Admin-UI-shaped save (full echo of the view) must not wipe
// limits or per-client advanced fields, and the view must expose them.
func TestUpdateRuntimeUIShapePreservesLimitsAndClientAdvancedFields(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	_ = os.Setenv("OPENAI_API_KEY", "real-upstream-key")
	defer os.Unsetenv("OPENAI_API_KEY")

	store, err := Open(OpenOptions{DataDir: dataDir})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	rev := store.RuntimeSnapshot().Revision
	seed := []byte(`{
  "revision": ` + itoa64(rev) + `,
  "llm": { "base_url": "https://api.example.com", "api_key": "__KEEP__", "timeout": "60s" },
  "clients": { "enabled": true, "items": [
    { "name": "alice", "key": "dr-alice-key", "default_model": "mA",
      "models": { "a": "b" }, "upstream_base_url": "https://other.example.com",
      "upstream_api_key": "uk-1" }
  ] },
  "models": { "default": "deepseek-v4-flash", "map": {} },
  "cache": { "local": { "enabled": true, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" },
  "limits": { "enabled": true, "per_ip_per_minute": 7, "per_client_per_minute": 8, "max_inflight_per_client": 9, "max_inflight_upstream": 10 }
}`)
	if _, _, err := store.UpdateRuntime(seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	rev2 := store.RuntimeSnapshot().Revision
	uiPayload := []byte(`{
  "schema_version": 2,
  "revision": ` + itoa64(rev2) + `,
  "llm": { "base_url": "https://api.example.com", "api_key": "__KEEP__", "timeout": "60s", "passthrough_headers": [], "extra_headers": {} },
  "clients": { "enabled": true, "items": [
    { "name": "alice", "key": "__KEEP__", "default_model": "mA",
      "models": { "a": "b" }, "upstream_base_url": "https://other.example.com",
      "upstream_api_key": "__KEEP__" }
  ] },
  "models": { "default": "deepseek-v4-flash", "map": {} },
  "cache": { "local": { "enabled": true, "ttl": "10m", "max_mb": 256 }, "valkey": { "enabled": false, "addr": "127.0.0.1:6379", "password": "", "db": 0, "key_prefix": "dual_read:", "ttl": "24h" } },
  "log": { "level": "info" },
  "admin": { "token": "" },
  "limits": { "enabled": true, "per_ip_per_minute": 7, "per_client_per_minute": 8, "max_inflight_per_client": 9, "max_inflight_upstream": 10 }
}`)
	if _, _, err := store.UpdateRuntime(uiPayload); err != nil {
		t.Fatalf("ui save: %v", err)
	}

	snap := store.RuntimeSnapshot()
	if !snap.Limits.Enabled || snap.Limits.PerIPPerMinute != 7 || snap.Limits.MaxInFlightUpstream != 10 {
		t.Fatalf("limits lost after UI save: %+v", snap.Limits)
	}
	if len(snap.Clients.Items) != 1 {
		t.Fatalf("clients lost: %+v", snap.Clients)
	}
	c := snap.Clients.Items[0]
	if c.DefaultModel != "mA" || c.Models["a"] != "b" || c.UpstreamBaseURL != "https://other.example.com" || c.UpstreamAPIKey != "uk-1" {
		t.Fatalf("client advanced fields lost: %+v", c)
	}

	v, err := store.View("")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if !v.Runtime.Limits.Enabled || v.Runtime.Limits.PerIPPerMinute != 7 {
		t.Fatalf("view missing limits: %+v", v.Runtime.Limits)
	}
	got := v.Runtime.Clients.Items[0]
	if got.UpstreamBaseURL != "https://other.example.com" || !got.UpstreamAPIKeySet {
		t.Fatalf("view missing client upstream fields: %+v", got)
	}
	if got.KeyHint != tokenmac.Hint("dr-alice-key") {
		t.Fatalf("view key hint=%q, want %q", got.KeyHint, tokenmac.Hint("dr-alice-key"))
	}
}

// Regression: [limits] / [metrics] bootstrap sections were silently dropped.
func TestBootstrapLimitsAndMetricsAreHonored(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	bootstrap := filepath.Join(dir, "config.toml")
	content := `
[server]
host = "127.0.0.1"
port = 18080

[admin]
enabled = true
path = "/admin"

[limits]
enabled = true
per_ip_per_minute = 42
trusted_proxies = ["172.16.0.0/12"]

[metrics]
enabled = true
path = "/metrics"
token = "secret-token"
`
	if err := os.WriteFile(bootstrap, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Setenv("OPENAI_API_KEY", "k")
	defer os.Unsetenv("OPENAI_API_KEY")

	store, err := Open(OpenOptions{BootstrapPath: bootstrap, DataDir: dataDir})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cfg, err := store.Effective()
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if !cfg.Limits.Enabled || cfg.Limits.PerIPPerMinute != 42 {
		t.Fatalf("bootstrap limits ignored: %+v", cfg.Limits)
	}
	if len(cfg.Limits.TrustedProxies) != 1 || cfg.Limits.TrustedProxies[0] != "172.16.0.0/12" {
		t.Fatalf("trusted proxies ignored: %+v", cfg.Limits.TrustedProxies)
	}
	if !cfg.Metrics.Enabled || cfg.Metrics.Token != "secret-token" {
		t.Fatalf("bootstrap metrics ignored: %+v", cfg.Metrics)
	}
}
