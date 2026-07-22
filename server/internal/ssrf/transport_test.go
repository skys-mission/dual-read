package ssrf

import (
	"context"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestValidateURL(t *testing.T) {
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
		{"userinfo", "https://user:pass@api.example.com", true},
		{"bad scheme file", "file:///etc/passwd", true},
		{"bad scheme gopher", "gopher://x", true},
		{"empty", "", true},
		{"no host", "https://", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateURL(tc.url)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tc.url)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.url, err)
			}
		})
	}
}

func TestValidateURLAllowPrivateOptIn(t *testing.T) {
	if err := ValidateURL("http://192.168.1.10"); err == nil {
		t.Fatal("expected private address to be rejected by default")
	}
	t.Setenv("DUAL_READ_ALLOW_PRIVATE_UPSTREAM", "true")
	if err := ValidateURL("http://192.168.1.10"); err != nil {
		t.Fatalf("expected private address allowed with opt-in, got %v", err)
	}
}

func TestValidateResolvedHostBlocksPrivate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ValidateResolvedHost(ctx, "127.0.0.1"); err != nil {
		t.Fatalf("loopback should be allowed: %v", err)
	}
	if err := ValidateResolvedHost(ctx, "10.1.2.3"); err == nil {
		t.Fatal("expected private IP rejection")
	}
}

func TestDialContextRejectsPrivateLiteral(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := DialContext(ctx, "tcp", net.JoinHostPort("169.254.169.254", "80"))
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected metadata IP dial to fail")
	}
}

func TestValidateRedirectBoundaryBlocksPublicToLoopback(t *testing.T) {
	original, _ := url.Parse("https://93.184.216.34/v1/chat/completions")
	target, _ := url.Parse("http://127.0.0.1:8080/admin/api/config")
	err := validateRedirectBoundary(context.Background(), original, target)
	if err == nil {
		t.Fatal("expected public-to-loopback redirect to be rejected")
	}
	if !strings.Contains(err.Error(), "restricted address") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateRedirectBoundaryAllowsLocalUpstreamRedirect(t *testing.T) {
	original, _ := url.Parse("http://127.0.0.1:11434/v1/chat/completions")
	target, _ := url.Parse("http://127.0.0.1:11435/v1/chat/completions")
	if err := validateRedirectBoundary(context.Background(), original, target); err != nil {
		t.Fatalf("local upstream redirect should remain supported: %v", err)
	}
}

func TestLocalhostNamePolicy(t *testing.T) {
	for _, host := range []string{"localhost", "LOCALHOST.", "api.localhost"} {
		if !isLocalhostName(host) {
			t.Fatalf("expected %q to be treated as explicit localhost", host)
		}
	}
	if isLocalhostName("localhost.example.com") {
		t.Fatal("ordinary hostname must not be treated as localhost")
	}
}
