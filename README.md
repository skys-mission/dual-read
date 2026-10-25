# Dual Read

[![CI](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml)
[![Nightly](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml)
[![Release](https://github.com/skys-mission/dual-read/actions/workflows/release.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/release.yml)
[![GitHub Release](https://img.shields.io/github/v/release/skys-mission/dual-read?logo=github&label=Release)](https://github.com/skys-mission/dual-read/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](extension/tsconfig.json)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](extension/wxt.config.ts)
[![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)](docs/FIREFOX_E2E.md)
[![Playwright](https://img.shields.io/badge/E2E-Playwright-2EAD33?logo=playwright&logoColor=white)](extension/playwright.config.ts)
[![Vitest](https://img.shields.io/badge/Unit-Vitest-6E9F18?logo=vitest&logoColor=white)](extension/vitest.config.ts)
[![golangci-lint](https://img.shields.io/badge/Lint-golangci--lint-3A464F)](server/.golangci.yml)
[![Zero telemetry](https://img.shields.io/badge/Telemetry-none-success)](PRIVACY.md)

**English** | [中文](README.zh-CN.md)

Open-source, self-hostable **bilingual web reading**: a browser extension plus an optional Go caching proxy (`dual-read-server`). Translate web pages and YouTube captions in Chrome, Edge, or Firefox using an OpenAI-compatible LLM API, such as DeepSeek, OpenAI, or a local Ollama endpoint.

The extension translates text through the API you configure. The server adds local / Valkey caching to reduce repeated upstream requests; savings depend on cache hits and the provider you use.

**Privacy in one line:** Dual Read has **zero telemetry by default**. Page, selection, and enabled subtitle text goes only to **the LLM / server you configure**. See [PRIVACY.md](PRIVACY.md).

This guide describes **0.2.0**, currently being prepared for release. It adds
YouTube bilingual subtitles and improves page layout, restoration, and cache
handling. See the [changelog](CHANGELOG.md) for changes and upgrade notes.

## Browser stores

GitHub Releases and browser stores are published separately. Existing store
listings below may still provide an earlier version; check the version on the
listing before installing for a 0.2.0 feature. Once published, the **v0.2.0**
assets will be available on [GitHub Releases](https://github.com/skys-mission/dual-read/releases).

| Browser | Installation channel |
|---|---|
| Chrome | Load a GitHub Release ZIP or a local build; no Chrome Web Store link is published here yet |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/dual-read-translator/) (Firefox **140+**) |
| Microsoft Edge | [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hpkdnnlmodeggabfieondnamlmamibik) |

<!-- TODO: add a screenshot or GIF here -->
<!-- ![Dual Read demo](docs/assets/demo.gif) -->

---

## Table of Contents

- [Why Dual Read?](#why-dual-read)
- [Features](#features)
- [Quick Start](#quick-start)
- [Browser stores](#browser-stores)
- [Documentation](#documentation)
- [CI & Quality Gates](#ci--quality-gates)
- [Make Targets](#make-targets-common)
- [Verify Server](#verify-server)
- [Contributing](#contributing)
- [License](#license)

---

## Why Dual Read?

- **Read foreign-language docs, papers, and news** with side-by-side bilingual display
- **Learn a language** by keeping the original text alongside the translation
- **Cut LLM costs** with the caching proxy — repeated paragraphs hit cache, not the API
- **Choose where text goes** — use your own server or a provider whose data policy you trust
- **Inspect and self-host** — Apache 2.0 source, with no project-operated translation service required

---

## Features

### Browser extension (Chrome / Edge / Firefox, Manifest V3)

- Bilingual overlay or replace mode
- YouTube bilingual subtitles (new in 0.2.0): open a desktop watch page
  and click the bilingual button beside CC to enable translation. Uses your
  existing API and target language. Optional subtitle settings are language,
  size, position, and automatic translation on YouTube; automatic translation is off by default.
  Idle player controls appear automatically using the manifest's YouTube-only
  host access, without a toolbar click or translation request. Browsers may ask
  for this site permission when installing or updating the extension.
  Supports available manual/automatic captions. Live streams, Shorts, mobile
  pages, embedded players, audio transcription, and picture-in-picture subtitles
  are outside the current scope.
- On-demand page translation (`activeTab` + `scripting`); idle controls load automatically only on YouTube
- Viewport-first lazy translation + MutationObserver incremental indexing
- Automatic retry with backoff; click-to-retry on persistent failures
- Local translation cache (memory + `chrome.storage.local` LRU)
- Selection overlay + context menu
- Shortcuts: `Alt+T` translate/restore, `Alt+M` mode toggle
- Per-site rules (auto-translate / blocklist)
- Local-only custom headers with explicit opt-in export
- UI locales: English, Simplified Chinese, Traditional Chinese, Russian, Spanish, French · targets: zh-CN, en, ru, es, fr

### Optional server

- OpenAI-compatible reverse proxy (default upstream: DeepSeek)
- Singleflight coalescing, BigCache / Valkey, auth keys, model aliases
- Admin UI, `/livez` `/readyz` `/metrics`, hardened Docker image

---

## Quick start

### A — Direct API (no server)

1. Get an OpenAI-compatible endpoint + API key.
2. Load the extension (below).
3. In Options set API base, key, and model (e.g. `https://api.deepseek.com`).

Use **Direct API** mode for a provider that requires an API key. Remote endpoints
must use HTTPS; HTTP is supported only on loopback. For a keyless local endpoint
such as Ollama, choose **Dual Read Proxy** mode and set its API base and model.

### B — Local server + extension (recommended)

For a source run, use Go **1.26.10+** (see [`server/go.mod`](server/go.mod))
and run the following from the repository root. Published server binaries are
also available through [GitHub Releases](https://github.com/skys-mission/dual-read/releases).

```bash
cd server
export OPENAI_API_KEY=sk-your-key
go run ./cmd/dual-read-server
```

Defaults: `http://127.0.0.1:8080`, local cache on, admin at `/admin`.  
Production deploy: [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md).

### Load the extension

**From a published GitHub Release:** select the intended release version and
download its browser ZIP plus `SHA256SUMS` (verification:
[`docs/RELEASE.md`](docs/RELEASE.md#verify-a-download)). For 0.2.0, use
`dual-read-extension-0.2.0-chrome.zip` for Chrome/Edge or
`dual-read-extension-0.2.0-firefox.zip` for Firefox, once available.

- Chrome/Edge: extract the Chrome ZIP, open `chrome://extensions` or
  `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**.
  Select the extracted directory containing `manifest.json`.
- Firefox **140+**: the GitHub ZIP is **unsigned**. Extract it, open
  `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
  and select `manifest.json`. This lasts until Firefox restarts; normal
  installation and automatic updates require the signed store version.
  See Mozilla's [temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

**Build from source:** use Node.js **22.12+** on the 22.x line, or supported
24.x / 26+. Run from the repository root:

```bash
npm --prefix extension ci
make build-extension
```

Load `extension/output/chrome-mv3` in Chrome/Edge, or temporarily load
`extension/output/firefox-mv3/manifest.json` in Firefox as above.
For development with HMR, see [`CONTRIBUTING.md`](CONTRIBUTING.md#extension).

When using the server, choose **Dual Read Proxy** mode and point the extension at
`http://127.0.0.1:8080/v1` (API key optional until server auth is enabled).

Copy `extension/dev-settings.json.example` for local imports if you like—**never** put secrets under `extension/public/` (that directory is packaged).

### Use YouTube bilingual subtitles

After configuring the API, open a desktop YouTube video with captions. Click the
bilingual button beside **CC**, or open the extension popup and use its
**Subtitles** tab. The **Page** tab controls webpage translation separately.
Subtitle language, size, position, and optional automatic translation are in
Options. Automatic translation is off by default and stays local to this device.

After upgrading from 0.1.x, accept YouTube site access if the browser prompts,
then refresh already-open YouTube pages. Reload an unpacked extension from its
installed directory before refreshing. If YouTube does not provide a usable
caption track, Dual Read may fall back to visible native captions; it cannot
create subtitles from audio. Source availability and translation latency depend
on YouTube and your configured provider.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [README.zh-CN.md](README.zh-CN.md) | Full Chinese guide |
| [PRIVACY.md](PRIVACY.md) | What data leaves the browser and where |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting & operator hardening |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, tests, PR expectations |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |
| [CHANGELOG.md](CHANGELOG.md) | Notable changes |
| [server/README.md](server/README.md) | Server configuration |
| [server/docs/DEPLOY.md](server/docs/DEPLOY.md) | Containers & production deploy |
| [docs/store/](docs/store/) | Chrome / Edge / Firefox store checklists & listing copy |
| [docs/RELEASE.md](docs/RELEASE.md) | Tag release, verify, attestations |
| [docs/PERF_LAB.md](docs/PERF_LAB.md) | Performance budget lab |
| [docs/FIREFOX_E2E.md](docs/FIREFOX_E2E.md) | Firefox E2E (Gecko harness notes) |

---

## CI & quality gates

Every PR / push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml),
selecting checks for the changed paths. Documentation-only changes skip unrelated
tests; CI configuration changes and manual dispatches run the full suite.

| Job | Checks |
|-----|--------|
| **Extension** | `tsc`, ESLint, runtime `npm audit`, Vitest, Chrome + Firefox builds, artifact secret scan, Playwright E2E |
| **Server** | golangci-lint (including `govet`), combined race/coverage tests, coverage floor, `govulncheck`, Docker smoke |
| **Server-only integration** | Chromium extension against the real proxy, without the full layout suite |
| **Store** | Listing / privacy / permission consistency |

Nightly adds daily `PERF_STRICT` + `PERF_FULL` performance budgets and a weekly release dry-run with SBOMs ([`nightly.yml`](.github/workflows/nightly.yml)). Manual dispatch runs both.
Tagged `vX.Y.Z` releases build zips, multi-arch binaries, GHCR image, checksums, and attestations ([`release.yml`](.github/workflows/release.yml)).

---

## Make targets (common)

```bash
make test                 # server + extension unit tests
make test-e2e             # Playwright (build + Chromium/Firefox)
make test-e2e-perf        # perf budget lab (Chromium)
make check-golangci       # Go lint
make check-npm-audit      # runtime npm audit gate
make sbom                 # CycloneDX + module SBOM → dist/sbom/
make check-store          # store listing / privacy / permission consistency
VERSION=0.2.0 REQUIRE_PACKAGE_MATCH=1 make check-release  # version + changelog gate
make package-amo-sources  # Firefox AMO sources zip → dist/store/
make assemble-release     # flatten dist/release/ + SHA256SUMS
VERSION=0.2.0 make release-dry-run  # build + verify release bundle (no publish)
make docker-smoke         # non-root read-only container + /livez
```

---

## Verify server

```bash
curl -s http://127.0.0.1:8080/livez
curl -s http://127.0.0.1:8080/readyz
curl -s http://127.0.0.1:8080/health
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

- Report bugs via [Issues](https://github.com/skys-mission/dual-read/issues/new?template=bug_report.yml)
- Request features via [Feature Request](https://github.com/skys-mission/dual-read/issues/new?template=feature_request.yml)
- PRs must follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=skys-mission/dual-read&type=Date)](https://star-history.com/#skys-mission/dual-read&Date)

---

## License

[Apache License 2.0](LICENSE)

By contributing, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and [Contributing](CONTRIBUTING.md) guidelines.
