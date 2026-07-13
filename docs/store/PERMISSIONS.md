# Store permission justifications

Single purpose: **bilingual / replacement reading of web pages** the user chooses to translate.

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
| `optional_host_permissions: https://*/` | Call the **user-configured** remote OpenAI-compatible HTTPS API (or a remote self-hosted server). Requested only when the user configures / uses a remote origin—not granted for all sites at install. |

**Not requested at install:** broad `http://*/*` or “read and change all your data on all websites”.

## Data transmission (store privacy questionnaires)

| Data | Collected by Dual Read project? | Sent where? |
|------|----------------------------------|-------------|
| Page / selection text | No (project operators do not receive it) | Only to the API endpoint **the user configures** |
| API keys and custom HTTP headers | No | Stored only on the current device; sent only to the configured endpoint. Both are excluded from settings exports unless the user explicitly includes them. |
| Browsing history | No | — |
| Analytics / telemetry | No | — |

Remote endpoints must be **HTTPS**. HTTP is allowed only for loopback.

## Firefox AMO data collection

`browser_specific_settings.gecko.data_collection_permissions.required = ["websiteContent"]` because translating a page or selection transmits website text to the user’s configured LLM endpoint. This matches real behavior and AMO honesty requirements (Firefox ≥ 140).
