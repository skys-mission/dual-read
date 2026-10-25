# Chrome Web Store — Dual Read

Use this checklist when submitting or updating the extension on the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
See Google's [publishing guide](https://developer.chrome.com/docs/webstore/publish)
for the current dashboard flow.

Canonical privacy policy URL (public HTTPS):

```text
https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md
```

## Single purpose

**One purpose only:** bilingual reading of user-selected web content using an
API they configure: webpage translation and YouTube caption translation.

0.2.0 includes YouTube bilingual subtitles. Keep the listing within the shipped
scope; PDF translation, audio transcription, shopping, VPN, and ad blocking
are not included.

## Package to upload

1. Download `dual-read-extension-0.2.0-chrome.zip` and `SHA256SUMS` from the
   published GitHub Release. [Verify the asset](../RELEASE.md#verify-a-download).
2. Upload that CI-built Chrome ZIP. Local builds are for validation; see the
   [store overview](README.md) for the common package policy.
3. Confirm the release's artifact policy and store consistency checks passed
   (no `dev-settings.json`, no WXT reload CSP).

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
| Does the extension collect user data? | **Yes** — website content (page/selection text and enabled YouTube captions with adjacent context) is processed for translation. |
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
6. YouTube bilingual captions and the idle control, with default-off automation

Use the version being submitted and remove real API keys. Existing synthetic
player fixtures in test reports must not be presented as live YouTube captures.

Screenshot sizes: **1280×800** or **640×400**; see the current
[image requirements](https://developer.chrome.com/docs/webstore/images).
Use icons from `extension/public/icons/`.

## Pre-submit checklist

- [ ] Version in `extension/package.json` / manifest matches the upload  
- [ ] Short + detailed description match single purpose  
- [ ] Privacy URL opens and matches dashboard answers  
- [ ] Permission justifications pasted  
- [ ] HTTPS-only remote endpoint policy stated  
- [ ] Artifact policy clean (`check-extension-artifacts.sh`)  
- [ ] Store consistency script green (`check-store-consistency.sh`)  
- [ ] Manual smoke: install zip → Options → translate example.com → restore  
- [ ] YouTube smoke: idle button without translation traffic → enable → seek → stop/restore CC
- [ ] New YouTube access and default-off automation are explained in review notes
- [ ] Upgrade from 0.1.x: permission acceptance and refresh behavior checked

## Reviewer notes (optional field)

Suggested text:

> Dual Read provides bilingual reading of webpages and YouTube captions through
> the user's configured OpenAI-compatible API or self-hosted server. Manual page
> translation uses `activeTab` + `scripting`; optional origin access supports the
> configured HTTPS API and explicitly enabled site rules. YouTube-only host
> access displays idle player controls without reading captions or sending
> translation requests. Subtitle translation starts on user action or separately
> enabled device-local automation, which is off by default. Caption text and
> adjacent context go to the configured API; YouTube cookies and signed caption
> URLs do not. No all-site host grant is requested at install. Source and privacy
> policy: https://github.com/skys-mission/dual-read
