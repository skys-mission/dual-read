# Chrome Web Store — Dual Read

Use this checklist when submitting or updating the extension on the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

Canonical privacy policy URL (public HTTPS):

```text
https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md
```

## Single purpose

**One purpose only:** help the user read web pages bilingually (or with replaced text) using an API they configure.

Do **not** advertise unrelated features (PDF, subtitles, shopping, VPN, ads) in the listing.

## Package to upload

1. From a clean tree:

   ```bash
   make build-extension
   ./scripts/check-store-consistency.sh
   ```

2. Upload the Chrome zip from `dist/` or `extension/output/*.chrome.zip` (exact name from WXT).
3. Confirm `./scripts/check-extension-artifacts.sh` passed (no `dev-settings.json`, no WXT reload CSP).

## Listing copy

Ready-to-paste text: [`LISTING.en.md`](LISTING.en.md) · [`LISTING.zh-CN.md`](LISTING.zh-CN.md)

| Field | Guidance |
|-------|----------|
| Name | Dual Read Translator (matches `_locales`) |
| Short description | ≤ 132 characters; see listing files |
| Detailed description | Paste long description; keep single-purpose wording |
| Category | Productivity / Tools |
| Language | English (+ Chinese if you publish localized listing) |

## Privacy practices (dashboard)

Answer consistently with [`PRIVACY.md`](../../PRIVACY.md) and [`PERMISSIONS.md`](PERMISSIONS.md):

| Question | Answer |
|----------|--------|
| Does the extension collect user data? | **Yes** — website content (page/selection text) is processed for translation. |
| Who receives it? | **Only the endpoint the user configures** (BYOK LLM or self-hosted server). Dual Read maintainers do not operate a default cloud that receives page text. |
| Is data sold? | **No.** |
| Is data used for purposes unrelated to the extension’s single purpose? | **No.** |
| Remote code? | **No** (no eval of remote scripts; translation strings rendered as text). |
| Transfer encryption | **HTTPS** required for remote APIs; HTTP only for localhost. |

### Permission justifications

Paste from [`PERMISSIONS.md`](PERMISSIONS.md) into the “Justify permissions” fields.

## Screenshots / assets (prepare manually)

Store policy requires realistic UI screenshots. Capture from a production build:

1. Popup — translate controls on a sample article  
2. Bilingual mode — original + translation visible  
3. Options — API / provider setup (no real API keys visible)  
4. Onboarding — first-run connection path  
5. (Optional) Replace mode  

Recommended size: **1280×800** or **640×400**. Use icons from `extension/public/icons/`.

## Pre-submit checklist

- [ ] Version in `extension/package.json` / manifest matches the upload  
- [ ] Short + detailed description match single purpose  
- [ ] Privacy URL opens and matches dashboard answers  
- [ ] Permission justifications pasted  
- [ ] HTTPS-only remote endpoint policy stated  
- [ ] Artifact policy clean (`check-extension-artifacts.sh`)  
- [ ] Store consistency script green (`check-store-consistency.sh`)  
- [ ] Manual smoke: install zip → Options → translate example.com → restore  

## Reviewer notes (optional field)

Suggested text:

> Dual Read translates the active tab on user action using an OpenAI-compatible API configured by the user (or a local dual-read-server). Content scripts are injected on demand via `activeTab` + `scripting`; we do not request host access to all websites at install time. Optional `https://*/` is requested only to reach the user’s API. Source and privacy policy: https://github.com/skys-mission/dual-read
