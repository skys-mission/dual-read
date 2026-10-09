/** A compact label can outgrow a constrained column even when its source was
 * deliberately nowrap. Measure the containing column, then wrap only our
 * companion inside the original hit target. */
export function readCompactLayouts(nodes: readonly HTMLElement[]): HTMLElement[] {
  const changes: HTMLElement[] = [];
  for (const node of nodes) {
    if (!node.isConnected || !node.matches('.dual-read-target--inner, .dual-read-target--inline, .dual-read-nav-sub, .dual-read-target--compact')) continue;
    // A remaining overflow can belong to positioned/fixed-width page chrome.
    // The owned wrapping rule is responsive already; do not enqueue it every frame.
    if (node.style.maxWidth === '100%' && node.style.getPropertyPriority('max-width') === 'important') continue;
    const target = node.getBoundingClientRect();
    if (!target.width || !target.height) continue;
    const control = node.closest('a[href], button, [role="button"], [role="tab"]');
    for (let box = node.parentElement; box && box !== document.body; box = box.parentElement) {
      const s = getComputedStyle(box);
      if (/auto|scroll/.test(s.overflowX || s.overflow)) break;
      if (box === control || s.display === 'inline' || s.display === 'contents' || s.display === 'inline-flex' || s.display === 'inline-grid') continue;
      const bounds = box.getBoundingClientRect();
      if (!bounds.width) break;
      if (target.right > bounds.right + 2 || target.left < bounds.left - 2) changes.push(node);
      break;
    }
  }
  return changes;
}

export function applyCompactLayouts(nodes: readonly HTMLElement[]): void {
  for (const node of nodes) {
    if (!node.isConnected) continue;
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('white-space', 'normal', 'important');
    node.style.setProperty('word-break', 'normal', 'important');
    node.style.setProperty('overflow-wrap', 'anywhere', 'important');
    node.style.setProperty('max-width', '100%', 'important');
  }
}
