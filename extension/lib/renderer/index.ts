import type { TargetLang, TranslationMode, TranslationPayload, TranslationUnit, UnitKind } from '../types';
import {
  CLS_BLOCK, CLS_ERR, CLS_FLOW, CLS_INLINE, CLS_INNER, CLS_NAV, CLS_REPLACE, DONE,
  FLOW, HIDE, LIST_OUTSIDE, MODE, NOWRAP, OURS_SEL, OUTSIDE, P, SHELL, STASH_ALL,
  STASH_LANGUAGE_ATTRS, STASH_TEXT,
} from '../dom-const';
import { isCompactControlHost } from '../dom-role';
import { collectSlotTextNodes, collectVisibleTextNodes } from '../collector';
import { buildSafeRichSkeleton } from './rich';

export { buildSafeRichSkeleton, sanitizeHref, isForbiddenAttr } from './rich';

const P_NAV_SUB = `${P}-nav-sub`;
const P_INLINE = `${P}-target--inline`;
const P_COMPACT = `${P}-target--compact`;
const P_INNER = `${P}-target--inner`;
const LIST_HOST = 'li, [role="listitem"]';

/** Fraction of host height reserved for the empty bilingual block shell. */
const SHELL_HEIGHT_RATIO = 0.85;
const SHELL_MIN_PX = 12;
const SHELL_MAX_PX = 480;
/** If filled height is within this ratio of reserved, keep min-height (no collapse CLS). */
const SHELL_STABILIZE_SLACK = 0.15;

export interface RenderOpts {
  /** BCP-47 lang for translation companions (from settings.targetLang). */
  targetLang?: TargetLang | string;
  /** UI locale for error chrome (not the translation target). */
  uiLocale?: string;
}

function applyTranslationLang(node: HTMLElement, opts?: RenderOpts): void {
  node.setAttribute('dir', 'auto');
  if (opts?.targetLang) node.setAttribute('lang', String(opts.targetLang));
  else node.removeAttribute('lang');
}

function stashAndReplaceText(nodes: Text[], translation: string, opts?: RenderOpts): HTMLElement {
  // Stash each source text node in place. Runs of one segment may be separated
  // by interactive chrome (link/button), and restore must rebuild the exact
  // original sequence — a single combined stash would relocate trailing runs.
  let firstStash: HTMLElement | null = null;
  for (const n of nodes) {
    const stash = document.createElement('span');
    stash.className = HIDE;
    stash.setAttribute(STASH_TEXT, 'true');
    stash.textContent = n.nodeValue ?? '';
    n.parentNode?.insertBefore(stash, n);
    firstStash ??= stash;
    n.remove();
  }

  const visible = document.createElement('span');
  visible.className = CLS_REPLACE;
  applyTranslationLang(visible, opts);
  visible.textContent = translation;

  if (firstStash?.parentNode) {
    firstStash.parentNode.insertBefore(visible, firstStash);
  } else {
    (nodes[0]?.parentElement as HTMLElement | null)?.appendChild(visible);
  }

  visible.setAttribute(DONE, 'true');
  visible.setAttribute(MODE, 'replace');
  return visible;
}

function hideAllChildren(el: HTMLElement): void {
  if (el.querySelector(`:scope > .${HIDE}[${STASH_ALL}]`)) return;
  const w = document.createElement('span');
  w.className = HIDE;
  w.setAttribute(STASH_ALL, 'true');
  while (el.firstChild) w.appendChild(el.firstChild);
  el.appendChild(w);
}

function stashLanguageAttrs(el: HTMLElement): void {
  if (el.hasAttribute(STASH_LANGUAGE_ATTRS)) return;
  el.setAttribute(STASH_LANGUAGE_ATTRS, JSON.stringify({
    // getAttribute distinguishes an absent attribute (null) from lang="".
    lang: el.getAttribute('lang'),
    dir: el.getAttribute('dir'),
  }));
}

