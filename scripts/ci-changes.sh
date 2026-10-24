#!/usr/bin/env bash
# Classify NUL-delimited git diff paths. Unknown code/config paths run everything.
set -euo pipefail

extension=false
server=false
docker=false
store=false
dependencies=false

all() {
  extension=true
  server=true
  docker=true
  store=true
  dependencies=true
}

if [[ "${1:-}" == --all ]]; then
  all
else
  while IFS= read -r -d '' path; do
    case "$path" in
      extension/package.json|extension/package-lock.json|server/go.mod|server/go.sum|server/Dockerfile|server/testdata/mock-upstream/Dockerfile|.github/workflows/*)
        dependencies=true ;;
    esac
    case "$path" in
      PRIVACY.md|docs/store/*|extension/wxt.config.ts|extension/package.json|extension/public/_locales/*|scripts/check-store-consistency.sh)
        store=true ;;
    esac
    case "$path" in
      .github/workflows/ci.yml|scripts/ci-changes.sh|scripts/test-ci-config.py|Makefile)
        all ;;
      *.md|docs/*|server/docs/*|LICENSE|.github/ISSUE_TEMPLATE/*|.github/CODEOWNERS|.github/dependabot.yml)
        ;;
      extension/*|scripts/build-extension.sh|scripts/check-extension-artifacts.sh|scripts/check-npm-audit.sh|scripts/dev-extension.sh)
        extension=true ;;
      server/*)
        server=true
        docker=true ;;
      scripts/check-server-coverage.sh|scripts/check-golangci.sh|scripts/build-server.sh)
        server=true ;;
      scripts/docker-*.sh)
        docker=true ;;
      scripts/check-store-consistency.sh)
        ;;
      *)
        all ;;
    esac
  done
fi

printf 'extension=%s\nserver=%s\ndocker=%s\nstore=%s\ndependencies=%s\n' \
  "$extension" "$server" "$docker" "$store" "$dependencies"
