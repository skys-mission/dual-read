package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAndExpandEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	_ = os.Setenv("TEST_DUAL_READ_KEY", "secret-key")
	defer os.Unsetenv("TEST_DUAL_READ_KEY")

	content := `
[server]
port = 9090

[upstream]
base_url = "https://api.example.com"
api_key = "${TEST_DUAL_READ_KEY}"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Server.Port != 9090 {
		t.Fatalf("expected port 9090, got %d", cfg.Server.Port)
	}
	if cfg.Upstream.APIKey != "secret-key" {
		t.Fatalf("expected expanded api key, got %q", cfg.Upstream.APIKey)
	}
}

func TestLoadFromEnvOnly(t *testing.T) {
	_ = os.Setenv("OPENAI_API_KEY", "env-key")
	defer os.Unsetenv("OPENAI_API_KEY")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Upstream.APIKey != "env-key" {
		t.Fatalf("expected env api key, got %q", cfg.Upstream.APIKey)
	}
	if !cfg.Admin.Enabled {
		t.Fatal("expected admin enabled by default")
	}
}

func TestValidateInvalidPort(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	content := `
[server]
port = 99999

[upstream]
base_url = "https://api.example.com"
api_key = "test-key"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for invalid port")
	}
}

func TestValidateRejectsInvalidTimeouts(t *testing.T) {
	cfg := defaultConfig()
	cfg.Upstream.APIKey = "test-key"
	cfg.Server.WriteTimeout = "not-a-duration"
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected invalid server.write_timeout to fail validation")
	}

	cfg = defaultConfig()
	cfg.Upstream.APIKey = "test-key"
	cfg.Cache.Local.TTL = "-1s"
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected non-positive cache.local.ttl to fail validation")
	}
}

func TestValidateRequiresWriteTimeoutBeyondUpstream(t *testing.T) {
	cfg := defaultConfig()
	cfg.Upstream.APIKey = "test-key"
	cfg.Server.WriteTimeout = "30s"
	cfg.Upstream.Timeout = "60s"
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected conflicting write/upstream timeouts to fail validation")
	}

	cfg.Server.WriteTimeout = "61s"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected ordered timeouts to validate: %v", err)
	}
}

func TestValidateMissingAPIKey(t *testing.T) {
	_ = os.Unsetenv("OPENAI_API_KEY")
	_, err := Load("")
	if err == nil {
		t.Fatal("expected error for missing api key")
	}
}

func TestAuthRequiresKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	content := `
[upstream]
base_url = "https://api.example.com"
api_key = "test-key"

[auth]
enabled = true
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error when auth enabled without keys")
	}
}

func TestAuthKeysAndModelMapTOML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	content := `
[upstream]
base_url = "https://api.example.com"
api_key = "test-key"

[auth]
enabled = true

[[auth.keys]]
name = "alice"
key = "sk-alice"
models = { flash = "deepseek-v4-flash" }

[models]
default = "deepseek-v4-flash"
[models.map]
lite = "deepseek-v4-flash"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Auth.Enabled || len(cfg.Auth.Keys) != 1 {
		t.Fatalf("auth keys: %+v", cfg.Auth)
	}
	if cfg.Auth.Keys[0].Models["flash"] != "deepseek-v4-flash" {
		t.Fatalf("per-key model map: %+v", cfg.Auth.Keys[0].Models)
	}
	if cfg.Models.Map["lite"] != "deepseek-v4-flash" {
		t.Fatalf("global map: %+v", cfg.Models.Map)
	}
}