function restoreLanguageAttrs(el: HTMLElement): void {
  const raw = el.getAttribute(STASH_LANGUAGE_ATTRS);
  if (raw == null) return;
  try {
    const saved = JSON.parse(raw) as { lang?: unknown; dir?: unknown };
    if (typeof saved.lang === 'string') el.setAttribute('lang', saved.lang);
    else el.removeAttribute('lang');
    if (typeof saved.dir === 'string') el.setAttribute('dir', saved.dir);
    else el.removeAttribute('dir');
  } catch {
    // A page script tampered with our marker. Remove only attributes applied
    // by rich replace rather than aborting the rest of full-page restore.
    el.removeAttribute('lang');
    if (el.getAttribute('dir') === 'auto') el.removeAttribute('dir');
  } finally {
    el.removeAttribute(STASH_LANGUAGE_ATTRS);
  }
}

function restoreTextReplace(visible: Element): void {
  // Reverse every stash owned by this replacement (one per source text node).
  const parent = visible.parentElement;
  if (!parent) return;
  for (const stash of Array.from(parent.querySelectorAll(`:scope .${HIDE}[${STASH_TEXT}]`))) {
    const replacement = document.createTextNode(stash.textContent ?? '');
    stash.parentElement?.insertBefore(replacement, stash);
    stash.remove();
  }
  visible.remove();
}

function restoreReplaceOn(el: HTMLElement): void {
  findNode(el)?.remove();

  const allStash = el.querySelector(`:scope > .${HIDE}[${STASH_ALL}]`);
  if (allStash) {
    // Rich replace stashes originals, then appends a filled skeleton as siblings
    // (no dual-read-target wrapper). Drop those translation siblings before
    // unpacking the stash — otherwise restore leaves original+translation.
    for (const child of Array.from(el.childNodes)) {
      if (child !== allStash) child.parentNode?.removeChild(child);
    }
    while (allStash.firstChild) el.insertBefore(allStash.firstChild, allStash);
    allStash.remove();
  }

  el.querySelectorAll(`:scope .${HIDE}[${STASH_TEXT}]`).forEach((stash) => {
    const visible = stash.nextElementSibling;
    if (visible?.classList?.contains(CLS_REPLACE)) visible.remove();
    const replacement = document.createTextNode(stash.textContent ?? '');
    stash.parentElement?.insertBefore(replacement, stash);
    stash.remove();
  });
}

function insertAfterLastText(el: HTMLElement, node: Node): void {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const p = (n as Text).parentElement;
      if (!p || p.closest(OURS_SEL)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let lastText: Text | null = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) lastText = n as Text;
  if (lastText?.parentElement) {
    lastText.parentElement.insertBefore(node, lastText.nextSibling);
  } else {
    el.appendChild(node);
  }
}

/**
 * Hosts that must not receive a nested companion (void / replaced elements).
 * Everything else nests a <span> so bilingual never becomes a flex/grid sibling
 * (afterend siblings get squeezed into vertical glyph columns on many sites).
 */
function canNestCompanion(el: HTMLElement): boolean {
  return !/^(IMG|BR|HR|INPUT|WBR|AREA|COL|EMBED|SOURCE|TRACK|META|LINK)$/i.test(el.tagName);
}

function isOursCompanion(n: Element): boolean {
  return Boolean(
    n.classList?.contains(CLS_BLOCK) ||
    n.classList?.contains(P_COMPACT) ||
    n.classList?.contains(P_NAV_SUB) ||
    n.classList?.contains(P_INLINE) ||
    n.classList?.contains(P_INNER) ||
    n.classList?.contains(CLS_ERR),
  );
}

/**
 * Ensure a block companion lives inside its host. Afterend siblings of <li>
 * escape the list content box and render flush under the marker.
 */
function nestCompanionInHost(host: HTMLElement, node: HTMLElement): void {
  if (node.parentElement === host) return;
  if (!canNestCompanion(host)) return;
  host.appendChild(node);
}

/**
 * When list-style-position is `inside`, a nested block companion starts at the
 * same inline edge as the marker. Force `outside` for the bilingual session so
 * the translation aligns with the original text (Immersive-style aligned break).
 */
