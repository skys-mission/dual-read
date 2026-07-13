# Firefox E2E notes

## Why two layers

| Layer | What | Tooling |
|-------|------|---------|
| Temporary addon smoke | Manifest + gecko.id load, browse without crash | `playwright-webextext` |
| Translate main path | collector / session / renderer / restore on Gecko | Content harness (`e2e/helpers/firefox-gecko.ts`) |

Playwright does **not** expose Firefox MV3 service workers or reliable `moz-extension://` navigation (unlike Chromium `--load-extension`). The harness therefore:

1. Opens the same loopback fixture pages as Chromium (`mock-server`).
2. Injects a minimal `chrome.*` shim + Forced `IntersectionObserver` (headless Gecko often skips IO for already-visible nodes).
3. `eval`s the **built** `output/firefox-mv3/dual-read.js` + CSS (the artifact users ship).
4. Drives `__DUAL_READ__.handleMessage({ action: 'translatePage', config })`.

This matches the approach in `tools/live-translate-probe/run.mjs` (Firefox gecko-shim mode).

## Commands

```bash
cd extension
npm run build:firefox
npx playwright test --project=firefox-ext
```

## Coverage vs Chromium

- **Covered on Firefox:** bilingual + restore, replace, auth-failure error chrome, editable left alone.
- **Chromium-only:** popup/options UI, real SW `scripting.executeScript` relay, DOM lab / perf lab projects.
