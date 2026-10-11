import { readSourceVisibility } from '../collector';
import { watchLayoutUpdates } from './layout-updates';
import { ensureTranslationStyles } from './styles';

interface RelocatedState {
  host: HTMLElement;
  nest: () => void;
  display?: { value: string; priority: string };
}
const active = new Map<HTMLElement, RelocatedState>();
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;

function clippingBox(host: HTMLElement, styles = new Map<Element, CSSStyleDeclaration>()): HTMLElement | null {
  const style = (element: Element): CSSStyleDeclaration => {
    let value = styles.get(element);
    if (!value) { value = getComputedStyle(element); styles.set(element, value); }
    return value;
  };
  let clipped: HTMLElement | null = null;
  for (let box: HTMLElement | null = host; box?.parentElement; box = box.parentElement) {
    // Retain the source's original interactive hit area.
    if (box.matches('a[href], button, [role="button"], [role="tab"], body')) break;
    const css = style(box);
    const clamp = parseInt(css.getPropertyValue('line-clamp'), 10)
      || parseInt(css.getPropertyValue('-webkit-line-clamp'), 10);
    if (clamp > 0) clipped = box;
  }
  if (!clipped?.parentElement) return null;
  const parent = style(clipped.parentElement);
  // An outside companion needs its own block row, not another narrow track.
  return !parent.display.includes('grid')
    && (!parent.display.includes('flex') || parent.flexDirection.startsWith('column')) ? clipped : null;
}

/** Register only companions which escape a source clamp. If that source later
 * moves, keep following it even while translation watching is paused. */
export function relocateCompanion(host: HTMLElement, node: HTMLElement, nest: () => void): boolean {
  const box = clippingBox(host);
  if (!box) return false;
  active.set(node, { host, nest });
  let after: Element = box;
  for (let next = after.nextElementSibling; next && next !== node; next = after.nextElementSibling) {
    const owner = active.get(next as HTMLElement)?.host;
    if (!owner || !box.contains(owner) || !(owner.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    after = next;
  }
  if (after.nextElementSibling !== node) after.after(node);
  watcher ??= watchLayoutUpdates(readUpdates, { checkSourcePolicies: true });
  watcher.addRoot(host.getRootNode());
  watcher.addRoot(node.getRootNode());
  return true;
}

function setVisible(node: HTMLElement, state: RelocatedState, visible: boolean): void {
  if (!visible) {
    state.display ??= { value: node.style.getPropertyValue('display'), priority: node.style.getPropertyPriority('display') };
    if (node.style.display !== 'none' || node.style.getPropertyPriority('display') !== 'important') node.style.setProperty('display', 'none', 'important');
  } else if (state.display) {
    // Restore only the property we still own; retain any page override.
    if (node.style.display === 'none' && node.style.getPropertyPriority('display') === 'important') {
      if (state.display.value) node.style.setProperty('display', state.display.value, state.display.priority);
      else node.style.removeProperty('display');
    }
    state.display = undefined;
  }
}

function readUpdates(): (() => void) | undefined {
  if (!active.size) return;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const visible = readSourceVisibility(Array.from(active.values(), state => state.host));
  const nested: [HTMLElement, RelocatedState][] = [];
  const groups = new Map<HTMLElement, [HTMLElement, RelocatedState][]>();
  for (const [node, state] of active) {
    if (!state.host.isConnected) continue;
    const box = clippingBox(state.host, styles);
    if (!box) nested.push([node, state]);
    else {
      const group = groups.get(box) ?? [];
      group.push([node, state]); groups.set(box, group);
    }
  }
  for (const group of groups.values()) group.sort((a, b) => a[1].host === b[1].host ? 0
    : a[1].host.compareDocumentPosition(b[1].host) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  return () => {
    for (const [node, state] of nested) {
      if (active.get(node) === state && state.host.isConnected && !state.host.contains(node)) state.nest();
    }
    // Reconcile each shared clamp in source order in a single pass. Repeatedly
    // searching all preceding companions would be quadratic on long lists.
    for (const [box, group] of groups) {
      if (!box.isConnected) continue;
      let after: Element = box;
      for (const [node, state] of group) {
        if (active.get(node) !== state || !box.contains(state.host)) continue;
        if (after.nextElementSibling !== node) after.after(node);
        after = node;
      }
    }
    for (const [node, state] of active) {
      setVisible(node, state, !!visible.get(state.host));
      if (node.isConnected) {
        ensureTranslationStyles(node.getRootNode());
        watcher?.addRoot(node.getRootNode());
        watcher?.addRoot(state.host.getRootNode());
      }
    }
  };
}

export function releaseRelocatedLayout(node: Element): void {
  active.delete(node as HTMLElement);
  if (active.size) return;
  watcher?.dispose(); watcher = null;
}

/** The page may retain detached cards for later reuse. Full restore also
 * clears their owned companions/markers, without reinserting any source. */
export function restoreRelocatedLayouts(restoreHost: (host: HTMLElement) => void): void {
  for (const [node, state] of Array.from(active)) {
    restoreHost(state.host);
    // A page-removed companion has no parent for restoreUnit to find. Cancel
    // its pending layout work too, so restore cannot resurrect that old node.
    releaseRelocatedLayout(node);
  }
}
