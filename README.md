# Dual Read

[![CI](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/ci.yml)
[![Nightly](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/nightly.yml)
[![Release](https://github.com/skys-mission/dual-read/actions/workflows/release.yml/badge.svg)](https://github.com/skys-mission/dual-read/actions/workflows/release.yml)
[![GitHub Release](https://img.shields.io/github/v/release/skys-mission/dual-read?logo=github&label=Release)](https://github.com/skys-mission/dual-read/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white)](server/go.mod)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](extension/tsconfig.json)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](extension/wxt.config.ts)
[![Firefox](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)](docs/FIREFOX_E2E.md)
[![Playwright](https://img.shields.io/badge/E2E-Playwright-2EAD33?logo=playwright&logoColor=white)](extension/playwright.config.ts)
[![Vitest](https://img.shields.io/badge/Unit-Vitest-6E9F18?logo=vitest&logoColor=white)](extension/vitest.config.ts)
[![golangci-lint](https://img.shields.io/badge/Lint-golangci--lint-3A464F)](server/.golangci.yml)
[![Zero telemetry](https://img.shields.io/badge/Telemetry-none-success)](PRIVACY.md)

**English** | [中文](README.zh-CN.md)

Open-source, self-hostable **bilingual web reading**: a browser extension plus an optional Go caching proxy (`dual-read-server`). Translate any webpage in Chrome, Edge, or Firefox with AI-powered parallel bilingual display — no vendor lock-in, works with DeepSeek, OpenAI, Ollama, or any OpenAI-compatible LLM API.

The extension translates pages through any OpenAI-compatible API. The server adds local / Valkey caching and only calls the upstream LLM on cache misses—cutting latency and cost by up to 90% on repeat content.

**Privacy in one line:** Dual Read has **zero telemetry by default**. Page text goes only to **the LLM / server you configure**. See [PRIVACY.md](PRIVACY.md).

<!-- TODO: add a screenshot or GIF here -->
<!-- ![Dual Read demo](docs/assets/demo.gif) -->

---

## Table of Contents

- [Why Dual Read?](#why-dual-read)
- [Features](#features)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [CI & Quality Gates](#ci--quality-gates)
- [Make Targets](#make-targets-common)
- [Verify Server](#verify-server)
- [Contributing](#contributing)
- [License](#license)

---

## Why Dual Read?

| | Dual Read | Immersive Translate | Readwise Reader |
|---|---|---|---|
| Open source | Apache 2.0 | Partial | No |
| Self-hostable caching proxy | Yes | No | No |
| LLM provider | Any OpenAI-compatible | Limited | Built-in only |
| Telemetry | Zero | Yes | Yes |
| Manifest V3 | Yes | Yes | N/A |
| Cost control | Cache + singleflight | No | Subscription |

- **Read foreign-language docs, papers, and news** with side-by-side bilingual display
- **Learn a language** by keeping the original text alongside the translation
- **Cut LLM costs** with the caching proxy — repeated paragraphs hit cache, not the API
- **Stay private** — your reading never leaves your infrastructure

---

## Features

### Browser extension (Chrome / Edge / Firefox, Manifest V3)

- Bilingual overlay or replace mode
- On-demand content-script injection (`activeTab` + `scripting`)
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

### B — Local server + extension (recommended)

```bash
cd server
export OPENAI_API_KEY=sk-your-key
go run ./cmd/dual-read-server
```

Defaults: `http://127.0.0.1:8080`, local cache on, admin at `/admin`.  
Production deploy: [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md).

### Load the extension

```bash
cd extension && npm ci
make dev-extension          # or: npm run build && load output/chrome-mv3
```

Chrome/Edge: `chrome://extensions` → Load unpacked → `extension/output/chrome-mv3`.  
Firefox: `npm run build:firefox` → load `extension/output/firefox-mv3` (min Firefox **140**).

Point the extension at `http://127.0.0.1:8080/v1` when using the server (API key optional until server auth is enabled).

Copy `extension/dev-settings.json.example` for local imports if you like—**never** put secrets under `extension/public/` (that directory is packaged).

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
| [docs/store/](docs/store/) | Chrome / Firefox store checklists & listing copy |
| [docs/RELEASE.md](docs/RELEASE.md) | Tag release, verify, attestations |
| [docs/PERF_LAB.md](docs/PERF_LAB.md) | Performance budget lab |
| [docs/FIREFOX_E2E.md](docs/FIREFOX_E2E.md) | Firefox E2E (Gecko harness notes) |

---

## CI & quality gates

Every PR / push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Job | Checks |
|-----|--------|
| **Extension** | `tsc`, ESLint, runtime `npm audit`, Vitest, Chrome + Firefox builds, artifact secret scan, Playwright E2E |
| **Server** | `go vet`, golangci-lint, race tests, coverage floor, `govulncheck` |
| **Store** | Listing / privacy / permission consistency |
| **SBOM** | CycloneDX (extension) + Go module SBOM |

Nightly adds `PERF_STRICT` + `PERF_FULL` performance budgets and a release dry-run ([`nightly.yml`](.github/workflows/nightly.yml)).  
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
make check-release        # VERSION + CHANGELOG + package.json gate (e.g. VERSION=0.1.0)
make package-amo-sources  # Firefox AMO sources zip → dist/store/
make assemble-release     # flatten dist/release/ + SHA256SUMS
make release-dry-run      # build + verify release bundle (no publish)
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
