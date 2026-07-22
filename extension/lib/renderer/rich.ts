/**
 * Safe rich-text skeleton builder.
 *
 * Replaces `cloneNode(true)` so bilingual companions never inherit page
 * identity (id/name), inline handlers, ARIA relationships, or interactive
 * chrome. Tag structure is preserved so text-slot order stays aligned with
 * `extractRichSlots` / `fillTextSlots`.
 */

import { isA11yHidden, isOursElement } from '../collector';
import { EDITABLE, OURS_SEL } from '../dom-const';

/** Tags that may appear in a rich companion (plus structural wrappers). */
const FORBIDDEN_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
  'LINK', 'META', 'BASE', 'IMG', 'PICTURE', 'SOURCE', 'VIDEO', 'AUDIO', 'TRACK',
  'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'LABEL', 'FORM', 'FIELDSET',
  'SVG', 'MATH', 'CANVAS', 'MAP', 'AREA', 'APPLET', 'FRAME', 'FRAMESET',
]);

/**
 * Form chrome tags whose *children* may be prose. Drop the tag itself but keep
 * the subtree so skeleton text nodes stay index-aligned with the source slot
 * walk (collector rejects these tags' controls via RICH_BLOCKING instead).
 */
const UNWRAP_TAGS = new Set(['LABEL', 'FORM', 'FIELDSET']);

const VOID_TAGS = new Set(['BR', 'WBR', 'HR']);

/** Global attributes safe to copy onto companion nodes. */
const SAFE_GLOBAL_ATTRS = new Set(['lang', 'dir', 'title']);

/**
 * Build a disconnected element whose children mirror `source`'s structure
 * with only safe tags/attributes. Slot text order matches the source.
 */
export function buildSafeRichSkeleton(source: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-dual-read-rich-skel', 'true');
  appendSafeChildren(source, wrap);
  return wrap;
}

function appendSafeChildren(source: ParentNode, target: ParentNode): void {
  for (const child of Array.from(source.childNodes)) {
    appendSafeNode(child, target);
  }
}

function appendSafeNode(node: Node, target: ParentNode): void {
  if (node.nodeType === Node.TEXT_NODE) {
    target.appendChild(document.createTextNode(node.nodeValue ?? ''));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  if (isOursElement(el) || el.closest(OURS_SEL)) return;

  // Mirror the source slot walk (collector collectSlotTextNodes): the skeleton
  // strips class/contenteditable, so pruning must evaluate the SOURCE element —
  // otherwise a11y-hidden or editable text would gain a skeleton node and shift
  // every later slot out of alignment. (isA11yHidden walks ancestors, so a
  // not-sr-only override inside an sr-only subtree is pruned along with it —
  // renderRich re-verifies slot parity as a final guard.)
  if (isA11yHidden(el) || el.closest(EDITABLE)) return;

  const tag = el.tagName;
  if (UNWRAP_TAGS.has(tag)) {
    appendSafeChildren(el, target);
    return;
  }
  if (FORBIDDEN_TAGS.has(tag)) return;

  if (VOID_TAGS.has(tag)) {
    target.appendChild(document.createElement(tag.toLowerCase()));
    return;
  }

  // Preserve tag name so slot walks stay aligned (including SPAN/DIV wrappers).
  let neu: HTMLElement;
  try {
    neu = document.createElement(tag.includes('-') ? tag.toLowerCase() : tag.toLowerCase());
  } catch {
    // Unknown / invalid tag — unwrap children to keep text.
    appendSafeChildren(el, target);
    return;
  }

  copySafeAttributes(el, neu);
  appendSafeChildren(el, neu);
  target.appendChild(neu);
}

function copySafeAttributes(from: Element, to: HTMLElement): void {
  const tag = from.tagName;

  for (const name of SAFE_GLOBAL_ATTRS) {
    const value = from.getAttribute(name);
    if (value != null && value !== '') to.setAttribute(name, value);
  }

  if (tag === 'A') {
    const href = sanitizeHref(from.getAttribute('href'));
    if (href) {
      to.setAttribute('href', href);
      // Companion links open safely; never inherit target=/_blank without rel.
      const target = from.getAttribute('target');
      if (target === '_blank') {
        to.setAttribute('target', '_blank');
        to.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }

  if (tag === 'ABBR') {
    const title = from.getAttribute('title');
    if (title) to.setAttribute('title', title);
  }
}

/**
 * Allow only navigational / relative URLs. Reject javascript:/data:/vbscript:.
 */
export function sanitizeHref(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const href = raw.trim();
  if (!href) return null;
  if (/^(javascript|vbscript|data):/i.test(href)) return null;
  return href;
}

/** True when an attribute name must never be copied into a companion. */
export function isForbiddenAttr(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'id' || n === 'name' || n === 'class' || n === 'style') return true;
  if (n === 'tabindex' || n === 'contenteditable' || n === 'draggable') return true;
  if (n.startsWith('on')) return true;
  if (n.startsWith('aria-')) return true;
  if (n.startsWith('data-')) return true;
  if (n === 'role' || n === 'slot' || n === 'is') return true;
  return false;
}
