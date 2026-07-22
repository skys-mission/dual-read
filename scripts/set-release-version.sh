#!/usr/bin/env bash
# Set extension/package.json version from VERSION / tag (tag is source of truth at release).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="${ROOT_DIR}/extension/package.json"

raw="${1:-${RELEASE_VERSION:-${VERSION:-${GITHUB_REF_NAME:-}}}}"
if [[ -z "${raw}" ]]; then
  echo "[set-release-version] usage: VERSION=1.2.3 $0" >&2
  exit 2
fi

VERSION="${raw#v}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "[set-release-version] invalid version: ${VERSION}" >&2
  exit 1
fi

VERSION="${VERSION}" node -e '
const fs = require("fs");
const path = process.argv[1];
const version = process.env.VERSION;
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = version;
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
console.log("[set-release-version] package.json → " + pkg.version);
' "${PKG_JSON}"
