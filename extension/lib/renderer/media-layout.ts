import { P } from '../dom-const';
import { composedContains } from '../dom-tree';
import { stylesheetChanged, watchLayoutUpdates } from './layout-updates';
import { readComputedSizing, readSourceLayoutPolicyState, readUnmaskedLayout, type SourceLayoutPolicy } from './source-layout-policy';

const BOUND = `data-${P}-media-bound`;
const STYLE = `data-${P}-media-style`;
const CHROME = 'nav, aside, header, footer, [role="navigation"], [role="menu"], [role="complementary"]';
const MEDIA_POLICY = ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size', 'aspect-ratio', 'object-fit', 'object-position', 'align-self'];
const ROW_POLICY = ['display', 'flex-direction', 'flex-wrap', 'grid-template-columns', 'grid-template-rows', 'align-items'];
const CONTAINER_POLICY = ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size', 'aspect-ratio', 'box-sizing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block', 'padding-inline', 'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-block-width', 'border-inline-width', 'grid-template-columns', 'grid-template-rows'];
interface MediaSnapshot {
  image: HTMLImageElement;
  parent: Element;
  source: string;
  widthRatio: number;
  cssSizing: boolean;
  row: Element;
  root: Node;
  attributes: (string | null)[];
  policy: SourceLayoutPolicy;
  rowPolicy: SourceLayoutPolicy;
  containers: {element: HTMLElement; policy: SourceLayoutPolicy; sizing: string | null}[];
  shape: MediaShape;
  retired?: boolean;
}
interface MediaChange { snapshot: MediaSnapshot; owner: HTMLElement; release?: true }
interface MediaRule { id: string; style: HTMLStyleElement; owners: Set<HTMLElement>; snapshot: MediaSnapshot }
let rows = new WeakMap<Element, MediaSnapshot[]>();
let hosts = new WeakMap<HTMLElement, MediaSnapshot[]>();
let owners = new WeakMap<HTMLElement, MediaSnapshot[]>();
const applied = new Map<HTMLImageElement, MediaRule>();
const SOURCE_ATTRIBUTES = ['src', 'srcset', 'sizes', 'width', 'height', 'class', 'style'];
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;
let sequence = 0;

interface MediaShape {
  paint: string;
  width: number;
  height: number;
  layoutHeight: number;
  parentHeight: number;
  heightFraction: number | null;
}

function contentSize(style: CSSStyleDeclaration, dimension: 'width' | 'height'): number {
  const size = parseFloat(style.getPropertyValue(dimension));
  if (style.boxSizing !== 'border-box') return size;
  const edges = dimension === 'height' ? ['top', 'bottom'] : ['left', 'right'];
  return Math.max(0, size - edges.reduce((sum, edge) => sum
    + (parseFloat(style.getPropertyValue(`padding-${edge}`)) || 0)
    + (parseFloat(style.getPropertyValue(`border-${edge}-width`)) || 0), 0));
}

/** Used pixels grow with translated prose. Compare paint, intrinsic shape and
 * the height's relationship to its containing column, rather than absolute
 * dimensions. Bounded heights do not establish a proportional relationship. */
function readMediaShape(image: HTMLImageElement, parent: Element, style: CSSStyleDeclaration): MediaShape {
  const width = contentSize(style, 'width'), height = contentSize(style, 'height');
  const layoutHeight = parseFloat(style.height);
  const parentHeight = contentSize(getComputedStyle(parent), 'height');
  const proportional = /^(auto|0(?:px)?)$/.test(style.minHeight) && style.maxHeight === 'none';
  return {width, height, layoutHeight, parentHeight,
    heightFraction: proportional && parentHeight > 0 && layoutHeight > 0 ? layoutHeight / parentHeight : null,
    paint: JSON.stringify(['object-fit', 'object-position', 'align-self', 'aspect-ratio', 'box-sizing', 'min-height', 'max-height']
      .map(property => style.getPropertyValue(property))),
  };
}

function sameMediaShape(source: MediaShape, current: MediaShape): boolean {
  if (source.paint !== current.paint) return false;
  const differs = (actual: number, expected: number): boolean => Math.abs(actual - expected) > Math.max(2, Math.abs(expected) * 0.02);
  if (source.width > 0 && source.height > 0 && current.width > 0 && current.height > 0
    && differs(current.width, current.height * source.width / source.height)) return false;
  return source.heightFraction === null || !Number.isFinite(current.parentHeight)
    || !differs(current.layoutHeight, current.parentHeight * source.heightFraction);
}

/** Read before rendering: a height-following image beside prose can widen as
 * translation makes the shared grid/flex row taller. Retain its source ratio
 * to the containing column, including intentional source overhang. */
