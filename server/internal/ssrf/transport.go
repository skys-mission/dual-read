package ssrf

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxRedirects = 5

// AllowPrivate reports whether private / link-local upstreams are permitted.
// Opt in via DUAL_READ_ALLOW_PRIVATE_UPSTREAM=true.
func AllowPrivate() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("DUAL_READ_ALLOW_PRIVATE_UPSTREAM")))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

// ValidateURL checks scheme/host/userinfo and literal-IP policy for a
// configured upstream base URL. Hostnames are accepted here; DialContext
// re-validates every resolved address at connect time.
func ValidateURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("empty upstream URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid upstream URL %q: %w", raw, err)
	}
	return validateParsedURL(u)
}

func validateParsedURL(u *url.URL) error {
	if u == nil {
		return fmt.Errorf("empty upstream URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("upstream URL %q must use http or https", u.String())
	}
	if u.User != nil {
		return fmt.Errorf("upstream URL must not include userinfo")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("upstream URL %q has no host", u.String())
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	return validateIP(ip, u.String())
}

func isRestrictedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

func isLocalhostName(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}

func validateIP(ip net.IP, raw string) error {
	if ip.IsLoopback() {
		return nil
	}
	if AllowPrivate() {
		return nil
	}
	if isRestrictedIP(ip) {
		return fmt.Errorf(
			"upstream URL %q resolves to a private/link-local address (%s); "+
				"set DUAL_READ_ALLOW_PRIVATE_UPSTREAM=true to permit LAN endpoints",
			raw, ip)
	}
	return nil
}

// ValidateResolvedHost resolves host and rejects any blocked address.
func ValidateResolvedHost(ctx context.Context, host string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("empty host")
	}
	if ip := net.ParseIP(host); ip != nil {
		return validateIP(ip, host)
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("resolve %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return fmt.Errorf("resolve %q: no addresses", host)
	}
	for _, addr := range addrs {
		// Loopback is supported for explicit localhost endpoints, but allowing an
		// arbitrary hostname that resolves to loopback would enable DNS rebinding.
		if addr.IP.IsLoopback() && !isLocalhostName(host) && !AllowPrivate() {
			return fmt.Errorf(
				"upstream host %q resolves to loopback (%s); use localhost, a literal loopback address, "+
					"or set DUAL_READ_ALLOW_PRIVATE_UPSTREAM=true",
				host, addr.IP)
		}
		if err := validateIP(addr.IP, host); err != nil {
			return err
		}
	}
	return nil
}

// DialContext dials only after resolving and validating every candidate IP.
func DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	if err := ValidateResolvedHost(ctx, host); err != nil {
		return nil, err
	}

	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("resolve %q: %w", host, err)
		}
		for _, addr := range addrs {
			if addr.IP.IsLoopback() && !isLocalhostName(host) && !AllowPrivate() {
				return nil, fmt.Errorf(
					"upstream host %q resolves to loopback (%s); use localhost, a literal loopback address, "+
						"or set DUAL_READ_ALLOW_PRIVATE_UPSTREAM=true",
					host, addr.IP)
			}
			if err := validateIP(addr.IP, host); err != nil {
				return nil, err
			}
			ips = append(ips, addr.IP)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no dialable addresses for %q", host)
	}

	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	var lastErr error
	for _, ip := range ips {
		target := net.JoinHostPort(ip.String(), port)
		conn, err := dialer.DialContext(ctx, network, target)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("dial %q failed", address)
	}
	return nil, lastErr
}

func hostHasRestrictedAddress(ctx context.Context, host string) (bool, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return false, fmt.Errorf("empty host")
	}
	if ip := net.ParseIP(host); ip != nil {
		return isRestrictedIP(ip), nil
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return false, fmt.Errorf("resolve %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return false, fmt.Errorf("resolve %q: no addresses", host)
	}
	for _, addr := range addrs {
		if isRestrictedIP(addr.IP) {
			return true, nil
		}
	}
	return false, nil
}

func validateRedirectBoundary(ctx context.Context, original, target *url.URL) error {
	if original == nil || target == nil {
		return fmt.Errorf("redirect URL is missing")
	}
	originalRestricted, err := hostHasRestrictedAddress(ctx, original.Hostname())
	if err != nil {
		return err
	}
	targetRestricted, err := hostHasRestrictedAddress(ctx, target.Hostname())
	if err != nil {
		return err
	}
	if !originalRestricted && targetRestricted {
		return fmt.Errorf(
			"redirect from public upstream %q to restricted address %q is not allowed",
			original.Hostname(), target.Hostname())
	}
	return nil
}

// NewHTTPClient returns an HTTP client with SSRF-safe dialing and redirect checks.
func NewHTTPClient(timeout time.Duration) *http.Client {
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.Proxy = nil // honor explicit operator proxying only via custom config later
	base.DialContext = DialContext
	base.MaxIdleConns = 100
	base.MaxIdleConnsPerHost = 20
	base.IdleConnTimeout = 90 * time.Second

	client := &http.Client{
		Timeout:   timeout,
		Transport: base,
	}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return fmt.Errorf("stopped after %d redirects", maxRedirects)
		}
		if err := validateParsedURL(req.URL); err != nil {
			return err
		}
		if err := ValidateResolvedHost(req.Context(), req.URL.Hostname()); err != nil {
			return err
		}
		if len(via) > 0 {
			if err := validateRedirectBoundary(req.Context(), via[0].URL, req.URL); err != nil {
				return err
			}
		}
		return nil
	}
	return client
}
