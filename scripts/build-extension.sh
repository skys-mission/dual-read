#!/usr/bin/env bash
set -euo pipefail

# Builds and zips the WXT extension for Chrome and Firefox into dist/.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
DIST_DIR="${ROOT_DIR}/dist"

cd "${EXT_DIR}"

# Never package leftover developer secrets from public/.
rm -f "${EXT_DIR}/public/dev-settings.json"

if [[ ! -d node_modules ]]; then
  echo "[build-extension] installing dependencies with npm ci..."
  npm ci
fi

echo "[build-extension] type-checking..."
npm run compile

echo "[build-extension] building + zipping chrome and firefox..."
npm run zip
npm run zip:firefox

echo "[build-extension] checking artifacts for secrets / dev markers..."
chmod +x "${ROOT_DIR}/scripts/check-extension-artifacts.sh"
"${ROOT_DIR}/scripts/check-extension-artifacts.sh"

mkdir -p "${DIST_DIR}"
# WXT writes zips to output/*.zip — copy them into dist/ for a stable path.
# A missing zip here means the build regressed; fail loudly instead of
# shipping an incomplete dist/.
cp "${EXT_DIR}"/output/*.zip "${DIST_DIR}/"

echo "[build-extension] done. Artifacts:"
ls -1 "${EXT_DIR}"/output/*.zip
echo "[build-extension] unpacked builds: ${EXT_DIR}/output/chrome-mv3 and firefox-mv3"
