package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// SchemaVersion is the server cache key namespace. Bump to invalidate all entries
// without migrating old values.
const SchemaVersion = "v2"

// ProviderID identifies the upstream protocol family for key isolation.
const ProviderID = "openai-compat"

// KeyInput is the canonical cache key material.
type KeyInput struct {
	Body                []byte
	ProviderID          string
	ResolvedBaseURL     string
	UpstreamSecretFP    string
	ExtraHeadersFP      string
	PassthroughConfigFP string
	PassthroughValuesFP string
	AuthScope           string
	ConfigGeneration    int64
}

// KeyV2 returns a hex sha256 of the v2 cache key fields.
func KeyV2(in KeyInput) string {
	h := sha256.New()
	writePart := func(label, value string) {
		h.Write([]byte(label))
		h.Write([]byte{0x1f})
		h.Write([]byte(value))
		h.Write([]byte{0x1e})
	}
	provider := in.ProviderID
	if provider == "" {
		provider = ProviderID
	}
	writePart("schema", SchemaVersion)
	h.Write([]byte("body"))
	h.Write([]byte{0x1f})
	h.Write(in.Body)
	h.Write([]byte{0x1e})
	writePart("provider", provider)
	writePart("base", in.ResolvedBaseURL)
	writePart("secret_fp", in.UpstreamSecretFP)
	writePart("extra_headers_fp", in.ExtraHeadersFP)
	writePart("passthrough_cfg_fp", in.PassthroughConfigFP)
	writePart("passthrough_val_fp", in.PassthroughValuesFP)
	writePart("auth", in.AuthScope)
	writePart("generation", strconv.FormatInt(in.ConfigGeneration, 10))
	return hex.EncodeToString(h.Sum(nil))
}

// SecretFingerprint returns a stable, non-reversible marker for a secret.
// Empty stays empty so clients sharing the process-default credential share a bucket.
func SecretFingerprint(secret string) string {
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:8])
}
