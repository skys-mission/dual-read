# Dual Read — Bilingual Web Translation & YouTube Subtitles

**English** | [简体中文](README.zh-CN.md)

Dual Read is an **open-source browser translation extension for Chrome, Edge, and Firefox**. Translate web pages and YouTube captions while keeping the original text visible, using your own OpenAI-compatible API — including DeepSeek, OpenAI, or a local Ollama endpoint.

Use the extension on its own, or add the optional self-hosted Go caching proxy to reduce repeated API requests. **Configure a translation service before use**; third-party API usage may incur charges.

[![GitHub Release](https://img.shields.io/github/v/release/skys-mission/dual-read?logo=github&label=Release)](https://github.com/skys-mission/dual-read/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml)
[![Zero telemetry](https://img.shields.io/badge/Telemetry-none-success)](PRIVACY.md)

## Browser stores

**Version 0.2.0 is available on Edge Add-ons, Firefox Add-ons, and [GitHub Releases](https://github.com/skys-mission/dual-read/releases/tag/v0.2.0).** It adds YouTube bilingual subtitles and improves page layout, restoration, and caching. See the [changelog](CHANGELOG.md).

| Browser | Install Dual Read | Installation notes |
|---|---|---|
| Microsoft Edge | [Install from Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hpkdnnlmodeggabfieondnamlmamibik) | Store installation with automatic updates |
| Firefox | [Install from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/dual-read-translator/) | Desktop Firefox **140+**; automatic updates |
| Chrome | [Download the 0.2.0 ZIP](https://github.com/skys-mission/dual-read/releases/download/v0.2.0/dual-read-extension-0.2.0-chrome.zip) | Manual installation; follow [Load the extension](#load-the-extension) |

[Quick start](#quick-start) · [Features](#features) · [Supported APIs](#supported-apis) · [FAQ](#faq) · [Optional server](#optional-server) · [Development](#development)

## Quick start

1. **Install the extension** from the store for Edge or Firefox. For Chrome, use the ZIP and [manual installation steps](#load-the-extension).
2. **Configure your translation service** in the extension's Options: choose **Direct API**, enter the API base URL, API key, and model, then choose your target language. Save, grant access to the API origin when prompted, and use **Test connection**. For a keyless local endpoint or your own proxy, see [Supported APIs](#supported-apis).
3. **Start translating.** Click the extension icon and choose **Translate page**, or press `Alt+T`. For YouTube, open a desktop video with captions and click the bilingual button beside **CC**.

Page translation and subtitle translation have separate controls in the popup's **Page** and **Subtitles** tabs. YouTube subtitle translation is off by default.

## Why Dual Read?

- **Read foreign-language articles, documentation, and research pages** with the original text and translation together.
- **Learn with YouTube captions** by comparing the original subtitles with their translation.
- **Choose your provider and model**, including a local Ollama endpoint, through an OpenAI-compatible API.
- **Reuse translations** with the extension's local cache; add the optional proxy for server-side caching.
- **Inspect the source and control where text goes.** Apache 2.0 licensed, with zero telemetry by default and no project-operated translation backend required.

## Features

### Bilingual web page translation

- Keep the original text alongside translations, or switch to replacement mode.
- Translate visible content first and pick up dynamically added text as you browse.
- Restore the original page with `Alt+T`; switch display modes with `Alt+M`.
- Translate selected text from the right-click menu and read it in an overlay.
- Set per-site rules for automatic translation or sites you never want to translate.
- Reuse locally cached translations, retry failed requests automatically, and click persistent errors to retry.

### YouTube bilingual subtitles

Translate available manual or automatically generated captions on **desktop YouTube watch pages**. Enable translation with the bilingual button beside **CC** or the popup's **Subtitles** tab, using your configured API and target language.

Adjust subtitle language, size, and position in Options. Automatic subtitle translation is an optional setting for this device and is **off by default**. Idle controls do not read captions or send translation requests.

Live streams, Shorts, mobile pages, embedded players, and picture-in-picture subtitles are not supported. Dual Read does not record audio or generate subtitles from speech. If a complete caption track is unavailable, it may fall back to translating visible native captions. Availability and latency depend on YouTube and your provider.

### Language and settings support

| Setting | Available options |
|---|---|
| Interface languages | English, Simplified Chinese, Traditional Chinese, Russian, Spanish, French |
| Translation target languages | Simplified Chinese, English, Russian, Spanish, French |
| Connection settings | API base URL, model, API key, and local-only custom HTTP headers |
| Settings transfer | Import/export; API keys and custom headers are excluded unless explicitly included |

## Supported APIs

Webpage and subtitle translation use the **OpenAI-compatible Chat Completions API**. Choose the connection route that matches your setup:

| Translation service | Connection route in Options | API key |
|---|---|---|
| DeepSeek, OpenAI, or another compatible provider | **Direct API** | Required |
| A keyless local endpoint, such as Ollama | **Dual Read Proxy**, with your local endpoint's API base and model | Can be blank if the endpoint requires no key |
| Your own `dual-read-server` | **Dual Read Proxy** | Required when server authentication is enabled |

Enter the provider's API base URL, not the full completion URL: Dual Read appends `/chat/completions`. For example, the default DeepSeek base is `https://api.deepseek.com`. Choose a model available from your provider. Remote endpoints must use **HTTPS**; HTTP is supported only on loopback (`localhost`, `127.0.0.1`, or `::1`).

Translation quality, speed, and costs depend on your model, provider, and network. API compatibility does not guarantee identical behavior across models.

## FAQ

### Do I need to deploy a server?

No. The extension connects directly to your configured API. The [optional server](#optional-server) adds caching, request coalescing, and access controls; it is not required for webpage or YouTube translation.

### Is Dual Read free to use?

The source code is available under the [Apache 2.0 license](LICENSE). Dual Read does not include a translation service or API credits. Third-party providers may charge for usage; a local model uses your hardware. Cache savings depend on cache hits and provider pricing.

### Can I use a local Ollama model?

Yes, through Ollama's OpenAI-compatible endpoint. Set its API base and an installed model in Options. For a keyless endpoint, choose **Dual Read Proxy** so the API key can be blank; this also works without running `dual-read-server`. A local cache alone does not make a remote API local.

### Where do my text and API key go?

Page, selection, and enabled subtitle text goes to **the endpoint you configure**. Your own proxy can forward requests to its configured upstream. The project maintainers do not receive your browsing content or API keys, and Dual Read has zero telemetry by default. API keys and custom headers are stored locally and used in requests to your endpoint; some non-secret preferences can sync through your browser account. See the [privacy policy](PRIVACY.md).

### Why does the extension request site access?

Manual webpage translation uses access to the tab you invoke. Remote API connections and per-site automatic translation request access to the relevant origins. YouTube access enables idle player controls and, after you enable translation, caption reading. Browsers may request acceptance when installing or upgrading. See [permissions and data handling](PRIVACY.md#what-the-extension-can-access).

### What should I do after upgrading from 0.1.x?

Accept YouTube site access if prompted, then refresh already-open YouTube pages. For a manual installation, reload the extension from its installed directory first. Subtitle translation still needs to be enabled separately. See the [0.2.0 changes and upgrade notes](CHANGELOG.md).

## Optional server

`dual-read-server` is a self-hosted Go caching proxy with local BigCache or shared Valkey caching, identical-request coalescing, API keys, model aliases, and an admin UI for cache and request activity.

For a source run, use the Go toolchain specified in [`server/go.mod`](server/go.mod) and run from the repository root:

```bash
cd server
export OPENAI_API_KEY=sk-your-key
go run ./cmd/dual-read-server
```

Defaults: DeepSeek upstream, `http://127.0.0.1:8080`, local cache enabled, admin at `/admin`. In the extension, choose **Dual Read Proxy** and set the API base to `http://127.0.0.1:8080/v1`; a client key is optional until server authentication is enabled.

[Published binaries](https://github.com/skys-mission/dual-read/releases) do not require Go. See the [server guide](server/README.md), [Docker and production deployment](server/docs/DEPLOY.md), and [security guidance](SECURITY.md) before exposing a server beyond loopback.

## Load the extension

For normal Edge and Firefox installation and automatic updates, use the [browser stores](#browser-stores). These steps are for Chrome or a manual test installation.

Download the matching ZIP and `SHA256SUMS` from the [0.2.0 release](https://github.com/skys-mission/dual-read/releases/tag/v0.2.0), and follow the [download verification guide](docs/RELEASE.md#verify-a-download):

- **Chrome / Edge:** use `dual-read-extension-0.2.0-chrome.zip`. Extract it, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select the extracted directory containing `manifest.json`.
- **Firefox 140+:** the GitHub ZIP, `dual-read-extension-0.2.0-firefox.zip`, is **unsigned**. Extract it, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`. This lasts until Firefox restarts; normal installation and automatic updates require the signed store version. See Mozilla's [temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

## Development

The extension uses TypeScript and WXT; the optional server uses Go. To build the extension, use Node.js **22.12+** on the 22.x line, or supported 24.x / 26+, and run from the repository root:

```bash
npm --prefix extension ci
make build-extension
```

Load `extension/output/chrome-mv3` in Chrome/Edge, or temporarily load `extension/output/firefox-mv3/manifest.json` in Firefox, using the [manual installation steps](#load-the-extension).

See [CONTRIBUTING.md](CONTRIBUTING.md) for hot reload, tests, and the DOM restoration contract, and the [Makefile](Makefile) for common commands. CI selects TypeScript, lint, unit, browser build/E2E, Go race/coverage, and store metadata checks according to changed paths; documentation-only changes skip unrelated builds and tests.

## Documentation

| Guide | What it covers |
|---|---|
| [简体中文](README.zh-CN.md) | Chinese installation and usage guide |
| [Privacy](PRIVACY.md) | Data destinations, storage, and browser permissions |
| [Security](SECURITY.md) | Vulnerability reporting and server hardening |
| [Changelog](CHANGELOG.md) | Version changes and upgrade notes |
| [Server guide](server/README.md) | Installation, configuration, caching, and authentication |
| [Deployment](server/docs/DEPLOY.md) | Containers, Valkey, TLS, and production deployment |
| [Contributing](CONTRIBUTING.md) | Development setup, tests, and PR expectations |
| [Releases and verification](docs/RELEASE.md) | Release process, checksums, and attestations |
| [Performance lab](docs/PERF_LAB.md) | Performance budgets and validation |
| [Firefox E2E](docs/FIREFOX_E2E.md) | Firefox browser test setup |

## Contributing

[Report a bug](https://github.com/skys-mission/dual-read/issues/new?template=bug_report.yml) or [request a feature](https://github.com/skys-mission/dual-read/issues/new?template=feature_request.yml). Before contributing code or documentation, read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). PR titles use Conventional Commits, such as `docs: clarify installation`.

## License

[Apache License 2.0](LICENSE).