function markListContentBox(host: HTMLElement): void {
  if (!host.matches(LIST_HOST)) return;
  try {
    if (getComputedStyle(host).listStylePosition === 'inside') {
      host.setAttribute(LIST_OUTSIDE, 'true');
    }
  } catch {
    /* jsdom / detached */
  }
}

/** Remove nodes wrongly inserted between caption|a and ul|ol (breaks doc-theme CSS). */
export function repairStructure(): void {
  for (const host of Array.from(document.querySelectorAll('p.caption, p[role="heading"], li'))) {
    const anchor = host.matches('li') ? host.querySelector(':scope > a[href]') : host;
    if (!anchor) continue;
    let s = anchor.nextElementSibling;
    while (s && s.tagName !== 'UL' && s.tagName !== 'OL') {
      if (isOursCompanion(s)) {
        const r = s;
        s = s.nextElementSibling;
        r.remove();
      } else break;
    }
  }

  // Reparent legacy afterend companions back into the preceding list item so
  // translations inherit list indentation (aligned newline under the text).
  for (const host of Array.from(document.querySelectorAll(LIST_HOST))) {
    const next = host.nextElementSibling;
    if (!next || !isOursCompanion(next)) continue;
    host.appendChild(next);
    if (host instanceof HTMLElement) markListContentBox(host);
  }
}

function findNode(el: Element): Element | null {
  // Prefer a companion nested inside the host (current Immersive-aligned mount).
  const nested = el.querySelector(
    `:scope > .${CLS_BLOCK}, :scope > .${CLS_ERR}, :scope .${P_NAV_SUB}, :scope .${P_INLINE}, :scope .${P_COMPACT}, :scope .${P_INNER}`,
  );
  if (nested) return nested;
  // Outside-mounted companions (painted CTAs) and legacy block afterend siblings.
  const next = el.nextElementSibling;
  if (next && isOursCompanion(next)) return next;
  return null;
}

function mountInlineTranslation(el: HTMLElement, kind: UnitKind): HTMLElement {
  const cls = kind === 'nav' ? CLS_NAV : CLS_INLINE;
  let node = findNode(el) as HTMLElement | null;
  if (node?.classList.contains(CLS_ERR)) {
    // A stale error badge must not share the host with a fresh translation.
    node.remove();
    node = null;
  }
  if (node) {
    node.className = cls;
    placeInlineCompanion(el, node);
    return node;
  }

  node = document.createElement('span');
  node.className = cls;
  node.setAttribute('dir', 'auto');
  placeInlineCompanion(el, node);
  return node;
}

/**
 * Place an inline/nav/inner companion.
 *
 * All interactive chrome keeps its translation inside the host so the original
 * hit target, background, border radius, and hover state cover both languages.
 */
function placeInlineCompanion(el: HTMLElement, node: HTMLElement): void {
  // Clean up the short-lived outside-CTA marker from previous builds. If the
  // companion is currently an afterend sibling, insertAfterLastText below moves
  // that same node back into the host without duplicating it.
  el.removeAttribute(OUTSIDE);
  if (node.parentElement === el || el.contains(node)) {
    // Already inside — keep position unless it drifted outside a flow wrapper.
    if (node.parentElement === el || node.parentElement?.getAttribute(FLOW) === 'true') return;
  }

  const label =
    el.querySelector(':scope > .caption-text') ||
    (el.matches('p, [role="heading"]') ? el.querySelector(':scope > span:first-of-type') : null);
  if (label) {
    label.insertAdjacentElement('afterend', node);
  } else {
    insertAfterLastText(el, node);
  }
}

/**
 * Mount a translation companion.
 *
 * Immersive-style rules:
 * - nav / inline / inner → muted <span> suffix inside the host
 * - block → <span display:block> nested inside the host (never afterend sibling of prose)
 *
 * Nesting (not afterend) is required for prose layout safety: an afterend node
 * becomes an extra flex/grid item and collapses into a vertical strip of glyphs.
 */
