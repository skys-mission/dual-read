#!/usr/bin/env bash
set -euo pipefail

# Runs WXT in dev mode with HMR. Usage: dev-extension.sh [chrome|firefox]
# WXT auto-launches a fresh browser profile with the extension loaded, and
# also writes an unpacked build to extension/output/<browser>-mv3.
#
# Dev settings MUST NOT be copied into public/ — that path is packaged into
# production artifacts. Seed settings via Options → Import instead.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"

BROWSER="${1:-chrome}"
case "${BROWSER}" in
  chrome)  DEV_SCRIPT="dev";         OUTPUT="chrome-mv3" ;;
  firefox) DEV_SCRIPT="dev:firefox"; OUTPUT="firefox-mv3" ;;
  *) echo "[dev-extension] unknown browser '${BROWSER}' (use chrome|firefox)"; exit 1 ;;
esac

cd "${EXT_DIR}"

# Never allow a leftover public secret file to ride into any build.
if [[ -f "${EXT_DIR}/public/dev-settings.json" ]]; then
  echo "[dev-extension] removing leftover public/dev-settings.json (must not be packaged)"
  rm -f "${EXT_DIR}/public/dev-settings.json"
fi

if [[ ! -d node_modules ]]; then
  echo "[dev-extension] installing dependencies..."
  npm install
fi

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WXT dev mode (HMR) — ${BROWSER}

  WXT will auto-open a fresh ${BROWSER} profile with the extension loaded.
  If it doesn't, load unpacked → extension/output/${OUTPUT}

  Tip: copy extension/dev-settings.json.example → a local JSON file, fill
  your API key, then import it from the Options page. Do NOT place secrets
  under extension/public/ — they will ship in release zips.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EOF

npm run "${DEV_SCRIPT}"
