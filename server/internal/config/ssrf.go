package config

import "github.com/skys-mission/dual-read/server/internal/ssrf"

// validateUpstreamURL guards against SSRF via admin/runtime-configurable
// upstream endpoints. Dial-time checks live in package ssrf.
func validateUpstreamURL(raw string) error {
	return ssrf.ValidateURL(raw)
}
