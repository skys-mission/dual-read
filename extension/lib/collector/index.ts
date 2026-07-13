import type { TranslationUnit, UnitKind } from '../types';
import {
  A11Y, AUX_NAV, BLOCKS, CHROME, CLS_BLOCK, CLS_ERR, CLS_REPLACE, DONE, EDITABLE,
  HIDE, INLINE_HOST, INLINE_MAX, INTERACTIVE, NAV, NAV_CHROME, NO_TEXT, OURS_SEL, P,
  PAGE_NAV, PAGE_NAV_EL, SKIP,
} from '../dom-const';
import { isCompactControlHost } from '../dom-role';
import { yieldToMain } from '../runtime/yield';

const P_NAV_SUB = `${P}-nav-sub`;
const P_INLINE = `${P}-target--inline`;
const P_INNER = `${P}-target--inner`;
const P_COMPACT = `${P}-target--compact`;

interface Segment {
  anchor: HTMLElement;
  nodes: Text[];
  text: string;
  key: Text;
}

/**
 * Per-collection memo for visibility / layout checks. A single index walk asks
 * isVisible/inViewport on the same ancestors thousands of times; caching
 * getComputedStyle results is the dominant win on large pages.
 *
 * Cleared across cooperative yields so MutationObserver updates cannot leave
 * stale style answers in the cache.
 */
interface CollectCache {
  /** Element is style-hidden on its own (display/visibility/opacity/hidden/aria). */
  selfHidden: WeakMap<Element, boolean>;
  visible: WeakMap<Element, boolean>;
  /** Has a non-zero layout box (inViewport, after isVisible). */
  layout: WeakMap<Element, boolean>;
  /** aside / complementary regions classified as supplementary prose (not chrome). */
  suppProse: WeakMap<Element, boolean>;
}

let collectCache: CollectCache | null = null;

function newCollectCache(): CollectCache {
  return {
    selfHidden: new WeakMap(),
    visible: new WeakMap(),
    layout: new WeakMap(),
    suppProse: new WeakMap(),
  };
}

function invalidateCollectCache(): void {
  if (!collectCache) return;
  collectCache = newCollectCache();
}

function withCollectCache<T>(fn: () => T): T {
  if (collectCache) return fn();
  collectCache = newCollectCache();
  try {
    return fn();
  } finally {
    collectCache = null;
  }
}

async function withCollectCacheAsync<T>(fn: () => Promise<T>): Promise<T> {
  if (collectCache) return fn();
  collectCache = newCollectCache();
  try {
    return await fn();
  } finally {
    collectCache = null;
  }
}

export function isOursElement(el: Element | null): boolean {
  if (!el?.classList) return false;
  return (
    el.classList.contains(CLS_BLOCK) ||
    el.classList.contains(P_NAV_SUB) ||
    el.classList.contains(P_INLINE) ||
    el.classList.contains(P_INNER) ||
    el.classList.contains(P_COMPACT) ||
    el.classList.contains(CLS_ERR) ||
    el.classList.contains(HIDE) ||
    el.classList.contains(CLS_REPLACE)
  );
}

export function mutationHasNewContent(mutations: MutationRecord[]): boolean {
  for (const m of mutations) {
    if (m.type === 'characterData') {
      const text = m.target as Text;
      if (!text.nodeValue?.trim()) continue;
      const p = text.parentElement;
      // Ignore edits inside our chrome / editable fields. DONE hosts still
      // need invalidation when their *source* text nodes change (SPA updates).
      if (!p || p.closest(OURS_SEL) || p.closest(EDITABLE)) continue;
      return true;
    }
    for (const n of Array.from(m.addedNodes)) {
      if (n.nodeType === 3) {
        const text = n as Text;
        if (
          text.nodeValue?.trim()
          && !text.parentElement?.closest(OURS_SEL)
          && !text.parentElement?.closest(EDITABLE)
        ) {
          return true;
        }
      } else if (n.nodeType === 1) {
        const el = n as Element;
        if (isOursElement(el) || el.closest(OURS_SEL)) continue;
        return true;
      }
    }
    if (m.removedNodes.length) return true;
  }
  return false;
}

/** Collapse nested roots so a parent subtree is indexed once. */
export function dedupeNestedRoots(roots: Element[]): Element[] {
  const unique = Array.from(new Set(roots.filter(Boolean)));
  return unique.filter((root) => {
    for (const other of unique) {
      if (other !== root && other.contains(root)) return false;
    }
    return true;
  });
}

/**
 * Collect element roots that should be re-indexed after a mutation batch.
 * Prefers added subtrees and characterData parents; ignores our own nodes.
 */