function mount(el: HTMLElement, kind: UnitKind): HTMLElement {
  if (kind === 'nav' || kind === 'inline') return mountInlineTranslation(el, kind);

  const cls = kind === 'inner' ? CLS_INNER : CLS_BLOCK;
  let node = findNode(el) as HTMLElement | null;
  if (node?.classList.contains(CLS_ERR)) {
    // A stale error badge must not share the host with a fresh translation.
    node.remove();
    node = null;
  }
  if (node) {
    node.className = cls;
    if (kind === 'inner') {
      placeInlineCompanion(el, node);
    } else if (kind === 'block') {
      nestCompanionInHost(el, node);
      markListContentBox(el);
      markFlexBreak(el, node);
    }
    return node;
  }

  // Always use <span>: valid phrasing content inside <p>/<h*>, display via CSS.
  node = document.createElement('span');
  node.className = cls;
  node.setAttribute('dir', 'auto');

  if (kind === 'inner') {
    placeInlineCompanion(el, node);
  } else if (canNestCompanion(el)) {
    // Block: last child of the host — never afterend (flex sibling), and never
    // nested inside a child <a>/<span> (insertAfterLastText would do that).
    el.appendChild(node);
  } else {
    el.insertAdjacentElement('afterend', node);
  }
  if (kind === 'block') {
    nestCompanionInHost(el, node);
    markListContentBox(el);
    markFlexBreak(el, node);
  }
  return node;
}

/**
 * Reserve vertical space on a newly mounted block companion so later text fill
 * does not cause a second layout shift (CLS). Uses host height as a proxy for
 * translation expansion.
 */
export function reserveBlockShell(host: HTMLElement, node: HTMLElement): void {
  // Skip inline-style companions (inner/nav/compact share the dual-read-target token).
  if (
    node.classList.contains(`${P}-target--inner`)
    || node.classList.contains(`${P}-target--inline`)
    || node.classList.contains(`${P}-target--compact`)
    || node.classList.contains(`${P}-nav-sub`)
    || node.classList.contains(CLS_ERR)
  ) {
    return;
  }
  if (node.getAttribute(SHELL)) return;
  try {
    const hostH = host.getBoundingClientRect().height;
    if (!(hostH > 0)) return;
    const reserved = Math.min(
      SHELL_MAX_PX,
      Math.max(SHELL_MIN_PX, Math.round(hostH * SHELL_HEIGHT_RATIO)),
    );
    node.style.minHeight = `${reserved}px`;
    node.setAttribute(SHELL, String(reserved));
  } catch {
    /* jsdom / detached */
  }
}

/**
 * After filling block companion content: keep reserved min-height when the
 * natural height would otherwise collapse below the reserve (second CLS).
 * Clear the reservation when content already holds the height on its own.
 */
export function stabilizeBlockShell(node: HTMLElement): void {
  const raw = node.getAttribute(SHELL);
  if (!raw) return;
  const reserved = Number(raw);
  if (!(reserved > 0)) {
    node.removeAttribute(SHELL);
    return;
  }
  try {
    const h = node.getBoundingClientRect().height || node.scrollHeight;
    // Content shorter than the floor → keep min-height to avoid collapse CLS.
    if (h < reserved * (1 - SHELL_STABILIZE_SLACK)) {
      node.style.minHeight = `${reserved}px`;
      return;
    }
    // Content tall enough: drop the floor (no layout change if h ≈ reserved).
    node.style.minHeight = '';
    node.removeAttribute(SHELL);
  } catch {
    /* ignore */
  }
}

function clearBlockShell(node: Element): void {
  if (!(node instanceof HTMLElement)) return;
  node.style.minHeight = '';
  node.removeAttribute(SHELL);
}

/** When host is flex/grid, force the companion onto its own row/track. */
function markFlexBreak(host: HTMLElement, node: HTMLElement): void {
  try {
    const d = getComputedStyle(host).display;
    if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') {
      node.classList.add(`${P}-target--break`);
    }
  } catch {
    /* jsdom / detached */
  }
}

