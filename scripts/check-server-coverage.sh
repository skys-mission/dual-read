#!/usr/bin/env bash
# Fail if Gate-4 critical Go packages still report 0% statement coverage.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/server"

fail=0
for rel in internal/server internal/runtime internal/metrics; do
  out="$(go test -cover "./${rel}" 2>&1)"
  echo "$out"
  pct="$(echo "$out" | grep -Eo 'coverage: [0-9.]+%' | head -1 | grep -Eo '[0-9.]+' || echo 0)"
  echo "[check-server-coverage] ${rel}: ${pct}%"
  if awk -v p="${pct}" 'BEGIN { exit !((p+0) > 0) }'; then
    :
  else
    echo "[check-server-coverage] FAIL: ${rel} still at 0%" >&2
    fail=1
  fi
done
exit "${fail}"
