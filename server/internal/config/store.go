package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/skys-mission/dual-read/server/internal/tokenmac"
)

// OpenOptions configures Store initialization.
type OpenOptions struct {
	BootstrapPath string
	DataDir       string
}

// StoreMeta describes config sources for the admin UI.
type StoreMeta struct {
	BootstrapPath string            `json:"bootstrap_path,omitempty"`
	RuntimePath   string            `json:"runtime_path"`
	SecretsPath   string            `json:"secrets_path"`
	DataDir       string            `json:"data_dir"`
	SchemaVersion int               `json:"schema_version"`
	Revision      int64             `json:"revision"`
	EnvLocked     []string          `json:"env_locked"`
	RestartFields []string          `json:"restart_required_fields"`
	ApplyPolicies map[string]string `json:"apply_policies"`
}

// ApplyResult reports what happened after a runtime update.
type ApplyResult struct {
	Applied       bool     `json:"applied"`
	Revision      int64    `json:"revision"`
	RestartNeeded bool     `json:"restart_needed"`
	RestartFields []string `json:"restart_fields,omitempty"`
	Message       string   `json:"message,omitempty"`
}

// Store merges bootstrap TOML, runtime JSON, secrets.json, and environment overrides.
type Store struct {
	mu sync.RWMutex

	bootstrapPath string
	bootstrap     *BootstrapFile
	runtime       *RuntimeConfig
	runtimePath   string
	secretsPath   string
	dataDir       string
	pepper        []byte
}

// Open loads bootstrap config, runtime JSON, secrets, and returns a validated Store.
// v1 runtime overlays fail fast with a migrate hint.
func Open(opts OpenOptions) (*Store, error) {
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		dataDir = strings.TrimSpace(os.Getenv("DUAL_READ_DATA_DIR"))
	}
	if dataDir == "" {
		dataDir = "data"
	}

	s := &Store{
		dataDir:     dataDir,
		runtimePath: filepath.Join(dataDir, "runtime.json"),
		secretsPath: secretsPath(dataDir),
	}

	pepper, err := tokenmac.LoadOrCreatePepper(dataDir)
	if err != nil {
		return nil, fmt.Errorf("auth pepper: %w", err)
	}
	s.pepper = pepper

	if opts.BootstrapPath != "" {
		bs, err := loadBootstrapFile(opts.BootstrapPath)
		if err != nil {
			return nil, err
		}
		s.bootstrap = bs
		s.bootstrapPath = opts.BootstrapPath
	}

	runtime, seeded, err := s.loadRuntime()
	if err != nil {
		return nil, err
	}
	s.runtime = runtime

	if seeded {
		if err := s.persistLocked(); err != nil {
			return nil, err
		}
	}

	if _, err := s.effectiveLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) loadRuntime() (*RuntimeConfig, bool, error) {
	if _, err := os.Stat(s.runtimePath); err == nil {
		ver, err := DetectRuntimeSchema(s.runtimePath)
		if err != nil {
			return nil, false, err
		}
		if ver < SupportedRuntimeSchema {
			return nil, false, &SchemaError{
				DataDir: s.dataDir,
				Cause:   fmt.Errorf("%w (schema_version=%d)", ErrSchemaV1, ver),
			}
		}
		if ver > SupportedRuntimeSchema {
			return nil, false, fmt.Errorf("unsupported runtime schema_version=%d", ver)
		}
		rt, err := loadRuntimeFileRaw(s.runtimePath)
		if err != nil {
			return nil, false, err
		}
		if runtimeContainsSecrets(rt) {
			return nil, false, &SchemaError{
				DataDir: s.dataDir,
				Cause: fmt.Errorf(
					"%w: runtime.json still embeds secrets (api_key/token/password/key)",
					ErrSchemaV1,
				),
			}
		}
		sec, err := loadSecretsFile(s.secretsPath)
		if err != nil {
			return nil, false, err
		}
		if hashAuthSecrets(s.pepper, sec) || secretsContainPlaintextAuth(sec) {
			_ = hashAuthSecrets(s.pepper, sec)
			if err := saveSecretsFile(s.secretsPath, sec); err != nil {
				return nil, false, err
			}
		}
		applySecretsToRuntime(rt, sec)
		hashRuntimeAuth(s.pepper, rt)
		normalizeRuntime(rt)
		return rt, false, nil
	} else if !os.IsNotExist(err) {
		return nil, false, err
	}

	rt := defaultRuntime()
	if s.bootstrap != nil {
		rt = s.bootstrap.seedRuntime(rt)
	}
	normalizeRuntime(rt)
	return rt, true, nil
}

func (s *Store) persistLocked() error {
	hashRuntimeAuth(s.pepper, s.runtime)
	sec := extractSecretsFromRuntime(s.runtime)
	_ = hashAuthSecrets(s.pepper, sec)
	if err := saveSecretsFile(s.secretsPath, sec); err != nil {
		return err
	}
	return saveRuntimeFile(s.runtimePath, s.runtime)
}