export function collectMutationRoots(mutations: MutationRecord[]): Element[] {
  const roots = new Set<Element>();

  for (const m of mutations) {
    if (m.type === 'characterData') {
      const p = (m.target as Text).parentElement;
      if (!p || p.closest(OURS_SEL) || p.closest(EDITABLE)) continue;
      if (!(m.target as Text).nodeValue?.trim()) continue;
      roots.add(p);
      continue;
    }

    for (const n of Array.from(m.addedNodes)) {
      if (n.nodeType === 3) {
        const p = (n as Text).parentElement;
        if (!p || p.closest(OURS_SEL) || p.closest(EDITABLE)) continue;
        if (!(n as Text).nodeValue?.trim()) continue;
        roots.add(p);
      } else if (n.nodeType === 1) {
        const el = n as Element;
        if (isOursElement(el) || el.closest(OURS_SEL)) continue;
        roots.add(el);
      }
    }
  }

  return dedupeNestedRoots(Array.from(roots));
}

export interface MutationIndexDelta {
  /** Units discovered under added / changed subtrees only. */
  added: TranslationUnit[];
  /** Previously indexed hosts that left the document. */
  removed: HTMLElement[];
  /** Indexed hosts whose source text nodes changed (need clear + re-index). */
  invalidated: HTMLElement[];
}

/**
 * Build an incremental index delta from MutationRecords against known hosts.
 * Does NOT rescan the full document.
 */
export function mutationIndexDelta(
  mutations: MutationRecord[],
  knownHosts: Iterable<HTMLElement>,
): MutationIndexDelta {
  const known = new Set<HTMLElement>();
  for (const h of knownHosts) known.add(h);

  const removed = new Set<HTMLElement>();
  const invalidated = new Set<HTMLElement>();

  for (const m of mutations) {
    for (const n of Array.from(m.removedNodes)) {
      if (n.nodeType !== 1) continue;
      const el = n as HTMLElement;
      for (const host of known) {
        if (host === el || (typeof el.contains === 'function' && el.contains(host))) {
          removed.add(host);
        }
      }
      if (known.has(el)) removed.add(el);
    }

    if (m.type === 'characterData') {
      const text = m.target as Text;
      for (const host of known) {
        if (removed.has(host)) continue;
        if (host === text.parentElement || host.contains(text)) {
          invalidated.add(host);
        }
      }
    }
  }

  for (const host of known) {
    if (!host.isConnected) removed.add(host);
  }

  // Drop hosts that are both removed and invalidated.
  for (const host of removed) invalidated.delete(host);

  const roots = collectMutationRoots(mutations).filter((r) => {
    // Skip roots that live entirely under an invalidated host — caller will
    // restoreUnit + collectUnits(host) after clearing DONE.
    for (const host of invalidated) {
      if (host.contains(r) || host === r) return false;
    }
    return r.isConnected;
  });

  const added: TranslationUnit[] = [];
  const seenEls = new Set<HTMLElement>();
  for (const root of dedupeNestedRoots(roots)) {
    for (const unit of collectUnits(root)) {
      if (seenEls.has(unit.el)) continue;
      if (known.has(unit.el) && !invalidated.has(unit.el)) continue;
      seenEls.add(unit.el);
      added.push(unit);
    }
  }

  return {
    added,
    removed: Array.from(removed),
    invalidated: Array.from(invalidated),
  };
}

function inNav(el: Element): boolean {
  // Menus / TOC / true navigation are always chrome.
  if (el.closest(NAV_CHROME)) return true;
  const aside = el.closest('aside, [role="complementary"]');
  if (!aside) return false;
  // Changelog / feed widgets in <aside> are document prose, not nav chrome.
  return !isSupplementaryProseRegion(aside);
}

/**
 * Aside / complementary regions that carry multi-item or long natural-language
 * copy (dashboard widgets, changelogs) should use the main BLOCKS / div passes
 * instead of the compact NAV chrome path.
 */
function isSupplementaryProseRegion(region: Element): boolean {
  const cached = collectCache?.suppProse.get(region);
  if (cached !== undefined) return cached;

  let hits = 0;
  for (const el of Array.from(
    region.querySelectorAll('p, li, a[href], [role="listitem"], article, [role="article"], div, span'),
  )) {
    if (el.closest(NAV_CHROME)) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 40 || !okText(t.length > 1500 ? t.slice(0, 1500) : t)) continue;
    hits++;
    if (hits >= 2) {
      collectCache?.suppProse.set(region, true);
      return true;
    }
  }
  collectCache?.suppProse.set(region, false);
  return false;
}

function inSkip(el: Element): boolean {
  return !!el.closest(SKIP) || !!el.closest(CHROME);
}
function inAuxNav(el: Element): boolean {
  return !!el.closest(AUX_NAV);
}
function isPageNavRegion(el: Element | null): boolean {
  return !!el?.closest(PAGE_NAV) || !!el?.matches(PAGE_NAV);
}

function isA11y(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.classList?.contains('not-sr-only')) return false;
    if (A11Y.some((c) => n!.classList?.contains(c))) return true;
  }
  return false;
}

