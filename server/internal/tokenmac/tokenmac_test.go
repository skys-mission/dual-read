package tokenmac

import (
	"path/filepath"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	pepper := []byte("0123456789abcdef")
	a := HashToken(pepper, []byte("sk-a"))
	b := HashToken(pepper, []byte("sk-a"))
	c := HashToken(pepper, []byte("sk-b"))
	if !VerifyMAC(a, b) {
		t.Fatal("same token should match")
	}
	if VerifyMAC(a, c) {
		t.Fatal("different token must not match")
	}
	hex := HashTokenHex(pepper, "sk-a")
	parsed, err := ParseHMACHex(hex)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyMAC(a, parsed) {
		t.Fatal("hex round-trip")
	}
}

func TestLoadOrCreatePepperPersists(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DUAL_READ_AUTH_PEPPER", "")
	p1, err := LoadOrCreatePepper(dir)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := LoadOrCreatePepper(dir)
	if err != nil {
		t.Fatal(err)
	}
	if string(p1) != string(p2) {
		t.Fatal("pepper should persist")
	}
	if _, err := filepath.Rel(dir, filepath.Join(dir, "auth_pepper")); err != nil {
		t.Fatal(err)
	}
}

func TestHint(t *testing.T) {
	if Hint("abcd") != "****" {
		t.Fatal("short hint")
	}
	h := Hint("dr-abcdefghijklmnop")
	if h == "" || h == "****" {
		t.Fatalf("expected truncated hint, got %q", h)
	}
}
