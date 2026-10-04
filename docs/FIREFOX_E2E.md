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

- **Covered on Firefox:** bilingual + restore, replace, auth-failure error chrome,
  editable left alone, dynamic source replacement, obsolete response rejection,
  nested/late Shadow DOM styles and restoration, translation mode switches,
  rich-node reparenting and transfers across hosts/shadow roots with and without
  mutation watching, transfers into newly added shadow hosts and late shadow
  attachments, text splitting/normalization, edits between normalized slots,
  cross-host normalization with a moved page-owned survivor, edits after
  normalization and repeated splitting, normalized transfers into untranslated
  document/shadow containers, independent slot recovery after normalize/split,
  identical translations with reordering and inserted page text, a split tail
  normalized again at its destination, opaque translations, same-valued page
  Text replacements/prefixes, complete retained slots beside emptied slots,
  conservative source retention after unobserved normalization or ambiguous
  equal-valued range deletions, attribute changes
  on local/transferred links, incremental text edits, and
  independent link preservation during parent updates. The text-structure and
  new-root cases also assert original Text/element identity and source-only
  provider requests after a translation mode switch.
- **Chromium-only:** popup/options UI, real SW `scripting.executeScript` relay, DOM lab / perf lab projects.

The shared `e2e/helpers/reconcile-regressions.ts` scenarios combine operations
with mutation watching both enabled and paused. They check final source text,
real removals, original node and new wrapper identity, event listeners,
attribute additions/removals, clean repeated restoration, and a subsequent
bilingual translation. Unit source-model tests additionally cover all six
orders of three slots, ordinary/shadow destinations, deferred/delivered mutation
records, and new page Text nodes whose values happen to equal removed translations.
Recovery uses proven complete source-slot boundaries; arbitrary character cuts
inside a translated slot do not establish equivalent offsets in its source.

The shared `e2e/helpers/unwrapped-regressions.ts` cases exercise normal collection
and replacement of prose inside `form` and `fieldset` wrappers. They cover
deletions, replacements between retained siblings (including nested wrappers),
and transfers with watching enabled and paused, followed by repeated restoration
and a bilingual mode switch. Assertions preserve wrapper identity, attributes,
listeners, new page Text identity, and source-only provider input. Unit tests
also cover `label`, ordinary `span` controls, direct Text removal, and originals
independently reparented by page code.

Reordering cases additionally cover omitted and nested containers, an ordinary
`span` control, insertion and transfer after reordering, and interleaved runs
from two containers. They verify original element order/identity through active
reconciliation, repeated restoration and a mode switch. Unit source-model tests
cross six layouts, all six orders of three siblings, six subsequent operations,
and both mutation delivery timings, using identical opaque translations.
Additional permutations cover bare Text slots before/after normalize and split,
and four siblings spanning mixed nested containers.
The source hierarchy retains each omitted wrapper around its first contiguous
run. If the page interleaves a later run after another container, that run moves
to the enclosing level: wrappers retain their identity once, and the page's
visible order is preserved. Untouched projected sibling lists are not moved.

The shared `e2e/helpers/boundary-regressions.ts` scenarios cover the two recovery
boundaries with watching enabled and paused on both built artifacts. Known
document/shadow destinations recover original Text identities at the target,
including emptied neighboring slots and a single retained slot split at zero.
Tests also exercise actual removals and explicit equal-valued replacements.
Native Chromium/Gecko cases additionally edit Texts discarded by normalize in
the same turn. Both browsers report these edits through transient observers on
removed subtrees until delivery; jsdom does not. Unit tests deliver the proven
merge first for that case, while the browser tests verify native record order.

A destination constructed while detached, or normalized inside a ShadowRoot
before that root is observed, can lose the copied Text without leaving a
normalization record. The same records and final DOM can result from removing
the copy and creating unrelated equal-valued page text. Similarly, editing a
normalized run from three identical translations to two does not reveal which
source slot was deleted: characterData records have no operation or range
offset. In these cases restoration keeps the last known source at its original
position and leaves the page's current target Text unchanged. It does not
claim to recover the target's source ownership. That current text can include
the translation and can be collected as page content during a subsequent
translation. The boundary tests explicitly check this behavior and preserved
page Text identity; source-only request assertions apply to proven transfers.
