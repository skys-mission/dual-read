# Store permission justifications

Single purpose: **bilingual reading of web content** the user chooses to translate, including webpage text and YouTube captions.

These texts are meant to be pasted into Chrome Web Store and Firefox AMO review forms.
Keep them aligned with [`PRIVACY.md`](../../PRIVACY.md) and `extension/wxt.config.ts`.

## Manifest permissions

| Permission | Justification |
|------------|---------------|
| `storage` | Persist user settings (API base, model, languages, site rules) and a local translation cache so repeated text does not re-query the API. API keys and custom HTTP headers are device-local and not browser-synced. |
| `activeTab` | Access the tab the user invokes (toolbar button / shortcut) so translation can run without requesting all-site access at install time. |
| `scripting` | Inject the translation engine **on demand** into the active tab (and reachable same-origin frames). The engine is an unlisted script—not a permanent content script on every site. |
| `contextMenus` | Provide “Translate selection” from the browser context menu. |

## Host permissions

| Permission | Justification |
|------------|---------------|
| `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*` | Allow the optional self-hosted `dual-read-server` on loopback over HTTP. |
| `https://www.youtube.com/*` | Display idle bilingual controls automatically on desktop YouTube video pages, including homepage-to-video navigation. Opening the toolbar popup is not required. This access does not enable subtitle translation. |
| `optional_host_permissions: https://*/` | Call the **user-configured** remote HTTPS API or enable explicitly chosen site automation. No all-site grant at install. |

**Not requested at install:** broad `http://*/*` or “read and change all your data on all websites”.

## Data transmission (store privacy questionnaires)

| Data | Collected by Dual Read project? | Sent where? |
|------|----------------------------------|-------------|
| Page / selection / enabled subtitle text and short adjacent context | No (project operators do not receive it) | Only to the API endpoint **the user configures** |
| API keys and custom HTTP headers | No | Stored only on the current device; sent only to the configured endpoint. Both are excluded from settings exports unless the user explicitly includes them. |
| Browsing history | No | — |
| Analytics / telemetry | No | — |

Remote endpoints must be **HTTPS**. HTTP is allowed only for loopback.

The manifest declares YouTube host access so a top-frame startup script displays
idle player controls on video pages without a toolbar click. It does so without
reading captions, changing CC or contacting the translation service. Turning
automatic translation off retains these controls; withholding host access removes
future injection and idle controls. Subtitle requests use the existing
YouTube page session; cookies and signed caption URLs are never sent to the
translation API. There is no audio recording or transcription permission.
Automatic translation remains an off-by-default, device-local preference.
Browsers may require consent to the YouTube permission during installation or
an upgrade from versions that declared it only as optional.

## Firefox AMO data collection

`browser_specific_settings.gecko.data_collection_permissions.required = ["websiteContent"]` because translating a page, selection, or enabled captions transmits website text to the user’s configured LLM endpoint. This matches real behavior and AMO honesty requirements (Firefox ≥ 140).