// Pepper returns a copy of the auth pepper (for Snapshot / Registry).
func (s *Store) Pepper() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]byte(nil), s.pepper...)
}

// Effective returns the merged, env-applied configuration.
func (s *Store) Effective() (*Config, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effectiveLocked()
}

func (s *Store) effectiveLocked() (*Config, error) {
	cfg := s.mergeWithoutEnv()
	cfg.applyEnv()
	cfg.normalize()
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return cfg, nil
}

func (s *Store) mergeWithoutEnv() *Config {
	return s.mergeFrom(s.runtime)
}

// mergeFrom builds a config from the store's bootstrap plus the given runtime,
// without touching s.runtime. Callers must hold at least a read lock.
func (s *Store) mergeFrom(rt *RuntimeConfig) *Config {
	cfg := defaultConfig()
	if s.bootstrap != nil {
		cfg.Server = s.bootstrap.Server
		cfg.Admin.Enabled = s.bootstrap.adminEnabled()
		cfg.Admin.Path = s.bootstrap.adminPath()
		if s.bootstrap.Metrics != nil {
			cfg.Metrics = *s.bootstrap.Metrics
		}
	}
	if rt != nil {
		cfg.Upstream = rt.LLM
		cfg.Auth = rt.Clients.toAuthConfig()
		cfg.Models = rt.Models
		cfg.Cache = rt.Cache
		cfg.Log = rt.Log
		cfg.Admin.Token = rt.Admin.Token
		cfg.Admin.TokenHMAC = rt.Admin.TokenHMAC
		cfg.Limits = rt.Limits
	}
	return cfg
}

// Meta returns source metadata for the admin UI.
func (s *Store) Meta() StoreMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.metaLocked()
}

func (s *Store) metaLocked() StoreMeta {
	rev := int64(1)
	if s.runtime != nil {
		rev = s.runtime.Revision
	}
	policies := make(map[string]string, len(RuntimeFieldRegistry))
	for _, f := range RuntimeFieldRegistry {
		policies[f.Path] = string(f.Policy)
	}
	return StoreMeta{
		BootstrapPath: s.bootstrapPath,
		RuntimePath:   s.runtimePath,
		SecretsPath:   s.secretsPath,
		DataDir:       s.dataDir,
		SchemaVersion: SupportedRuntimeSchema,
		Revision:      rev,
		EnvLocked:     envLockedFields(),
		RestartFields: RestartRequiredPaths(),
		ApplyPolicies: policies,
	}
}

// BootstrapPath returns the TOML bootstrap file path, if any.
func (s *Store) BootstrapPath() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bootstrapPath
}

// RuntimePath returns the JSON persistence path.
func (s *Store) RuntimePath() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.runtimePath
}

// SecretsPath returns the secrets.json path.
func (s *Store) SecretsPath() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.secretsPath
}

// RuntimeSnapshot returns a copy of the in-memory runtime config (includes secrets).
func (s *Store) RuntimeSnapshot() RuntimeConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneRuntime(s.runtime)
}

// UpdateRuntime validates, merges secrets, persists overlay + secrets, and returns apply hints.
// When incoming.Revision > 0 it must match the current revision (optimistic concurrency).
func (s *Store) UpdateRuntime(raw []byte) (*RuntimeConfig, ApplyResult, error) {
	var incoming RuntimeConfig
	if err := json.Unmarshal(raw, &incoming); err != nil {
		return nil, ApplyResult{}, fmt.Errorf("parse runtime update: %w", err)
	}
	normalizeRuntime(&incoming)

	s.mu.Lock()
	defer s.mu.Unlock()

	currentRev := int64(1)
	if s.runtime != nil {
		currentRev = s.runtime.Revision
	}
	if incoming.Revision > 0 && incoming.Revision != currentRev {
		return nil, ApplyResult{}, fmt.Errorf(
			"%w: client revision %d, server revision %d",
			ErrRevisionConflict, incoming.Revision, currentRev,
		)
	}

	merged := mergeRuntimeSecrets(s.runtime, &incoming)
	merged.SchemaVersion = SupportedRuntimeSchema
	merged.Revision = currentRev + 1
	normalizeRuntime(merged)

	prev := cloneRuntime(s.runtime)
	s.runtime = merged

	cfg := s.mergeWithoutEnv()
	cfg.applyEnv()
	cfg.normalize()
	if err := cfg.Validate(); err != nil {
		s.runtime = cloneRuntimePtr(&prev)
		return nil, ApplyResult{}, fmt.Errorf("validate config: %w", err)
	}

	if err := s.persistLocked(); err != nil {
		s.runtime = cloneRuntimePtr(&prev)
		return nil, ApplyResult{}, err
	}

	result := ApplyResult{
		Applied:  true,
		Revision: merged.Revision,
		Message:  "已保存。上游 / 用户 Key / 模型映射已生效。",
	}
	if runtimeRestartNeeded(cloneRuntimePtr(&prev), merged) {
		result.RestartNeeded = true
		result.RestartFields = RestartRequiredPaths()
		result.Message = "已保存。缓存相关改动需重启进程后完全生效；其余项已热更新。"
	}

	out := cloneRuntime(s.runtime)
	return &out, result, nil
}

