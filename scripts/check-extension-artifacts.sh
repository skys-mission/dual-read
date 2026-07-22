#!/usr/bin/env bash
# Fail if production extension artifacts contain secrets or dev-only files.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUTPUT_DIR="${EXT_DIR}/output"

if [[ ! -d "${OUTPUT_DIR}" ]]; then
  echo "[check-artifacts] missing ${OUTPUT_DIR}; run a production build first" >&2
  exit 1
fi

FORBIDDEN_NAMES=(
  'dev-settings.json'
  '.env'
  '.env.local'
  'credentials.json'
)

FOUND=0

while IFS= read -r -d '' path; do
  base="$(basename "${path}")"
  for forbidden in "${FORBIDDEN_NAMES[@]}"; do
    if [[ "${base}" == "${forbidden}" ]]; then
      echo "[check-artifacts] FORBIDDEN file in artifact: ${path}" >&2
      FOUND=1
    fi
  done
done < <(find "${OUTPUT_DIR}" \( -type f -o -type l \) -print0)

# Zip contents (WXT may place zips under output/)
while IFS= read -r -d '' zip; do
  if unzip -Z1 "${zip}" 2>/dev/null | grep -E '(^|/)(dev-settings\.json|\.env(\.|$)|credentials\.json)(/|$)' >/dev/null; then
    echo "[check-artifacts] FORBIDDEN entry inside zip: ${zip}" >&2
    unzip -Z1 "${zip}" | grep -E '(^|/)(dev-settings\.json|\.env(\.|$)|credentials\.json)(/|$)' >&2 || true
    FOUND=1
  fi
done < <(find "${OUTPUT_DIR}" -type f -name '*.zip' -print0 2>/dev/null)

# Manifest must not retain WXT reload / localhost:3000 CSP from a mis-tagged build.
while IFS= read -r -d '' manifest; do
  if grep -E 'wxt:reload-extension|localhost:3000' "${manifest}" >/dev/null 2>&1; then
    echo "[check-artifacts] FORBIDDEN dev marker in manifest: ${manifest}" >&2
    FOUND=1
  fi
done < <(find "${OUTPUT_DIR}" -type f -name 'manifest.json' -print0)

if [[ "${FOUND}" -ne 0 ]]; then
  echo "[check-artifacts] FAILED" >&2
  exit 1
fi

echo "[check-artifacts] OK — no forbidden secret/dev files in ${OUTPUT_DIR}"