export function captureMediaLayouts(elements: readonly HTMLElement[]): void {
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el);
    if (!s) { s = getComputedStyle(el); styles.set(el, s); }
    return s;
  };
  for (const host of elements) {
    if (hosts.has(host) || host.closest(CHROME)) continue;
    for (let row = host.parentElement, depth = 0; row && row !== document.body && depth < 8; row = row.parentElement, depth++) {
      const s = style(row);
      if (s.position === 'absolute' || s.position === 'fixed') break;
      const sharedRow = (s.display === 'flex' && !s.flexDirection.startsWith('column'))
        || (s.display === 'grid' && s.gridTemplateColumns.trim().split(/\s+/).length > 1);
      if (!sharedRow || row.children.length < 2) continue;
      let snapshots = rows.get(row);
      if (!snapshots) {
        snapshots = [];
        const images = Array.from(row.querySelectorAll('img'));
        if (images.length <= 8) for (const image of images) {
          const parent = image.parentElement;
          const rect = image.getBoundingClientRect();
          if (!parent || rect.width < 80 || rect.height < 40 || style(image).transform !== 'none'
            || /absolute|fixed/.test(style(image).position)) continue;
          const width = parent.getBoundingClientRect().width;
          const cssWidth = parseFloat(style(image).width), parentWidth = contentSize(style(parent), 'width');
          const cssSizing = cssWidth > 0 && parentWidth > 0;
          if (width > 0) snapshots.push({ image, parent, source: image.currentSrc || image.src,
            // max-width percentages use the containing block's content box;
            // the image's used width follows its own box-sizing declaration.
            widthRatio: cssSizing ? cssWidth / parentWidth : rect.width / width, cssSizing,
            row, root: image.getRootNode(), attributes: SOURCE_ATTRIBUTES.map(name => image.getAttribute(name)),
            policy: readSourceLayoutPolicyState(image, MEDIA_POLICY), rowPolicy: readSourceLayoutPolicyState(row, ROW_POLICY),
            containers: containerPolicies(parent), shape: readMediaShape(image, parent, style(image)) });
        }
        rows.set(row, snapshots);
      }
      const branch = Array.from(row.children).find(child => child.contains(host));
      hosts.set(host, snapshots.filter(({ image }) => !branch?.contains(image)));
      break;
    }
  }
}

/** Percentage media sizing also depends on authored containing-block sizing.
 * Record declarations, not dimensions that naturally grow with the prose. */
function containerPolicies(parent: Element): MediaSnapshot['containers'] {
  const containers: MediaSnapshot['containers'] = [];
  for (let element: Element | null = parent, depth = 0; element && element !== document.body && depth < 16; element = element.parentElement, depth++) {
    if (element instanceof HTMLElement) {
      const policy = readSourceLayoutPolicyState(element, CONTAINER_POLICY);
      containers.push({element, policy, sizing: policy.complete ? null : readComputedSizing(element, CONTAINER_POLICY)});
    }
  }
  return containers;
}

/** Associate our companion with a source snapshot without reading layout. */
export function attachMediaLayouts(host: HTMLElement, owner: HTMLElement): void {
  const snapshots = hosts.get(host);
  if (snapshots?.length) owners.set(owner, snapshots);
}

export function readMediaLayouts(nodes: readonly HTMLElement[]): MediaChange[] {
  const changes: MediaChange[] = [];
  for (const owner of nodes) {
    if (!owner.isConnected) continue;
    for (const snapshot of owners.get(owner) || []) {
      const { image, parent, widthRatio } = snapshot;
      const rule = applied.get(image);
      if (!sourceContractIntact(snapshot)) {
        if (rule?.snapshot === snapshot) changes.push({ snapshot, owner, release: true });
        continue;
      }
      if (!snapshot.row.contains(owner)) continue;
      const style = getComputedStyle(image);
      if (style.transform !== 'none' || /absolute|fixed/.test(style.position)) {
        if (rule?.snapshot === snapshot) changes.push({ snapshot, owner, release: true });
        continue;
      }
      if (rule?.style.isConnected && image.getAttribute(BOUND) === rule.id) rule.owners.add(owner);
      const rect = image.getBoundingClientRect();
      const limit = (snapshot.cssSizing ? contentSize(getComputedStyle(parent), 'width') : parent.getBoundingClientRect().width) * widthRatio;
      const width = snapshot.cssSizing ? parseFloat(style.width) : rect.width;
      if (limit > 0 && width > limit + 2 && (rect.right > innerWidth + 2 || rect.left < -2)) changes.push({ snapshot, owner });
    }
  }
  return changes;
}

export function applyMediaLayouts(changes: readonly MediaChange[]): void {
  for (const { snapshot, owner, release } of changes) {
    const { image, widthRatio } = snapshot;
    if (release) {
      if (applied.get(image)?.snapshot === snapshot) { snapshot.retired = true; clearMediaRule(image); }
      continue;
    }
    if (!sourceContractIntact(snapshot) || !snapshot.row.contains(owner)) continue;
    if (!image.isConnected || !owner.isConnected) continue;
    let rule = applied.get(image);
    if (!rule || !rule.style.isConnected) {
      const id = `${Date.now().toString(36)}-${++sequence}`;
      const style = document.createElement('style');
      style.setAttribute(STYLE, 'true');
      style.className = `${P}-media-style`;
      style.textContent = `[${BOUND}="${id}"] { max-width: ${widthRatio * 100}% !important; height: auto !important; align-self: center !important; object-fit: contain !important; }`;
      const root = image.getRootNode();
      (root instanceof ShadowRoot ? root : document.head).appendChild(style);
      image.setAttribute(BOUND, id);
      rule = { id, style, owners: new Set(), snapshot };
      applied.set(image, rule);
    }
    rule.owners.add(owner);
    watcher ??= watchLayoutUpdates(readUpdates);
    watcher.addRoot(image.getRootNode());
  }
}

