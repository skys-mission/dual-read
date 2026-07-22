package observe

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"unicode"
)

type ctxKey int

const (
	requestIDKey    ctxKey = iota
	HeaderRequestID        = "X-Request-Id"
	maxRequestIDLen        = 128
)

// FromContext returns the request id, if any.
func FromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	v, _ := ctx.Value(requestIDKey).(string)
	return v
}

// WithRequestID stores the id on the context.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// ValidRequestID reports whether a client-supplied id is safe to accept.
func ValidRequestID(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > maxRequestIDLen {
		return false
	}
	for _, r := range id {
		if r > unicode.MaxASCII || unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// NewRequestID generates a high-entropy request id.
func NewRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "dr-" + hex.EncodeToString([]byte("fallback-request-id"))[:32]
	}
	return "dr-" + hex.EncodeToString(b[:])
}

// ResolveRequestID returns a client id when valid, otherwise a new one.
func ResolveRequestID(incoming string) string {
	if ValidRequestID(incoming) {
		return strings.TrimSpace(incoming)
	}
	return NewRequestID()
}

// Middleware injects X-Request-Id into context and response headers.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := ResolveRequestID(r.Header.Get(HeaderRequestID))
		w.Header().Set(HeaderRequestID, id)
		ctx := WithRequestID(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
