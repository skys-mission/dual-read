// DOM markers and selector heuristics shared by collector + renderer.
// Kept identical to the proven v1 behavior; do not tweak without E2E coverage.

export const P = 'dual-read';
export const DONE = `data-${P}-done`;
export const MODE = `data-${P}-mode`;
export const NOWRAP = `data-${P}-nowrap`;
/**
 * Legacy marker from the short-lived outside-CTA renderer. Retained only so
 * restore/re-render can clean already translated tabs after an extension reload.
 */
export const OUTSIDE = `data-${P}-outside`;
/**
 * Set on list hosts when we force `list-style-position: outside` so a nested
 * block companion aligns with the text, not under an `inside` marker.
 */
export const LIST_OUTSIDE = `data-${P}-list-outside`;
export const CLS_BLOCK = `${P}-target`;
export const CLS_INNER = `${P}-target ${P}-target--inner`;
export const CLS_INLINE = `${P}-target ${P}-target--inline ${P}-nav-sub`;
export const CLS_NAV = `${P}-target ${P}-target--compact ${P}-nav-sub`;
export const CLS_ERR = `${P}-error`;
/** Inline flow wrapper: keeps original text + companion as one flex item. */
export const CLS_FLOW = `${P}-flow`;
export const FLOW = `data-${P}-flow`;
export const HIDE = `${P}-original-hidden`;
export const CLS_REPLACE = `${P}-replace-text`;
export const STASH_ALL = `data-${P}-stash-all`;
export const STASH_TEXT = `data-${P}-stash-text`;
/** JSON snapshot of host lang/dir before rich replace mutates them. */
export const STASH_LANGUAGE_ATTRS = `data-${P}-stash-language-attrs`;
/** Reserved min-height (px) on block bilingual shells to stabilize CLS. */
export const SHELL = `data-${P}-shell`;
export const INLINE_MAX = 100;

export const SKIP = 'footer, [role="contentinfo"], form, fieldset';
export const CHROME = 'body > header, [role="banner"]';
export const NAV =
  'nav, aside, [role="navigation"], [role="menubar"], [role="menu"], [role="tree"], [role="complementary"]';
/** Strict chrome (menus / TOC) — excludes prose-heavy asides handled by the main passes. */
export const NAV_CHROME =
  'nav, [role="navigation"], [role="menubar"], [role="menu"], [role="tree"]';
export const PAGE_NAV =
  '.rst-content [role="navigation"], main [role="navigation"], article [role="navigation"], [role="main"] [role="navigation"], .wy-breadcrumbs, .breadcrumbs, nav[aria-label*="breadcrumb" i]';
export const PAGE_NAV_EL = 'div, p, li, a[href], [role="heading"], h1, h2, h3, h4, h5, h6';
export const AUX_NAV =
  '.rst-footer-buttons, .prev-next-footer, footer nav, [role="contentinfo"] nav, [role="contentinfo"] [role="navigation"]';
export const BLOCKS =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dd, dt, figcaption, caption, article, [role="heading"], [role="article"], [role="listitem"]';
export const INLINE_HOST =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dd, dt, figcaption, caption, label, button, article, [role="heading"], [role="article"], [role="listitem"]';
export const INTERACTIVE =
  'a[href], button, label, summary, input:not([type="hidden"]), select, textarea, img, video, audio, iframe';

// Elements whose text is never natural language / must not be touched.
// v1.1: added KBD/VAR/SAMP/TIME so shortcut keys and machine tokens survive.
// OBJECT/EMBED/APPLET/FRAMESET fallback text is plugin chrome, not prose —
// excluding it also keeps rich-slot parity with the skeleton (renderer/rich).
export const NO_TEXT = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
  'BUTTON', 'SVG', 'MATH', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO',
  'KBD', 'VAR', 'SAMP', 'TIME', 'OBJECT', 'EMBED', 'APPLET', 'FRAME', 'FRAMESET',
]);

export const A11Y = [
  'sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text',
  'u-sr-only', 'a11y-only', 'assistive-text',
];

// Guard against editing rich-text inputs the user is typing into.
export const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

export const DONE_SEL = `[${DONE}]`;
export const OURS_SEL = `.${CLS_BLOCK}, .${CLS_ERR}, .${HIDE}, .${CLS_REPLACE}`;
