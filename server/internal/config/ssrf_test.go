package config

import "testing"

func TestValidateUpstreamURL(t *testing.T) {
	cases := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"public https", "https://api.deepseek.com", false},
		{"public https path", "https://api.openai.com/v1", false},
		{"loopback ipv4", "http://127.0.0.1:11434", false},
		{"loopback name", "http://localhost:8080", false},
		{"loopback ipv6", "http://[::1]:8080", false},
		{"cloud metadata", "http://169.254.169.254/latest/meta-data/", true},
		{"private 10", "http://10.0.0.5:8080", true},
		{"private 192", "http://192.168.1.10", true},
		{"private 172", "http://172.16.0.1", true},
		{"unspecified", "http://0.0.0.0:8080", true},
		{"bad scheme file", "file:///etc/passwd", true},
		{"bad scheme gopher", "gopher://x", true},
		{"empty", "", true},
		{"no host", "https://", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateUpstreamURL(tc.url)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tc.url)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.url, err)
			}
		})
	}
}

func TestValidateUpstreamURLAllowPrivateOptIn(t *testing.T) {
	if err := validateUpstreamURL("http://192.168.1.10"); err == nil {
		t.Fatal("expected private address to be rejected by default")
	}
	t.Setenv("DUAL_READ_ALLOW_PRIVATE_UPSTREAM", "true")
	if err := validateUpstreamURL("http://192.168.1.10"); err != nil {
		t.Fatalf("expected private address allowed with opt-in, got %v", err)
	}
}
