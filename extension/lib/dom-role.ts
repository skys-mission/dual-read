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
  if (hasControlSemantics(el)) return true;
  if (!el.matches('a[href]')) return false;
  try {
    const style = getComputedStyle(el);
    return (
      style.display === 'inline-flex'
      || style.display === 'inline-grid'
      || style.whiteSpace === 'nowrap'
      || style.whiteSpace === 'pre'
    );
  } catch {
    return false;
  }
}
