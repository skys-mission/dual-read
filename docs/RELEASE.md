# Releasing Dual Read

Tag `vX.Y.Z` on `main` triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Dry-run (no tag, no publish)

Validates gates + builds the same artifact set as a release (checksums verified). Does **not** create a GitHub Release, attest, or push GHCR.

```bash
make release-dry-run

# Or pick a specific version
VERSION=0.1.0 ./scripts/release-dry-run.sh
```

Nightly CI also runs this: [`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) (`workflow_dispatch` or cron).

## Before you tag

1. Cut `CHANGELOG.md`: move Unreleased notes into `## [X.Y.Z] - YYYY-MM-DD`.
2. `make check-store` and prefer green CI on `main`. This verifies all six manifest locale catalogs have matching keys and substitutions.
3. `VERSION=X.Y.Z make check-release` (after drafting the changelog section).
4. Optionally `VERSION=X.Y.Z make release-dry-run` once more.
5. Tag and push (CI publishes):

```bash
git tag -a vX.Y.Z -m "Dual Read X.Y.Z"
git push origin vX.Y.Z
```

Do **not** upload local `extension/output/` or `dist/` to the stores or GitHub Release — only CI artifacts.

## What CI publishes

| Asset | Notes |
|-------|--------|
| `dual-read-extension-*-chrome.zip` | Chrome / Edge store upload |
| `dual-read-extension-*-firefox.zip` | Firefox AMO signed upload |
| `dual-read-*-amo-sources.zip` | AMO source package |
| `dual-read-server-*` | linux/darwin/windows binaries (`version` subcommand shows buildinfo) |
| `sbom-*.json` | CycloneDX / Go module SBOM |
| `SHA256SUMS` + `VERIFY.md` | Checksums + attestation verify hints |
| `ghcr.io/<owner>/dual-read-server:X.Y.Z` | Multi-arch (`linux/amd64,linux/arm64`) |

## Verify a download

```bash
shasum -a 256 -c SHA256SUMS
gh attestation verify ./dual-read-server-linux-amd64 --repo skys-mission/dual-read
./dual-read-server-linux-amd64 version
```

## Manual / local packaging (not for public release)

```bash
VERSION=1.2.3 COMMIT=$(git rev-parse --short HEAD) make build-server
VERSION=1.2.3 ./scripts/set-release-version.sh
make build-extension
make package-amo-sources
./scripts/generate-sbom.sh
VERSION=1.2.3 ./scripts/assemble-release.sh
```
