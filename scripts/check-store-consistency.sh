#!/usr/bin/env bash
# Machine checks that store listings, privacy, and manifest stay aligned.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
WXT="${EXT_DIR}/wxt.config.ts"
PKG="${EXT_DIR}/package.json"
PRIVACY="${ROOT_DIR}/PRIVACY.md"
FAIL=0

fail() {
  echo "[check-store] FAIL: $*" >&2
  FAIL=1
}

ok() {
  echo "[check-store] OK: $*"
}

[[ -f "${PRIVACY}" ]] || fail "missing PRIVACY.md"
[[ -f "${ROOT_DIR}/docs/store/CHROME_WEB_STORE.md" ]] || fail "missing CWS checklist"
[[ -f "${ROOT_DIR}/docs/store/FIREFOX_AMO.md" ]] || fail "missing AMO checklist"
[[ -f "${ROOT_DIR}/docs/store/PERMISSIONS.md" ]] || fail "missing PERMISSIONS.md"
[[ -f "${ROOT_DIR}/docs/store/LISTING.en.md" ]] || fail "missing LISTING.en.md"

grep -q 'HTTPS' "${PRIVACY}" || fail "PRIVACY.md must mention HTTPS"
grep -qi 'telemetry' "${PRIVACY}" || fail "PRIVACY.md must mention telemetry stance"
grep -qi 'configure' "${PRIVACY}" || fail "PRIVACY.md must mention user-configured endpoint"

grep -q "https://\*/" "${WXT}" || fail "wxt.config.ts must allow optional https://*/ hosts"
grep -q "strict_min_version: '140.0'" "${WXT}" || fail "Firefox strict_min_version must be 140.0"
grep -q "websiteContent" "${WXT}" || fail "gecko data_collection_permissions must declare websiteContent"

# Install-time host_permissions should stay loopback-only (no https://* or http://*).
HOST_BLOCK="$(awk '/host_permissions:/{flag=1} flag{print; if (/\]/) exit}' "${WXT}")"
echo "${HOST_BLOCK}" | grep -q 'localhost' || fail "host_permissions should include localhost"
if echo "${HOST_BLOCK}" | grep -E "https://\*/\*|http://\*/\*" >/dev/null; then
  fail "install-time host_permissions must not include https://*/ or http://*"
fi

EN_DESC="$(node -e "const m=require('${EXT_DIR}/public/_locales/en/messages.json'); process.stdout.write(m.extDescription.message)")"
echo "${EN_DESC}" | grep -qi 'translat' || fail "en extDescription should mention translation"
if echo "${EN_DESC}" | grep -Eiq 'vpn|ad block|shopping'; then
  fail "en extDescription looks off-purpose"
fi

LOCALES=(en zh_CN zh_TW ru es fr)
for locale in "${LOCALES[@]}"; do
  [[ -f "${EXT_DIR}/public/_locales/${locale}/messages.json" ]] \
    || fail "missing manifest locale catalog: ${locale}"
done

node - "${EXT_DIR}" <<'NODE' || fail "locale catalogs must have matching keys and placeholders"
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const locales = ['en', 'zh_CN', 'zh_TW', 'ru', 'es', 'fr'];
const requiredManifestKeys = ['extName', 'extDescription', 'cmdToggleTranslate', 'cmdToggleMode'];
const entries = locales.map((locale) => {
  const file = path.join(root, 'public', '_locales', locale, 'messages.json');
  return [locale, JSON.parse(fs.readFileSync(file, 'utf8'))];
});
const baseline = entries[0][1];
const baseKeys = Object.keys(baseline).sort();
for (const [locale, catalog] of entries) {
  const keys = Object.keys(catalog).sort();
  if (keys.join('\n') !== baseKeys.join('\n')) {
    throw new Error(`${locale}: key set differs from en`);
  }
  for (const key of requiredManifestKeys) {
    if (!String(catalog[key]?.message || '').trim()) throw new Error(`${locale}: missing ${key}`);
  }
  for (const key of baseKeys) {
    const expected = (String(baseline[key]?.message || '').match(/\$\d+/g) || []).sort().join(',');
    const actual = (String(catalog[key]?.message || '').match(/\$\d+/g) || []).sort().join(',');
    if (actual !== expected) throw new Error(`${locale}:${key}: placeholder mismatch`);
  }
}
NODE

node -e "const p=require('${PKG}'); if(!/^\d+\.\d+\.\d+/.test(p.version)) process.exit(1)" \
  || fail "extension/package.json version must be semver-like"

grep -q 'PRIVACY.md' "${ROOT_DIR}/docs/store/CHROME_WEB_STORE.md" || fail "CWS doc must link PRIVACY.md"
grep -q 'PRIVACY.md' "${ROOT_DIR}/docs/store/FIREFOX_AMO.md" || fail "AMO doc must link PRIVACY.md"

SHORT="$(awk '/^```text$/{flag=1;next}/^```$/{flag=0}flag' "${ROOT_DIR}/docs/store/LISTING.en.md" | head -n 1)"
if [[ -n "${SHORT}" ]]; then
  LEN="$(printf '%s' "${SHORT}" | wc -c | tr -d ' ')"
  if [[ "${LEN}" -gt 132 ]]; then
    fail "LISTING.en.md short description is ${LEN} chars (Chrome limit 132)"
  else
    ok "short description length ${LEN} ≤ 132"
  fi
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo "[check-store] FAILED" >&2
  exit 1
fi

ok "store consistency checks passed"
ok "privacy URL for dashboards: https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md"
