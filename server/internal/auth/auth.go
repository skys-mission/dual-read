package auth

import (
	"crypto/subtle"
	"strings"

	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/tokenmac"
)

// Identity is the authenticated server client (no plaintext token).
type Identity struct {
	Name            string
	KeyHint         string
	UpstreamAPIKey  string
	UpstreamBaseURL string
	DefaultModel    string
	Models          map[string]string
}

type credential struct {
	mac [32]byte
	id  *Identity
}

// Registry verifies client-facing API keys via HMAC digests.
type Registry struct {
	enabled bool
	pepper  []byte
	creds   []credential
}

// NewRegistry builds an auth registry from effective config + pepper.
// Each AuthKey must carry KeyHMAC (preferred) or plaintext Key (hashed in-memory).
func NewRegistry(cfg config.AuthConfig, pepper []byte) *Registry {
	r := &Registry{
		enabled: cfg.Enabled,
		pepper:  append([]byte(nil), pepper...),
		creds:   make([]credential, 0, len(cfg.Keys)),
	}
	for i := range cfg.Keys {
		k := cfg.Keys[i]
		mac, ok := resolveMAC(pepper, k)
		if !ok {
			continue
		}
		id := &Identity{
			Name:            k.Name,
			KeyHint:         k.KeyHint,
			UpstreamAPIKey:  strings.TrimSpace(k.UpstreamAPIKey),
			UpstreamBaseURL: strings.TrimRight(strings.TrimSpace(k.UpstreamBaseURL), "/"),
			DefaultModel:    strings.TrimSpace(k.DefaultModel),
			Models:          k.Models,
		}
		if id.KeyHint == "" && k.Key != "" {
			id.KeyHint = tokenmac.Hint(k.Key)
		}
		if id.KeyHint == "" {
			id.KeyHint = "****"
		}
		if id.Models == nil {
			id.Models = map[string]string{}
		}
		r.creds = append(r.creds, credential{mac: mac, id: id})
	}
	return r
}

func resolveMAC(pepper []byte, k config.AuthKey) ([32]byte, bool) {
	var zero [32]byte
	if hex := strings.TrimSpace(k.KeyHMAC); hex != "" {
		mac, err := tokenmac.ParseHMACHex(hex)
		if err != nil {
			return zero, false
		}
		return mac, true
	}
	if plain := strings.TrimSpace(k.Key); plain != "" && len(pepper) > 0 {
		return tokenmac.HashToken(pepper, []byte(plain)), true
	}
	return zero, false
}

// Enabled reports whether auth is required.
func (r *Registry) Enabled() bool {
	return r != nil && r.enabled
}

// Authenticate extracts Bearer token and verifies HMAC against stored digests.
func (r *Registry) Authenticate(authorization string) (*Identity, bool) {
	if r == nil || !r.enabled {
		return &Identity{Name: "anonymous", KeyHint: "anon"}, true
	}
	token := extractBearer(authorization)
	if token == "" || len(r.pepper) == 0 {
		return nil, false
	}
	computed := tokenmac.HashToken(r.pepper, []byte(token))
	var matched *Identity
	for i := range r.creds {
		if subtle.ConstantTimeCompare(r.creds[i].mac[:], computed[:]) == 1 {
			matched = r.creds[i].id
		}
	}
	if matched == nil {
		return nil, false
	}
	return matched, true
}

// VerifyAdminToken checks a presented admin token against a stored HMAC hex.
func VerifyAdminToken(pepper []byte, storedHMACHex, presented string) bool {
	presented = strings.TrimSpace(presented)
	if presented == "" || len(pepper) == 0 {
		return false
	}
	stored, err := tokenmac.ParseHMACHex(storedHMACHex)
	if err != nil {
		// Legacy: treat storedHMACHex as plaintext when not valid hex digest.
		if storedHMACHex == "" {
			return false
		}
		ha := tokenmac.HashToken(pepper, []byte(storedHMACHex))
		hb := tokenmac.HashToken(pepper, []byte(presented))
		return tokenmac.VerifyMAC(ha, hb)
	}
	return tokenmac.VerifyMAC(stored, tokenmac.HashToken(pepper, []byte(presented)))
}

// Summaries returns non-secret key metadata for admin UI.
func (r *Registry) Summaries() []KeySummary {
	if r == nil {
		return nil
	}
	out := make([]KeySummary, 0, len(r.creds))
	for _, c := range r.creds {
		out = append(out, KeySummary{
			Name:           c.id.Name,
			KeyHint:        c.id.KeyHint,
			HasUpstreamKey: c.id.UpstreamAPIKey != "",
			DefaultModel:   c.id.DefaultModel,
			ModelMappings:  len(c.id.Models),
		})
	}
	return out
}

// KeySummary is safe to expose via admin APIs.
type KeySummary struct {
	Name           string `json:"name"`
	KeyHint        string `json:"key_hint"`
	HasUpstreamKey bool   `json:"has_upstream_key"`
	DefaultModel   string `json:"default_model,omitempty"`
	ModelMappings  int    `json:"model_mappings"`
}

func extractBearer(authorization string) string {
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(authorization) >= len(prefix) && strings.EqualFold(authorization[:len(prefix)], prefix) {
		return strings.TrimSpace(authorization[len(prefix):])
	}
	return authorization
}

// Re-exports for callers that previously used auth.HashToken* / pepper helpers.
func HashToken(pepper, token []byte) [32]byte { return tokenmac.HashToken(pepper, token) }
func HashTokenHex(pepper []byte, token string) string {
	return tokenmac.HashTokenHex(pepper, token)
}
func ParseHMACHex(s string) ([32]byte, error)  { return tokenmac.ParseHMACHex(s) }
func VerifyMAC(stored, computed [32]byte) bool { return tokenmac.VerifyMAC(stored, computed) }
func NewToken() (string, error)                { return tokenmac.NewToken() }
func Hint(token string) string                 { return tokenmac.Hint(token) }
func LoadOrCreatePepper(dataDir string) ([]byte, error) {
	return tokenmac.LoadOrCreatePepper(dataDir)
}
