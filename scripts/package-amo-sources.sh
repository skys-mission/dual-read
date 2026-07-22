#!/usr/bin/env bash
# Build a reproducible Firefox AMO source package (no node_modules / build output / secrets).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUT_DIR="${ROOT_DIR}/dist/store"
VERSION="$(node -p "require('${EXT_DIR}/package.json').version")"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/dual-read-amo-src.XXXXXX")"
NAME="dual-read-${VERSION}-amo-sources"
DEST="${STAGE}/${NAME}"

cleanup() {
  rm -rf "${STAGE}"
}
trap cleanup EXIT

mkdir -p "${DEST}" "${OUT_DIR}"

echo "[amo-sources] staging ${NAME} from extension/ (filtered)"

# Copy the extension sources as submitted for review. Excludes build artifacts and secrets.
# (git archive alone is unreliable when the working tree has not been fully committed.)
rsync -a \
  --exclude node_modules/ \
  --exclude output/ \
  --exclude .output/ \
  --exclude .wxt/ \
  --exclude test-results/ \
  --exclude playwright-report/ \
  --exclude '**/dev-settings.json' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'credentials.json' \
  --exclude '.DS_Store' \
  "${EXT_DIR}/" "${DEST}/"

cp "${ROOT_DIR}/LICENSE" "${DEST}/LICENSE"
cp "${ROOT_DIR}/PRIVACY.md" "${DEST}/PRIVACY.md"
cp "${ROOT_DIR}/SECURITY.md" "${DEST}/SECURITY.md"

rm -f "${DEST}/public/dev-settings.json" "${DEST}/dev-settings.json"

cat > "${DEST}/AMO_BUILD.md" << EOF
# Building Dual Read (Firefox) from this source package

## Requirements

- Node.js 22.x
- npm 10+

## Reproduce the Firefox MV3 build

\`\`\`bash
# cd into the extracted top-level folder, then:
npm ci
npm run compile
npm run build:firefox
\`\`\`

Unpacked output: \`output/firefox-mv3/\`

Optional zip:

\`\`\`bash
npm run zip:firefox
\`\`\`

## Notes

- Do **not** place API keys in \`public/\` — that directory is packaged into the addon.
- \`wxt.config.ts\` sets \`gecko.id = dual-read@skysmission.github.io\` and \`strict_min_version = 140.0\`.
- Privacy policy: \`PRIVACY.md\` in this archive
  (also https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md).
- Declared version (\`package.json\`): ${VERSION}
EOF

if find "${DEST}" -type f \( -name 'dev-settings.json' -o -name '.env' -o -name '.env.*' -o -name 'credentials.json' \) | grep -q .; then
  echo "[amo-sources] FORBIDDEN secret-like file in staging tree" >&2
  find "${DEST}" -type f \( -name 'dev-settings.json' -o -name '.env' -o -name '.env.*' -o -name 'credentials.json' \) >&2
  exit 1
fi

if [[ ! -f "${DEST}/wxt.config.ts" || ! -f "${DEST}/package.json" ]]; then
  echo "[amo-sources] staging tree looks incomplete (missing wxt.config.ts / package.json)" >&2
  exit 1
fi

ZIP_PATH="${OUT_DIR}/${NAME}.zip"
rm -f "${ZIP_PATH}"
(
  cd "${STAGE}"
  zip -qr "${ZIP_PATH}" "${NAME}"
)

echo "[amo-sources] wrote ${ZIP_PATH}"
ls -lh "${ZIP_PATH}"
echo "[amo-sources] OK"
