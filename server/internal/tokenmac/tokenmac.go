// Package tokenmac provides HMAC-SHA256 token digests and pepper management.
// Kept separate from auth/config to avoid an import cycle.
package tokenmac

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	hmacHexLen   = sha256.Size * 2 // 64
	tokenBytes   = 24
	tokenPrefix  = "dr-"
	pepperBytes  = 32
	pepperEnvKey = "DUAL_READ_AUTH_PEPPER"
)

// HashToken returns HMAC-SHA256(pepper, token) as a fixed 32-byte digest.
func HashToken(pepper, token []byte) [32]byte {
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write(token)
	var out [32]byte
	copy(out[:], mac.Sum(nil))
	return out
}

// HashTokenHex returns the hex encoding of HashToken.
func HashTokenHex(pepper []byte, token string) string {
	sum := HashToken(pepper, []byte(token))
	return hex.EncodeToString(sum[:])
}

// ParseHMACHex decodes a 64-char hex HMAC into a fixed digest.
func ParseHMACHex(s string) ([32]byte, error) {
	var out [32]byte
	s = strings.TrimSpace(s)
	if len(s) != hmacHexLen {
		return out, fmt.Errorf("hmac hex length %d, want %d", len(s), hmacHexLen)
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return out, err
	}
	copy(out[:], b)
	return out, nil
}

// VerifyMAC compares two digests in constant time.
func VerifyMAC(stored, computed [32]byte) bool {
	return hmac.Equal(stored[:], computed[:])
}

// NewToken generates a high-entropy client/admin token (dr- + hex).
func NewToken() (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return tokenPrefix + hex.EncodeToString(buf), nil
}

// Hint returns a safe display fragment of a plaintext token.
func Hint(token string) string {
	token = strings.TrimSpace(token)
	if len(token) <= 8 {
		return "****"
	}
	return token[:4] + "…" + token[len(token)-4:]
}

// LoadOrCreatePepper resolves the auth pepper.
// Priority: DUAL_READ_AUTH_PEPPER env → dataDir/auth_pepper → auto-generate.
func LoadOrCreatePepper(dataDir string) ([]byte, error) {
	if env := strings.TrimSpace(os.Getenv(pepperEnvKey)); env != "" {
		return normalizePepper([]byte(env))
	}
	path := filepath.Join(dataDir, "auth_pepper")
	data, err := os.ReadFile(path)
	if err == nil {
		return normalizePepper(bytesTrimSpace(data))
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read auth pepper: %w", err)
	}
	buf := make([]byte, pepperBytes)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	encoded := hex.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(encoded+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write auth pepper: %w", err)
	}
	return normalizePepper([]byte(encoded))
}

func normalizePepper(raw []byte) ([]byte, error) {
	raw = bytesTrimSpace(raw)
	if len(raw) == 0 {
		return nil, fmt.Errorf("auth pepper is empty")
	}
	if len(raw) == pepperBytes*2 {
		if decoded, err := hex.DecodeString(string(raw)); err == nil && len(decoded) == pepperBytes {
			return decoded, nil
		}
	}
	if len(raw) < 16 {
		return nil, fmt.Errorf("auth pepper too short (need ≥16 bytes)")
	}
	return raw, nil
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}
