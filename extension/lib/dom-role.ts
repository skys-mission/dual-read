import { INLINE_MAX, OURS_SEL } from './dom-const';

/**
 * UI controls must be classified by semantics before CSS layout. A prose-card
 * link and a painted CTA can both use `display:flex`, but only the former may
 * receive a block translation companion.
 */
const CONTROL_ROLE =
  'button, label, summary, [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="option"]';

// Match whole class-name segments, including BEM / utility conventions:
// Button--small, btn-primary, cta_link, styles_button__hash.
const CONTROL_CLASS_SEGMENT = /(^|[-_])(button|btn|pill|chip|cta)($|[-_])/i;

export function hasControlSemantics(el: Element): boolean {
  if (el.matches(CONTROL_ROLE)) return true;
  if (!el.matches('a[href]')) return false;
  return (el.getAttribute('class') || '')
    .split(/\s+/)
    .some((token) => CONTROL_CLASS_SEGMENT.test(token));
}

/**
 * Presentation fallback for accessible-but-unlabelled link controls. Inline
 * flex/grid and nowrap anchors overwhelmingly represent compact actions rather
 * than prose cards; ordinary display:flex/grid links still need semantic proof.
 */
export function isCompactControlHost(el: Element): boolean {
  // Labels nested inside a semantic control share its size and hit target.
  // Their own display:block does not turn them into a prose block.
  if (el.closest(CONTROL_ROLE)) return true;
  const anchor = el.closest('a[href]');
  if (!anchor) return false;
  if (hasControlSemantics(anchor)) return true;
  try {
    const style = getComputedStyle(anchor);
    if (
      style.display === 'inline-flex'
      || style.display === 'inline-grid'
      || style.whiteSpace === 'nowrap'
      || style.whiteSpace === 'pre'
    ) return true;

    // Flex items are blockified by layout: an inline-flex time/link can have
    // computed display:flex. Centered row actions and short nowrap metadata
    // still own one text run, including labels nested around an icon.
    if (style.display !== 'flex' || (style.flexDirection && !style.flexDirection.startsWith('row'))) return false;
    const ownTextLength = (anchor.textContent || '').trim().length
      - Array.from(anchor.querySelectorAll(OURS_SEL))
        .filter(node => !node.parentElement?.closest(OURS_SEL))
        .reduce((length, node) => length + (node.textContent || '').length, 0);
    if (ownTextLength > INLINE_MAX) return false;
    if (style.alignItems === 'center' && style.justifyContent === 'center') return true;
    const parent = anchor.parentElement;
    return !!parent && getComputedStyle(parent).whiteSpace === 'nowrap';
  } catch {
    return false;
  }
}

/** Centered row actions may wrap between languages when their label is long. */
export function shouldKeepControlOnOneLine(el: Element): boolean {
  if (el.closest(CONTROL_ROLE)) return true;
  const anchor = el.closest('a[href]');
  if (!anchor) return false;
  if (hasControlSemantics(anchor)) return true;
  try {
    const style = getComputedStyle(anchor);
    return style.display === 'inline-flex' || style.display === 'inline-grid'
      || style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre'
      || (style.display === 'flex' && isCompactControlHost(anchor)
        && !!anchor.parentElement && getComputedStyle(anchor.parentElement).whiteSpace === 'nowrap');
  } catch {
    return false;
  }
}
