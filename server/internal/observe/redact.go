package observe

import (
	"strings"
	"unicode"
)

// Stable error categories safe for logs / Admin recent.
const (
	ErrUnauthorized      = "unauthorized"
	ErrRateLimited       = "rate_limited"
	ErrUpstreamError     = "upstream_error"
	ErrUpstreamBusy      = "inflight_upstream"
	ErrClientCanceled    = "client_canceled"
	ErrInvalidRequest    = "invalid_request"
	ErrMethodNotAllowed  = "method_not_allowed"
	ErrPayloadTooLarge   = "payload_too_large"
	ErrStreamUnsupported = "stream_unsupported"
	ErrBadRequest        = "bad_request"
	ErrInternal          = "internal_error"
)

var knownCodes = map[string]struct{}{
	ErrUnauthorized:      {},
	ErrRateLimited:       {},
	"rate_ip":            {},
	"rate_client":        {},
	"inflight_client":    {},
	ErrUpstreamBusy:      {},
	ErrUpstreamError:     {},
	ErrClientCanceled:    {},
	ErrInvalidRequest:    {},
	ErrMethodNotAllowed:  {},
	ErrPayloadTooLarge:   {},
	ErrStreamUnsupported: {},
	ErrBadRequest:        {},
	ErrInternal:          {},
}

// RedactError collapses arbitrary error text to a stable, non-secret category.
// Never returns prompt/body/Authorization content.
func RedactError(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if _, ok := knownCodes[raw]; ok {
		return raw
	}
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "unauthorized"), strings.Contains(lower, "invalid or missing api key"):
		return ErrUnauthorized
	case strings.Contains(lower, "rate limit"), strings.Contains(lower, "too many"):
		return ErrRateLimited
	case strings.Contains(lower, "concurrency"), strings.Contains(lower, "inflight"):
		return ErrUpstreamBusy
	case strings.Contains(lower, "canceled"), strings.Contains(lower, "cancelled"), strings.Contains(lower, "context deadline"):
		return ErrClientCanceled
	case strings.Contains(lower, "upstream"):
		return ErrUpstreamError
	case looksSecretive(raw):
		return ErrInternal
	case len(raw) > 64 || strings.Contains(raw, "{") || strings.Contains(raw, "Bearer "):
		return ErrInternal
	default:
		// Short opaque tokens only (already category-like).
		if isCategoryLike(raw) {
			return raw
		}
		return ErrInternal
	}
}

func looksSecretive(s string) bool {
	lower := strings.ToLower(s)
	for _, needle := range []string{
		"authorization", "api_key", "apikey", "password", "token",
		"sk-", "dr-", "bearer ", "prompt", "messages",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func isCategoryLike(s string) bool {
	if len(s) > 48 {
		return false
	}
	for _, r := range s {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' {
			return false
		}
	}
	return true
}
