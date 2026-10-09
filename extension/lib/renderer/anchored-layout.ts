import { P } from '../dom-const';
import { watchLayoutUpdates } from './layout-updates';
import { readSourceLayoutPolicy, readSourceLayoutPolicyState } from './source-layout-policy';

const ANCHOR = `data-${P}-layout-anchor`;
const STYLE = `data-${P}-anchor-style`;
const CHROME = 'nav, aside, header, footer, [role="navigation"], [role="menu"], [role="complementary"]';
const ANCHOR_POLICY = ['top', 'height', 'inset', 'inset-block-start', 'block-size', 'min-height', 'max-height'];
interface AnchorSnapshot {
  element: HTMLElement;
  parent: HTMLElement;
  top: number;
  sourceTop: string;
  sourceHeight: string;
  sourceTopPriority: string;
  sourceHeightPriority: string;
  parentHeight: number;
  parentWidth: number;
  policy: string;
}
interface AnchorChange { snapshot: AnchorSnapshot; owner: HTMLElement; top: number | null }
interface AnchorRule { id: string; style: HTMLStyleElement; owners: Set<HTMLElement>; top: number; snapshot: AnchorSnapshot }
let parents = new WeakMap<HTMLElement, AnchorSnapshot[]>();
let hosts = new WeakMap<HTMLElement, AnchorSnapshot[]>();
let owners = new WeakMap<HTMLElement, AnchorSnapshot[]>();
const applied = new Map<HTMLElement, AnchorRule>();
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;
let sequence = 0;

/** Some pages reserve an absolute control footer with top:Npx and
 * height:calc(100% - Npx). Capture that explicit relationship before prose
 * grows, so the footer follows the added height without covering actions. */
export function captureAnchoredLayouts(elements: readonly HTMLElement[]): void {
  for (const host of elements) {
    if (hosts.has(host) || host.closest(CHROME)) continue;
    const snapshots: AnchorSnapshot[] = [];
    for (let parent = host.parentElement, depth = 0; parent && parent !== document.body && depth < 16; parent = parent.parentElement, depth++) {
      let anchors = parents.get(parent);
      if (!anchors) {
        anchors = [];
        if (parent.children.length <= 16) for (const child of parent.children) {
          if (!(child instanceof HTMLElement)) continue;
          const top = child.style.top.match(/^(\d+(?:\.\d+)?)px$/);
          const height = child.style.height.match(/^calc\(100%\s*-\s*(\d+(?:\.\d+)?)px\)$/);
          if (!top || !height || Number(top[1]) !== Number(height[1])
            || child.style.getPropertyPriority('top') || child.style.getPropertyPriority('height')
            || !child.querySelector('button, [role="button"], a[href]')
            || getComputedStyle(child).position !== 'absolute'
            || getComputedStyle(parent).position !== 'relative') continue;
          const offset = Number(top[1]);
          if (offset < 24 || parent.clientHeight < offset + 20 || !parent.clientWidth) continue;
          anchors.push({ element: child, parent, top: offset, sourceTop: child.style.top, sourceHeight: child.style.height,
            sourceTopPriority: child.style.getPropertyPriority('top'), sourceHeightPriority: child.style.getPropertyPriority('height'),
            parentHeight: parent.clientHeight, parentWidth: parent.clientWidth, policy: readSourceLayoutPolicy(child, ANCHOR_POLICY) });
        }
        parents.set(parent, anchors);
      }
      if (!anchors.length) continue;
      const branch = Array.from(parent.children).find(child => child.contains(host));
      if (branch && !/absolute|fixed/.test(getComputedStyle(branch).position)) snapshots.push(...anchors);
    }
    hosts.set(host, snapshots);
  }
}

export function attachAnchoredLayouts(host: HTMLElement, owner: HTMLElement): void {
  const snapshots = hosts.get(host);
  if (snapshots?.length) owners.set(owner, snapshots);
}

function sourceContractIntact(snapshot: AnchorSnapshot): boolean {
  const {element, parent} = snapshot;
  const policy = readSourceLayoutPolicyState(element, ANCHOR_POLICY);
  return element.isConnected && element.parentElement === parent
    && element.style.top === snapshot.sourceTop && element.style.height === snapshot.sourceHeight
    && element.style.getPropertyPriority('top') === snapshot.sourceTopPriority
    && element.style.getPropertyPriority('height') === snapshot.sourceHeightPriority
    && !policy.animated && policy.signature === snapshot.policy;
}

