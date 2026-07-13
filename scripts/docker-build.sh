#!/usr/bin/env bash
# Build dual-read-server container image (optionally multi-arch).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
IMAGE="${IMAGE:-dual-read-server:local}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
PUSH="${PUSH:-0}"
VERSION="${VERSION:-dev}"
COMMIT="${COMMIT:-$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
DATE="${DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

cd "${SERVER_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-build] docker not found" >&2
  exit 1
fi

echo "[docker-build] image=${IMAGE} platforms=${PLATFORMS} push=${PUSH} version=${VERSION}"

BUILD_ARGS=(--build-arg "VERSION=${VERSION}" --build-arg "COMMIT=${COMMIT}" --build-arg "DATE=${DATE}")

if [[ "${PLATFORMS}" == *","* ]] || [[ "${PUSH}" == "1" ]]; then
  if ! docker buildx version >/dev/null 2>&1; then
    echo "[docker-build] docker buildx required for multi-arch / push" >&2
    exit 1
  fi
  args=(buildx build --platform "${PLATFORMS}" -t "${IMAGE}" -f Dockerfile "${BUILD_ARGS[@]}" .)
  if [[ "${PUSH}" == "1" ]]; then
    args+=(--push)
  else
    # Multi-platform --load is unsupported; build single platform into local docker.
    if [[ "${PLATFORMS}" == *","* ]]; then
      echo "[docker-build] multi-platform without PUSH=1 only verifies the build (no local load)" >&2
      args+=(--output=type=cacheonly)
    else
      args+=(--load)
    fi
  fi
  docker "${args[@]}"
else
  docker build -t "${IMAGE}" -f Dockerfile "${BUILD_ARGS[@]}" .
fi

echo "[docker-build] done: ${IMAGE}"
