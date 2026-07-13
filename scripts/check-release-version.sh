#!/usr/bin/env bash
# Gate a tag release: semver tag ↔ CHANGELOG ↔ (optional) extension package.json.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="${ROOT_DIR}/extension/package.json"
CHANGELOG="${ROOT_DIR}/CHANGELOG.md"
FAIL=0

fail() {
  echo "[check-release] FAIL: $*" >&2
  FAIL=1
}

ok() {
  echo "[check-release] OK: $*"
}

# Resolve VERSION (no leading v).
raw="${1:-${RELEASE_VERSION:-${VERSION:-}}}"
if [[ -z "${raw}" && -n "${GITHUB_REF_NAME:-}" && "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
  raw="${GITHUB_REF_NAME}"
fi
if [[ -z "${raw}" ]]; then
  raw="$(node -p "require('${PKG_JSON}').version")"
fi

VERSION="${raw#v}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  fail "invalid version '${VERSION}' (want X.Y.Z)"
fi

ok "version=${VERSION}"

if [[ ! -f "${CHANGELOG}" ]]; then
  fail "missing CHANGELOG.md"
elif ! grep -E "^## \[${VERSION//./\\.}\]" "${CHANGELOG}" >/dev/null; then
  fail "CHANGELOG.md missing section ## [${VERSION}] (add it before tagging)"
else
  ok "CHANGELOG has ## [${VERSION}]"
fi

PKG_VER="$(node -p "require('${PKG_JSON}').version")"
if [[ "${PKG_VER}" != "${VERSION}" ]]; then
  if [[ "${REQUIRE_PACKAGE_MATCH:-}" == "1" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    fail "extension/package.json version=${PKG_VER} != ${VERSION} (run set-release-version.sh)"
  else
    echo "[check-release] WARN: package.json=${PKG_VER} != ${VERSION} (ok for local preview; CI syncs from tag)"
  fi
else
  ok "package.json version matches"
fi

# Tag shape when running under Actions tag push.
if [[ -n "${GITHUB_REF_NAME:-}" && "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
  if [[ "${GITHUB_REF_NAME}" != "v${VERSION}" ]]; then
    fail "tag ${GITHUB_REF_NAME} must be v${VERSION}"
  else
    ok "git tag is v${VERSION}"
  fi
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "[check-release] FAILED" >&2
  exit 1
fi

echo "[check-release] OK — ready for v${VERSION}"