/**
 * Fill text-node slots in document order (same walk as collector extractRichSlots).
 * Parents in NO_TEXT (code/kbd/…) are skipped so machine tokens stay intact.
 * Works on disconnected clones (no viewport check).
 */
export function fillTextSlots(root: Element, slots: string[]): void {
  const nodes = collectSlotTextNodes(root);
  let i = 0;
  for (const n of nodes) {
    if (i >= slots.length) break;
    const raw = n.nodeValue ?? '';
    const lead = raw.match(/^\s*/)?.[0] ?? '';
    const trail = raw.match(/\s*$/)?.[0] ?? '';
    n.nodeValue = `${lead}${slots[i]}${trail}`;
    i++;
  }
}

function stripOursFromTree(root: Element): void {
  root.querySelectorAll(OURS_SEL).forEach((n) => n.remove());
  root.removeAttribute(DONE);
  root.removeAttribute(MODE);
}

/**
 * Bilingual / replace rich path: rebuild a *safe* inline skeleton (no id /
 * handlers / ARIA), fill translated slots, then mount. Never `cloneNode`.
 * Returns false when the rebuilt skeleton's text nodes drift from the slot
 * list (source predicates pruned differently) — caller degrades to plain text
 * rather than risking misaligned translations.
 */
function renderRich(
  unit: TranslationUnit,
  slots: string[],
  mode: TranslationMode,
  opts: RenderOpts | undefined,
  onBlock: (host: HTMLElement, node: HTMLElement) => void,
): boolean {
  const { el, kind } = unit;

  const skeleton = buildSafeRichSkeleton(el);
  stripOursFromTree(skeleton);
  if (collectSlotTextNodes(skeleton).length !== slots.length) return false;
  fillTextSlots(skeleton, slots);

  if (mode === 'replace') {
    // Stash original children so restoreDom can undo; show filled skeleton in place.
    stashLanguageAttrs(el);
    hideAllChildren(el);
    while (skeleton.firstChild) el.appendChild(skeleton.firstChild);
    el.setAttribute(DONE, 'true');
    el.setAttribute(MODE, 'replace');
    applyTranslationLang(el, opts);
    return true;
  }

  const node = mount(el, kind);
  node.replaceChildren();

  // Prefer moving children into the companion so block mounts stay a single
  // dual-read wrapper (valid next to <p>/<li>, inherits page typography).
  while (skeleton.firstChild) node.appendChild(skeleton.firstChild);

  // Give inline/nav/inner companions a visible gap plus a break opportunity
  // before the translation. This lets constrained chrome move the whole
  // translated label to the next line without splitting CJK into a glyph stack.
  if (kind === 'nav' || kind === 'inline' || kind === 'inner') {
    node.insertBefore(document.createTextNode('\u200b\u00a0'), node.firstChild);
  }

  applyTranslationLang(node, opts);
  finalizeInlineCompanion(el, node, kind);
  if (kind === 'block') onBlock(el, node);
  el.setAttribute(DONE, 'true');
  el.setAttribute(MODE, 'bilingual');
  return true;
}

/**
 * Icons / media that must stay direct flex children (e.g. Donate heart) so
 * wrapping text+translation into a flow span does not break icon alignment.
 */
function isFlexLeadMedia(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  return /^(I|SVG|IMG|PICTURE|VIDEO|CANVAS)$/i.test(el.tagName)
    || (el.getAttribute('aria-hidden') === 'true' && el.childElementCount === 0);
}

/**
 * When the host is flex/inline-flex, an after-text companion becomes a second
 * flex item. Under width pressure that yields Immersive-unlike squeeze:
 * Chinese sitting beside a stacked "Get" / "Involved" instead of wrapping as
 * "Get" / "Involved 参与".
 *
 * Flat hosts wrap direct non-media children + companion into one inline flow.
 * Structured controls already mount inside their nested label; preserving that
 * subtree keeps page selectors such as `button > content > label` intact.
 */