func runtimeRestartNeeded(before, after *RuntimeConfig) bool {
	if before == nil || after == nil {
		return false
	}
	return before.Cache.Local != after.Cache.Local
}

func mergeRuntimeSecrets(current, incoming *RuntimeConfig) *RuntimeConfig {
	out := cloneRuntime(incoming)
	if current == nil {
		return &out
	}

	if isSecretKeep(out.LLM.APIKey) {
		out.LLM.APIKey = current.LLM.APIKey
	}
	if isSecretKeep(out.Admin.Token) {
		out.Admin.Token = current.Admin.Token
		out.Admin.TokenHMAC = current.Admin.TokenHMAC
	}
	if isSecretKeep(out.Cache.Valkey.Password) {
		out.Cache.Valkey.Password = current.Cache.Valkey.Password
	}

	byName := make(map[string]ClientKey, len(current.Clients.Items))
	for _, item := range current.Clients.Items {
		byName[item.Name] = item
	}

	out.Clients.Items = make([]ClientKey, len(incoming.Clients.Items))
	for i := range incoming.Clients.Items {
		out.Clients.Items[i] = incoming.Clients.Items[i]
		if out.Clients.Items[i].Models == nil {
			out.Clients.Items[i].Models = map[string]string{}
		}
		cur, ok := byName[out.Clients.Items[i].Name]
		if isSecretKeep(out.Clients.Items[i].Key) {
			if ok {
				out.Clients.Items[i].Key = ""
				out.Clients.Items[i].KeyHMAC = cur.KeyHMAC
				out.Clients.Items[i].KeyHint = cur.KeyHint
			} else {
				out.Clients.Items[i].Key = ""
			}
		}
		if isSecretKeep(out.Clients.Items[i].UpstreamAPIKey) {
			if ok {
				out.Clients.Items[i].UpstreamAPIKey = cur.UpstreamAPIKey
			} else {
				out.Clients.Items[i].UpstreamAPIKey = ""
			}
		}
	}
	return &out
}

func isSecretKeep(v string) bool {
	return strings.TrimSpace(v) == "" || strings.TrimSpace(v) == SecretKeep
}

func (s *Store) BuildEffectiveFromRuntime(rt *RuntimeConfig) (*Config, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := s.mergeFrom(rt)
	cfg.applyEnv()
	cfg.normalize()
	return cfg, nil
}

func envLockedFields() []string {
	var locked []string
	if os.Getenv("OPENAI_API_KEY") != "" {
		locked = append(locked, "llm.api_key")
	}
	if os.Getenv("OPENAI_BASE_URL") != "" {
		locked = append(locked, "llm.base_url")
	}
	if os.Getenv("DUAL_READ_HOST") != "" {
		locked = append(locked, "server.host")
	}
	if os.Getenv("DUAL_READ_PORT") != "" {
		locked = append(locked, "server.port")
	}
	if os.Getenv("DUAL_READ_CACHE_LOCAL") != "" {
		locked = append(locked, "cache.local.enabled")
	}
	if os.Getenv("DUAL_READ_CACHE_VALKEY") != "" {
		locked = append(locked, "cache.valkey.enabled")
	}
	if os.Getenv("DUAL_READ_VALKEY_ADDR") != "" {
		locked = append(locked, "cache.valkey.addr")
	}
	if os.Getenv("DUAL_READ_VALKEY_PASSWORD") != "" {
		locked = append(locked, "cache.valkey.password")
	}
	if os.Getenv("DUAL_READ_LOG_LEVEL") != "" {
		locked = append(locked, "log.level")
	}
	if os.Getenv("DUAL_READ_ADMIN_TOKEN") != "" {
		locked = append(locked, "admin.token")
	}
	if os.Getenv("DUAL_READ_AUTH_ENABLED") != "" {
		locked = append(locked, "clients.enabled")
	}
	return locked
}

// IsRevisionConflict reports whether err is (or wraps) ErrRevisionConflict.
func IsRevisionConflict(err error) bool {
	return errors.Is(err, ErrRevisionConflict)
}

// IsSchemaV1 reports whether err is (or wraps) ErrSchemaV1 / SchemaError for v1.
func IsSchemaV1(err error) bool {
	if errors.Is(err, ErrSchemaV1) {
		return true
	}
	var se *SchemaError
	return errors.As(err, &se)
}
