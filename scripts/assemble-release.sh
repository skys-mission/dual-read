#!/usr/bin/env bash
# Assemble a flat dist/release/ tree with stable names + SHA256SUMS.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-$(node -p "require('${ROOT_DIR}/extension/package.json').version")}"
VERSION="${VERSION#v}"
OUT="${ROOT_DIR}/dist/release"
EXT_OUT="${ROOT_DIR}/extension/output"
SRV_OUT="${ROOT_DIR}/dist/server"
SBOM_OUT="${ROOT_DIR}/dist/sbom"
AMO_OUT="${ROOT_DIR}/dist/store"

rm -rf "${OUT}"
mkdir -p "${OUT}"

echo "[assemble-release] version=${VERSION}"

# Extension zips (WXT naming varies; pick chrome/firefox by filename).
copy_ext_zip() {
  local needle="$1" dest="$2"
  local found=""
  # Only accept zips named for THIS release version: a fallback to "any zip"
  # could silently rename a stale build as the new release.
  found="$(find "${EXT_OUT}" -maxdepth 1 -type f -name '*.zip' \
    | grep -i "${needle}" \
    | grep -F "${VERSION}" \
    | head -n 1 || true)"
  if [[ -z "${found}" ]]; then
    echo "[assemble-release] FAIL: no ${needle} zip for version ${VERSION} under ${EXT_OUT}" >&2
    ls -la "${EXT_OUT}" >&2 || true
    exit 1
  fi
  # Cross-check the packaged manifest version against the release version.
  local mver
  mver="$(unzip -p "${found}" manifest.json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version||'')}catch{console.log('')}})" \
    || true)"
  if [[ -n "${mver}" && "${mver}" != "${VERSION}" ]]; then
    echo "[assemble-release] FAIL: $(basename "${found}") has manifest version ${mver}, expected ${VERSION}" >&2
    exit 1
  fi
  cp "${found}" "${OUT}/${dest}"
  echo "[assemble-release] ${dest} ← $(basename "${found}")"
}

if [[ -d "${EXT_OUT}" ]]; then
  copy_ext_zip chrome "dual-read-extension-${VERSION}-chrome.zip"
  copy_ext_zip firefox "dual-read-extension-${VERSION}-firefox.zip"
fi

if [[ -d "${SRV_OUT}" ]]; then
  for f in \
    dual-read-server-linux-amd64 \
    dual-read-server-linux-arm64 \
    dual-read-server-darwin-amd64 \
    dual-read-server-darwin-arm64 \
    dual-read-server-windows-amd64.exe \
    config.example.toml \
    README.md
  do
    if [[ -f "${SRV_OUT}/${f}" ]]; then
      cp "${SRV_OUT}/${f}" "${OUT}/${f}"
    fi
  done
fi

if [[ -d "${SBOM_OUT}" ]]; then
  [[ -f "${SBOM_OUT}/extension.cdx.json" ]] && cp "${SBOM_OUT}/extension.cdx.json" "${OUT}/sbom-extension.cdx.json"
  [[ -f "${SBOM_OUT}/server-modules.json" ]] && cp "${SBOM_OUT}/server-modules.json" "${OUT}/sbom-server-modules.json"
  [[ -f "${SBOM_OUT}/SHA256SUMS" ]] && cp "${SBOM_OUT}/SHA256SUMS" "${OUT}/sbom-SHA256SUMS.txt"
fi

if [[ -d "${AMO_OUT}" ]]; then
  while IFS= read -r -d '' z; do
    base="$(basename "${z}")"
    # Prefer versioned AMO sources; skip stale zips from earlier dry-runs.
    if [[ "${base}" == *"-${VERSION}-amo-sources.zip" || "${base}" == "dual-read-${VERSION}-amo-sources.zip" ]]; then
      cp "${z}" "${OUT}/${base}"
    fi
  done < <(find "${AMO_OUT}" -maxdepth 1 -type f -name '*-amo-sources.zip' -print0 2>/dev/null)
fi

# Notes
if [[ -f "${ROOT_DIR}/CHANGELOG.md" ]]; then
  awk -v ver="${VERSION}" '
    $0 ~ ("^## \\[" ver "\\]") {found=1; print; next}
    found && /^## / {exit}
    found {print}
  ' "${ROOT_DIR}/CHANGELOG.md" > "${OUT}/RELEASE_NOTES.md" || true
  if [[ ! -s "${OUT}/RELEASE_NOTES.md" ]]; then
    echo "Dual Read ${VERSION}" > "${OUT}/RELEASE_NOTES.md"
  fi
fi

cat > "${OUT}/VERIFY.md" << EOF
# Verifying Dual Read ${VERSION}

## Checksums

\`\`\`bash
cd <download-dir>
shasum -a 256 -c SHA256SUMS
\`\`\`

## Provenance (GitHub artifact attestations)

Requires [GitHub CLI](https://cli.github.com/) ≥ 2.49:

\`\`\`bash
gh attestation verify ./dual-read-server-linux-amd64 \\
  --repo skys-mission/dual-read
\`\`\`

Repeat for other binaries / extension zips listed in \`SHA256SUMS\`.

## Server binary identity

\`\`\`bash
./dual-read-server-linux-amd64 version
\`\`\`

Expect version \`${VERSION}\`.
EOF

(
  cd "${OUT}"
  # Hash every file except the checksum file itself.
  find . -type f ! -name SHA256SUMS ! -name '.*' | sed 's|^\./||' | sort \
    | while IFS= read -r f; do
        shasum -a 256 "${f}"
      done > SHA256SUMS
)

echo "[assemble-release] wrote ${OUT}"
ls -la "${OUT}"
echo "[assemble-release] OK"
