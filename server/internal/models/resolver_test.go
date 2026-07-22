package models

import (
	"testing"

	"github.com/skys-mission/dual-read/server/internal/auth"
	"github.com/skys-mission/dual-read/server/internal/config"
)

func TestResolveOrder(t *testing.T) {
	r := NewResolver(config.ModelsConfig{
		Default: "global-default",
		Map:     map[string]string{"flash": "global-flash"},
	})
	id := &auth.Identity{
		DefaultModel: "key-default",
		Models:       map[string]string{"flash": "key-flash"},
	}

	up, client := r.Resolve("flash", id)
	if up != "key-flash" || client != "flash" {
		t.Fatalf("per-key map should win: %s / %s", up, client)
	}

	up, client = r.Resolve("other", id)
	if up != "other" || client != "other" {
		t.Fatalf("unmapped should pass through: %s / %s", up, client)
	}

	up, _ = r.Resolve("", id)
	if up != "key-default" {
		t.Fatalf("expected key default, got %s", up)
	}

	up, _ = r.Resolve("", nil)
	if up != "global-default" {
		t.Fatalf("expected global default, got %s", up)
	}
}
