package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/observe"
	"github.com/skys-mission/dual-read/server/internal/runtime"
	"github.com/skys-mission/dual-read/server/internal/upstream"
)

const maxBodyBytes = 1 << 20 // 1 MiB

// Chat handles OpenAI-compatible /v1/chat/completions with caching and mapping.
type Chat struct {
	cache   *cache.Chain
	runtime *runtime.Snapshot
	metrics *metrics.Collector
	logger  *slog.Logger
}

// NewChat creates the chat completion handler.
func NewChat(
	c *cache.Chain,
	rt *runtime.Snapshot,
	metricsCol *metrics.Collector,
	logger *slog.Logger,
) *Chat {
	return &Chat{
		cache:   c,
		runtime: rt,
		metrics: metricsCol,
		logger:  logger,
	}
}

// Register registers API routes on the given mux.
func (h *Chat) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/chat/completions", h.handleChatCompletions)
	mux.HandleFunc("/v1/models", h.handleModels)
}

func (h *Chat) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	h.metrics.Begin()

	rec := metrics.RecentRequest{
		Time:      start.UTC(),
		RequestID: observe.FromContext(r.Context()),
		Method:    r.Method,
		Path:      "/v1/chat/completions",
	}
	defer func() {
		rec.DurationMs = float64(time.Since(start).Milliseconds())
		rec.Error = observe.RedactError(rec.Error)
		h.metrics.End(rec)
	}()

	if r.Method != http.MethodPost {
		rec.Status = http.StatusMethodNotAllowed
		rec.Error = observe.ErrMethodNotAllowed
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}

	now := time.Now()
	if lim := h.runtime.Limiter(); lim != nil && lim.Enabled() {
		if d := lim.AllowIP(lim.ClientIP(r), now); !d.Allowed {
			rec.Status = http.StatusTooManyRequests
			rec.Error = d.Reason
			writeRateLimited(w, d.RetryAfter, d.Reason)
			return
		}
	}

	id, ok := h.runtime.Authenticate(r.Header.Get("Authorization"))
	if !ok {
		rec.Status = http.StatusUnauthorized
		rec.Error = "unauthorized"
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or missing API key")
		return
	}
	rec.AuthName = id.Name

	if lim := h.runtime.Limiter(); lim != nil && lim.Enabled() {
		if d := lim.AllowClient(id.Name, now); !d.Allowed {
			rec.Status = http.StatusTooManyRequests
			rec.Error = d.Reason
			writeRateLimited(w, d.RetryAfter, d.Reason)
			return
		}
		defer lim.ReleaseClient(id.Name)
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		rec.Status = http.StatusBadRequest
		rec.Error = observe.ErrBadRequest
		writeError(w, http.StatusBadRequest, "bad_request", "read body failed")
		return
	}
	defer func() { _ = r.Body.Close() }()
	if len(body) > maxBodyBytes {
		rec.Status = http.StatusRequestEntityTooLarge
		rec.Error = observe.ErrPayloadTooLarge
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds 1 MiB")
		return
	}

	reqFields, err := parseChatRequest(body)
	if err != nil {
		rec.Status = http.StatusBadRequest
		rec.Error = observe.ErrInvalidRequest
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if reqFields.Stream {
		rec.Status = http.StatusBadRequest
		rec.Error = observe.ErrStreamUnsupported
		writeError(w, http.StatusBadRequest, "stream_unsupported", "streaming is not supported by dual-read-server")
		return
	}

	upstreamModel, clientModel := h.runtime.ResolveModel(reqFields.Model, id)
	if upstreamModel == "" {
		rec.Status = http.StatusBadRequest
		rec.Error = observe.ErrInvalidRequest
		writeError(w, http.StatusBadRequest, "invalid_request", "model is required")
		return
	}
	rec.ClientModel = clientModel
	rec.UpstreamModel = upstreamModel

	opts := upstream.ChatOptions{
		APIKey:  id.UpstreamAPIKey,
		BaseURL: id.UpstreamBaseURL,
	}
	effectiveBaseURL := opts.BaseURL
	if effectiveBaseURL == "" {
		effectiveBaseURL = h.runtime.BaseURL()
	}
	disableThinking := shouldDisableThinking(upstreamModel, effectiveBaseURL)
	forwardBody, err := rewriteModel(body, upstreamModel, disableThinking)
	if err != nil {
		rec.Status = http.StatusBadRequest
		rec.Error = observe.ErrInvalidRequest
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	key := cache.KeyV2(h.runtime.CacheKeyInput(forwardBody, id, r.Header, opts))

	respBytes, outcome, err := h.cache.GetOrLoad(r.Context(), key, func(ctx context.Context) ([]byte, error) {
		return h.runtime.ChatCompletion(ctx, forwardBody, r.Header, opts)
	}, true)
	if err != nil {
		if errors.Is(err, runtime.ErrUpstreamBusy) {
			rec.Status = http.StatusTooManyRequests
			rec.Error = "inflight_upstream"
			writeRateLimited(w, runtime.UpstreamBusyRetryAfter(), "inflight_upstream")
			return
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			// Cancellation from the request context means the client went away
			// (499, nothing to answer). A deadline from the load path means the
			// UPSTREAM was slow — that must surface as 504; returning without a
			// Write would make net/http emit a bare 200 with an empty body.
			if r.Context().Err() != nil {
				rec.Status = 499
				rec.Error = "client_canceled"
				return
			}
			rec.Status = http.StatusGatewayTimeout
			rec.Error = "upstream_timeout"
			rec.Cache = string(cache.OutcomeMISS)
			writeError(w, http.StatusGatewayTimeout, "upstream_timeout", "upstream request timed out")
			return
		}
		var httpErr *upstream.HTTPError
		if errors.As(err, &httpErr) {
			rec.Status = httpErr.StatusCode
			rec.Error = "upstream_error"
			rec.Cache = string(cache.OutcomeMISS)
			writeUpstreamError(w, httpErr)
			return
		}
		h.logger.Error("upstream chat completion failed",
			"request_id", rec.RequestID,
			"auth", id.Name,
			"err_class", observe.ErrUpstreamError,
		)
		rec.Status = http.StatusBadGateway
		rec.Error = observe.ErrUpstreamError
		rec.Cache = string(cache.OutcomeMISS)
		writeError(w, http.StatusBadGateway, "upstream_error", "upstream request failed")
		return
	}

	cacheStatus := outcome.String()
	rec.Cache = cacheStatus
	rec.Status = http.StatusOK
	rec.BytesOut = len(respBytes)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Cache", cacheStatus)
	w.Header().Set("X-Dual-Read-Model", upstreamModel)
	if clientModel != upstreamModel {
		w.Header().Set("X-Dual-Read-Client-Model", clientModel)
	}
	_, _ = w.Write(respBytes)
}

func (h *Chat) handleModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if _, ok := h.runtime.Authenticate(r.Header.Get("Authorization")); !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or missing API key")
		return
	}

	type modelItem struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	seen := map[string]struct{}{}
	var data []modelItem
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		data = append(data, modelItem{ID: id, Object: "model", OwnedBy: "dual-read"})
	}
	add(h.runtime.DefaultModel())
	for k, v := range h.runtime.GlobalModelMap() {
		add(k)
		add(v)
	}
	sort.Slice(data, func(i, j int) bool { return data[i].ID < data[j].ID })

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"object": "list",
		"data":   data,
	})
}

