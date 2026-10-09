# Contributing to Dual Read

Thanks for helping improve Dual Read—an open-source, self-hostable bilingual web reader (browser extension + optional Go server).

- English project entry: [`README.md`](README.md) (CI badges + quick start)
- Full Chinese guide: [`README.zh-CN.md`](README.zh-CN.md)

## First principles

1. Prefer **site-wide compatibility** over one-site hacks.
2. Keep the permission model **minimal** (`activeTab` + on-demand inject; no install-time “read all sites”).
3. Do not commit secrets (`dev-settings.json`, API keys, `runtime.json` secrets).
4. Ship changes that are **testable**: unit tests for pure logic, Playwright fixtures for DOM/main path when behavior changes.

## Development setup

### Prerequisites

- Node.js **22+** (CI uses 22)
- Go **1.25.12+** (see `server/go.mod` toolchain)
- Make (optional but convenient)

### Extension

```bash
cd extension
npm ci
npm run compile
npm test
npm run lint
npm run build            # Chrome MV3 → output/chrome-mv3
npm run build:firefox    # Firefox MV3 → output/firefox-mv3
```

Dev / HMR:

```bash
make dev-extension           # Chrome
make dev-extension-firefox   # Firefox
```

Load unpacked from `extension/output/chrome-mv3` or `firefox-mv3`.

E2E (needs a prior build):

```bash
cd extension
npx playwright install --with-deps chromium firefox
npx playwright test --project=chromium-ext
npx playwright test --project=firefox-ext
```

### Server

```bash
cd server
go test ./...
../scripts/check-golangci.sh
go run ./cmd/dual-read-server   # needs OPENAI_API_KEY for live upstream
```

Docker smoke:

```bash
make docker-smoke
```

## Pull requests

1. Fork / branch from `main`.
2. Keep PRs focused (one concern per PR when possible).
3. Fill out the PR template.
4. Ensure locally:

   ```bash
   make test-extension    # compile + lint + vitest
   make test-server
   # If you touch DOM/translate paths:
   cd extension && npm run build && npx playwright test --project=chromium-ext
   ```

5. Do **not** include `extension/output/`, secrets, or personal `dev-settings.json`.

### Commit messages

Prefer short imperative subjects focused on **why**:

- `fix(extension): avoid reinject tearing down retry sessions`
- `feat(server): expose shadowRoots on PageResult`
- `docs: add privacy and security policies`

### DOM restoration changes

For a collector/renderer/session fix, establish the restoration contract before
editing production code: which node owns each source, which wrappers are omitted,
which page edits must survive, and what the available mutation records cannot
prove. Keep ambiguous ownership fallbacks separate from complete recovery claims.

- Reproduce on the pre-fix source and record the expected text, original/new node
  identities, order, attributes and removals. Derive expectations from page
  operations, independently of renderer matching and restoration helpers.
- Cross the affected structure with neighboring operations. For ordering, include
  ordinary, omitted, nested and multiple containers; permutations followed by
  insertion, replacement, deletion, wrapping and transfer. For text provenance,
  include split/normalize, edits on either side, empty and equal-valued slots.
- Exercise deferred and delivered mutation records, watching and paused sessions,
  repeated restoration and a mode switch. Run representative cases through normal
  collection on freshly built Chromium and Firefox artifacts; direct renderer
  tests alone do not establish session behavior.
- When another review finds an issue, compare against a saved pre-fix version or
  HEAD to distinguish a new regression from an uncovered boundary. Report the
  tested contract and remaining limits alongside suite results; a larger passing
  test count does not establish coverage of a different structure/operation pair.

## Code layout

| Path | Role |
|------|------|
| `extension/lib/` | Collector, renderer, scheduler, provider, cache, settings |
| `extension/entrypoints/` | background, popup, options, onboarding, unlisted content |
| `extension/e2e/` | Playwright fixtures (local mock API—no live providers in CI) |
| `server/internal/` | HTTP, auth, cache, config, upstream, admin |

## Documentation

- Product / privacy: [`PRIVACY.md`](PRIVACY.md)
- Security reports: [`SECURITY.md`](SECURITY.md)
- Server deploy: [`server/docs/DEPLOY.md`](server/docs/DEPLOY.md)

## Code of Conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
