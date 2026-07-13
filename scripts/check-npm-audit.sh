#!/usr/bin/env bash
# Production npm audit gate for the extension.
#
# Policy:
#   1. Runtime deps (--omit=dev) must have no moderate+ findings (blocks CI).
#   2. Full tree is printed for visibility; critical/high in devDependencies
#      are reported as warnings so build-tool churn does not block every PR.
#      Track upgrades separately (Dependabot / scheduled chore).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/extension"

echo "[check-npm-audit] runtime (--omit=dev, audit-level=moderate)"
npm audit --omit=dev --audit-level=moderate

echo "[check-npm-audit] full tree (informational)"
set +e
FULL_OUT="$(npm audit 2>&1)"
FULL_EC=$?
set -e
echo "${FULL_OUT}" | tail -n 50
if [[ "${FULL_EC}" -ne 0 ]]; then
  echo "[check-npm-audit] WARN: full-tree findings present (dev/build chain); runtime gate still green." >&2
fi

echo "[check-npm-audit] OK (runtime clean)"
