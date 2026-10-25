# YouTube player controls before translation

Date: 2026-10-25. Version retained at **0.2.0**.
Baseline: `19ff873` (full-track recovery and realtime continuity fix).

## Report and cause

The player button appeared only after clicking Enable in the toolbar popup.
The previous implementation created `SubtitleRenderer` inside `begin()`, after
starting a translation session. Its registered YouTube bootstrap was also tied
to the automatic-translation preference, so granting host access alone could
not provide a manual entry point on a new watch page.

Before production changes, the new first-load and homepage-to-watch scenarios
reproduced missing controls on the baseline: both Chromium cases and the Firefox
homepage case failed with no matching button. The Firefox first-load attempt
hit a test-harness new-window/onboarding race before its assertion. The harness
now reuses the existing blank tab, as the other subtitle suites already do.

## Resulting behavior

- With YouTube host access, a top-frame bootstrap shows idle controls on watch
  pages even when `youtubeAuto` is false. This mounts only extension-owned UI;
  it does not query caption state, read caption text, toggle CC or translate.
- Without persistent access, opening the toolbar popup uses `activeTab` to show
  controls on the current page. The first manual Enable click may request the
  existing optional `https://www.youtube.com/*` grant. Its explanatory hint is
  shown only when needed. No setting, new permission or all-site grant is added.
- The explicit current-tab start is sent independently of that optional request.
  Denial leaves manual use available. `permissions.onAdded` registers controls
  even if the native permission dialog closes the popup. Permission requests
  begin in the original extension-page click stack for Firefox compatibility.
- Automatic translation remains a separate device-local preference, off by
  default. Explicitly disabled tabs remain disabled on reload/navigation;
  disabling automatic translation retains idle controls.
- Idle controls wait for late CC controls, recover from player/control replacement
  without duplicate buttons, and disappear on non-watch pages or disabled sites.
  Revoking host access unregisters future bootstrap injection and destroys idle UI.
- Page-generated button clicks cannot start translation. Browser-generated
  mouse/keyboard activation still uses the existing manual session path.

## Restoration and validation contract

Tests preserve native caption node identities and text, check that CC stays off
and native captions stay visible before activation, and assert zero caption and
provider requests during idle mounting. After an actual click, the normal
translation path must work; after closing it and reloading, only the idle button
returns. Control replacement must not move or replace page-owned nodes.

Seven new browser scenarios run on fresh production bundles for each engine:
first load, reload after closing, homepage SPA navigation, late controls, replaced
controls, replaced player, and disabled site. Existing reload/native-off tests now
assert a visible disabled control plus `enabled: false`, instead of absence of
all extension UI. Their translation/ownership assertions are retained.

Eight new unit tests cover idle mounting/restoration, simulated-click rejection,
host registration/revocation, activeTab-only popup mounting, and granted/denied
permission requests in the original click stack. Native permission prompt UI
is not clicked by these tests; browser integration uses a disposable test-only
host grant and control relay around the production bundles.

## Final verification

TypeScript, ESLint and the store/privacy consistency check passed. Vitest passed
**2,053 tests across 54 files**. The fresh Chromium and Firefox builds passed
**176 distinct browser cases**, 88 per engine:

| Suite | Chromium | Firefox |
| --- | ---: | ---: |
| Source bridge | 32 | 32 |
| Production subtitle flow | 24 | 24 |
| Earlier review regressions | 17 | 17 |
| Source recovery and realtime continuity | 8 | 8 |
| Idle player controls | 7 | 7 |

The full run produced 174 passes and two nested-control expectation failures.
That older test recorded every control child before activation; with the new
idle UI, its expected list incorrectly included the extension's own button.
The corrected expectation records only page-owned nodes and still checks their
identity and order after disposal. Both corrected cases passed on the same
runtime builds. No production code changed between the full and focused runs;
the package build record preserves both run summaries.

The production manifests are identical to the previous 0.2.0 package, with no
new permissions or static content scripts. ZIP integrity checks passed; all 64
runtime/manifest files match their unpacked builds byte for byte. File hashes
were captured before browser testing and checked again at packaging. Credential
and test-relay scans passed. The earlier 0.2.0 package is archived locally.

Screenshots are controlled, muted fixture pages showing a disabled entry point
after homepage-to-watch navigation, with no caption/provider requests:

![Chromium idle controls](../research/evidence/youtube-idle-controls-chromium.png)
![Firefox idle controls](../research/evidence/youtube-idle-controls-firefox.png)

## Follow-up: automatic controls from the installed package

The earlier change still required an optional YouTube grant. On a normal
installation without that grant, opening the toolbar popup was still necessary
to display the button. Its browser fixtures added the missing host permission
to their disposable manifests, so they did not establish first-use behavior.

The installation manifest now declares exactly `https://www.youtube.com/*`
alongside the existing loopback origins. The existing top-frame bootstrap can
therefore register and mount idle controls without a toolbar click. Translation
continues to require a manual click unless the user explicitly enables the
separate automatic-translation preference. No caption, CC or translation logic
was changed for this follow-up. The permission consistency check now enforces
the exact four-origin allowlist, including entries after the IPv6 address.

A new regression launches freshly built, unmodified Chromium and Firefox
bundles with clean browser profiles. It neither adds manifest entries nor
pre-grants optional permissions, sends relay messages, seeds settings or opens
the popup. Firefox's test library permission override is explicitly disabled.
Both browsers reproduced the missing-button failure before the manifest change
and passed after it. The scenario covers direct video entry, refresh and
homepage-to-watch navigation. It checks one disabled button, unchanged native
caption identity/visibility and CC state, and no additional HTTP requests. An
unrelated origin receives no player UI. The existing configured-service cases
separately check that a real user click starts translation and stopping restores
native captions.

The instrumented subtitle fixture no longer supplies a missing host permission;
it requires the production manifest to include YouTube. Privacy disclosures,
store listings and the restricted-access hint have been updated accordingly.

### Follow-up verification

TypeScript, ESLint and store/privacy consistency checks passed. Vitest passed
**2,072 tests across 55 files**. Fresh Chromium and Firefox builds passed
**64 browser tests**, 32 per engine: eight automatic/idle-control cases and
24 production subtitle-flow cases. Idle mounting made zero caption/provider
requests, and the configured-service cases still required activation to translate.
The unmodified-package regression failed in both browsers before the manifest
change and passed in both afterward.

The local package is under `dist/youtube-auto-controls-2026-10-25/`. Its 64
runtime/manifest files and two browser ZIPs were checked byte for byte against
the tested builds. ZIP integrity, the exact host allowlist, and secret/test-relay
checks passed. The previous package directories were retained.

These screenshots are controlled fixture pages, not a logged-in YouTube session:

![Chromium: automatic idle controls from the unmodified package](../research/evidence/youtube-auto-controls-chromium.png)
![Firefox: automatic idle controls from the unmodified package](../research/evidence/youtube-auto-controls-firefox.png)

### Upgrade

Replace or reload the installed extension with the new build, then refresh any
already open YouTube page. An old unpacked copy is not updated by rebuilding a
different directory. Browsers may require one-time acceptance of the newly
declared YouTube access when installing/updating. Explicitly withheld browser
site access is still respected; the extension does not bypass that setting.
The version remains 0.2.0 for the local test package.