function sourceContractIntact(snapshot: MediaSnapshot): boolean {
  const { image } = snapshot;
  if (snapshot.retired || !image.isConnected || image.parentElement !== snapshot.parent
    || image.getRootNode() !== snapshot.root || (image.currentSrc || image.src) !== snapshot.source
    || !SOURCE_ATTRIBUTES.every((name, index) => image.getAttribute(name) === snapshot.attributes[index])) return false;
  const policy = readSourceLayoutPolicyState(image, MEDIA_POLICY);
  const rowPolicy = readSourceLayoutPolicyState(snapshot.row as HTMLElement, ROW_POLICY);
  if (policy.signature !== snapshot.policy.signature || rowPolicy.signature !== snapshot.rowPolicy.signature) return false;
  const containers = containerPolicies(snapshot.parent);
  if (policy.animated || rowPolicy.animated || containers.some(container => container.policy.animated)) return false;
  if (containers.length !== snapshot.containers.length || containers.some((container, index) =>
    container.element !== snapshot.containers[index].element || container.policy.signature !== snapshot.containers[index].policy.signature
    || container.sizing !== snapshot.containers[index].sizing)) return false;
  if (policy.complete && rowPolicy.complete && snapshot.policy.complete && snapshot.rowPolicy.complete
    && containers.every((container, index) => container.policy.complete && snapshot.containers[index].policy.complete)) return true;
  const rule = applied.get(image);
  const read = (style: CSSStyleDeclaration): MediaShape => readMediaShape(image, snapshot.parent, style);
  const shape = rule?.style.isConnected ? readUnmaskedLayout(image, rule.style, read) : read(getComputedStyle(image));
  return sameMediaShape(snapshot.shape, shape);
}

function clearMediaRule(image: HTMLImageElement): void {
  const rule = applied.get(image);
  if (!rule) return;
  if (image.getAttribute(BOUND) === rule.id) image.removeAttribute(BOUND);
  rule.style.remove();
  applied.delete(image);
  if (!applied.size) { watcher?.dispose(); watcher = null; }
}

function readUpdates(mutations: readonly MutationRecord[] | null): (() => void) | undefined {
  const releases: { image: HTMLImageElement; rule: MediaRule; invalidSource: boolean; remaining: HTMLElement[] }[] = [];
  // Sibling selectors and :has() can change an image without touching its
  // ancestry. Recheck installed contracts once per frame, without new renders.
  const global = !mutations || stylesheetChanged(mutations)
    || mutations.some(record => record.type === 'attributes' || record.type === 'childList');
  for (const [image, rule] of applied) {
    const affected = !image.isConnected || global || mutations?.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !!target && (composedContains(target, image) || rule.snapshot.row.contains(target)
        || record.type === 'childList' && [...record.removedNodes].some(node => node === rule.snapshot.row || node.contains(rule.snapshot.row)));
    });
    if (!affected) continue;
    const remaining = [...rule.owners].filter(owner => owner.isConnected && rule.snapshot.row.contains(owner));
    const style = image.isConnected ? getComputedStyle(image) : null;
    const invalidSource = !sourceContractIntact(rule.snapshot) || !!style && (style.transform !== 'none' || /absolute|fixed/.test(style.position));
    if (invalidSource || remaining.length !== rule.owners.size) releases.push({ image, rule, invalidSource, remaining });
  }
  if (!releases.length) return;
  return () => {
    for (const { image, rule, invalidSource, remaining } of releases) {
      if (applied.get(image) !== rule) continue;
      if (invalidSource) rule.snapshot.retired = true;
      rule.owners = new Set(remaining);
      if (invalidSource || !remaining.length) clearMediaRule(image);
    }
  };
}

export function releaseMediaLayout(owner: Element): void {
  for (const { image } of owners.get(owner as HTMLElement) || []) {
    const rule = applied.get(image);
    if (!rule) continue;
    rule.owners.delete(owner as HTMLElement);
    if ([...rule.owners].some(node => node.isConnected && rule.snapshot.row.contains(node))) continue;
    clearMediaRule(image);
  }
  owners.delete(owner as HTMLElement);
}

export function restoreMediaLayouts(root: ParentNode): void {
  for (const [image, rule] of applied) {
    if (!image.isConnected || root.contains(image) || root.contains(rule.style)) clearMediaRule(image);
  }
  root.querySelectorAll<HTMLImageElement>(`[${BOUND}]`).forEach(image => { image.removeAttribute(BOUND); applied.delete(image); });
  root.querySelectorAll(`style[${STYLE}]`).forEach(style => style.remove());
  rows = new WeakMap();
  hosts = new WeakMap();
  owners = new WeakMap();
}
