# Releasing Dual Read

Pushing a tag matching `vX.Y.Z` triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Create release tags from the intended, verified commit on `main`. The workflow
publishes a GitHub Release and GHCR image; it does not submit to browser stores.

## 0.2.0 release sequence

| Stage | Documentation and release work |
|-------|--------------------------------|
| 1. Before GitHub Releases | Commit the 0.2.0 README, changelog, installation/upgrade instructions, privacy disclosures, and store submission copy. Keep existing store links without claiming that they already offer 0.2.0. |
| 2. GitHub Releases | Finalize the changelog date, check versions and CI, then tag. Verify the published assets and use the release notes to explain installation while store updates are pending. |
| 3. Browser stores | Submit the same CI-built browser packages and matching AMO sources. Use the [store checklists](store/README.md); record each store's review result separately. |
| 4. After store availability | Verify the publicly installable version in each store, then update both READMEs and release notes with confirmed versions, links, and installation guidance. |

This document prepares stage 1. A GitHub Release, a submitted store update, and
a publicly available store update are separate milestones.

## Dry-run (no tag, no publish)

Validates version/store gates and builds extension ZIPs, server binaries, AMO
sources, SBOMs, release notes, and checksums. It does **not** create a GitHub
Release, attest, build/push the GHCR image, or run the full browser test suite.

```bash
VERSION=0.2.0 make release-dry-run
```

Always pass the intended version: `scripts/release-dry-run.sh` currently defaults
to **0.1.0**, including when called by Nightly without `VERSION`. Its temporary
package-version rewrite means a passing dry-run does not establish that the
committed version matches the intended tag. Run the strict gate below first.

