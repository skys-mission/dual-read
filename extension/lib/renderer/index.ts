import type { TargetLang, TranslationMode, TranslationPayload, TranslationUnit, UnitKind } from '../types';
import {
  CLS_BLOCK, CLS_ERR, CLS_FLOW, CLS_INLINE, CLS_INNER, CLS_NAV, CLS_REPLACE, DONE,
  FLOW, HIDE, LIST_OUTSIDE, MODE, NOWRAP, OURS_SEL, OUTSIDE, P, SHELL, STASH_ALL,
  STASH_LANGUAGE_ATTRS, STASH_TEXT,
  WRAP_TEXT,
} from '../dom-const';
import { isCompactControlHost, shouldKeepControlOnOneLine } from '../dom-role';
import { collectSlotTextNodes, collectVisibleTextNodes, hasComposedBoundary } from '../collector';
import { hasCodeBlock } from '../collector/code-content';
import { buildSafeRichSkeleton } from './rich';
import { captureRichReplacement, forgetRichReplacement, restoreMovedRichNodes, restoreRichReplacement, type RichReplacementNode } from './rich-replace';
import { walkOpenShadowRoots } from '../roots';
import { ensureTranslationStyles, removeTranslationStyles } from './styles';
import { applyBoundedLayouts, readBoundedLayouts, releaseBoundedLayout, restoreBoundedLayouts } from './bounded-layout';
import { applyCompactLayouts, readCompactLayouts } from './compact-layout';
import { applyMediaLayouts, attachMediaLayouts, captureMediaLayouts, readMediaLayouts, releaseMediaLayout, restoreMediaLayouts } from './media-layout';
import { applySourceTypography, readSourceTypography, releaseSourceTypography, restoreSourceTypography, type SourceTypography } from './source-typography';
import { applyAnchoredLayouts, attachAnchoredLayouts, captureAnchoredLayouts, readAnchoredLayouts, releaseAnchoredLayout, restoreAnchoredLayouts } from './anchored-layout';

export { buildSafeRichSkeleton, sanitizeHref, isForbiddenAttr } from './rich';
export { restoreMovedRichNodes } from './rich-replace';
export { applyBoundedLayouts, readBoundedLayouts } from './bounded-layout';
export { applyCompactLayouts, readCompactLayouts } from './compact-layout';
export { applyMediaLayouts, captureMediaLayouts, readMediaLayouts } from './media-layout';
export { readSourceTypography } from './source-typography';
export { applyAnchoredLayouts, captureAnchoredLayouts, readAnchoredLayouts } from './anchored-layout';

const P_NAV_SUB = `${P}-nav-sub`;
const P_INLINE = `${P}-target--inline`;
const P_COMPACT = `${P}-target--compact`;
const P_INNER = `${P}-target--inner`;
const LIST_HOST = 'li, [role="listitem"]';
const richReplacementNodes = new WeakMap<HTMLElement, RichReplacementNode[]>();
const companions = new WeakMap<Element, Element>();
const companionHosts = new WeakMap<Element, Element>();
const flows = new WeakMap<HTMLElement, Set<HTMLElement>>();
const flowHosts = new WeakMap<Element, HTMLElement>();
interface TextReplacement {
  host: HTMLElement;
  visible: HTMLElement;
  stashes: HTMLElement[];
}
const textReplacements = new WeakMap<HTMLElement, TextReplacement>();
const textReplacementNodes = new WeakMap<Element, TextReplacement>();

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

