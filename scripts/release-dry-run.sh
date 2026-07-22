#!/usr/bin/env bash
# Build + gate a release bundle without tagging, attesting, or publishing.
# Uses CHANGELOG section VERSION (default 0.1.0) so gates are real.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

VERSION="${VERSION:-0.1.0}"
VERSION="${VERSION#v}"
PKG_JSON="${ROOT_DIR}/extension/package.json"
PKG_BACKUP="$(mktemp)"

cleanup() {
  if [[ -f "${PKG_BACKUP}" ]]; then
    mv "${PKG_BACKUP}" "${PKG_JSON}"
    echo "[release-dry-run] restored extension/package.json"
  fi
}
trap cleanup EXIT

cp "${PKG_JSON}" "${PKG_BACKUP}"

echo "[release-dry-run] VERSION=${VERSION}"

chmod +x \
  ./scripts/set-release-version.sh \
  ./scripts/check-release-version.sh \
  ./scripts/check-store-consistency.sh \
  ./scripts/build-extension.sh \
  ./scripts/build-server.sh \
  ./scripts/generate-sbom.sh \
  ./scripts/package-amo-sources.sh \
  ./scripts/assemble-release.sh \
  ./scripts/check-extension-artifacts.sh

VERSION="${VERSION}" ./scripts/set-release-version.sh
VERSION="${VERSION}" ./scripts/check-release-version.sh
./scripts/check-store-consistency.sh

echo "[release-dry-run] building extension…"
./scripts/build-extension.sh

echo "[release-dry-run] building server binaries…"
VERSION="${VERSION}" COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo dryrun)" \
  SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || date +%s)" \
  ./scripts/build-server.sh

echo "[release-dry-run] SBOM…"
(
  cd extension
  if [[ ! -d node_modules ]]; then npm ci; fi
)
./scripts/generate-sbom.sh

echo "[release-dry-run] AMO sources…"
rm -rf "${ROOT_DIR}/dist/store"
./scripts/package-amo-sources.sh

echo "[release-dry-run] assemble…"
VERSION="${VERSION}" ./scripts/assemble-release.sh

OUT="${ROOT_DIR}/dist/release"
[[ -f "${OUT}/SHA256SUMS" ]] || { echo "[release-dry-run] missing SHA256SUMS" >&2; exit 1; }

echo "[release-dry-run] verifying checksums…"
(
  cd "${OUT}"
  # VERIFY.md / RELEASE_NOTES are part of the bundle; verify all hashed files.
  shasum -a 256 -c SHA256SUMS
)

# Required release subjects (names from assemble-release.sh)
need=(
  "dual-read-extension-${VERSION}-chrome.zip"
  "dual-read-extension-${VERSION}-firefox.zip"
  "dual-read-${VERSION}-amo-sources.zip"
  "dual-read-server-linux-amd64"
  "dual-read-server-linux-arm64"
  "dual-read-server-darwin-amd64"
  "dual-read-server-darwin-arm64"
  "dual-read-server-windows-amd64.exe"
  "sbom-extension.cdx.json"
  "VERIFY.md"
)
for f in "${need[@]}"; do
  [[ -f "${OUT}/${f}" ]] || { echo "[release-dry-run] missing ${f}" >&2; exit 1; }
done

# Binary identity (native arch only when runnable)
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  out="$("${OUT}/dual-read-server-linux-amd64" version || true)"
  echo "[release-dry-run] server version: ${out}"
  echo "${out}" | grep -q "${VERSION}" || {
    echo "[release-dry-run] FAIL: binary version string missing ${VERSION}" >&2
    exit 1
  }
fi

echo "[release-dry-run] OK — bundle at ${OUT} (not published)"
ls -lh "${OUT}" | head -40