function ensureInlineFlow(host: HTMLElement, companion: HTMLElement): void {
  if (!(companion instanceof HTMLElement) || companion.parentElement !== host) return;

  let display = '';
  try {
    display = getComputedStyle(host).display;
  } catch {
    return;
  }
  if (display !== 'flex' && display !== 'inline-flex') return;

  const flow = document.createElement('span');
  flow.className = CLS_FLOW;
  flow.setAttribute(FLOW, 'true');

  const move: Node[] = [];
  for (const child of Array.from(host.childNodes)) {
    if (child === companion) continue;
    if (isFlexLeadMedia(child)) continue;
    if (child.nodeType === 1 && (child as Element).getAttribute(FLOW) === 'true') continue;
    move.push(child);
  }
  for (const n of move) flow.appendChild(n);
  flow.appendChild(companion);
  host.appendChild(flow);
}

function unwrapInlineFlows(host: HTMLElement): void {
  for (const flow of Array.from(host.querySelectorAll(`:scope > .${CLS_FLOW}`))) {
    while (flow.firstChild) host.insertBefore(flow.firstChild, flow);
    flow.remove();
  }
}

/** Mark compact control hosts so original+translation stay on one horizontal line. */
function markNowrapHost(el: HTMLElement, kind: UnitKind): void {
  if (
    (kind === 'nav' || kind === 'inline' || kind === 'inner')
    && isCompactControlHost(el)
  ) {
    el.setAttribute(NOWRAP, 'true');
  } else {
    el.removeAttribute(NOWRAP);
  }
}

/** After mounting an inline companion: flow-wrap flex hosts + mark layout guards. */
function finalizeInlineCompanion(el: HTMLElement, node: HTMLElement, kind: UnitKind): void {
  if (kind !== 'nav' && kind !== 'inline' && kind !== 'inner') return;
  ensureInlineFlow(el, node);
  markNowrapHost(el, kind);
}

function asPlainText(payload: TranslationPayload): string {
  return Array.isArray(payload) ? payload.join(' ') : payload;
}

/**
 * LLMs correctly preserve names, domains, dates, and technical tokens that do
 * not need translation. In bilingual mode, rendering that unchanged response
 * only duplicates the source and makes dense pages harder to scan.
 *
 * Keep this comparison deliberately conservative: normalize Unicode width,
 * casing, and whitespace only. Punctuation or wording changes still render.
 */
function normalizeComparableText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

export function isEffectivelyUnchanged(
  unit: TranslationUnit,
  payload: TranslationPayload,
): boolean {
  const sourceSlots = unit.rich?.slots;
  if (sourceSlots?.length) {
    const translatedSlots = Array.isArray(payload)
      ? payload
      : sourceSlots.length === 1
        ? [payload]
        : null;
    return Boolean(
      translatedSlots
      && translatedSlots.length === sourceSlots.length
      && sourceSlots.every(
        (source, index) =>
          normalizeComparableText(source) === normalizeComparableText(translatedSlots[index] ?? ''),
      ),
    );
  }

  return normalizeComparableText(unit.text) === normalizeComparableText(asPlainText(payload));
}

/**
 * Mount + fill a translation companion, deferring the block shell measurement
 * to `onBlock`. All DOM *writes* (insert, text, attrs) run inline; the only
 * layout *reads* (getBoundingClientRect in reserveBlockShell/stabilizeBlockShell)
 * are invoked via `onBlock` so a batch caller can run them all together after
 * every unit has been written — collapsing N forced layouts into one.
 */
