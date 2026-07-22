package cache

import (
	"testing"
)

func TestKeyV2StableAndSensitive(t *testing.T) {
	base := KeyInput{
		Body:             []byte(`{"model":"m"}`),
		ResolvedBaseURL:  "https://api.example.com",
		UpstreamSecretFP: SecretFingerprint("sk-1"),
		AuthScope:        "alice",
		ConfigGeneration: 1,
	}
	k1 := KeyV2(base)
	k2 := KeyV2(base)
	if k1 != k2 {
		t.Fatal("same input must be stable")
	}

	changed := base
	changed.ConfigGeneration = 2
	if KeyV2(changed) == k1 {
		t.Fatal("generation must change key")
	}

	changed = base
	changed.ResolvedBaseURL = "https://other.example.com"
	if KeyV2(changed) == k1 {
		t.Fatal("resolved base must change key")
	}

	changed = base
	changed.ExtraHeadersFP = "abcd"
	if KeyV2(changed) == k1 {
		t.Fatal("extra headers fingerprint must change key")
	}

	changed = base
	changed.PassthroughConfigFP = "cfg"
	if KeyV2(changed) == k1 {
		t.Fatal("passthrough config fingerprint must change key")
	}

	changed = base
	changed.PassthroughValuesFP = "org=a"
	if KeyV2(changed) == k1 {
		t.Fatal("passthrough values fingerprint must change key")
	}

	changed = base
	changed.AuthScope = "bob"
	if KeyV2(changed) == k1 {
		t.Fatal("auth scope must change key")
	}

	changed = base
	changed.Body = []byte(`{"model":"m","temperature":0.5}`)
	if KeyV2(changed) == k1 {
		t.Fatal("body must change key")
	}
}

func TestSecretFingerprintEmpty(t *testing.T) {
	if SecretFingerprint("") != "" {
		t.Fatal("empty secret stays empty")
	}
	if SecretFingerprint("a") == SecretFingerprint("b") {
		t.Fatal("different secrets must differ")
	}
}
