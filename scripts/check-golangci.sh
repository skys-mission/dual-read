#!/usr/bin/env bash
# Run golangci-lint v2 against server/ with a pinned module version.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}/server"

GOLANGCI_VERSION="${GOLANGCI_VERSION:-v2.1.6}"

echo "[check-golangci] golangci-lint ${GOLANGCI_VERSION}"
# go run pins the exact module; CI uses the same command (no floating "latest").
go run "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${GOLANGCI_VERSION}" run ./...

echo "[check-golangci] OK"
