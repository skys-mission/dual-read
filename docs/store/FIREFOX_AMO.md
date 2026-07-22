# Firefox Add-ons (AMO) — Dual Read

Submit via [addons.mozilla.org](https://addons.mozilla.org/developers/).

Extension id (gecko): `dual-read@skysmission.github.io`  
Minimum Firefox: **140.0** (built-in data-transmission consent)  
Privacy policy: https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md

## Data collection declaration

Manifest declares:

```json
"data_collection_permissions": { "required": ["websiteContent"] }
```

This is required because translating a page or selection sends website text to the
**user-configured** LLM endpoint. Dual Read does not send that text to project-operated
telemetry. Keep AMO questionnaire answers identical to [`PRIVACY.md`](../../PRIVACY.md).

## Packages to upload

### 1. Built extension (XPI / zip)

```bash
make build-extension
# Firefox package: extension/output/*.firefox.zip (copied under dist/)
```

### 2. Source code package (reproducible)

AMO requires sources for listed add-ons. Generate with:

```bash
./scripts/package-amo-sources.sh
# → dist/store/dual-read-<version>-amo-sources.zip
```

The archive includes `AMO_BUILD.md` with exact rebuild steps. It **excludes**
`node_modules/`, `output/`, secrets, and local data dirs.

### 3. Consistency gate

```bash
./scripts/check-store-consistency.sh
```

## Listing copy

Use [`LISTING.en.md`](LISTING.en.md) / [`LISTING.zh-CN.md`](LISTING.zh-CN.md).  
Permission justifications: [`PERMISSIONS.md`](PERMISSIONS.md).

## Pre-submit checklist

- [ ] `strict_min_version` is `140.0`  
- [ ] `data_collection_permissions.required` includes `websiteContent` only as needed  
- [ ] Sources zip rebuilds to a functionally equivalent addon (`npm ci && npm run build:firefox`)  
- [ ] No `dev-settings.json` in sources or binary package  
- [ ] Firefox E2E smoke green: `npx playwright test --project=firefox-ext`  
- [ ] Manual smoke in Firefox 140+: temporary add-on or signed build → translate → restore  

## Notes for reviewers

> Dual Read is a bilingual page reader. Translation runs only after user action
> (toolbar, shortcut, or context menu). Remote APIs must be HTTPS; localhost HTTP
> is for an optional self-hosted cache proxy. Build from the attached sources using
> the included AMO_BUILD.md (Node 22, `npm ci`, `npm run build:firefox`).