function renderCore(
  unit: TranslationUnit,
  payload: TranslationPayload,
  mode: TranslationMode,
  opts: RenderOpts | undefined,
  onBlock: (host: HTMLElement, node: HTMLElement) => void,
): void {
  const { el, kind } = unit;

  if (isEffectivelyUnchanged(unit, payload)) {
    // Mark the unit as processed so a new session does not collect it again.
    // No source DOM is changed, so replace mode also remains semantically safe.
    el.setAttribute(DONE, 'true');
    el.setAttribute(MODE, mode);
    el.removeAttribute(NOWRAP);
    el.removeAttribute(OUTSIDE);
    return;
  }

  if (unit.rich?.slots?.length) {
    const slots = Array.isArray(payload)
      ? payload
      : unit.rich.slots.length === 1
        ? [payload]
        : null;
    if (slots && slots.length === unit.rich.slots.length && renderRich(unit, slots, mode, opts, onBlock)) {
      return;
    }
    // Slot count / skeleton parity mismatch — degrade to plain text rather
    // than corrupt the DOM.
  }

  const text = asPlainText(payload);

  if (mode === 'replace') {
    if (unit.segment && unit.nodes?.length) {
      stashAndReplaceText(unit.nodes, text, opts);
      return;
    }
    if (kind === 'inner') {
      const nodes = collectVisibleTextNodes(el);
      if (nodes.length) stashAndReplaceText(nodes, text, opts);
      else el.appendChild(document.createTextNode(text));
      el.setAttribute(DONE, 'true');
      el.setAttribute(MODE, 'replace');
      return;
    }
    hideAllChildren(el);
    const node = mount(el, kind);
    applyTranslationLang(node, opts);
    node.textContent = kind === 'nav' || kind === 'inline' ? `\u200b\u00a0${text}` : text;
    el.setAttribute(DONE, 'true');
    el.setAttribute(MODE, 'replace');
    return;
  }

  const node = mount(el, kind);
  applyTranslationLang(node, opts);
  node.textContent = kind === 'nav' || kind === 'inline' || kind === 'inner' ? `\u200b\u00a0${text}` : text;
  finalizeInlineCompanion(el, node, kind);
  if (kind === 'block') onBlock(el, node);
  el.setAttribute(DONE, 'true');
  el.setAttribute(MODE, 'bilingual');
}

/** Single-unit render: reserve + stabilize the block shell synchronously. */
export function render(
  unit: TranslationUnit,
  payload: TranslationPayload,
  mode: TranslationMode,
  opts?: RenderOpts,
): void {
  renderCore(unit, payload, mode, opts, (host, node) => {
    reserveBlockShell(host, node);
    stabilizeBlockShell(node);
  });
}

/**
 * Render a batch while avoiding layout thrashing. mount + fill (DOM writes)
 * run for every unit first, then block-shell stabilization is split into
 * alternating read/write passes so getBoundingClientRect reads are never
 * interleaved with style writes. This lets the browser coalesce the forced
 * layouts into a constant number per batch instead of one per block.
 */
export function renderBatch(
  items: ReadonlyArray<{ unit: TranslationUnit; payload: TranslationPayload }>,
  mode: TranslationMode,
  opts?: RenderOpts,
): void {
  const pending: Array<{ host: HTMLElement; node: HTMLElement }> = [];
  for (const { unit, payload } of items) {
    try {
      renderCore(unit, payload, mode, opts, (host, node) => {
        pending.push({ host, node });
      });
    } catch (err) {
      console.error('[Dual Read] render:', err);
    }
  }
  // Shell stabilization is split into read/write passes so the browser settles
  // layout a constant number of times per batch instead of once per block:
  //   1. read every host rect → compute reserved floor (no writes between reads)
  //   2. write every reserved minHeight + SHELL attr (no reads between writes)
  //   3. read every companion rect → decide keep/clear (no writes between reads)
  //   4. write the final minHeight decisions.
  // Inline companions (inner/nav/compact/err) are skipped, matching reserveBlockShell.
  const reserved: Array<{ node: HTMLElement; value: number }> = [];
  for (const { host, node } of pending) {
    if (
      node.classList.contains(P_INNER)
      || node.classList.contains(P_INLINE)
      || node.classList.contains(P_COMPACT)
      || node.classList.contains(P_NAV_SUB)
      || node.classList.contains(CLS_ERR)
      || node.getAttribute(SHELL)
    ) {
      continue;
    }
    let hostH = 0;
    try {
      hostH = host.getBoundingClientRect().height;
    } catch {
      /* jsdom / detached */
    }
    if (!(hostH > 0)) continue;
    const value = Math.min(SHELL_MAX_PX, Math.max(SHELL_MIN_PX, Math.round(hostH * SHELL_HEIGHT_RATIO)));
    reserved.push({ node, value });
  }
  for (const { node, value } of reserved) {
    node.style.minHeight = `${value}px`;
    node.setAttribute(SHELL, String(value));
  }
  // Now that every reserved floor is applied, measure filled heights together.
  const stabilize: Array<{ node: HTMLElement; keep: boolean; value: number }> = [];
  for (const { node, value } of reserved) {
    let h = 0;
    try {
      h = node.getBoundingClientRect().height || node.scrollHeight;
    } catch {
      /* jsdom / detached */
    }
    stabilize.push({ node, keep: h < value * (1 - SHELL_STABILIZE_SLACK), value });
  }
  for (const { node, keep, value } of stabilize) {
    if (keep) {
      node.style.minHeight = `${value}px`;
    } else {
      node.style.minHeight = '';
      node.removeAttribute(SHELL);
    }
  }
}

