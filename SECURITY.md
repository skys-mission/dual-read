# Security Policy

## Supported versions

Security fixes are applied on the default branch (`main`). Pre-release / local builds from feature branches are unsupported.

| Component | Support |
|-----------|---------|
| Browser extension (MV3) | Latest `main` build |
| `dual-read-server` | Latest `main` / tagged releases when published |

## Reporting a vulnerability

**Please do not open a public issue for security bugs.**

1. Prefer GitHub Private Vulnerability Reporting:  
   [Open a security advisory](https://github.com/skys-mission/dual-read/security/advisories/new)
2. Include: affected component (extension / server), version or commit, reproduction steps, impact, and any suggested fix.
3. Allow reasonable time for a fix before public disclosure (we aim to acknowledge within **7 days**).

## Hardening expectations (operators)

When running `dual-read-server` on a public interface:

- Enable `auth.enabled` and configure server API keys.
- Set a strong `admin.token` (or `DUAL_READ_ADMIN_TOKEN`).
- Do **not** set `DUAL_READ_ALLOW_INSECURE_PUBLIC=true` except for short-lived local demos.
- Prefer TLS termination (see [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md)).
- Keep upstream `base_url` on the public internet or explicitly allow private upstreams via `DUAL_READ_ALLOW_PRIVATE_UPSTREAM` only when you understand the SSRF trade-off.
- Run the published container as non-root with a read-only root filesystem and a dedicated data volume.

## Extension threat model (short)

- Secrets must never ship in production zip / `public/` artifacts (CI artifact policy enforces this).
- Content scripts receive `PublicSessionConfig` only—no raw API keys.
- Remote API bases require HTTPS (loopback HTTP only).
- Translations are inserted via `textContent` paths designed to avoid HTML injection from model output.

## Dependency scanning

CI runs:

- `govulncheck` (Go)
- runtime `npm audit --omit=dev` (extension production deps)
- optional SBOM generation (`scripts/generate-sbom.sh`)

DevDependency advisories in the WXT/tooling chain may appear in full-tree `npm audit`; they do not block PRs by themselves—upgrade tooling when feasible.

## Safe disclosure hall of fame

We gratefully acknowledge responsible reporters in release notes when they wish to be named.