Nightly CI also runs this weekly, on Sunday at 16:00 UTC (Monday 00:00 China time),
or on `workflow_dispatch`: [`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml).

## Before you tag

1. Finalize `CHANGELOG.md`: replace the pending date in `## [0.2.0] - Unreleased`
   with the actual release date (`YYYY-MM-DD`). Keep the general `[Unreleased]`
   section for future changes. CI extracts the version section into release notes.
2. Confirm `extension/package.json` and both root version fields in
   `extension/package-lock.json` are `0.2.0`. They already match in this release
   preparation. For future version changes, update both files together;
   `set-release-version.sh` changes only `package.json`.
3. Run these checks from the repository root:

   ```bash
   VERSION=0.2.0 REQUIRE_PACKAGE_MATCH=1 make check-release
   make check-store
   ```

   The release workflow checks the committed package version **before** syncing
   it from the tag. A mismatched version fails; tag CI does not repair it.
4. Confirm CI for the intended `main` commit. Documentation-only CI deliberately
   skips runtime suites; use the latest code validation or a full manual CI run
   for release confidence. Review the 0.2.0 checks below, and optionally run
   `VERSION=0.2.0 make release-dry-run`.
5. Commit/merge the final release preparation before creating the tag. Verify
   the commit to be tagged, then tag and push **when publishing**:

```bash
git tag -a v0.2.0 -m "Dual Read 0.2.0"
git push origin v0.2.0
```

Do **not** upload local `extension/output/` or `dist/` to the stores or GitHub Release — only CI artifacts.

### 0.2.0 checks and known limits

- Verify upgrade behavior from 0.1.x: newly declared YouTube access may require
  browser acceptance; reload the extension and refresh existing YouTube tabs.
  Idle controls alone must not fetch captions or send translation requests.
- Test page translation/restoration and YouTube start/stop, manual/automatic
  captions, seeking, navigation, and the default-off automation setting on
  fresh Chrome/Edge and Firefox builds.
- Review [the subtitle acceptance record](testing/youtube-subtitles-v1.md) and
  [the later production-manifest regression](testing/youtube-idle-controls.md).
  The earlier record describes optional-only YouTube access; the later follow-up
  supersedes that permission behavior without replacing its live-test limits.
- The recorded Firefox logged-in YouTube source check remains incomplete after
  login was blocked. Controlled-source tests with a real provider do not replace
  it. Resolve it or retain the limitation explicitly in the release notes.
  Long-video readiness, per-minute costs, and broader live-site cases are also
  not established by the existing fixtures.
- GitHub Firefox ZIPs are unsigned. Store signing and installation/update
  consent require separate verification; temporary-addon tests do not cover them.

## What CI publishes

| Asset | Notes |
|-------|--------|
| `dual-read-extension-*-chrome.zip` | Chrome / Edge store upload |
| `dual-read-extension-*-firefox.zip` | Unsigned Firefox package for AMO review/signing or temporary testing |
| `dual-read-*-amo-sources.zip` | AMO source package |
| `dual-read-server-*` | linux/darwin/windows binaries (`version` subcommand shows buildinfo) |
| `sbom-*.json` | CycloneDX / Go module SBOM |
| `SHA256SUMS` + `VERIFY.md` | Checksums + attestation verify hints |
| `RELEASE_NOTES.md` | Extracted changelog section; also used as the release body |
| `ghcr.io/<owner>/dual-read-server:X.Y.Z` | Multi-arch (`linux/amd64,linux/arm64`) |

## Verify a download

Download all files listed in `SHA256SUMS` into the same directory to verify the
complete bundle:

```bash
shasum -a 256 -c SHA256SUMS
gh attestation verify ./dual-read-server-linux-amd64 --repo skys-mission/dual-read
chmod +x ./dual-read-server-linux-amd64
./dual-read-server-linux-amd64 version
```

If you downloaded only an extension ZIP, select its checksum entry instead of
checking missing server/SBOM files:

```bash
awk '$2 == "dual-read-extension-0.2.0-chrome.zip"' SHA256SUMS | shasum -a 256 -c -
gh attestation verify ./dual-read-extension-0.2.0-chrome.zip --repo skys-mission/dual-read
```

Substitute `firefox` for `chrome` when verifying the Firefox ZIP, or use the
downloaded server binary's filename in both commands for a single server asset.
Check that the
ZIP's `manifest.json` reports `0.2.0`; confirm the server binary's `version`
output matches the release. Follow the [README installation steps](../README.md#load-the-extension)
to load a browser package.

## After GitHub publication and store submission

1. Verify the release assets and GHCR image belong to the intended tag/commit.
   The workflow publishes immediately (`draft: false`); it does not stop at a draft.
2. Use the [store overview](store/README.md) to submit the verified CI packages.
   Keep version, listing copy, permission justifications, and privacy answers
   aligned, including the new YouTube access.
3. Keep the GitHub release body explicit about pending store availability.
   It can link directly to the published `v0.2.0` assets while README store
   guidance continues to tell users to check the listing's version.

## Documentation pass after store availability

- [ ] Check each public store page and a fresh installation for **0.2.0**;
  record the confirmation date and version per store.
- [ ] Update the release-preparation wording in both READMEs and replace pending
  availability with the verified version and store link. Leave pending stores
  marked separately; add a Chrome Web Store link only if it is actually live.
- [ ] Prefer store installation for normal users, while keeping source builds,
  GitHub ZIPs, and Firefox's temporary/unsigned distinction available.
- [ ] Update the GitHub release body with confirmed store links and versions.
  Preserve the YouTube permission and refresh instructions for 0.1.x upgrades.
- [ ] Add current production screenshots to user-facing documentation/listings.
  Existing controlled fixtures in test reports are evidence, not live-site
  product screenshots.
- [ ] Record any newly completed live-site checks without rewriting historical
  test results. Keep remaining limitations explicit.

## Manual / local packaging (not for public release)

```bash
VERSION=0.2.0 COMMIT=$(git rev-parse --short HEAD) make build-server
make build-extension
make package-amo-sources
./scripts/generate-sbom.sh
VERSION=0.2.0 ./scripts/assemble-release.sh
```

These commands assume the checked-out package version is already `0.2.0`.