/** Compact in-page failure label. No controls — retry lives in the popup. */
export function renderError(
  unit: TranslationUnit,
  message: string,
  detail?: string,
  opts?: RenderOpts,
): void {
  const node = mount(unit.el, unit.kind);
  node.className = CLS_ERR;
  node.setAttribute('dir', 'auto');
  const ui = String(opts?.uiLocale || 'en').trim().replace(/_/g, '-');
  node.setAttribute('lang', ui === 'zh' ? 'zh-CN' : ui);
  node.textContent = '';
  const label = document.createElement('span');
  label.textContent = message;
  node.appendChild(label);
  if (detail) node.title = detail;
}

/** Remove the translation/error node attached to a unit (for retry). */
export function clearNode(el: HTMLElement): void {
  const n = findNode(el);
  if (n) {
    clearBlockShell(n);
    n.remove();
  }
  unwrapInlineFlows(el);
}

/**
 * Undo translation chrome on a single host so it can be re-collected.
 * Idempotent: a second call is a no-op once markers and chrome are gone.
 */
export function restoreUnit(el: HTMLElement): void {
  if (el.classList.contains(CLS_REPLACE)) {
    restoreTextReplace(el);
    el.removeAttribute(DONE);
    el.removeAttribute(MODE);
    return;
  }

  const hadReplace = el.getAttribute(MODE) === 'replace';
  const n = findNode(el);
  if (n) {
    clearBlockShell(n);
    n.remove();
  }
  unwrapInlineFlows(el);
  if (hadReplace) {
    restoreReplaceOn(el);
    restoreLanguageAttrs(el);
  }

  el.removeAttribute(DONE);
  el.removeAttribute(MODE);
  el.removeAttribute(NOWRAP);
  el.removeAttribute(OUTSIDE);
  el.removeAttribute(LIST_OUTSIDE);
}

/** Full-page restore. Safe to call repeatedly. */
export function restoreDom(): void {
  repairStructure();
  document.querySelectorAll<HTMLElement>(`[${DONE}]`).forEach((el) => {
    restoreUnit(el);
  });
  // Second pass: replace-text chrome may not carry DONE on the host.
  document.querySelectorAll<HTMLElement>(`.${CLS_REPLACE}`).forEach((el) => {
    restoreUnit(el);
  });
  // Error badges carry no DONE marker on their host — sweep them directly.
  document.querySelectorAll(`.${CLS_ERR}`).forEach((n) => n.remove());
  // Orphan list-outside marks (host already clean) — clear without a full restore.
  document.querySelectorAll<HTMLElement>(`[${LIST_OUTSIDE}]`).forEach((el) => {
    if (!el.hasAttribute(DONE)) el.removeAttribute(LIST_OUTSIDE);
  });
}

