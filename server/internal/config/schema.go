package config

// Runtime schema versions. Detected v1 installs must migrate explicitly —
// the server never silently upgrades on serve.
const (
	RuntimeSchemaV1 = 1 // implicit legacy (no schema_version field)
	RuntimeSchemaV2 = 2
)

// SupportedRuntimeSchema is the only version Open() accepts.
const SupportedRuntimeSchema = RuntimeSchemaV2

// ApplyPolicy classifies how a runtime field change takes effect.
type ApplyPolicy string

const (
	PolicyHot             ApplyPolicy = "hot"
	PolicyRestartRequired ApplyPolicy = "restart-required"
	PolicyImmutable       ApplyPolicy = "immutable"
)

// FieldSpec documents apply policy for a runtime / bootstrap path.
type FieldSpec struct {
	Path   string
	Policy ApplyPolicy
}

// RuntimeFieldRegistry is the authoritative apply-policy table for runtime config.
var RuntimeFieldRegistry = []FieldSpec{
	{Path: "llm.base_url", Policy: PolicyHot},
	{Path: "llm.timeout", Policy: PolicyHot},
	{Path: "llm.api_key", Policy: PolicyHot}, // stored in secrets.json, hot for Effective()
	{Path: "clients", Policy: PolicyHot},
	{Path: "models", Policy: PolicyHot},
	{Path: "log.level", Policy: PolicyHot},
	{Path: "admin.token", Policy: PolicyHot},
	{Path: "limits.enabled", Policy: PolicyHot},
	{Path: "limits.per_ip_per_minute", Policy: PolicyHot},
	{Path: "limits.per_client_per_minute", Policy: PolicyHot},
	{Path: "limits.max_inflight_per_client", Policy: PolicyHot},
	{Path: "limits.max_inflight_upstream", Policy: PolicyHot},
	{Path: "cache.local.enabled", Policy: PolicyRestartRequired},
	{Path: "cache.local.max_mb", Policy: PolicyRestartRequired},
	{Path: "cache.local.ttl", Policy: PolicyRestartRequired},
	{Path: "cache.valkey.enabled", Policy: PolicyHot},
	{Path: "cache.valkey.addr", Policy: PolicyHot},
	{Path: "cache.valkey.password", Policy: PolicyHot},
	{Path: "cache.valkey.db", Policy: PolicyHot},
	{Path: "cache.valkey.key_prefix", Policy: PolicyHot},
	{Path: "cache.valkey.ttl", Policy: PolicyHot},
	{Path: "server.host", Policy: PolicyImmutable},
	{Path: "server.port", Policy: PolicyImmutable},
	{Path: "admin.path", Policy: PolicyImmutable},
	{Path: "admin.enabled", Policy: PolicyImmutable},
	{Path: "metrics.enabled", Policy: PolicyImmutable},
	{Path: "metrics.path", Policy: PolicyImmutable},
	{Path: "metrics.token", Policy: PolicyImmutable},
}

// RestartRequiredPaths returns paths that need a process restart when changed.
func RestartRequiredPaths() []string {
	out := make([]string, 0, 8)
	for _, f := range RuntimeFieldRegistry {
		if f.Policy == PolicyRestartRequired {
			out = append(out, f.Path)
		}
	}
	return out
}
