package upstream

import (
	"net/http"
	"testing"
)

func TestPassthroughFingerprintStable(t *testing.T) {
	client := NewClient("https://api.example.com", "key", 0, []string{
		"X-Request-Id",
		"OpenAI-Organization",
	}, nil)

	incoming := http.Header{}
	incoming.Set("X-Request-Id", "req-1")
	incoming.Set("OpenAI-Organization", "org-a")
	incoming.Set("X-Ignored", "ignored")

	fp1 := client.PassthroughFingerprint(incoming)
	fp2 := client.PassthroughFingerprint(incoming)
	if fp1 == "" {
		t.Fatal("expected non-empty fingerprint")
	}
	if fp1 != fp2 {
		t.Fatalf("expected stable fingerprint, got %q and %q", fp1, fp2)
	}
}

func TestApplyHeadersPrecedence(t *testing.T) {
	client := NewClient("https://api.example.com", "proxy-key", 0, []string{
		"X-Request-Id",
		"Authorization",
	}, map[string]string{
		"X-Source": "dual-read-server",
	})

	incoming := http.Header{}
	incoming.Set("X-Request-Id", "req-42")
	incoming.Set("Authorization", "Bearer client-key")

	dst := make(http.Header)
	client.applyHeaders(dst, incoming, "")

	if got := dst.Get("X-Request-Id"); got != "req-42" {
		t.Fatalf("expected passthrough header, got %q", got)
	}
	if got := dst.Get("X-Source"); got != "dual-read-server" {
		t.Fatalf("expected extra header, got %q", got)
	}
	if got := dst.Get("Authorization"); got != "Bearer proxy-key" {
		t.Fatalf("expected proxy api key to win, got %q", got)
	}
	if got := dst.Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected content type, got %q", got)
	}
}

func TestApplyHeadersPerKeyOverride(t *testing.T) {
	client := NewClient("https://api.example.com", "default-key", 0, nil, nil)
	dst := make(http.Header)
	client.applyHeaders(dst, nil, "per-key")
	if got := dst.Get("Authorization"); got != "Bearer per-key" {
		t.Fatalf("expected per-key override, got %q", got)
	}
}

func TestValidateChatCompletionResponse(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{
			name: "valid",
			body: `{"choices":[{"message":{"content":"translated"}}]}`,
		},
		{name: "empty", body: ``, wantErr: true},
		{name: "invalid json", body: `{`, wantErr: true},
		{name: "missing choices", body: `{"ok":true}`, wantErr: true},
		{name: "empty content", body: `{"choices":[{"message":{"content":""}}]}`, wantErr: true},
		{name: "null content", body: `{"choices":[{"message":{"content":null}}]}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateChatCompletionResponse([]byte(tt.body))
			if tt.wantErr && err == nil {
				t.Fatal("expected validation error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
		})
	}
}