function stashAndReplaceText(host: HTMLElement, nodes: Text[], translation: string, opts?: RenderOpts): HTMLElement {
  // Stash each source text node in place. Runs of one segment may be separated
  // by interactive chrome (link/button), and restore must rebuild the exact
  // original sequence — a single combined stash would relocate trailing runs.
  let firstStash: HTMLElement | null = null;
  const stashes: HTMLElement[] = [];
  for (const n of nodes) {
    const stash = document.createElement('span');
    stash.className = HIDE;
    stash.setAttribute(STASH_TEXT, 'true');
    n.parentNode?.insertBefore(stash, n);
    stash.appendChild(n);
    stashes.push(stash);
    firstStash ??= stash;
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
  const replacement = { host, visible, stashes };
  textReplacements.set(host, replacement);
  textReplacementNodes.set(visible, replacement);
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

/** Move current source children back in place, preserving identities and edits. */
function unwrapTextStash(stash: Element): void {
  const parent = stash.parentNode;
  if (!parent) return;
  while (stash.firstChild) parent.insertBefore(stash.firstChild, stash);
  stash.remove();
}

function restoreTextReplace(visible: Element): void {
  const replacement = textReplacementNodes.get(visible);
  if (replacement) {
    for (const stash of replacement.stashes) {
      unwrapTextStash(stash);
    }
    visible.remove();
    textReplacements.delete(replacement.host);
    textReplacementNodes.delete(visible);
    return;
  }
  // Reverse every stash owned by this replacement (one per source text node).
  const parent = visible.parentElement;
  if (!parent) return;
  for (const stash of Array.from(parent.querySelectorAll(`:scope .${HIDE}[${STASH_TEXT}]`))) {
    unwrapTextStash(stash);
  }
  visible.remove();
}

function restoreReplaceOn(el: HTMLElement): void {
  restoreMovedRichNodes([el]);
  const companion = findNode(el);
  if (companion) removeCompanion(companion);

  const allStash = el.querySelector(`:scope > .${HIDE}[${STASH_ALL}]`);
  if (allStash) {
    // Rich replace stashes originals, then appends a filled skeleton as siblings
    // (no dual-read-target wrapper). Drop those translation siblings before
    // unpacking the stash — otherwise restore leaves original+translation.
    const translated = richReplacementNodes.get(el);
    if (translated) {
      restoreRichReplacement(el, allStash, translated);
    } else if (el.hasAttribute(STASH_LANGUAGE_ATTRS)) {
      // Legacy rich replacements can survive an extension reload without our
      // node map. Plain replacements have only a companion, removed above;
      // their other siblings are page content and must survive restoration.
      for (const child of Array.from(el.childNodes)) {
        if (child !== allStash) el.removeChild(child);
      }
    }
    while (allStash.firstChild) el.insertBefore(allStash.firstChild, allStash);
    allStash.remove();
  }
  richReplacementNodes.delete(el);
  forgetRichReplacement(el);

  el.querySelectorAll(`:scope .${HIDE}[${STASH_TEXT}]`).forEach((stash) => {
    const visible = stash.nextElementSibling;
    if (visible?.classList?.contains(CLS_REPLACE)) visible.remove();
    unwrapTextStash(stash);
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
export function repairStructure(root: ParentNode = document): void {
  for (const host of Array.from(root.querySelectorAll('p.caption, p[role="heading"], li'))) {
    const anchor = host.matches('li') ? host.querySelector(':scope > a[href]') : host;
    if (!anchor) continue;
    let s = anchor.nextElementSibling;
    while (s && s.tagName !== 'UL' && s.tagName !== 'OL') {
      if (isOursCompanion(s)) {
        const r = s;
        s = s.nextElementSibling;
        removeCompanion(r);
      } else break;
    }
  }

  // Reparent legacy afterend companions back into the preceding list item so
  // translations inherit list indentation (aligned newline under the text).
  for (const host of Array.from(root.querySelectorAll(LIST_HOST))) {
    const next = host.nextElementSibling;
    if (!next || !isOursCompanion(next)) continue;
    host.appendChild(next);
    if (host instanceof HTMLElement) markListContentBox(host);
  }
}

function rememberCompanion(host: Element, node: Element): Element {
  companions.set(host, node);
  companionHosts.set(node, host);
  return node;
}

function removeCompanion(node: Element): void {
  releaseSourceTypography(node);
  releaseBoundedLayout(node);
  releaseMediaLayout(node);
  releaseAnchoredLayout(node);
  const host = companionHosts.get(node);
  if (host && companions.get(host) === node) companions.delete(host);
  companionHosts.delete(node);
  node.remove();
}

function ownsCompanion(host: Element, node: Element): boolean {
  const owner = companionHosts.get(node);
  if (owner) return owner === host;
  // Legacy companions have no in-memory owner. A nested translated host is
  // still an ownership boundary, including across extension reinjection.
  const nestedHost = node.parentElement?.closest(`[${DONE}], [${MODE}]`);
  return !nestedHost || nestedHost === host || !host.contains(nestedHost);
}

function findNode(el: Element): Element | null {
  const owned = companions.get(el);
  // A clipped source's companion may live after an ancestor clipping box.
  // Keep its explicit owner even when the page moves/removes that source.
  if (owned?.parentNode && companionHosts.get(owned) === el) return owned;
  // Prefer a companion nested inside the host (current Immersive-aligned mount).
  const nested = Array.from(el.querySelectorAll(
    `:scope > .${CLS_BLOCK}, :scope > .${CLS_ERR}, :scope .${P_NAV_SUB}, :scope .${P_INLINE}, :scope .${P_COMPACT}, :scope .${P_INNER}`,
  )).find((node) => ownsCompanion(el, node));
  if (nested) return rememberCompanion(el, nested);
  // Outside-mounted companions (painted CTAs) and legacy block afterend siblings.
  const next = el.nextElementSibling;
  if (next && isOursCompanion(next) && ownsCompanion(el, next)) return rememberCompanion(el, next);
  return null;
}

function mountInlineTranslation(el: HTMLElement, kind: UnitKind): HTMLElement {
  const cls = kind === 'nav' ? CLS_NAV : CLS_INLINE;
  let node = findNode(el) as HTMLElement | null;
  if (node?.classList.contains(CLS_ERR)) {
    // A stale error badge must not share the host with a fresh translation.
    removeCompanion(node);
    node = null;
  }
  if (node) {
    node.className = cls;
    placeInlineCompanion(el, node);
    return node;
  }

  node = document.createElement('span');
  rememberCompanion(el, node);
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
function mount(el: HTMLElement, kind: UnitKind, avoidClipping = false): HTMLElement {
  if (kind === 'nav' || kind === 'inline') return mountInlineTranslation(el, kind);

  const cls = kind === 'inner' ? CLS_INNER : CLS_BLOCK;
  let node = findNode(el) as HTMLElement | null;
  if (node?.classList.contains(CLS_ERR)) {
    // A stale error badge must not share the host with a fresh translation.
    removeCompanion(node);
    node = null;
  }
  if (node) {
    node.className = cls;
    if (kind === 'inner') {
      placeInlineCompanion(el, node);
    } else if (kind === 'block') {
      placeBlockCompanion(el, node, avoidClipping);
    }
    return node;
  }

  // Always use <span>: valid phrasing content inside <p>/<h*>, display via CSS.
  node = document.createElement('span');
  rememberCompanion(el, node);
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
    placeBlockCompanion(el, node, avoidClipping);
  }
  return node;
}

/** Leave source line clamps intact while giving bilingual prose a visible row. */
function placeBlockCompanion(host: HTMLElement, node: HTMLElement, avoidClipping: boolean): void {
  // Source-only nowrap truncation must not turn a prose translation into one
  // unbreakable line. Preserve actual source paragraph breaks under `pre`.
  const sourceWhiteSpace = getComputedStyle(host).whiteSpace;
  if (sourceWhiteSpace === 'nowrap' || sourceWhiteSpace === 'pre') {
    node.style.whiteSpace = sourceWhiteSpace === 'pre' ? 'pre-wrap' : 'normal';
    node.style.overflowWrap = 'anywhere';
  }
  if (avoidClipping) {
    let clippingBox: HTMLElement | null = null;
    for (let box: HTMLElement | null = host; box?.parentElement; box = box.parentElement) {
      // Keep translated text inside the source's original interactive hit area.
      if (box.matches('a[href], button, [role="button"], [role="tab"], body')) break;
      const style = getComputedStyle(box);
      const clamp = parseInt(style.getPropertyValue('line-clamp'), 10)
        || parseInt(style.getPropertyValue('-webkit-line-clamp'), 10);
      if (clamp > 0) clippingBox = box;
    }
    // Nested excerpt clamps can otherwise hide a companion moved out of only
    // the innermost box. Stay inside the original card/link ownership boundary.
    const box = clippingBox;
    if (box?.parentElement) {
      const parentStyle = getComputedStyle(box.parentElement);
      // A new sibling must have a block row, rather than a squeezed flex/grid
      // track beside the source. Ordinary blocks and column flex cards allow it.
      if (!parentStyle.display.includes('grid')
        && (!parentStyle.display.includes('flex') || parentStyle.flexDirection.startsWith('column'))) {
        let after: Element = box;
        for (let next = after.nextElementSibling; next && next !== node; next = after.nextElementSibling) {
          const owner = companionHosts.get(next);
          if (!owner || !box.contains(owner)
            || !(owner.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
          after = next;
        }
        if (after.nextElementSibling !== node) after.insertAdjacentElement('afterend', node);
        // Relocated companions still share the source's text metrics, even when
        // the card shell has a different font or whitespace policy.
        const sourceStyle = getComputedStyle(host);
        for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'white-space', 'text-wrap', 'word-break', 'overflow-wrap']) {
          if ((sourceWhiteSpace === 'nowrap' || sourceWhiteSpace === 'pre')
            && (property === 'white-space' || property === 'overflow-wrap')) continue;
          const value = sourceStyle.getPropertyValue(property);
          if (value) node.style.setProperty(property, value);
        }
        return;
      }
    }
  }
  nestCompanionInHost(host, node);
  markListContentBox(host);
  markFlexBreak(host, node);
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
    const style = getComputedStyle(host);
    const d = style.display;
    if (d === 'flex' || d === 'inline-flex') {
      if (style.flexDirection.startsWith('column')) return;
      if (style.flexWrap !== 'wrap' && style.flexWrap !== 'wrap-reverse') {
        ensureBlockFlow(host, node);
        return;
      }
    }
    if (d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid') {
      node.classList.add(`${P}-target--break`);
    }
  } catch {
    /* jsdom / detached */
  }
}

/** A nowrap icon row gives prose and its translation one shrinking flex item. */
function ensureBlockFlow(host: HTMLElement, companion: HTMLElement): void {
  if (companion.parentElement !== host) return;
  const directText = Array.from(host.childNodes).some(node => node.nodeType === Node.TEXT_NODE && !!node.nodeValue?.trim());
  const labels = Array.from(host.children).filter(child => child !== companion
    && !isFlexLeadMedia(child) && !!child.textContent?.trim());
  if (!directText) {
    // Reuse the page's label rather than moving it out of its flex slot.
    if (labels.length === 1 && labels[0] instanceof HTMLElement
      && !labels[0].matches('a[href], button, label, summary')) labels[0].appendChild(companion);
    return;
  }
  if (labels.some(label => !isTextFlowBoundary(label))) {
    // Original prose markup can depend on direct-child selectors. Keep every
    // page element in place and give the companion a complete wrapping row.
    host.setAttribute(WRAP_TEXT, 'true');
    companion.classList.add(`${P}-target--break`);
    return;
  }
  wrapTextFlow(host, companion, true);
}

/** Independent flex slots split source runs; their page selectors stay intact. */
function isTextFlowBoundary(node: Node): boolean {
  return isFlexLeadMedia(node) || node instanceof Element && (
    node.matches('button, label, summary, input, select, textarea, iframe, audio, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"]')
    || node.matches('a[href]') && (isCompactControlHost(node)
      || /^(inline-)?(flex|grid)$/.test(getComputedStyle(node).display))
    || hasCodeBlock(node)
  );
}

/** Keep each contiguous source run at its current position around independent
 * media/control/code slots, with the companion in the final text run. */
function wrapTextFlow(host: HTMLElement, companion: HTMLElement, block: boolean): void {
  const existing = Array.from(host.querySelectorAll<HTMLElement>(`:scope > .${CLS_FLOW}`))
    .filter(flow => !flowHosts.has(flow) || flowHosts.get(flow) === host).at(-1);
  if (existing) {
    rememberFlow(host, existing);
    existing.appendChild(companion);
    return;
  }
  const children = Array.from(host.childNodes).filter(child => child !== companion);
  // Read source roles before wrapping changes direct-child selectors/layout.
  const boundaries = new Map<Node, boolean>(children.map(child => [child, isTextFlowBoundary(child)]));
  const isContent = (child: Node): boolean => child.nodeType === Node.TEXT_NODE
    ? !!child.nodeValue?.trim()
    : !boundaries.get(child) && !!child.textContent?.trim();
  const first = children.findIndex(isContent);
  let last = children.length - 1;
  while (last >= first && !isContent(children[last])) last--;
  if (first < 0) return;

  const runs: Node[][] = [];
  let run: Node[] = [];
  for (const child of children.slice(first, last + 1)) {
    if (boundaries.get(child)) {
      if (run.some(isContent)) runs.push(run);
      run = [];
    } else run.push(child);
  }
  if (run.some(isContent)) runs.push(run);
  for (let index = 0; index < runs.length; index++) {
    const nodes = runs[index];
    const flow = document.createElement('span');
    flow.className = block ? `${CLS_FLOW} ${CLS_FLOW}--block` : CLS_FLOW;
    flow.setAttribute(FLOW, 'true');
    rememberFlow(host, flow);
    host.insertBefore(flow, nodes[0]);
    for (const child of nodes) flow.appendChild(child);
    if (index === runs.length - 1) flow.appendChild(companion);
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

  const originals = mode === 'replace' ? new Map<Node, Node>() : undefined;
  const skeleton = buildSafeRichSkeleton(el, originals);
  stripOursFromTree(skeleton);
  if (collectSlotTextNodes(skeleton).length !== slots.length) return false;
  fillTextSlots(skeleton, slots);

  if (mode === 'replace') {
    // Stash original children so restoreDom can undo; show filled skeleton in place.
    stashLanguageAttrs(el);
    hideAllChildren(el);
    richReplacementNodes.set(el, captureRichReplacement(skeleton, originals!, el));
    while (skeleton.firstChild) el.appendChild(skeleton.firstChild);
    el.setAttribute(DONE, 'true');
    el.setAttribute(MODE, 'replace');
    applyTranslationLang(el, opts);
    return true;
  }

  const node = mount(el, kind, true);
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
 * Flat hosts wrap a contiguous source run + companion into one inline flow.
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

  wrapTextFlow(host, companion, false);
}

function rememberFlow(host: HTMLElement, flow: HTMLElement): void {
  const owned = flows.get(host) ?? new Set<HTMLElement>();
  owned.add(flow);
  flows.set(host, owned);
  flowHosts.set(flow, host);
}

/** Unwrap at the page's current position; never move transferred sources back. */
function unwrapFlow(flow: Element): void {
  const parent = flow.parentNode;
  if (!parent) return;
  while (flow.firstChild) parent.insertBefore(flow.firstChild, flow);
  flow.remove();
  const host = flowHosts.get(flow);
  if (host) flows.get(host)?.delete(flow as HTMLElement);
  flowHosts.delete(flow);
}

function unwrapInlineFlows(host: HTMLElement): void {
  const owned = new Set<Element>(flows.get(host));
  // Legacy/reinjected flows lack an identity map. A different translated host
  // remains an ownership boundary during single-unit restoration.
  for (const flow of host.querySelectorAll(`.${CLS_FLOW}[${FLOW}="true"]`)) {
    const owner = flowHosts.get(flow) ?? flow.parentElement?.closest(`[${DONE}], [${MODE}]`);
    if (!owner || owner === host) owned.add(flow);
  }
  for (const flow of owned) unwrapFlow(flow);
  flows.delete(host);
}

/** Mark compact control hosts so original+translation stay on one horizontal line. */
function markNowrapHost(el: HTMLElement, kind: UnitKind): void {
  if (
    (kind === 'nav' || kind === 'inline' || kind === 'inner')
    && shouldKeepControlOnOneLine(el)
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
  ensureTranslationStyles(el.getRootNode());

  if (isEffectivelyUnchanged(unit, payload)) {
    // Mark the unit as processed so a new session does not collect it again.
    // No source DOM is changed, so replace mode also remains semantically safe.
    el.setAttribute(DONE, 'true');
    el.setAttribute(MODE, mode);
    el.removeAttribute(NOWRAP);
    el.removeAttribute(OUTSIDE);
    return;
  }

  if (unit.rich?.slots?.length && !hasComposedBoundary(el)) {
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
      stashAndReplaceText(el, unit.nodes, text, opts);
      return;
    }
    if (hasComposedBoundary(el)) {
      const nodes = collectVisibleTextNodes(el);
      if (nodes.length) stashAndReplaceText(el, nodes, text, opts);
      return;
    }
    if (kind === 'inner') {
      const nodes = collectVisibleTextNodes(el);
      if (nodes.length) stashAndReplaceText(el, nodes, text, opts);
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

  const node = mount(el, kind, true);
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
  const typography = readSourceTypography([unit]);
  captureMediaLayouts([unit.el]);
  if (mode === 'bilingual') {
    captureAnchoredLayouts([unit.el]);
  }
  renderCore(unit, payload, mode, opts, (host, node) => {
    applySourceTypography(node, typography.get(unit.el));
    reserveBlockShell(host, node);
    stabilizeBlockShell(node);
    attachMediaLayouts(unit.el, node);
    attachAnchoredLayouts(unit.el, node);
    applyBoundedLayouts(readBoundedLayouts([node]));
    applyMediaLayouts(readMediaLayouts([node]));
    applyAnchoredLayouts(readAnchoredLayouts([node]));
  });
  const node = findNode(unit.el);
  if (mode === 'replace') {
    if (node instanceof HTMLElement) applySourceTypography(node, typography.get(unit.el));
    const owner = node instanceof HTMLElement ? node : textReplacements.get(unit.el)?.visible ?? unit.el;
    attachMediaLayouts(unit.el, owner);
    applyMediaLayouts(readMediaLayouts([owner]));
  }
  if (mode === 'bilingual' && node instanceof HTMLElement) applyCompactLayouts(readCompactLayouts([node]));
}

/** A companion awaiting layout checks; value zero denotes an inline label. */
export interface ShellReservation {
  node: HTMLElement;
  value: number;
}

/** keep/clear outcome for one reserved shell, from the read pass. */
interface ShellDecision {
  node: HTMLElement;
  keep: boolean;
  value: number;
}

/**
 * Read pass of shell stabilization: measure every filled companion and decide
 * whether the reserved floor must stay. Call while layout is clean (frame
 * start, before any DOM write of the frame) so the reads cost no forced layout.
 */
export function readShellDecisions(
  reserved: ReadonlyArray<ShellReservation>,
): ShellDecision[] {
  const decisions: ShellDecision[] = [];
  for (const { node, value } of reserved) {
    if (!value) continue;
    let h = 0;
    try {
      h = node.getBoundingClientRect().height || node.scrollHeight;
    } catch {
      /* jsdom / detached */
    }
    decisions.push({ node, keep: h < value * (1 - SHELL_STABILIZE_SLACK), value });
  }
  return decisions;
}

/** Write pass of shell stabilization — no layout reads. */
export function applyShellDecisions(decisions: ReadonlyArray<ShellDecision>): void {
  for (const { node, keep, value } of decisions) {
    if (keep) {
      node.style.minHeight = `${value}px`;
    } else {
      node.style.minHeight = '';
      node.removeAttribute(SHELL);
    }
  }
}

/**
 * Render a batch while avoiding layout thrashing. mount + fill (DOM writes)
 * run for every unit first, then reserved floors are applied in one write
 * pass. Host heights come from `preMeasuredHostHeights` (read by the caller
 * while layout was still clean); without it they are measured inline, which
 * forces one layout per batch.
 *
 * Returns the applied reservations WITHOUT settling them: the caller settles
 * via readShellDecisions + applyShellDecisions at the start of a later frame,
 * so a translate flush performs zero forced synchronous layouts.
 */
export function renderBatch(
  items: ReadonlyArray<{ unit: TranslationUnit; payload: TranslationPayload }>,
  mode: TranslationMode,
  opts?: RenderOpts,
  preMeasuredHostHeights?: ReadonlyMap<HTMLElement, number>,
  preMeasuredTypography?: ReadonlyMap<HTMLElement, SourceTypography>,
): ShellReservation[] {
  const typography = preMeasuredTypography ?? readSourceTypography(items.map(({ unit }) => unit));
  if (!preMeasuredHostHeights) {
    captureMediaLayouts(items.map(({ unit }) => unit.el));
    if (mode === 'bilingual') captureAnchoredLayouts(items.map(({ unit }) => unit.el));
  }
  const pending: Array<{ host: HTMLElement; node: HTMLElement }> = [];
  const replacements: HTMLElement[] = [];
  for (const { unit, payload } of items) {
    try {
      renderCore(unit, payload, mode, opts, (host, node) => {
        applySourceTypography(node, typography.get(unit.el));
        attachMediaLayouts(unit.el, node);
        attachAnchoredLayouts(unit.el, node);
        pending.push({ host, node });
      });
      const node = mode === 'replace' ? findNode(unit.el) : null;
      if (node instanceof HTMLElement) applySourceTypography(node, typography.get(unit.el));
      if (mode === 'replace') {
        const owner = node instanceof HTMLElement ? node : textReplacements.get(unit.el)?.visible ?? unit.el;
        attachMediaLayouts(unit.el, owner);
        replacements.push(owner);
      }
    } catch (err) {
      console.error('[Dual Read] render:', err);
    }
  }
  // Apply every reserved floor in one write pass (no reads between writes).
  // Inline companions (inner/nav/compact/err) are skipped, matching reserveBlockShell.
  const reserved: ShellReservation[] = [];
  for (const node of replacements) reserved.push({ node, value: 0 });
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
    let hostH = preMeasuredHostHeights?.get(host) ?? 0;
    if (!(hostH > 0)) {
      try {
        hostH = host.getBoundingClientRect().height;
      } catch {
        /* jsdom / detached */
      }
    }
    if (!(hostH > 0)) continue;
    const value = Math.min(SHELL_MAX_PX, Math.max(SHELL_MIN_PX, Math.round(hostH * SHELL_HEIGHT_RATIO)));
    node.style.minHeight = `${value}px`;
    node.setAttribute(SHELL, String(value));
    reserved.push({ node, value });
  }
  if (mode === 'bilingual') {
    for (const { unit } of items) {
      const node = findNode(unit.el);
      if (node instanceof HTMLElement && node.matches(`.${P_INNER}, .${P_INLINE}, .${P_NAV_SUB}, .${P_COMPACT}`)) {
        reserved.push({ node, value: 0 });
      }
    }
  }
  return reserved;
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
    removeCompanion(n);
  }
  unwrapInlineFlows(el);
  el.removeAttribute(WRAP_TEXT);
}

/**
 * Undo translation chrome on a single host so it can be re-collected.
 * Idempotent: a second call is a no-op once markers and chrome are gone.
 */
export function restoreUnit(el: HTMLElement): void {
  releaseSourceTypography(el);
  releaseBoundedLayout(el);
  releaseMediaLayout(el);
  const replacedText = textReplacements.get(el)?.visible;
  if (replacedText) {
    releaseSourceTypography(replacedText);
    releaseBoundedLayout(replacedText);
    releaseMediaLayout(replacedText);
  }
  if (el.classList.contains(CLS_REPLACE)) {
    restoreTextReplace(el);
    el.removeAttribute(DONE);
    el.removeAttribute(MODE);
    return;
  }

  const textReplacement = textReplacements.get(el);
  if (textReplacement) restoreTextReplace(textReplacement.visible);

  const hadReplace = el.getAttribute(MODE) === 'replace';
  const n = findNode(el);
  if (n) {
    clearBlockShell(n);
    removeCompanion(n);
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
  el.removeAttribute(WRAP_TEXT);
}

/** Full-page restore. Safe to call repeatedly. */
export function restoreDom(): void {
  const roots = [document, ...walkOpenShadowRoots(document)];
  restoreMovedRichNodes(roots);
  for (const root of roots) {
    restoreRoot(root);
    removeTranslationStyles(root);
  }
  restoreSourceTypography();
}

/** Includes translated Web Components, which document selectors cannot reach. */
export function hasTranslatedDom(): boolean {
  return [document, ...walkOpenShadowRoots(document)].some((root) => Boolean(root.querySelector(`[${DONE}]`)));
}

function restoreRoot(root: ParentNode): void {
  repairStructure(root);
  root.querySelectorAll<HTMLElement>(`[${DONE}]`).forEach((el) => {
    restoreUnit(el);
  });
  // Second pass: replace-text chrome may not carry DONE on the host.
  root.querySelectorAll<HTMLElement>(`.${CLS_REPLACE}`).forEach((el) => {
    restoreUnit(el);
  });
  // Detached sources can leave an outside-clamp companion in the live card.
  // Error badges also carry no DONE marker on their host.
  root.querySelectorAll(`.${CLS_BLOCK}, .${CLS_ERR}`).forEach(removeCompanion);
  // Page wrappers, transfers and deleted owners can leave a flow outside the
  // original host. Full restore removes that chrome at its current location.
  root.querySelectorAll(`.${CLS_FLOW}[${FLOW}="true"]`).forEach(unwrapFlow);
  // Orphan list-outside marks (host already clean) — clear without a full restore.
  root.querySelectorAll<HTMLElement>(`[${LIST_OUTSIDE}]`).forEach((el) => {
    if (!el.hasAttribute(DONE)) el.removeAttribute(LIST_OUTSIDE);
  });
  root.querySelectorAll(`[${WRAP_TEXT}]`).forEach(el => el.removeAttribute(WRAP_TEXT));
  restoreBoundedLayouts(root);
  restoreMediaLayouts(root);
  restoreAnchoredLayouts(root);
}
