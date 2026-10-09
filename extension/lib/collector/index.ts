import type { TranslationUnit, UnitKind } from '../types';
import {
  A11Y, AUX_NAV, BLOCKS, CHROME, CLS_BLOCK, CLS_ERR, CLS_REPLACE, DONE, EDITABLE,
  HIDE, INLINE_HOST, INLINE_MAX, INTERACTIVE, NAV, NAV_CHROME, NO_TEXT, OURS_SEL, P,
  PAGE_NAV, PAGE_NAV_EL, SKIP,
} from '../dom-const';
import { isCompactControlHost, isEllipsizedTextHost } from '../dom-role';
import { composedContains, composedParent } from '../dom-tree';
import { yieldToMain } from '../runtime/yield';
import { hasCodeBlock, isNonProseElement } from './code-content';

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
interface SourceClipping {
  negative: boolean;
  boxes: Element[];
  escapedZero: Element | null;
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
  /** Hosts/slots whose composed subtree must remain independently rendered. */
  composedBoundary: WeakMap<Element, boolean>;
  nonProse: WeakMap<Element, boolean>;
  codeBoundary: WeakMap<Element, boolean>;
  textColumns: WeakMap<Element, boolean>;
  translatedBoundary: WeakMap<Element, boolean>;
  visibilityStyles: WeakMap<Element, CSSStyleDeclaration>;
  clipping: WeakMap<Element, SourceClipping>;
  zeroClipping: WeakMap<Element, boolean>;
  positionedBoundary: WeakMap<Element, boolean>;
}

let collectCache: CollectCache | null = null;

