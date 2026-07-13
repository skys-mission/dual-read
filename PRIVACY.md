# Privacy Policy — Dual Read

**Last updated:** 2026-07-14
**Applies to:** Dual Read browser extension and the optional self-hosted `dual-read-server`.

Dual Read is designed as a **BYOK / self-hosted** bilingual reading tool. We (the open-source project) do **not** operate a cloud translation service that receives your browsing content by default.

## Summary (plain language)

| Question | Answer |
|----------|--------|
| Do we collect your browsing history? | **No.** |
| Do we run product analytics / telemetry? | **No** (zero telemetry by default). |
| Where does page text go? | Only to the **API endpoint you configure** (your LLM provider or your own `dual-read-server`). |
| Are API keys sent to us? | **No.** Keys stay in your browser (and optionally on your self-hosted server). |
| Do we sell data? | **No.** |

## What the extension can access

Manifest permissions (see `extension/wxt.config.ts`):

| Permission | Why |
|------------|-----|
| `storage` | Save settings, site rules, and translation cache |
| `activeTab` | Act on the tab you invoke (translate / restore) |
| `scripting` | Inject the translation engine **on demand** (not on every page load) |
| `contextMenus` | “Translate selection” from the right-click menu |
| `host_permissions` for localhost | Talk to a local `dual-read-server` over HTTP |
| `optional_host_permissions: https://*/` | Call **your** remote HTTPS API only after you grant it |

Content scripts are **unlisted** and injected when you translate—Dual Read does not auto-inject into all websites at install time.

## Data the extension processes

### Sent to your configured API

When you translate a page or selection, the extension sends **page or selection text** (and related prompt metadata) to:

- the OpenAI-compatible base URL you set in Options, **or**
- your self-hosted `dual-read-server` (which may forward to an upstream LLM).

Remote endpoints must use **HTTPS**. HTTP is allowed only for loopback (`localhost` / `127.0.0.1` / `::1`).

### Stored locally in the browser

- Non-secret preferences in `chrome.storage.sync` (API base, model, languages, site rules, …), which may sync through the browser account you choose to use
- API key in `chrome.storage.local` and/or `chrome.storage.session` (never synced as a secret across devices via the sync API)
- Custom HTTP headers in `chrome.storage.local` only (never synced); they are excluded from exports unless you explicitly include them
- Translation cache entries in `chrome.storage.local` (TTL + LRU)

Clearing the translation cache in Options removes cached translations. Uninstalling the extension removes its storage.

### Not collected by the project

The Dual Read project maintainers do **not** receive:

- page contents
- API keys
- browsing history
- crash telemetry
- advertising identifiers

If you use a third-party LLM API, **that provider’s** privacy policy applies to the text you send them. If you self-host `dual-read-server`, you control logs, cache, and upstream credentials.

## Optional self-hosted server

`dual-read-server` may cache request/response bodies (local BigCache and/or Valkey) to reduce cost and latency. Cache keys include model/prompt fingerprints—not your Google account. Admin pages (`/admin`) are protected by a configured token when enabled; do not expose an unauthenticated admin on the public internet.

See [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md) and [`SECURITY.md`](SECURITY.md).

## Firefox / Chrome Web Store disclosures

- Firefox declares `websiteContent` data transmission because page/selection text is sent to **your** configured endpoint (AMO honesty requirement).
- Store listings should link to this document and match the permission explanations above.

## Contact

Privacy questions and data concerns: open a GitHub Discussion or Issue in [skys-mission/dual-read](https://github.com/skys-mission/dual-read), or use [Security Advisories](https://github.com/skys-mission/dual-read/security/advisories/new) for sensitive reports.

## Changes

Material changes to this policy will be noted in [`CHANGELOG.md`](CHANGELOG.md) and the “Last updated” date above.
