# YouTube subtitle acquisition and realtime continuity

Date: 2026-10-25. Version retained at **0.2.0** as requested.
Baseline: `f34c0a6`, including the earlier nested-controls initialization fix.

## Reproduction and scope

The reported video was <https://www.youtube.com/watch?v=3bM5tn52gxQ>.
Both screenshots showed the realtime fallback state. In the baseline, each
native text change replaced the only DOM cue and immediately cleared its
translation. A successful response for a previous cue could never be displayed
after the native text changed. The baseline did not retry full-track acquisition.

A controlled baseline run with 700 ms native updates and 1,800 ms provider
responses produced 50/50 Chromium and 48/48 Firefox samples without Chinese
while captions changed, despite six completed translations in each browser.
The final stable caption translated successfully. This was a simulated timing
test, not a measurement of the user's provider latency.

The new production-addon regressions were first run against the baseline:
native refresh, full-source recovery, rolling delayed translations and late
native text all failed in both browsers (eight failures).

## Changes

### Full-track acquisition

- Install bounded request observation before activating CC. When CC was already
  on and no response was captured, the existing lease may perform one synchronous
  off/on cycle to let YouTube renew its own native request. Preserve the selected
  track, original CC ownership and the user's later CC changes.
- Replay an observed native URL without changing its format or signed
  parameters. If that fails, try at most one different metadata URL. Parse JSON3,
  SRV3 timedtext XML and legacy transcript XML; reject arbitrary HTML/DOCTYPEs.
  The existing 4 MiB / 50,000-event limits remain. XML is parsed without creating
  DOM or a Trusted Types policy. The XML browser cases include the Chromium
  `require-trusted-types-for 'script'` restriction, encoded text, CDATA and
  nested segments; the previous DOMParser approach failed all three Chromium
  cases under this policy, and the bounded reader passed them on both engines.
- While realtime captions continue, make at most three recovery probes. Wait
  8 seconds before the first, then 20 and 60 seconds after failed attempts.
  Recovery does not clear the current track's translation authorization or
  interrupt its realtime queue. Promote only a matching, normalized timeline.
- Missing timing uses the original-caption fallback. Empty native text at the
  instant of fallback can become usable later without forcing a manual restart.
- Native text and selected track still come from one MAIN-world snapshot.
  Resolve a language-only selection only when the matching track is unique,
  and keep words separated when text spans cross native caption nodes.
- Release/cancel hooks on stop, native CC off or navigation. Recheck session
  authorization after acquiring the lease and before activating a source probe.

### Realtime translation

- Queue bounded, immutable submitted source snapshots. Coalesce undispatched
  prefix revisions of rolling ASR instead of modifying text already in flight.
  Dispatch after 300 ms of stability or a 1-second draft lifetime.
- Retain in-flight originals until their responses arrive, including slow
  responses. Bound the buffer to 24 snapshots; age out unsubmitted backlog and
  finished items separately. The session still allows at most two batches of
  five items and no more than one new realtime request per second.
- Display source and translation as a pair. Native text changes no longer clear
  the last complete pair; never put an older translation under newer English.
  Keep completed utterances in order, prefer the latest completed revision of
  an utterance, and do not regress when replies arrive out of order.
- Limit pair turnover to at least 600 ms. A superseded visible pair is held for
  at most 4 seconds; long native silence clears it. Slow service still means
  delayed captions, and sustained overload can drop obsolete queued snapshots.
  No automatic pausing, audio capture, new preference or new permission is added.
- Seek, track/session changes and stop clear queued/displayed pairs and invalidate
  old responses. A state snapshot started before cancellation cannot repopulate
  the queue. Existing automatic-translation safeguards remain in effect.
- Only realtime captions wait for a fresh native snapshot after seeking.
  Full timelines continue to follow the new media time immediately. The full
  regression run caught an unintended 397–404 ms seek delay when this wait was
  applied to both modes. After narrowing the wait, both engines passed the
  existing clock, slow-seek and ad/layout cases without relaxing their timing
  limits (seek under 250 ms, playback transition under 150 ms).

The only UI change is the existing realtime status text, now explaining that
the bilingual display can be delayed together.

## Restoration contract

Native caption/control nodes are not replaced or rewritten by this feature.
Tests retain references to page-owned nodes, verify native visibility after
stop, exercise initially-on CC, and verify that source hooks and leases are
removed after cancellation. Existing tests also cover initially-off CC,
page edits, nested controls, ads, navigation, reload and repeated restoration.

## Live source evidence

Using the production source/lease/normalizer functions in an authenticated
Chromium in-app page with native CC already on:

- Status `ready`, English ASR track `a.en`.
- A fresh **native player response**, HTTP 200, 129,552 bytes.
- 380 JSON3 events normalized into 190 cues in 1,499 ms.
- CC remained on after lease release; video stayed muted, then was paused and
  the diagnostic tab was closed.

This validates source acquisition in that live session. It is not a claim that
the complete addon was installed in that in-app browser. The installed-addon
regressions run controlled sources and a local mock provider on both browsers.
Authenticated live YouTube on Firefox remains unverified because the previous
login attempt was blocked. No account/session copying or login bypass was used.

## Final verification

TypeScript and ESLint passed. Vitest passed **2,045 tests across 52 files**.
Both browser bundles were rebuilt after the final seek correction.
The final browser run passed **162/162**, with no skipped, failed or flaky tests:

| Suite | Chromium | Firefox |
| --- | ---: | ---: |
| Source bridge | 32 | 32 |
| Production subtitle flow | 24 | 24 |
| Earlier review regressions | 17 | 17 |
| Recovery and realtime continuity | 8 | 8 |
| Total | 81 | 81 |

The source bridge uses a disposable diagnostic extension with the production
source function. The other 98 cases use fresh production bundles copied into
disposable extensions with a test-only host grant and control relay. Those test
permissions and relay scripts are absent from the delivered artifacts.

For 700 ms source updates and 1,800 ms mock-provider latency, the eight-second
moving-caption test recorded these results after 3.5 seconds of warmup:

| Measurement | Chromium | Firefox |
| --- | ---: | ---: |
| Distinct translated pairs during movement | 8 | 7 |
| Warm samples without translation | 0 / 45 | 0 / 43 |
| All displayed translations matched their source | Yes | Yes |
| Full-timeline seek refresh | 14.6 ms | 6 ms |
| Full-timeline playback boundary delay | 16.6 ms | 3.9 ms |

These controlled measurements establish the regression contract, not a latency
guarantee for any remote provider. First translation, sustained provider overload
and native source silence can still delay or temporarily remove translated text.

Final browser command (two workers, completed in 5.6 minutes):

```sh
cd extension
npx playwright test e2e/youtube-source.spec.ts e2e/youtube-subtitles.spec.ts \
  e2e/youtube-subtitles-regression.spec.ts e2e/youtube-subtitles-recovery.spec.ts \
  --workers=2
```

Both ZIPs pass integrity checks and match the 64 tested runtime/manifest files
byte for byte. Production manifests are identical to the previous 0.2.0 package:
unchanged permissions, no static content-script injection. Credential and test
relay checks passed. Runtime hashes were captured before the final run and
rechecked afterward. The package README and `build-info.json` identify this
rebuild; the previous manual test package is archived locally before replacement.
