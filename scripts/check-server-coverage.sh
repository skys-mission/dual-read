#!/usr/bin/env bash
# Check a shared race/coverage profile, or generate one for local use.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-}"
if [[ -n "${PROFILE}" && "${PROFILE}" != /* ]]; then
  PROFILE="${PWD}/${PROFILE}"
fi
cd "${ROOT_DIR}/server"

if [[ -z "${PROFILE}" ]]; then
  PROFILE="$(mktemp)"
  trap 'rm -f "${PROFILE}"' EXIT
  go test -race -coverprofile="${PROFILE}" ./...
fi
[[ -s "${PROFILE}" ]] || { echo "[check-server-coverage] missing profile: ${PROFILE}" >&2; exit 1; }
MODULE="$(awk '$1 == "module" { print $2; exit }' go.mod)"

fail=0
for rel in internal/server internal/runtime internal/metrics; do
  pct="$(awk -v package="${MODULE}/${rel}" '
    NR > 1 {
      directory = $1
      sub(/\/[^\/]*$/, "", directory)
      if (directory == package) {
        total += $2
        if ($3 > 0) covered += $2
      }
    }
    END { printf "%.6f", (total > 0 ? 100 * covered / total : 0) }
  ' "${PROFILE}")"
  echo "[check-server-coverage] ${rel}: ${pct}%"
  if awk -v p="${pct}" 'BEGIN { exit !((p+0) > 0) }'; then
    :
  else
    echo "[check-server-coverage] FAIL: ${rel} still at 0%" >&2
    fail=1
  fi
done
exit "${fail}"
