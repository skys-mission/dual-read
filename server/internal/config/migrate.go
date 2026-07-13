package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrSchemaV1 indicates runtime.json must be migrated before serve.
var ErrSchemaV1 = errors.New("runtime config schema v1 detected")

// ErrRevisionConflict indicates optimistic concurrency failure on UpdateRuntime.
var ErrRevisionConflict = errors.New("runtime revision conflict")

// SchemaError wraps a schema problem with an operator hint.
type SchemaError struct {
	DataDir string
	Cause   error
}

func (e *SchemaError) Error() string {
	hint := fmt.Sprintf(
		"Migrate: dual-read-server config migrate --from v1 --data-dir %s",
		e.DataDir,
	)
	if e.Cause == nil {
		return hint
	}
	return fmt.Sprintf("%v\n%s", e.Cause, hint)
}

func (e *SchemaError) Unwrap() error { return e.Cause }

// DetectRuntimeSchema peeks at runtime.json without full load.
// Returns RuntimeSchemaV1 when the file is missing schema_version or is legacy-shaped.
func DetectRuntimeSchema(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	var head struct {
		SchemaVersion int             `json:"schema_version"`
		Upstream      json.RawMessage `json:"upstream"`
		Auth          json.RawMessage `json:"auth"`
		LLM           json.RawMessage `json:"llm"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return 0, fmt.Errorf("parse runtime header: %w", err)
	}
	if head.SchemaVersion >= SupportedRuntimeSchema {
		return head.SchemaVersion, nil
	}
	if head.SchemaVersion == RuntimeSchemaV1 {
		return RuntimeSchemaV1, nil
	}
	// No schema_version: treat as v1 (legacy llm/clients or upstream/auth).
	if head.SchemaVersion == 0 {
		return RuntimeSchemaV1, nil
	}
	return head.SchemaVersion, nil
}

// CheckResult summarizes config check findings (no secret values).
type CheckResult struct {
	OK                bool     `json:"ok"`
	SchemaVersion     int      `json:"schema_version"`
	Revision          int64    `json:"revision,omitempty"`
	SecretsPath       string   `json:"secrets_path,omitempty"`
	SecretsPresent    bool     `json:"secrets_present"`
	RuntimeHasSecrets bool     `json:"runtime_embeds_secrets"`
	Issues            []string `json:"issues,omitempty"`
}

// CheckDataDir inspects a data directory without starting the server.
func CheckDataDir(dataDir string) (*CheckResult, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		dataDir = "data"
	}
	rtPath := filepath.Join(dataDir, "runtime.json")
	secPath := secretsPath(dataDir)
	res := &CheckResult{SecretsPath: secPath}

	if _, err := os.Stat(rtPath); os.IsNotExist(err) {
		res.OK = true
		res.SchemaVersion = SupportedRuntimeSchema
		res.Issues = append(res.Issues, "runtime.json missing (will be seeded on first serve)")
		return res, nil
	} else if err != nil {
		return nil, err
	}

	ver, err := DetectRuntimeSchema(rtPath)
	if err != nil {
		return nil, err
	}
	res.SchemaVersion = ver

	if ver < SupportedRuntimeSchema {
		res.OK = false
		res.Issues = append(res.Issues,
			fmt.Sprintf("schema_version=%d (need %d); run config migrate --from v1", ver, SupportedRuntimeSchema),
		)
		return res, nil
	}
	if ver > SupportedRuntimeSchema {
		res.OK = false
		res.Issues = append(res.Issues, fmt.Sprintf("unsupported schema_version=%d", ver))
		return res, nil
	}

	rt, err := loadRuntimeFileRaw(rtPath)
	if err != nil {
		return nil, err
	}
	res.Revision = rt.Revision
	res.RuntimeHasSecrets = runtimeContainsSecrets(rt)
	if res.RuntimeHasSecrets {
		res.OK = false
		res.Issues = append(res.Issues, "runtime.json still embeds secrets; re-run migrate or serve will refuse")
	}

	if _, err := os.Stat(secPath); err == nil {
		res.SecretsPresent = true
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	if len(res.Issues) == 0 {
		res.OK = true
	}
	return res, nil
}

// MigrateOptions controls v1 → v2 migration.
type MigrateOptions struct {
	DataDir string
	DryRun  bool
}

// MigrateResult summarizes a migration.
type MigrateResult struct {
	BackupPath  string `json:"backup_path"`
	RuntimePath string `json:"runtime_path"`
	SecretsPath string `json:"secrets_path"`
	Revision    int64  `json:"revision"`
	DryRun      bool   `json:"dry_run"`
	Message     string `json:"message"`
}

// MigrateV1ToV2 extracts secrets from a v1 runtime overlay into secrets.json
// and writes a v2 runtime.json without secret material.
func MigrateV1ToV2(opts MigrateOptions) (*MigrateResult, error) {
	dataDir := strings.TrimSpace(opts.DataDir)
	if dataDir == "" {
		dataDir = "data"
	}
	rtPath := filepath.Join(dataDir, "runtime.json")
	secPath := secretsPath(dataDir)
	backup := rtPath + ".v1.bak"

	if _, err := os.Stat(rtPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("no runtime.json at %s", rtPath)
	} else if err != nil {
		return nil, err
	}

	ver, err := DetectRuntimeSchema(rtPath)
	if err != nil {
		return nil, err
	}
	if ver >= SupportedRuntimeSchema {
		// Allow re-run to strip residual secrets from a half-migrated v2 file.
		rt, err := loadRuntimeFileRaw(rtPath)
		if err != nil {
			return nil, err
		}
		if !runtimeContainsSecrets(rt) {
			return &MigrateResult{
				RuntimePath: rtPath,
				SecretsPath: secPath,
				Revision:    rt.Revision,
				DryRun:      opts.DryRun,
				Message:     "already schema v2 with secrets separated; nothing to do",
			}, nil
		}
	}

	rt, err := loadRuntimeFileLegacy(rtPath)
	if err != nil {
		return nil, err
	}
	sec := extractSecretsFromRuntime(rt)
	existing, _ := loadSecretsFile(secPath)
	sec = mergeSecretsPreferIncoming(existing, sec)

	stripped := stripSecretsForDisk(rt)
	stripped.SchemaVersion = SupportedRuntimeSchema
	if stripped.Revision <= 0 {
		stripped.Revision = 1
	}
	normalizeRuntime(stripped)

	result := &MigrateResult{
		BackupPath:  backup,
		RuntimePath: rtPath,
		SecretsPath: secPath,
		Revision:    stripped.Revision,
		DryRun:      opts.DryRun,
		Message:     "migrated runtime to schema v2; secrets written to secrets.json",
	}
	if opts.DryRun {
		result.Message = "dry-run: would migrate runtime to schema v2 and write secrets.json"
		return result, nil
	}

	data, err := os.ReadFile(rtPath)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(backup, data, 0o600); err != nil {
		return nil, fmt.Errorf("write backup: %w", err)
	}
	if err := saveSecretsFile(secPath, sec); err != nil {
		return nil, err
	}
	if err := saveRuntimeFile(rtPath, stripped); err != nil {
		return nil, err
	}
	return result, nil
}

func mergeSecretsPreferIncoming(base, incoming *SecretsFile) *SecretsFile {
	out := defaultSecrets()
	if base != nil {
		*out = *base
	}
	if incoming == nil {
		return out
	}
	if incoming.LLMAPIKey != "" {
		out.LLMAPIKey = incoming.LLMAPIKey
	}
	if incoming.AdminToken != "" {
		out.AdminToken = incoming.AdminToken
	}
	if incoming.ValkeyPassword != "" {
		out.ValkeyPassword = incoming.ValkeyPassword
	}
	if len(incoming.Clients) > 0 {
		out.Clients = append([]ClientSecret{}, incoming.Clients...)
	}
	out.SchemaVersion = SupportedRuntimeSchema
	return out
}
