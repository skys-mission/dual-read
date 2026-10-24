/** Extension contexts can inspect closed roots too. Firefox exposes the root
 * on the element; Chromium provides the equivalent chrome.dom method. */
export function getShadowRoot(element: Element): ShadowRoot | null {
  if (element.shadowRoot) return element.shadowRoot;
  try {
    const root = (element as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
    if (root instanceof ShadowRoot) return root;
    const openOrClosed = chrome?.dom?.openOrClosedShadowRoot;
    if (typeof openOrClosed === 'function' && element instanceof HTMLElement) return openOrClosed(element) ?? null;
  } catch {
    /* Closed-root access is optional outside extension content scripts. */
  }
  return null;
}

/** Follow the rendered ancestry through assigned slots and shadow hosts. */
export function composedParent(node: Node): Element | null {
  const slot = node instanceof Element || node instanceof Text ? node.assignedSlot : null;
  const root = node.getRootNode();
  return slot || node.parentElement || (root instanceof ShadowRoot ? root.host : null);
}

/** Retain ordinary source ownership while also recognizing rendered ancestry. */
export function composedContains(ancestor: Element, node: Node): boolean {
  if (ancestor.contains(node)) return true;
  for (let parent = composedParent(node); parent; parent = composedParent(parent)) {
    if (parent === ancestor) return true;
  }
  return false;
}
