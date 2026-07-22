#!/usr/bin/env bash
# Emit SBOMs for extension and server into dist/sbom/ (+ SHA256SUMS).
# Attestation/signing is deferred to the tag-release pipeline.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist/sbom"
mkdir -p "${OUT_DIR}"

echo "[generate-sbom] extension (npm sbom → CycloneDX JSON)"
cd "${ROOT_DIR}/extension"
if ! npm sbom --help >/dev/null 2>&1; then
  echo "[generate-sbom] FAIL: npm sbom not available (need npm 10+)" >&2
  exit 1
fi
npm sbom --sbom-format cyclonedx > "${OUT_DIR}/extension.cdx.json"

echo "[generate-sbom] server (go list -m -json all)"
cd "${ROOT_DIR}/server"
go list -m -json all > "${OUT_DIR}/server-modules.json"

(
  cd "${OUT_DIR}"
  shasum -a 256 extension.cdx.json server-modules.json > SHA256SUMS
)

echo "[generate-sbom] wrote:"
ls -la "${OUT_DIR}"
echo "[generate-sbom] OK"