/** Source-side slot pruning shared with the rich skeleton builder (renderer/rich). */
export function isA11yHidden(el: Element): boolean {
  return isA11y(el);
}

/** True when this element alone would hide itself (ancestors not considered). */
function isSelfStyleHidden(el: Element): boolean {
  const cached = collectCache?.selfHidden.get(el);
  if (cached !== undefined) return cached;

  let hidden = false;
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') {
    hidden = true;
  } else {
    const s = getComputedStyle(el);
    const width = parseFloat(s.width);
    const height = parseFloat(s.height);
    const clippedAssistiveText =
      s.position === 'absolute'
      && s.overflow === 'hidden'
      && width <= 2
      && height <= 2
      && (
        (s.clip !== 'auto' && s.clip !== '')
        || (s.clipPath !== 'none' && s.clipPath !== '')
      );
    hidden =
      s.display === 'none'
      || s.visibility === 'hidden'
      || parseFloat(s.opacity) === 0
      || clippedAssistiveText;
  }
  collectCache?.selfHidden.set(el, hidden);
  return hidden;
}

function isVisible(el: Element | null): boolean {
  if (!el?.isConnected || isA11y(el)) return false;

  const cached = collectCache?.visible.get(el);
  if (cached !== undefined) return cached;

  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n.nodeType !== 1) break;
    if (isSelfStyleHidden(n)) {
      collectCache?.visible.set(el, false);
      return false;
    }
  }
  const d = el.closest('details') as HTMLDetailsElement | null;
  if (d && !d.open && !el.closest('summary')) {
    collectCache?.visible.set(el, false);
    return false;
  }
  collectCache?.visible.set(el, true);
  return true;
}

function inViewport(el: Element | null): boolean {
  if (!isVisible(el)) return false;
  const cached = collectCache?.layout.get(el as Element);
  if (cached !== undefined) return cached;
  const r = (el as Element).getBoundingClientRect();
  const ok = r.width >= 1 || r.height >= 1;
  collectCache?.layout.set(el as Element, ok);
  return ok;
}

export function okText(t: string): boolean {
  const s = t.replace(/\s+/g, ' ').trim();
  return (
    s.length >= 2 &&
    s.length <= 1500 &&
    !/^\d+([.,]\d+)?$/.test(s) &&
    !/^(https?|ftp):\/\//i.test(s) &&
    !/^[\d\s\p{P}]+$/u.test(s)
  );
}

/** Text under an already-translated host must not be re-collected. */
function underDone(el: Element | null): boolean {
  return !!el?.closest(`[${DONE}]`);
}

