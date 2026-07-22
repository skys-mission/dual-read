package admin

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/skys-mission/dual-read/server/internal/cache"
	"github.com/skys-mission/dual-read/server/internal/config"
	"github.com/skys-mission/dual-read/server/internal/metrics"
	"github.com/skys-mission/dual-read/server/internal/runtime"
)

func testHandler(t *testing.T, adminToken string) *httptest.Server {
	t.Helper()
	if adminToken != "" {
		t.Setenv("DUAL_READ_ADMIN_TOKEN", adminToken)
	} else {
		t.Setenv("DUAL_READ_ADMIN_TOKEN", "")
	}
	t.Setenv("OPENAI_API_KEY", "test-upstream-key")

	dir := t.TempDir()
	store, err := config.Open(config.OpenOptions{DataDir: filepath.Join(dir, "data")})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	cfg, err := store.Effective()
	if err != nil {
		t.Fatalf("effective: %v", err)
	}
	if adminToken != "" && cfg.Admin.Token != adminToken {
		t.Fatalf("expected admin token from env, got %q", cfg.Admin.Token)
	}

	snap := runtime.NewSnapshot(cfg, store.Pepper(), store.RuntimeSnapshot().Revision)
	chain := cache.NewChain(nil, nil)
	h := New(store, snap, chain, metrics.New(), nil)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestQueryTokenRejected(t *testing.T) {
	srv := testHandler(t, "secret-admin-token")
	res, err := http.Get(srv.URL + "/admin/api/overview?token=secret-admin-token")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for query token, got %d", res.StatusCode)
	}
}

func TestLoginSessionAndCSRF(t *testing.T) {
	srv := testHandler(t, "secret-admin-token")
	client := &http.Client{}

	loginReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/admin/api/login", strings.NewReader(`{"token":"secret-admin-token"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRes, err := client.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	defer loginRes.Body.Close()
	if loginRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(loginRes.Body)
		t.Fatalf("login status %d: %s", loginRes.StatusCode, body)
	}

	var sessionCookie, csrfCookie *http.Cookie
	for _, c := range loginRes.Cookies() {
		switch c.Name {
		case sessionCookieName:
			sessionCookie = c
		case csrfCookieName:
			csrfCookie = c
		}
	}
	if sessionCookie == nil || !sessionCookie.HttpOnly {
		t.Fatal("expected HttpOnly session cookie")
	}
	if csrfCookie == nil || csrfCookie.HttpOnly {
		t.Fatal("expected readable CSRF cookie")
	}

	getReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/admin/api/overview", nil)
	getReq.AddCookie(sessionCookie)
	getRes, err := client.Do(getReq)
	if err != nil {
		t.Fatal(err)
	}
	defer getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK {
		t.Fatalf("overview with session: %d", getRes.StatusCode)
	}

	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/admin/api/config", strings.NewReader(`{}`))
	putReq.Header.Set("Content-Type", "application/json")
	putReq.AddCookie(sessionCookie)
	putRes, err := client.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	defer putRes.Body.Close()
	if putRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected CSRF rejection, got %d", putRes.StatusCode)
	}

	putReq2, _ := http.NewRequest(http.MethodPut, srv.URL+"/admin/api/config", strings.NewReader(`{}`))
	putReq2.Header.Set("Content-Type", "application/json")
	putReq2.Header.Set(csrfHeaderName, csrfCookie.Value)
	putReq2.AddCookie(sessionCookie)
	putReq2.AddCookie(csrfCookie)
	putRes2, err := client.Do(putReq2)
	if err != nil {
		t.Fatal(err)
	}
	defer putRes2.Body.Close()
	if putRes2.StatusCode == http.StatusUnauthorized || putRes2.StatusCode == http.StatusForbidden {
		body, _ := io.ReadAll(putRes2.Body)
		t.Fatalf("CSRF+session should authenticate mutating request, got %d: %s", putRes2.StatusCode, body)
	}
}

func TestHeaderTokenBypassesCSRF(t *testing.T) {
	srv := testHandler(t, "secret-admin-token")
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/admin/api/overview", nil)
	req.Header.Set("X-Admin-Token", "secret-admin-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("header token auth failed: %d", res.StatusCode)
	}
}

func TestNoTokenModeCreatesCSRFSessionForMutations(t *testing.T) {
	srv := testHandler(t, "")
	client := &http.Client{}

	loginReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/admin/api/login", strings.NewReader(`{}`))
	loginReq.Header.Set("Content-Type", "application/json")
	loginRes, err := client.Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	defer loginRes.Body.Close()
	if loginRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(loginRes.Body)
		t.Fatalf("local session bootstrap status %d: %s", loginRes.StatusCode, body)
	}

	var sessionCookie, csrfCookie *http.Cookie
	for _, c := range loginRes.Cookies() {
		switch c.Name {
		case sessionCookieName:
			sessionCookie = c
		case csrfCookieName:
			csrfCookie = c
		}
	}
	if sessionCookie == nil || csrfCookie == nil {
		t.Fatal("expected session and CSRF cookies in no-token mode")
	}

	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/admin/api/config", strings.NewReader(`{}`))
	putReq.Header.Set("Content-Type", "application/json")
	putReq.Header.Set(csrfHeaderName, csrfCookie.Value)
	putReq.AddCookie(sessionCookie)
	putReq.AddCookie(csrfCookie)
	putRes, err := client.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	defer putRes.Body.Close()
	if putRes.StatusCode == http.StatusUnauthorized || putRes.StatusCode == http.StatusForbidden {
		body, _ := io.ReadAll(putRes.Body)
		t.Fatalf("CSRF session should permit local mutation, got %d: %s", putRes.StatusCode, body)
	}
}

func TestSecurityHeadersPresent(t *testing.T) {
	srv := testHandler(t, "")
	res, err := http.Get(srv.URL + "/admin/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := res.Header.Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("missing CSP: %q", got)
	}
	if res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
}

func TestTokenEqual(t *testing.T) {
	if tokenEqual("a", "b") {
		t.Fatal("different tokens must not equal")
	}
	if !tokenEqual("same", "same") {
		t.Fatal("identical tokens must equal")
	}
}
