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