/** Read only: layout growth is measured in the containing block's CSS pixels. */
export function readAnchoredLayouts(nodes: readonly HTMLElement[]): AnchorChange[] {
  const changes: AnchorChange[] = [];
  for (const owner of nodes) {
    if (!owner.isConnected) continue;
    for (const snapshot of owners.get(owner) || []) {
      const { element, parent, parentHeight, parentWidth } = snapshot;
      const rule = applied.get(element);
      const style = getComputedStyle(element);
      // The winning half of a stylesheet-important override can differ from
      // our paired rule even when its sheet cannot be inspected through CSSOM.
      const resolvedPair = rule && style.top.endsWith('px') && style.height.endsWith('px');
      const topMismatch = resolvedPair && Math.abs(parseFloat(style.top) - rule.top) > 2;
      const heightMismatch = resolvedPair && Math.abs(parseFloat(style.height) - Math.max(0, parent.clientHeight - rule.top)) > 2;
      if (!sourceContractIntact(snapshot)
        || topMismatch || heightMismatch
        || style.position !== 'absolute' || getComputedStyle(parent).position !== 'relative'
        || Math.abs(parent.clientWidth - parentWidth) > 2) {
        if (rule) changes.push({ snapshot, owner, top: null });
        continue;
      }
      const growth = parent.clientHeight - parentHeight;
      if (growth <= 2 || growth > Math.max(parentHeight, innerHeight)) {
        if (rule) changes.push({ snapshot, owner, top: null });
        continue;
      }
      const top = snapshot.top + growth;
      if (!rule || Math.abs(rule.top - top) > 1) changes.push({ snapshot, owner, top });
      else rule.owners.add(owner);
    }
  }
  return changes;
}

function clearAnchor(element: HTMLElement): void {
  const rule = applied.get(element);
  if (!rule) return;
  if (element.getAttribute(ANCHOR) === rule.id) element.removeAttribute(ANCHOR);
  rule.style.remove();
  applied.delete(element);
  if (!applied.size) { watcher?.dispose(); watcher = null; }
}

export function applyAnchoredLayouts(changes: readonly AnchorChange[]): void {
  for (const { snapshot, owner, top } of changes) {
    const { element } = snapshot;
    if (top === null) { clearAnchor(element); continue; }
    if (!sourceContractIntact(snapshot)) { clearAnchor(element); continue; }
    if (!element.isConnected || !owner.isConnected) continue;
    let rule = applied.get(element);
    if (!rule || !rule.style.isConnected) {
      const id = `${Date.now().toString(36)}-${++sequence}`;
      const style = document.createElement('style');
      style.setAttribute(STYLE, 'true');
      style.className = `${P}-anchor-style`;
      const root = element.getRootNode();
      (root instanceof ShadowRoot ? root : document.head).appendChild(style);
      element.setAttribute(ANCHOR, id);
      rule = { id, style, owners: new Set(), top, snapshot };
      applied.set(element, rule);
    }
    rule.owners.add(owner);
    rule.top = top;
    rule.style.textContent = `[${ANCHOR}="${rule.id}"] { top: ${top}px !important; height: calc(100% - ${top}px) !important; }`;
    watcher ??= watchLayoutUpdates(readUpdates);
    watcher.addRoot(element.getRootNode());
  }
}

/** Only revisit installed rules: page changes may invalidate a captured
 * footer, but must never create an anchor from already translated geometry. */
function readUpdates(): (() => void) | undefined {
  const states = [...applied].map(([element, rule]) => ({ element, rule,
    remaining: [...rule.owners].filter(owner => owner.isConnected && rule.snapshot.parent.contains(owner)),
    detached: !element.isConnected || element.getRootNode() !== rule.style.getRootNode(),
  }));
  const changes = readAnchoredLayouts(states.filter(state => !state.detached).flatMap(state => state.remaining));
  return () => {
    for (const { element, rule, remaining, detached } of states) {
      if (applied.get(element) !== rule) continue;
      rule.owners = new Set(remaining);
      if (detached || !remaining.length) clearAnchor(element);
    }
    applyAnchoredLayouts(changes.filter(({ snapshot }) => applied.has(snapshot.element)));
  };
}

export function releaseAnchoredLayout(owner: Element): void {
  for (const snapshot of owners.get(owner as HTMLElement) || []) {
    const { element, parent } = snapshot;
    const rule = applied.get(element);
    if (!rule) continue;
    rule.owners.delete(owner as HTMLElement);
    if (![...rule.owners].some(node => node.isConnected && parent.contains(node))) clearAnchor(element);
    else watcher?.refresh();
  }
  owners.delete(owner as HTMLElement);
}

export function restoreAnchoredLayouts(root: ParentNode): void {
  for (const [element, rule] of applied) {
    if (!element.isConnected || root.contains(element) || root.contains(rule.style)) clearAnchor(element);
  }
  root.querySelectorAll<HTMLElement>(`[${ANCHOR}]`).forEach(element => { element.removeAttribute(ANCHOR); applied.delete(element); });
  root.querySelectorAll(`style[${STYLE}]`).forEach(style => style.remove());
  parents = new WeakMap();
  hosts = new WeakMap();
  owners = new WeakMap();
}
