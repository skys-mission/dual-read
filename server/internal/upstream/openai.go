package upstream

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/skys-mission/dual-read/server/internal/ssrf"
)

const maxResponseBytes = 8 << 20 // 8 MiB

// Client forwards requests to an OpenAI-compatible upstream via HTTP.
type Client struct {
	httpClient         *http.Client
	baseURL            string
	apiKey             string
	passthroughHeaders map[string]struct{}
	extraHeaders       map[string]string
}

// NewClient creates a new upstream client with SSRF-safe transport.
func NewClient(baseURL, apiKey string, timeout time.Duration, passthroughHeaders []string, extraHeaders map[string]string) *Client {
	allowlist := make(map[string]struct{}, len(passthroughHeaders))
	for _, name := range passthroughHeaders {
		n := strings.ToLower(strings.TrimSpace(name))
		if n == "" {
			continue
		}
		allowlist[n] = struct{}{}
	}

	extras := make(map[string]string, len(extraHeaders))
	for key, value := range extraHeaders {
		k := strings.TrimSpace(key)
		if k == "" || value == "" {
			continue
		}
		extras[k] = value
	}

	return &Client{
		httpClient:         ssrf.NewHTTPClient(timeout),
		baseURL:            strings.TrimRight(baseURL, "/"),
		apiKey:             apiKey,
		passthroughHeaders: allowlist,
		extraHeaders:       extras,
	}
}

// BaseURL returns the configured default base URL.
func (c *Client) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.baseURL
}

// APIKey returns the configured default upstream API key (for resolved fingerprinting only).
func (c *Client) APIKey() string {
	if c == nil {
		return ""
	}
	return c.apiKey
}

// ExtraHeadersFingerprint returns a stable fingerprint of configured extra headers.
func (c *Client) ExtraHeadersFingerprint() string {
	if c == nil || len(c.extraHeaders) == 0 {
		return ""
	}
	keys := make([]string, 0, len(c.extraHeaders))
	for k := range c.extraHeaders {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(c.extraHeaders[k])
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:8])
}

// PassthroughAllowlistFingerprint returns a stable fingerprint of the passthrough allowlist.
func (c *Client) PassthroughAllowlistFingerprint() string {
	if c == nil || len(c.passthroughHeaders) == 0 {
		return ""
	}
	names := make([]string, 0, len(c.passthroughHeaders))
	for n := range c.passthroughHeaders {
		names = append(names, n)
	}
	sort.Strings(names)
	sum := sha256.Sum256([]byte(strings.Join(names, "\n")))
	return hex.EncodeToString(sum[:8])
}

// ResolveBaseURL returns the effective upstream base URL for a call.
func (c *Client) ResolveBaseURL(opts ChatOptions) string {
	if c == nil {
		return strings.TrimRight(opts.BaseURL, "/")
	}
	if opts.BaseURL != "" {
		return strings.TrimRight(opts.BaseURL, "/")
	}
	return c.baseURL
}

// ResolveAPIKey returns the effective upstream API key for a call.
func (c *Client) ResolveAPIKey(opts ChatOptions) string {
	if opts.APIKey != "" {
		return opts.APIKey
	}
	if c == nil {
		return ""
	}
	return c.apiKey
}

// HTTPError is a non-2xx upstream response that should be relayed to the client.
type HTTPError struct {
	StatusCode int
	Body       []byte
	Header     http.Header
}

func (e *HTTPError) Error() string {
	msg := string(e.Body)
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return fmt.Sprintf("upstream HTTP %d: %s", e.StatusCode, msg)
}

// PassthroughFingerprint returns a stable string of forwarded header values for cache keys.
func (c *Client) PassthroughFingerprint(incoming http.Header) string {
	if len(c.passthroughHeaders) == 0 {
		return ""
	}

	type pair struct {
		key   string
		value string
	}
	pairs := make([]pair, 0, len(c.passthroughHeaders))
	for name := range c.passthroughHeaders {
		value := incoming.Get(name)
		if value == "" {
			continue
		}
		pairs = append(pairs, pair{key: name, value: value})
	}
	if len(pairs) == 0 {
		return ""
	}

	sort.Slice(pairs, func(i, j int) bool { return pairs[i].key < pairs[j].key })

	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(p.key)
		b.WriteByte('=')
		b.WriteString(p.value)
	}
	return b.String()
}

func (c *Client) applyHeaders(dst, incoming http.Header, apiKey string) {
	for key, value := range c.extraHeaders {
		dst.Set(key, value)
	}

	for name := range c.passthroughHeaders {
		if value := incoming.Get(name); value != "" {
			dst.Set(name, value)
		}
	}

	dst.Set("Content-Type", "application/json")
	key := apiKey
	if key == "" {
		key = c.apiKey
	}
	if key != "" {
		dst.Set("Authorization", "Bearer "+key)
	}
}

// ChatOptions customizes a single upstream call.
type ChatOptions struct {
	BaseURL string
	APIKey  string
}

func validateChatCompletionResponse(body []byte) error {
	var payload struct {
		Choices []struct {
			Message struct {
				Content interface{} `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return fmt.Errorf("empty response body")
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("invalid JSON")
	}
	if len(payload.Choices) == 0 {
		return fmt.Errorf("missing choices")
	}
	for _, choice := range payload.Choices {
		if content, ok := choice.Message.Content.(string); ok && strings.TrimSpace(content) != "" {
			return nil
		}
	}
	return fmt.Errorf("choices contain no non-empty message content")
}

// ChatCompletion forwards the request body and returns the raw JSON response.
func (c *Client) ChatCompletion(ctx context.Context, body []byte, incoming http.Header, opts ChatOptions) ([]byte, error) {
	base := c.baseURL
	if opts.BaseURL != "" {
		base = strings.TrimRight(opts.BaseURL, "/")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	c.applyHeaders(req.Header, incoming, opts.APIKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upstream request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read upstream response: %w", err)
	}
	if len(respBody) > maxResponseBytes {
		return nil, fmt.Errorf("upstream response too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{
			StatusCode: resp.StatusCode,
			Body:       respBody,
			Header:     resp.Header.Clone(),
		}
	}
	if err := validateChatCompletionResponse(respBody); err != nil {
		return nil, fmt.Errorf("invalid upstream chat completion response: %w", err)
	}

	return respBody, nil
}

// Ping checks base connectivity with a short HEAD/GET to the base URL host.
func (c *Client) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	return nil
}