function newCollectCache(): CollectCache {
  return {
    selfHidden: new WeakMap(),
    visible: new WeakMap(),
    layout: new WeakMap(),
    suppProse: new WeakMap(),
    composedBoundary: new WeakMap(),
    nonProse: new WeakMap(),
    codeBoundary: new WeakMap(),
    textColumns: new WeakMap(),
    translatedBoundary: new WeakMap(),
    visibilityStyles: new WeakMap(),
    clipping: new WeakMap(),
    zeroClipping: new WeakMap(),
    positionedBoundary: new WeakMap(),
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
    if (isVisibilityMutation(m)) return true;
    if (m.type === 'characterData') {
      const text = m.target as Text;
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

/** Ignore animation transforms and our own chrome while watching CSS reveals. */
export function isVisibilityMutation(mutation: MutationRecord): boolean {
  if (mutation.type !== 'attributes' || !(mutation.target instanceof Element)) return false;
  const target = mutation.target;
  // A page can hydrate its original nodes inside a replace-mode stash. Those
  // nodes remain page-owned; only the stash itself and translated chrome are ours.
  const chrome = target.closest(OURS_SEL);
  if (isOursElement(target) || chrome && !chrome.classList.contains(HIDE)
    || target.closest(EDITABLE) && !inNonProse(target)) return false;
  const name = mutation.attributeName;
  if (name === 'hidden' || name === 'aria-hidden' || name === 'open') return true;
  if (name === 'class') return mutation.oldValue !== target.getAttribute('class');
  if (name !== 'style') return false;
  const visibilityDeclarations = (value: string | null): string =>
    Array.from((value || '').matchAll(/(?:^|;)\s*(display|visibility|opacity|(?:min-|max-)?(?:width|height|inline-size|block-size)|overflow(?:-x|-y)?|text-indent|padding(?:-[a-z-]+)?|border(?:-[a-z-]+)?|box-sizing)\s*:\s*([^;]*)/gi))
      .map(match => `${match[1].toLowerCase()}:${match[2].trim()}`)
      .sort().join(';');
  const current = target.getAttribute('style');
  if (visibilityDeclarations(mutation.oldValue) !== visibilityDeclarations(current)) return true;
  // Variables can feed descendant/shadow visibility through stylesheets and
  // aliases. Their names and values are case-sensitive; ordinary transform
  // declarations still take the cheap filtered path above.
  const customProperties = (value: string | null): string => {
    if (!value?.includes('--')) return '';
    const style = document.createElement('span').style;
    style.cssText = value || '';
    const names = Array.from(style).filter(name => name.startsWith('--')).sort();
    return names.length ? JSON.stringify(names.map(name => [name, style.getPropertyValue(name), style.getPropertyPriority(name)])) : '';
  };
  return customProperties(mutation.oldValue) !== customProperties(current);
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
    if (isVisibilityMutation(m)) {
      roots.add(m.target as Element);
      continue;
    }
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
  /** Indexed hosts whose source text or children changed (need clear + re-index). */
  invalidated: HTMLElement[];
}

/**
 * Build an incremental index delta from MutationRecords against known hosts.
 * Does NOT rescan the full document.
 */
export function mutationIndexDelta(
  mutations: MutationRecord[],
  knownHosts: Iterable<HTMLElement>,
  sourceChanged?: (host: HTMLElement) => boolean,
  containsSource?: (host: HTMLElement, box: Element) => boolean,
): MutationIndexDelta {
  const known = new Set<HTMLElement>();
  for (const h of knownHosts) known.add(h);

  const removed = new Set<HTMLElement>();
  const invalidated = new Set<HTMLElement>();

  const invalidateAncestors = (node: Node): void => {
    let el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (!el || el.closest(OURS_SEL) || el.closest(EDITABLE)) return;
    while (el) {
      const host = el as HTMLElement;
      if (known.has(host) && (!sourceChanged || sourceChanged(host))) invalidated.add(host);
      el = el.parentElement;
    }
  };

  for (const m of mutations) {
    for (const n of Array.from(m.removedNodes)) {
      if (n.nodeType !== 1) continue;
      const el = n as HTMLElement;
      for (const host of known) {
        if (!host.isConnected && (host === el || el.contains(host))) {
          removed.add(host);
        }
      }
    }

    if (m.type === 'characterData') {
      invalidateAncestors(m.target);
    } else if (isVisibilityMutation(m)) {
      const box = m.target as Element;
      for (const host of known) {
        if (composedContains(box, host) && (isA11yHidden(host) || inNonProse(host))) invalidated.add(host);
        // An editor can appear inside a previously aggregated prose unit.
        // Source ownership prevents existing editor animations from invalidating
        // an adjacent prose segment that merely shares the same container.
        else if (composedContains(host, box) && inNonProse(box) && (!containsSource || containsSource(host, box))) invalidated.add(host);
      }
    } else if (m.type === 'childList') {
      // A textContent/replaceChildren update replaces text nodes rather than
      // emitting characterData. Ignore pure companion writes; the session's
      // source snapshot also filters renderer moves and rich replacements.
      const changed = [...m.addedNodes, ...m.removedNodes].some((n) =>
        n.nodeType === Node.TEXT_NODE || (n instanceof Element && !isOursElement(n)),
      );
      if (changed) invalidateAncestors(m.target);
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
function inNonProse(el: Element): boolean {
  return isNonProseElement(el, collectCache?.nonProse);
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
  // Disconnected skeletons no longer carry the page's classes/styles. Evaluate
  // CSS on connected source nodes, before the safe builder strips those attrs.
  return isA11y(el) || (el.isConnected && !isVisible(el));
}

/** True when this element alone would hide itself (ancestors not considered). */
function isSelfStyleHidden(el: Element): boolean {
  const cached = collectCache?.selfHidden.get(el);
  if (cached !== undefined) return cached;

  let hidden = false;
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') {
    hidden = true;
  } else {
    const s = visibilityStyle(el);
    hidden = s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0;
  }
  collectCache?.selfHidden.set(el, hidden);
  return hidden;
}

/** Zero padding-box size clips only descendants in this box's clipping chain.
 * Keep that condition separate from semantic/paint hiding of the whole tree. */
function isZeroSizeClip(el: Element): boolean {
  const cached = collectCache?.zeroClipping.get(el);
  if (cached !== undefined) return cached;
  const s = visibilityStyle(el);
  let clipped = false;
  if (s.display !== 'inline' && s.display !== 'contents' && (s.overflow === 'hidden' || s.overflow === 'clip')) {
    const width = parseFloat(s.width);
    const height = parseFloat(s.height);
    // Overflow clips at the padding box. A zero content height can still
    // leave an entire visible text line inside substantial padding.
    const clipSize = (size: number, edges: readonly string[]): number => size + edges.reduce((sum, edge) => sum
      + (s.boxSizing === 'border-box' ? -(parseFloat(s.getPropertyValue(`border-${edge}-width`)) || 0)
        : parseFloat(s.getPropertyValue(`padding-${edge}`)) || 0), 0);
    const clipWidth = clipSize(width, ['left', 'right']);
    const clipHeight = clipSize(height, ['top', 'bottom']);
    clipped = (clipWidth >= 0 && clipWidth <= 2) || (clipHeight >= 0 && clipHeight <= 2);
  }
  collectCache?.zeroClipping.set(el, clipped);
  return clipped;
}

function visibilityStyle(el: Element): CSSStyleDeclaration {
  const cached = collectCache?.visibilityStyles.get(el);
  if (cached) return cached;
  const style = getComputedStyle(el);
  collectCache?.visibilityStyles.set(el, style);
  return style;
}

/** Overflow between a positioned box and its containing block does not clip
 * that box. Fixed positioning ignores ordinary positioned ancestors, while
 * transforms, filters and layout/paint containment establish both kinds. */
function positionedContainer(element: Element, fixed: boolean): Element | null {
  for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
    const style = visibilityStyle(parent);
    if (style.display === 'contents' || style.display === 'none') continue;
    if (!fixed && style.position && style.position !== 'static') return parent;
    const transformable = style.display !== 'inline' && !/^table-(column|column-group)$/.test(style.display);
    const set = (property: string): boolean => {
      const value = style.getPropertyValue(property);
      return !!value && value !== 'none';
    };
    const transforms = ['transform', 'translate', 'rotate', 'scale', 'perspective'];
    const filters = ['filter', 'backdrop-filter'];
    const filtered = parent !== document.documentElement;
    const hints = style.willChange.split(',').map(value => value.trim());
    if (transformable && (transforms.some(set) || hints.some(name => transforms.includes(name))
      || /\b(layout|paint|strict|content)\b/.test(style.contain) || style.contentVisibility === 'auto')
      || filtered && (filters.some(set) || hints.some(name => filters.includes(name)))) return parent;
  }
  return null;
}

/** Negative indent affects text runs, not every descendant. A child can reset
 * it, and subsequent lines can remain visible. Inspect actual source lines
 * only when a boxed ancestor combines negative indent and horizontal clipping. */
function sourceClipping(parent: Element): SourceClipping {
  const path: Element[] = [];
  let state: SourceClipping = {negative: false, boxes: [], escapedZero:null};
  for (let element: Element | null = parent; element; element = composedParent(element)) {
    const cached = collectCache?.clipping.get(element);
    if (cached) { state = cached; break; }
    path.push(element);
  }
  for (const element of path.reverse()) {
    const style = visibilityStyle(element);
    const boxed = style.display !== 'inline' && style.display !== 'contents';
    if (style.display !== 'contents' && /^(absolute|fixed)$/.test(style.position) && state.boxes.length) {
      const container = positionedContainer(element, style.position === 'fixed');
      const boxes = container ? state.boxes.filter(box => composedContains(box, container)) : [];
      state = {negative:state.negative, boxes, escapedZero:
        state.boxes.some(box => !boxes.includes(box) && isZeroSizeClip(box)) ? element : state.escapedZero};
    }
    state = {negative: state.negative || boxed && parseFloat(style.textIndent) <= -1000,
      boxes: boxed && /^(hidden|clip)$/.test(style.overflowX || style.overflow) ? [...state.boxes, element] : state.boxes,
      escapedZero:state.escapedZero};
    collectCache?.clipping.set(element, state);
  }
  return state;
}

function isIndentedTextClipped(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  const state = sourceClipping(parent);
  if (!state.negative || !state.boxes.length) return false;
  const range = document.createRange();
  // Incomplete DOM implementations cannot establish a clipped text run.
  if (typeof range.getClientRects !== 'function') return false;
  range.selectNodeContents(node);
  const lines = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  if (!lines.length) return false;
  const clips = state.boxes.map(box => {
    const rect = box.getBoundingClientRect(), style = visibilityStyle(box);
    const scale = box instanceof HTMLElement && box.offsetWidth ? rect.width / box.offsetWidth : 1;
    return {left: rect.left + (parseFloat(style.borderLeftWidth) || 0) * scale,
      right: rect.right - (parseFloat(style.borderRightWidth) || 0) * scale};
  });
  const left = Math.max(...clips.map(clip => clip.left)), right = Math.min(...clips.map(clip => clip.right));
  return !lines.some(rect => rect.right > left && rect.left < right);
}

function isVisible(el: Element | null): boolean {
  if (!el?.isConnected || isA11y(el)) return false;

  const cached = collectCache?.visible.get(el);
  if (cached !== undefined) return cached;

  for (let n: Element | null = el; n && n !== document.documentElement;) {
    if (n.nodeType !== 1) break;
    if (isSelfStyleHidden(n)) {
      collectCache?.visible.set(el, false);
      return false;
    }
    const parent: Element | null = n.parentElement;
    // Light DOM without a matching slot is fallback data, not rendered text.
    // Walk the composed ancestry so hidden hosts/slots also hide shadow prose.
    if (parent?.shadowRoot && !(n as HTMLElement).assignedSlot) {
      collectCache?.visible.set(el, false);
      return false;
    }
    if (parent instanceof HTMLSlotElement && parent.assignedNodes().length) {
      collectCache?.visible.set(el, false);
      return false;
    }
    const root = n.getRootNode();
    n = (n as HTMLElement).assignedSlot || parent || (root instanceof ShadowRoot ? root.host : null);
  }
  const d = el.closest('details') as HTMLDetailsElement | null;
  if (d && !d.open && !el.closest('summary')) {
    collectCache?.visible.set(el, false);
    return false;
  }
  if (sourceClipping(el).boxes.some(isZeroSizeClip)) {
    collectCache?.visible.set(el, false);
    return false;
  }
  collectCache?.visible.set(el, true);
  return true;
}

/** A shadow host's unassigned direct text is not part of its rendered tree. */
export function isRenderedTextNode(node: Text): boolean {
  if (!node.isConnected) return true;
  const parent = node.parentElement;
  if (parent instanceof HTMLSlotElement && parent.assignedNodes().length) return false;
  return (!parent?.shadowRoot || node.assignedSlot !== null) && !isIndentedTextClipped(node);
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
    if (n.nodeType === 3 && isRenderedTextNode(n as Text)) raw += (n as Text).nodeValue ?? '';
  }
  return normalizeRenderedText(el, raw);
}

/** Keep paragraph breaks when CSS makes source newlines visible. */
function normalizeRenderedText(el: Element, raw: string): string {
  if (/[\r\n]/.test(raw)) {
    const whiteSpace = getComputedStyle(el).whiteSpace;
    if (/^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace)) {
      return raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
    }
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function extractText(el: Element, nav = false): string {
  const vis = nav ? isVisible : inViewport;
  // Common case on article / perf pages: a block with only text nodes.
  if (!el.firstElementChild) {
    if (inNonProse(el) || underDone(el) || el.closest(OURS_SEL) || el.closest(EDITABLE)) return '';
    if (!vis(el)) return '';
    return leafTextContent(el);
  }

  const out: string[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !el.contains(p) || NO_TEXT.has(p.tagName) || inNonProse(p)) return NodeFilter.FILTER_REJECT;
      if (!isRenderedTextNode(n as Text)) return NodeFilter.FILTER_REJECT;
      // DONE hosts keep their original text nodes; rejecting them stops a parent
      // (e.g. <li>) from being re-collected after a child <a> was translated.
      if (underDone(p) || p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (!vis(p) || !(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push((n as Text).nodeValue ?? '');
  return normalizeRenderedText(el, out.join(''));
}

function skip(el: Element | null, nav = false, allowEscaped = false): boolean {
  if (!el || NO_TEXT.has(el.tagName) || inNonProse(el)) return true;
  if (!(nav ? isVisible(el) : inViewport(el)) && !(allowEscaped && hasEscapedPositionedText(el)) || inSkip(el)) return true;
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
  if (hasTranslatedBoundary(el) || hasComposedBoundary(el) || hasCodeBlock(el, collectCache?.codeBoundary)
    || hasIndependentTextColumns(el) || hasEscapedPositionedText(el)) return true;
  for (const c of Array.from(el.querySelectorAll(INTERACTIVE))) {
    if (c === el || !isVisible(c)) continue;
    // A DONE interactive still owns its text — treat it as covering the host so
    // parents are not re-collected after the child was translated.
    if (c.hasAttribute(DONE) || underDone(c)) return true;
    if (c.closest(OURS_SEL)) continue;
    // Buttons/inputs are excluded as translation hosts, but still own their
    // nested labels. A parent must not combine several controls into one unit.
    if (NO_TEXT.has(c.tagName)) return true;
    if (skip(c, nav)) continue;
    return true;
  }
  return false;
}

/** An escaped text box owns its painted position. A zero-sized wrapper must
 * not consume it into a companion that would be mounted inside that wrapper. */
function hasEscapedPositionedText(el: Element): boolean {
  const cached = collectCache?.positionedBoundary.get(el);
  if (cached !== undefined) return cached;
  const parentEscape = sourceClipping(el).escapedZero;
  const result = Array.from(el.children).some(child => !isOursElement(child) && !NO_TEXT.has(child.tagName)
    && !inNonProse(child) && (sourceClipping(child).escapedZero && sourceClipping(child).escapedZero !== parentEscape
      && isVisible(child) && !!child.textContent?.trim()
      || hasEscapedPositionedText(child)));
  collectCache?.positionedBoundary.set(el, result);
  return result;
}

/** Incremental parent scans must not consume already processed source slots,
 * including visible rich replacements that no longer have a companion class. */
function hasTranslatedBoundary(el: Element): boolean {
  const cached = collectCache?.translatedBoundary.get(el);
  if (cached !== undefined) return cached;
  const boundary = !!el.firstElementChild && !!el.querySelector(`[${DONE}]`);
  collectCache?.translatedBoundary.set(el, boundary);
  return boundary;
}

/** Multiple textual flex items already own independent layout columns. Keep
 * their parents and direct-child selectors by collecting each column in place. */
function hasIndependentTextColumns(el: Element): boolean {
  const cached = collectCache?.textColumns.get(el);
  if (cached !== undefined) return cached;
  let result = false;
  if (el.children.length >= 2 && !Array.from(el.childNodes).some(node =>
    node.nodeType === Node.TEXT_NODE && !!node.nodeValue?.trim(),
  )) {
    const style = getComputedStyle(el);
    if ((style.display === 'flex' || style.display === 'inline-flex')
      && !style.flexDirection.startsWith('column') && !isCompactControlHost(el)) {
      result = Array.from(el.children).filter(child => !isOursElement(child)
        && !NO_TEXT.has(child.tagName) && !inNonProse(child)
        && !!child.textContent?.trim() && isVisible(child)).length >= 2;
    }
  }
  collectCache?.textColumns.set(el, result);
  return result;
}

/** Light-DOM text does not describe a custom element's shadow contents. Never
 * combine that independent subtree into a plain/rich replacement container. */
export function hasComposedBoundary(el: Element): boolean {
  const cached = collectCache?.composedBoundary.get(el);
  if (cached !== undefined) return cached;
  const boundary = !!el.shadowRoot || el instanceof HTMLSlotElement
    || Array.from(el.children).some(child => !isOursElement(child) && hasComposedBoundary(child));
  collectCache?.composedBoundary.set(el, boundary);
  return boundary;
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
    if (inNonProse(root) || underDone(root) || root.closest(OURS_SEL) || root.closest(EDITABLE)) return [];
    if (!vis(root)) return [];
    const nodes: Text[] = [];
    for (let n = root.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && isRenderedTextNode(n as Text) && (n as Text).nodeValue?.trim()) nodes.push(n as Text);
    }
    return nodes;
  }
  const nodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName) || inNonProse(p)) return NodeFilter.FILTER_REJECT;
      if (!isRenderedTextNode(n as Text)) return NodeFilter.FILTER_REJECT;
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
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName) || inNonProse(p)) return NodeFilter.FILTER_REJECT;
      if (!isRenderedTextNode(n as Text)) return NodeFilter.FILTER_REJECT;
      if (p.closest(OURS_SEL) || p.closest(EDITABLE)) return NodeFilter.FILTER_REJECT;
      if (isA11yHidden(p)) return NodeFilter.FILTER_REJECT;
      if (!(n as Text).nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n as Text);
  return nodes;
}

/** Text-node slots under a host, in document order (NO_TEXT parents skipped). */
export function extractRichSlots(el: Element): string[] {
  return collectSlotTextNodes(el).map(n => normalizeRenderedText(n.parentElement || el, n.nodeValue ?? '')).filter(Boolean);
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
      if (!p || !root.contains(p) || NO_TEXT.has(p.tagName) || inNonProse(p)) return NodeFilter.FILTER_REJECT;
      if (!isRenderedTextNode(n as Text)) return NodeFilter.FILTER_REJECT;
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
    .map((s) => ({ anchor: s.anchor, nodes: s.nodes, text: normalizeRenderedText(s.anchor, s.text), key: s.nodes[0] as Text }))
    .filter((s) => okText(s.text));
}

/**
 * Inline markup that should survive into the bilingual companion (Immersive-style).
 * Form controls / media are excluded — those fall back to mixed-content splitting.
 */
const RICH_MARKUP =
  'a[href], code, kbd, var, samp, strong, b, em, i, mark, sup, sub, abbr, cite, q';
const RICH_BLOCKING =
  'button, label, summary, input, select, textarea, img, video, audio, iframe, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="option"]';

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
  kindOverride?: UnitKind,
): boolean {
  if (nav || inNav(host)) return false;
  if (hasRichBlocking(host) || !hasRichMarkup(host) || hasComposedBoundary(host)
    || hasCodeBlock(host, collectCache?.codeBoundary) || hasIndependentTextColumns(host) || hasTranslatedBoundary(host)
    || hasEscapedPositionedText(host)) return false;
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
    kind: kindOverride ?? classifyKind(host, text),
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
    // A media/control sibling can disqualify the outer block while a nested
    // caption remains ordinary rich prose. Keep that caption and its links
    // together rather than merging only its non-link text runs.
    if (seg.anchor !== host && tryCollectRichUnit(seg.anchor, seen, units, nav, 'block')) continue;
    for (const n of seg.nodes) seen.add(n);
    // Segment ownership affects replacement, not visual layout. A short block
    // caption next to media still needs a separate, wrapping translation row;
    // controls and inline credit labels retain their compact classification.
    units.push({
      el: seg.anchor,
      nodes: seg.nodes,
      text: seg.text,
      kind: nav ? 'inner' : classifyKind(seg.anchor, seg.text),
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

  // Ellipsis is a source truncation policy, rather than evidence of a compact
  // control. Keep that source line intact and let translated prose wrap below.
  if (isEllipsizedTextHost(el)) return 'block';

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

  // Descriptions and captions are prose; short terms/data cells stay compact.
  if (el.matches('dd')) return 'block';
  if (el.matches('figcaption, caption')) return 'block';
  // Structured cells already put their source in a block (often clipped or
  // ellipsized). Give the companion its own row inside the cell, outside that
  // source-only clipping box. Plain short data/header cells stay inline.
  if (el.matches('td, th') && Array.from(el.children).some(child => isBlockLikeLayout(child))) {
    return 'block';
  }
  if (el.matches('dt, th, td') && len <= INLINE_MAX) return 'inline';

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
    if (inNav(el) || skip(el, false, true) || hasChildBlock(el)) continue;
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
    if (inNav(el) || inSkip(el) || skip(el, false, true) || hasChildBlock(el) || seen.has(el)) continue;
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
    if (inNav(el) || skip(el, false, true) || hasChildBlock(el)) return;
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
    if (inNav(el) || inSkip(el) || skip(el, false, true) || hasChildBlock(el) || seen.has(el)) return;
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

  // Rank does one getBoundingClientRect per unit — slice it like the passes
  // above so a 20k-unit sort cannot form a Long Task on its own.
  const ranked: Array<{ u: TranslationUnit; r: number }> = [];
  for (const u of units) {
    const tRank = performance.now();
    ranked.push({ u, r: rank(u) });
    sliceMark = tRank;
    await bump();
  }
  const tSort = performance.now();
  ranked.sort((a, b) => a.r - b.r);
  cpuMs += performance.now() - tSort;
  return { units: ranked.map((x) => x.u), cpuMs };
  });
}

function rank(u: TranslationUnit): number {
  const rect = u.el.getBoundingClientRect();
  const near = rect.bottom > -100 && rect.top < innerHeight + 400 ? 0 : 10;
  const inlineish = u.kind === 'nav' || u.kind === 'inline' || u.kind === 'inner' || u.segment ? 5 : 0;
  return near + inlineish;
}
