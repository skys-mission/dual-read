package auth

import (
	"testing"

	"github.com/skys-mission/dual-read/server/internal/config"
)

func TestAuthenticate(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	r := NewRegistry(config.AuthConfig{
		Enabled: true,
		Keys: []config.AuthKey{
			{Name: "alice", Key: "sk-a"},
		},
	}, pepper)

	if _, ok := r.Authenticate(""); ok {
		t.Fatal("expected fail without token")
	}
	id, ok := r.Authenticate("Bearer sk-a")
	if !ok || id.Name != "alice" {
		t.Fatalf("expected alice, ok=%v id=%v", ok, id)
	}

	open := NewRegistry(config.AuthConfig{Enabled: false}, pepper)
	id, ok = open.Authenticate("")
	if !ok || id.Name != "anonymous" {
		t.Fatal("expected anonymous when auth disabled")
	}
}

func TestAuthenticateRejectsWrongKey(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	r := NewRegistry(config.AuthConfig{
		Enabled: true,
		Keys:    []config.AuthKey{{Name: "alice", Key: "sk-a"}},
	}, pepper)
	if _, ok := r.Authenticate("Bearer sk-wrong"); ok {
		t.Fatal("expected reject")
	}
}

func TestVerifyAdminToken(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	mac := HashTokenHex(pepper, "admin-secret")
	if !VerifyAdminToken(pepper, mac, "admin-secret") {
		t.Fatal("expected admin match")
	}
	if VerifyAdminToken(pepper, mac, "wrong") {
		t.Fatal("expected admin reject")
	}
}