function leafTextContent(el: Element): string {
  let raw = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) raw += (n as Text).nodeValue ?? '';
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function extractText(el: Element, nav = false): string {
  const vis = nav ? isVisible : inViewport;
  // Common case on article / perf pages: a block with only text nodes.
  if (!el.firstElementChild) {
    if (underDone(el) || el.closest(OURS_SEL) || el.closest(EDITABLE)) return '';
    if (!vis(el)) return '';
    return leafTextContent(el);
  }

  const out: string[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !el.contains(p) || NO_TEXT.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      // DONE hosts keep their original text nodes; rejecting them stops a parent
      // (e.g. <li>) from being re-collected after a child <a> was translated.
      if (underDone(p) || p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (!vis(p) || !(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push((n as Text).nodeValue ?? '');
  return out.join('').replace(/\s+/g, ' ').trim();
}

function skip(el: Element | null, nav = false): boolean {
  if (!el || NO_TEXT.has(el.tagName)) return true;
  if (!(nav ? isVisible(el) : inViewport(el)) || inSkip(el)) return true;
  if (el.closest(EDITABLE)) return true;
  if (el.closest(`[${DONE}], .${CLS_BLOCK}, .${CLS_ERR}`)) return true;
  return false;
}

function hasChildBlock(el: Element): boolean {
  if (!el.firstElementChild) return false;
  // querySelectorAll(BLOCKS) is scoped to descendants only (not `el` itself).
  for (const c of Array.from(el.querySelectorAll(BLOCKS))) {
    // Cheap rejects before extractText (which walks text + visibility).
    if (NO_TEXT.has(c.tagName) || inSkip(c)) continue;
    if (skip(c)) continue;
    if (okText(extractText(c))) return true;
  }
  return false;
}

/** True when a child element already owns collectable prose (prefer leaf hosts). */
function hasTranslatableChild(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    if (!(c instanceof HTMLElement)) continue;
    if (NO_TEXT.has(c.tagName) || isOursElement(c)) continue;
    const raw = (c.textContent || '').replace(/\s+/g, ' ').trim();
    if (raw.length >= 2 && okText(raw.length > 1500 ? raw.slice(0, 1500) : raw)) return true;
  }
  return false;
}

function isTopNavLink(el: Element, region: Element | null): boolean {
  if (!el.matches('a[href]')) return true;
  if (region?.matches('aside')) return true;
  const li = el.parentElement;
  return li?.tagName === 'LI' && li.firstElementChild === el;
}

/** Skip li when a descendant link will be / was already collected separately. */
function pageNavLiEligible(el: Element): boolean {
  if (!el.matches('li')) return true;
  for (const a of Array.from(el.querySelectorAll(':scope a[href]'))) {
    // Already-translated links still "own" the li's text — do not re-collect the li.
    if (a.hasAttribute(DONE) || underDone(a)) return false;
    if (!skip(a, true) && okText(extractText(a, true))) return false;
  }
  return true;
}

/**
 * True when the element owns a layout text block (needs a bilingual newline
 * under the original, Immersive dual-mode style). Tag name alone is not enough:
 * many card titles/excerpts are `display:block` <a> elements.
 */
function isBlockLikeLayout(el: Element): boolean {
  try {
    const d = getComputedStyle(el).display;
    if (
      d === 'block'
      || d === 'flex'
      || d === 'grid'
      || d === 'flow-root'
      || d === 'list-item'
      || d === 'table-cell'
    ) {
      return true;
    }
  } catch {
    /* jsdom / detached */
  }
  // Card excerpts often wrap a <p> inside a block-styled <a>.
  return !!el.querySelector(
    ':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > div',
  );
}

function isBlockLink(el: Element): boolean {
  if (!el.matches('a[href]') || inNav(el) || inSkip(el)) return false;
  if (el.closest(INLINE_HOST)) return false;
  if (skip(el)) return false;
  const text = extractText(el);
  if (!okText(text)) return false;
  const d = getComputedStyle(el).display;
  return d === 'block' || d === 'flex' || d === 'grid' || d === 'inline-block' || text.length >= 30;
}

function hasInteractiveDescendant(el: Element, nav = false): boolean {
  if (!el?.querySelectorAll) return false;
  for (const c of Array.from(el.querySelectorAll(INTERACTIVE))) {
    if (c === el || !isVisible(c)) continue;
    // A DONE interactive still owns its text — treat it as covering the host so
    // parents are not re-collected after the child was translated.
    if (c.hasAttribute(DONE) || underDone(c)) return true;
    if (skip(c, nav) || c.closest(OURS_SEL)) continue;
    return true;
  }
  return false;
}

function isInlineLink(el: Element): boolean {
  if (!el.matches('a[href]') || inNav(el) || inSkip(el) || skip(el)) return false;
  if (!el.closest(INLINE_HOST)) return false;
  return okText(extractText(el));
}

export function collectVisibleTextNodes(root: Element, nav = false): Text[] {
  const vis = nav ? isVisible : inViewport;
  // Leaf hosts: avoid TreeWalker setup for the common single-text-node case.
  if (!root.firstElementChild) {
    if (underDone(root) || root.closest(OURS_SEL) || root.closest(EDITABLE)) return [];
    if (!vis(root)) return [];
    const nodes: Text[] = [];
    for (let n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && (n as Text).nodeValue?.trim()) nodes.push(n as Text);
    }
    return nodes;
  }
  const nodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (underDone(p) || p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (!vis(p) || !(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
  return nodes;
}

/**
 * Document-order text slots for rich units. No viewport check — the host is
 * already visibility-gated, and the same walk must work on a disconnected clone
 * when the renderer fills translations.
 */
export function collectSlotTextNodes(root: Element): Text[] {
  const nodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (isA11y(p)) return NodeFilter.FILTER_REJECT;
      if (!(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
  return nodes;
}

/** Text-node slots under a host, in document order (NO_TEXT parents skipped). */
export function extractRichSlots(el: Element): string[] {
  return collectSlotTextNodes(el).map((n) => (n.nodeValue ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Text-node level dedup: an element overlaps an existing unit when ANY of the
// visible text nodes it owns was already claimed by an earlier unit. Document
// order guarantees ancestors / mixed-content hosts claim first, so this stops a
// container and its inline descendants (e.g. <p class="caption"><span>, or a
// span whose text runs are split by comment nodes) from being translated twice.
// "Any" rather than "all" is required because non-translatable runs (e.g. a
// bare "2026" rejected by okText) never get claimed and would otherwise leave a
// wrapper looking only partially covered.
function textCovered(el: Element, seen: Set<Node>, nav: boolean): boolean {
  const ns = collectVisibleTextNodes(el, nav);
  return ns.some((n) => seen.has(n));
}

function claimText(el: Element, seen: Set<Node>, nav: boolean): void {
  for (const n of collectVisibleTextNodes(el, nav)) seen.add(n);
}

function collectTextSegments(root: Element, nav = false): Segment[] {
  const vis = nav ? isVisible : inViewport;
  const raw: { anchor: HTMLElement; nodes: Text[]; text: string }[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.closest(INTERACTIVE)) return NodeFilter.FILTER_REJECT;
      if (underDone(p) || p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (!vis(p) || !(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let run: { anchor: HTMLElement; nodes: Text[]; text: string } | null = null;
  for (let node = w.nextNode(); node; node = w.nextNode()) {
    const n = node as Text;
    const anchor = n.parentElement as HTMLElement;
    if (run && run.anchor === anchor && run.nodes[run.nodes.length - 1]?.nextSibling === n) {
      run.nodes.push(n);
      run.text += n.nodeValue ?? '';
    } else {
      run = { anchor, nodes: [n], text: n.nodeValue ?? '' };
      raw.push(run);
    }
  }

  // Merge runs that share an anchor: interactive chrome (button/link) splits a
  // paragraph's text into separate runs, and downstream bookkeeping keys units
  // by anchor element — unmerged runs would silently drop all but the first.
  const byAnchor = new Map<HTMLElement, { anchor: HTMLElement; nodes: Text[]; text: string }>();
  for (const s of raw) {
    const group = byAnchor.get(s.anchor);
    if (group) {
      group.nodes.push(...s.nodes);
      group.text += ` ${s.text}`;
    } else {
      byAnchor.set(s.anchor, { anchor: s.anchor, nodes: [...s.nodes], text: s.text });
    }
  }

  return Array.from(byAnchor.values())
    .map((s) => ({ anchor: s.anchor, nodes: s.nodes, text: s.text.replace(/\s+/g, ' ').trim(), key: s.nodes[0] as Text }))
    .filter((s) => okText(s.text));
}

/**
 * Inline markup that should survive into the bilingual companion (Immersive-style).
 * Form controls / media are excluded — those fall back to mixed-content splitting.
 */
const RICH_MARKUP =
  'a[href], code, kbd, var, samp, strong, b, em, i, mark, sup, sub, abbr, cite, q';
const RICH_BLOCKING =
  'button, label, summary, input, select, textarea, img, video, audio, iframe';

function hasRichMarkup(el: Element): boolean {
  return !!el.querySelector(RICH_MARKUP);
}

function hasRichBlocking(el: Element): boolean {
  return !!el.querySelector(RICH_BLOCKING);
}

/**
 * Prefer a single rich unit (skeleton + slots) over flattening / splitting when
 * the host is prose with inline links/code/emphasis and no form/media chrome.
 * Nav chrome stays on the mixed/inner path for compact suffixes.
 */
function tryCollectRichUnit(
  host: Element,
  seen: Set<Node>,
  units: TranslationUnit[],
  nav = false,
): boolean {
  if (nav || inNav(host)) return false;
  if (hasRichBlocking(host) || !hasRichMarkup(host)) return false;
  if (seen.has(host) || textCovered(host, seen, nav)) return false;

  const slots = extractRichSlots(host);
  if (slots.length < 1) return false;
  const text = slots.join(' ').replace(/\s+/g, ' ').trim();
  if (!okText(text)) return false;

  seen.add(host);
  claimText(host, seen, nav);
  // Claim nested links so the later a[href] passes do not double-collect them.
  for (const a of Array.from(host.querySelectorAll('a[href]'))) {
    seen.add(a);
    claimText(a, seen, nav);
  }

  units.push({
    el: host as HTMLElement,
    text,
    kind: classifyKind(host, text),
    rich: { slots },
  });
  return true;
}

function collectMixedContentUnits(
  host: Element,
  seen: Set<Node>,
  units: TranslationUnit[],
  nav = false,
): void {
  for (const seg of collectTextSegments(host, nav)) {
    if (seen.has(seg.key)) continue;
    for (const n of seg.nodes) seen.add(n);
    // Immersive-style: mount as an inline suffix inside the text host.
    // `segment` still steers replace-mode to stashAndReplaceText; bilingual
    // uses `inner` so we never insert a block afterend sibling of a <span>.
    units.push({
      el: seg.anchor,
      nodes: seg.nodes,
      text: seg.text,
      kind: nav || seg.text.length <= INLINE_MAX ? 'inner' : 'block',
      segment: true,
    });
  }
  for (const a of Array.from(host.querySelectorAll(':scope a[href]'))) {
    if (skip(a, nav) || seen.has(a) || textCovered(a, seen, nav)) continue;
    const text = extractText(a, nav);
    if (!okText(text)) continue;
    seen.add(a);
    claimText(a, seen, nav);
    units.push({ el: a as HTMLElement, text, kind: classifyKind(a, text) });
  }
}

/**
 * Short UI chrome → inline/inner suffix; prose / block-layout hosts → block below.
 *
 * Alignment rule (Immersive dual-mode): a companion left-aligns with the original
 * when it is a nested `display:block` under the same text host. Layout role —
 * not the tag name — decides this. Block-styled card links (`a.cards-item-title`)
 * must be `block`, while true inline links stay `inner` ("Premium 高级版").
 */
function classifyKind(el: Element, text: string): UnitKind {
  const len = text.length;

  // Navigation is a stronger semantic region than an individual control.
  // Compact nav CTAs still receive nowrap protection in the renderer.
  if (inNav(el) || isPageNavRegion(el)) return 'nav';

  // Semantic controls take precedence over layout. Painted links and prose
  // cards both commonly use display:flex/grid; a block companion inside the
  // former takes a full flex row and can squeeze its label into a glyph stack.
  if (isCompactControlHost(el)) return 'inner';

  // Outside chrome, block-layout anchors are prose cards.
  if (el.matches('a[href]')) {
    return isBlockLikeLayout(el) ? 'block' : 'inner';
  }

  // Headings always get a bilingual newline under the title (not a mid-line suffix).
  if (el.matches('h1, h2, h3, h4, h5, h6, [role="heading"]')) return 'block';

  // Body list items: always block so the companion nests inside the list
  // content box and aligns under the original text (not under the marker).
  // Short-li → inline was a historical workaround for afterend siblings that
  // escaped the content box; nesting makes that unnecessary. Nav/TOC already
  // returned 'nav' above.
  if (el.matches('li, [role="listitem"]')) return 'block';

  // Definition descriptions are prose; short terms/cells/captions stay compact.
  if (el.matches('dd')) return 'block';
  if (el.matches('dt, th, td, figcaption, caption') && len <= INLINE_MAX) return 'inline';

  // Block-layout hosts (including short card titles) prefer an aligned newline.
  if (isBlockLikeLayout(el) && !el.matches('dt, th, td, figcaption, caption')) {
    return 'block';
  }

  if (len <= INLINE_MAX) {
    const chrome = el.closest(
      'header, [role="banner"], nav, aside, [role="navigation"], [role="menubar"], [role="menu"], [role="tablist"], [role="toolbar"], [role="tree"], button, a',
    );
    // Block-display anchors (feed/card titles) are prose, not chrome suffixes.
    if (chrome && !(chrome.matches('a[href]') && isBlockLikeLayout(chrome))) {
      return 'inline';
    }
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const lh = parseFloat(style.lineHeight) || rect.height;
    // Single-line / compact UI chrome → same-line muted suffix (Immersive).
    if (rect.height > 0 && lh > 0 && rect.height <= lh * 2.2) return 'inline';
  }
  return 'block';
}

function* matchAll(scope: Element | ShadowRoot, selector: string): Iterable<Element> {
  if (scope instanceof Element && scope.matches?.(selector)) yield scope;
  yield* Array.from(scope.querySelectorAll(selector));
}

function resolveCollectScope(root: ParentNode): Element | ShadowRoot | null {
  if (root instanceof Element) return root;
  if (root instanceof Document) return root.body;
  if (root instanceof ShadowRoot) return root;
  return null;
}

function sortUnitsByRank(units: TranslationUnit[]): TranslationUnit[] {
  // Cache ranks once — comparator getBoundingClientRect would be O(n log n).
  const ranked = units.map((u) => ({ u, r: rank(u) }));
  ranked.sort((a, b) => a.r - b.r);
  return ranked.map((x) => x.u);
}

function collectUnderScope(scope: Element | ShadowRoot): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  const seen = new Set<Node>();
  collectPasses(scope, units, seen);
  return sortUnitsByRank(units);
}

/** Shared collection passes. */
function collectPasses(
  scope: Element | ShadowRoot,
  units: TranslationUnit[],
  seen: Set<Node>,
): void {
  for (const el of matchAll(scope, BLOCKS)) {
    if (inNav(el) || skip(el) || hasChildBlock(el)) continue;
    if (tryCollectRichUnit(el, seen, units, false)) continue;
    if (hasInteractiveDescendant(el, false)) {
      collectMixedContentUnits(el, seen, units);
      continue;
    }
    const text = extractText(el);
    if (!okText(text) || seen.has(el) || textCovered(el, seen, false)) continue;
    seen.add(el);
    claimText(el, seen, false);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  }

  for (const el of matchAll(scope, 'a[href]')) {
    if (!isBlockLink(el) || seen.has(el) || textCovered(el, seen, false)) continue;
    seen.add(el);
    claimText(el, seen, false);
    const text = extractText(el);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  }

  for (const el of matchAll(scope, 'a[href]')) {
    if (!isInlineLink(el) || seen.has(el) || textCovered(el, seen, false)) continue;
    seen.add(el);
    claimText(el, seen, false);
    const text = extractText(el);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  }

  for (const el of matchAll(scope, 'span, div')) {
    if (inNav(el) || inSkip(el) || skip(el) || hasChildBlock(el) || seen.has(el)) continue;
    if (el.matches(BLOCKS)) continue;
    if (tryCollectRichUnit(el, seen, units, false)) continue;
    if (hasInteractiveDescendant(el, false)) {
      collectMixedContentUnits(el, seen, units);
      continue;
    }
    const text = extractText(el);
    if (!okText(text) || textCovered(el, seen, false)) continue;
    // Short chrome labels stay inline-capped; longer card/body copy is collected
    // as block prose (feed cards, dashboard widgets) when this host is a leaf.
    if (text.length > INLINE_MAX) {
      if (hasTranslatableChild(el)) continue;
      seen.add(el);
      claimText(el, seen, false);
      units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
      continue;
    }
    seen.add(el);
    claimText(el, seen, false);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  }

  const NAV_EL = 'a[href], button, label, p, span, div, li, [role="heading"], h1, h2, h3, h4, h5, h6';
  for (const region of matchAll(scope, NAV)) {
    if (!isVisible(region) || inSkip(region) || isPageNavRegion(region)) continue;
    for (const el of Array.from(region.querySelectorAll(NAV_EL))) {
      if (inAuxNav(el) || !isTopNavLink(el, region) || skip(el, true) || hasChildBlock(el) || seen.has(el)) continue;
      if (hasInteractiveDescendant(el, true)) {
        collectMixedContentUnits(el, seen, units, true);
        continue;
      }
      if (textCovered(el, seen, true)) continue;
      const text = extractText(el, true);
      if (!okText(text)) continue;
      seen.add(el);
      claimText(el, seen, true);
      const kind = classifyKind(el, text);
      units.push({ el: el as HTMLElement, text, kind: kind === 'block' ? 'nav' : kind });
    }
  }

  for (const region of matchAll(scope, PAGE_NAV)) {
    if (!isVisible(region) || inSkip(region)) continue;
    for (const el of Array.from(region.querySelectorAll(PAGE_NAV_EL))) {
      if (!pageNavLiEligible(el) || skip(el, true) || hasChildBlock(el) || seen.has(el)) continue;
      if (hasInteractiveDescendant(el, true)) {
        collectMixedContentUnits(el, seen, units, true);
        continue;
      }
      if (textCovered(el, seen, true)) continue;
      const text = extractText(el, true);
      if (!okText(text)) continue;
      seen.add(el);
      claimText(el, seen, true);
      const kind = classifyKind(el, text);
      // Never emit block inside page-nav chrome — Immersive keeps menu/TOC
      // as same-line suffixes so flex sidebars do not grow vertical strips.
      units.push({
        el: el as HTMLElement,
        text,
        kind: kind === 'block' ? 'nav' : kind,
      });
    }
  }
}

/**
 * Collect translatable units under `root` (defaults to `document.body`).
 * Passing a subtree root (Element or ShadowRoot) enables incremental indexing
 * and open-shadow coverage without rescanning the entire page.
 */
export function collectUnits(root: ParentNode = document.body): TranslationUnit[] {
  const scope = resolveCollectScope(root);
  if (!scope) return [];
  return withCollectCache(() => collectUnderScope(scope));
}

export interface CollectUnitsAsyncOptions {
  /** Soft CPU budget per turn before yielding (ms). Default 12. */
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface CollectUnitsAsyncResult {
  units: TranslationUnit[];
  /** Active collector CPU excluding yield waits. */
  cpuMs: number;
}

/**
 * Cooperative collector: same passes as `collectUnits`, but yields to the main
 * thread whenever a soft CPU budget is exceeded so Long Tasks stay bounded.
 * One querySelectorAll per pass (no per-child re-scan).
 */
export async function collectUnitsAsync(
  root: ParentNode = document.body,
  options: CollectUnitsAsyncOptions = {},
): Promise<CollectUnitsAsyncResult> {
  const scope = resolveCollectScope(root);
  if (!scope) return { units: [], cpuMs: 0 };

  return withCollectCacheAsync(async () => {
  const budgetMs = options.budgetMs ?? 12;
  const signal = options.signal;
  const units: TranslationUnit[] = [];
  const seen = new Set<Node>();
  let cpuMs = 0;
  let sliceCpu = 0;
  let sliceMark = performance.now();

  const bump = async (): Promise<void> => {
    if (signal?.aborted) {
      throw new DOMException('collectUnitsAsync aborted', 'AbortError');
    }
    const now = performance.now();
    const dt = now - sliceMark;
    cpuMs += dt;
    sliceCpu += dt;
    sliceMark = now;
    if (sliceCpu >= budgetMs) {
      invalidateCollectCache();
      await yieldToMain();
      sliceMark = performance.now();
      sliceCpu = 0;
    }
  };

  // Materialize each pass so we can checkpoint between elements without
  // holding a live NodeList across yields (mutations may run in between).
  const runPass = async (elements: Element[], handle: (el: Element) => void): Promise<void> => {
    for (const el of elements) {
      const t0 = performance.now();
      handle(el);
      sliceMark = t0;
      await bump();
    }
  };

  await runPass([...matchAll(scope, BLOCKS)], (el) => {
    if (inNav(el) || skip(el) || hasChildBlock(el)) return;
    if (tryCollectRichUnit(el, seen, units, false)) return;
    if (hasInteractiveDescendant(el, false)) {
      collectMixedContentUnits(el, seen, units);
      return;
    }
    const text = extractText(el);
    if (!okText(text) || seen.has(el) || textCovered(el, seen, false)) return;
    seen.add(el);
    claimText(el, seen, false);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  });

  await runPass([...matchAll(scope, 'a[href]')], (el) => {
    if (!isBlockLink(el) || seen.has(el) || textCovered(el, seen, false)) return;
    seen.add(el);
    claimText(el, seen, false);
    const text = extractText(el);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  });

  await runPass([...matchAll(scope, 'a[href]')], (el) => {
    if (!isInlineLink(el) || seen.has(el) || textCovered(el, seen, false)) return;
    seen.add(el);
    claimText(el, seen, false);
    const text = extractText(el);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  });

  await runPass([...matchAll(scope, 'span, div')], (el) => {
    if (inNav(el) || inSkip(el) || skip(el) || hasChildBlock(el) || seen.has(el)) return;
    if (el.matches(BLOCKS)) return;
    if (tryCollectRichUnit(el, seen, units, false)) return;
    if (hasInteractiveDescendant(el, false)) {
      collectMixedContentUnits(el, seen, units);
      return;
    }
    const text = extractText(el);
    if (!okText(text) || textCovered(el, seen, false)) return;
    if (text.length > INLINE_MAX) {
      if (hasTranslatableChild(el)) return;
      seen.add(el);
      claimText(el, seen, false);
      units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
      return;
    }
    seen.add(el);
    claimText(el, seen, false);
    units.push({ el: el as HTMLElement, text, kind: classifyKind(el, text) });
  });

  const NAV_EL = 'a[href], button, label, p, span, div, li, [role="heading"], h1, h2, h3, h4, h5, h6';
  for (const region of [...matchAll(scope, NAV)]) {
    const t0 = performance.now();
    if (!isVisible(region) || inSkip(region) || isPageNavRegion(region)) {
      sliceMark = t0;
      await bump();
      continue;
    }
    for (const el of Array.from(region.querySelectorAll(NAV_EL))) {
      const t1 = performance.now();
      if (inAuxNav(el) || !isTopNavLink(el, region) || skip(el, true) || hasChildBlock(el) || seen.has(el)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      if (hasInteractiveDescendant(el, true)) {
        collectMixedContentUnits(el, seen, units, true);
        sliceMark = t1;
        await bump();
        continue;
      }
      if (textCovered(el, seen, true)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      const text = extractText(el, true);
      if (!okText(text)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      seen.add(el);
      claimText(el, seen, true);
      const kind = classifyKind(el, text);
      units.push({ el: el as HTMLElement, text, kind: kind === 'block' ? 'nav' : kind });
      sliceMark = t1;
      await bump();
    }
  }

  for (const region of [...matchAll(scope, PAGE_NAV)]) {
    const t0 = performance.now();
    if (!isVisible(region) || inSkip(region)) {
      sliceMark = t0;
      await bump();
      continue;
    }
    for (const el of Array.from(region.querySelectorAll(PAGE_NAV_EL))) {
      const t1 = performance.now();
      if (!pageNavLiEligible(el) || skip(el, true) || hasChildBlock(el) || seen.has(el)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      if (hasInteractiveDescendant(el, true)) {
        collectMixedContentUnits(el, seen, units, true);
        sliceMark = t1;
        await bump();
        continue;
      }
      if (textCovered(el, seen, true)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      const text = extractText(el, true);
      if (!okText(text)) {
        sliceMark = t1;
        await bump();
        continue;
      }
      seen.add(el);
      claimText(el, seen, true);
      const kind = classifyKind(el, text);
      units.push({
        el: el as HTMLElement,
        text,
        kind: kind === 'block' ? 'nav' : kind,
      });
      sliceMark = t1;
      await bump();
    }
  }

  const tSort = performance.now();
  const sorted = sortUnitsByRank(units);
  cpuMs += performance.now() - tSort;
  return { units: sorted, cpuMs };
  });
}

function rank(u: TranslationUnit): number {
  const rect = u.el.getBoundingClientRect();
  const near = rect.bottom > -100 && rect.top < innerHeight + 400 ? 0 : 10;
  const inlineish = u.kind === 'nav' || u.kind === 'inline' || u.kind === 'inner' || u.segment ? 5 : 0;
  return near + inlineish;
}
