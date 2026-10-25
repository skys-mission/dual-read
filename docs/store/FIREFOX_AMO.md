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

This is required because translating a page, selection, or enabled YouTube captions
with adjacent context sends website text to the
**user-configured** LLM endpoint. Dual Read does not send that text to project-operated
telemetry. Keep AMO questionnaire answers identical to [`PRIVACY.md`](../../PRIVACY.md).

## Packages to upload

### 1. Built extension (unsigned ZIP)

Download `dual-read-extension-0.2.0-firefox.zip` from the published GitHub Release
and [verify it](../RELEASE.md#verify-a-download). Submit that CI-built package
for review and signing. The GitHub ZIP is not already signed and is not a
permanent-install XPI for Firefox release builds. See Mozilla's
[signing and distribution guide](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).

### 2. Source code package (reproducible)

Upload `dual-read-0.2.0-amo-sources.zip` from the **same** GitHub Release so
reviewers can reproduce the bundled/minified extension. Local source packaging
commands are in the [store overview](README.md) for preparation only.

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
- [ ] YouTube idle controls, start/stop, captions, seek, and default-off automation checked
- [ ] YouTube host access and caption transmission disclosed in questionnaire/review notes
- [ ] Signed installation/update consent and 0.1.x upgrade verified separately from temporary loading
- [ ] Outstanding real YouTube source checks reviewed in the [release checklist](../RELEASE.md#020-checks-and-known-limits)

## Notes for reviewers

> Dual Read is a bilingual reader for webpage text and YouTube captions.
> Translation starts on user action or explicitly enabled automation. YouTube
> site access is declared to show idle player controls; displaying them does not
> read captions or call the translation API. Subtitle automation is off by
> default and stored only on this device. Website text and adjacent caption
> context go only to the user's configured endpoint; YouTube cookies and signed
> caption URLs are not sent there. Remote APIs require HTTPS; loopback HTTP is
> supported for local services. Build the attached matching sources using
> AMO_BUILD.md (Node 22.12+ on 22.x, `npm ci`, `npm run build:firefox`).