type chatRequestFields struct {
	Model            string          `json:"model"`
	Messages         json.RawMessage `json:"messages"`
	Temperature      json.RawMessage `json:"temperature"`
	TopP             json.RawMessage `json:"top_p"`
	MaxTokens        json.RawMessage `json:"max_tokens"`
	MaxCompletionTok json.RawMessage `json:"max_completion_tokens"`
	Seed             json.RawMessage `json:"seed"`
	Stop             json.RawMessage `json:"stop"`
	N                json.RawMessage `json:"n"`
	ResponseFormat   json.RawMessage `json:"response_format"`
	Tools            json.RawMessage `json:"tools"`
	ToolChoice       json.RawMessage `json:"tool_choice"`
	Stream           bool            `json:"stream"`
}

func parseChatRequest(body []byte) (chatRequestFields, error) {
	var fields chatRequestFields
	if err := json.Unmarshal(body, &fields); err != nil {
		return fields, fmt.Errorf("invalid JSON body")
	}
	if len(fields.Messages) == 0 || string(fields.Messages) == "null" {
		return fields, fmt.Errorf("messages are required")
	}
	return fields, nil
}

func shouldDisableThinking(upstreamModel, baseURL string) bool {
	return strings.Contains(strings.ToLower(upstreamModel), "deepseek") ||
		strings.Contains(strings.ToLower(baseURL), "deepseek")
}

func rewriteModel(body []byte, upstreamModel string, disableThinking bool) ([]byte, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON body")
	}
	b, err := json.Marshal(upstreamModel)
	if err != nil {
		return nil, err
	}
	raw["model"] = b
	delete(raw, "stream") // ensure non-streaming
	if disableThinking {
		thinking, exists := raw["thinking"]
		if !exists || strings.TrimSpace(string(thinking)) == "null" {
			raw["thinking"] = json.RawMessage(`{"type":"disabled"}`)
		}
	}
	out, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error": map[string]string{
			"message": msg,
			"type":    code,
			"code":    code,
		},
	})
}

func writeRateLimited(w http.ResponseWriter, retryAfter time.Duration, reason string) {
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Round(time.Second)/time.Second)))
	msg := "rate limit exceeded"
	switch reason {
	case "inflight_client":
		msg = "too many concurrent requests for this API key"
	case "inflight_upstream":
		msg = "upstream concurrency limit reached"
	case "rate_ip":
		msg = "too many requests from this IP"
	case "rate_client":
		msg = "too many requests for this API key"
	}
	writeError(w, http.StatusTooManyRequests, "rate_limited", msg)
}

func writeUpstreamError(w http.ResponseWriter, httpErr *upstream.HTTPError) {
	ct := httpErr.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	w.Header().Set("Content-Type", ct)
	for _, name := range []string{
		"Retry-After",
		"OpenAI-Request-Id",
		"X-Request-Id",
		"RateLimit-Limit",
		"RateLimit-Remaining",
		"RateLimit-Reset",
		"X-RateLimit-Limit",
		"X-RateLimit-Remaining",
		"X-RateLimit-Reset",
	} {
		if values := httpErr.Header.Values(name); len(values) > 0 {
			w.Header()[http.CanonicalHeaderKey(name)] = append([]string(nil), values...)
		}
	}
	w.Header().Set("X-Cache", "MISS")
	w.WriteHeader(httpErr.StatusCode)
	_, _ = w.Write(httpErr.Body)
}
