#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
DIST_DIR="${ROOT_DIR}/dist/server"

VERSION="${VERSION:-dev}"
COMMIT="${COMMIT:-$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
# Prefer SOURCE_DATE_EPOCH for reproducible builds; fall back to UTC now.
if [[ -n "${SOURCE_DATE_EPOCH:-}" ]]; then
  DATE="$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -r "${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || echo "${SOURCE_DATE_EPOCH}")"
else
  DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

PKG="github.com/skys-mission/dual-read/server/internal/buildinfo"
LDFLAGS="-s -w -X ${PKG}.Version=${VERSION} -X ${PKG}.Commit=${COMMIT} -X ${PKG}.Date=${DATE}"

echo "[build-server] version=${VERSION} commit=${COMMIT} date=${DATE}"
echo "[build-server] downloading dependencies..."
cd "${SERVER_DIR}"
go mod download

echo "[build-server] building binaries..."
mkdir -p "${DIST_DIR}"
# Do not run `go mod tidy` here — release builds must not mutate the dependency graph.
build_one() {
  local goos="$1" goarch="$2" out="$3"
  echo "[build-server] ${goos}/${goarch} → ${out}"
  GOOS="${goos}" GOARCH="${goarch}" CGO_ENABLED=0 \
    go build -trimpath -ldflags="${LDFLAGS}" -o "${DIST_DIR}/${out}" ./cmd/dual-read-server
}

build_one linux amd64 dual-read-server-linux-amd64
build_one linux arm64 dual-read-server-linux-arm64
build_one darwin amd64 dual-read-server-darwin-amd64
build_one darwin arm64 dual-read-server-darwin-arm64
build_one windows amd64 dual-read-server-windows-amd64.exe

cp "${SERVER_DIR}/config.example.toml" "${DIST_DIR}/config.example.toml"
cp "${SERVER_DIR}/README.md" "${DIST_DIR}/README.md"

echo "[build-server] done. binaries in ${DIST_DIR}"
