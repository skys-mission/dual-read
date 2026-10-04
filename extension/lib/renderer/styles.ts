import translationCss from '../../public/dual-read.css?inline';

const STYLE = 'data-dual-read-style';
const installed = new WeakMap<ShadowRoot, HTMLStyleElement>();

/** Document CSS cannot cross a shadow boundary. Reuse the same shipped styles. */
export function ensureTranslationStyles(root: Node): void {
  if (!(root instanceof ShadowRoot)) return;
  // Rendering many units in one shadow tree must not query its entire subtree
  // for each paint. Re-check ownership so page-side style removal can recover.
  if (installed.get(root)?.getRootNode() === root) return;
  const existing = root.querySelector<HTMLStyleElement>(`style[${STYLE}]`);
  if (existing) {
    installed.set(root, existing);
    return;
  }
  const style = document.createElement('style');
  style.setAttribute(STYLE, 'true');
  style.textContent = translationCss;
  root.appendChild(style);
  installed.set(root, style);
}

export function removeTranslationStyles(root: ParentNode): void {
  if (root instanceof ShadowRoot) installed.delete(root);
  root.querySelectorAll(`style[${STYLE}]`).forEach((style) => style.remove());
}
