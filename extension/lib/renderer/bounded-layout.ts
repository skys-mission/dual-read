import { P } from '../dom-const';
import { composedContains, composedParent } from '../dom-tree';
import { stylesheetChanged, watchLayoutUpdates } from './layout-updates';
import { applyAnchoredLayouts, readAnchoredLayouts } from './anchored-layout';
import { readComputedSizing, readSourceLayoutPolicyState, readUnmaskedLayout, readUnmaskedLayoutProperty, setSourceExpansionStyle, withSourceLayoutRead, type SourceLayoutPolicy } from './source-layout-policy';
import { takeLayoutWork } from './layout-work';

const HEIGHT = `data-${P}-layout-height`;
const STYLE = `data-${P}-layout-style`;
const CHROME = 'nav, aside, header, footer, [role="navigation"], [role="menu"], [role="menubar"], [role="tree"], [role="complementary"]';
const SIZING = ['height', 'min-height', 'max-height', 'block-size', 'min-block-size', 'max-block-size', 'grid-template-rows', 'padding-top', 'padding-bottom', 'padding-block', 'padding-block-start', 'padding-block-end', 'border-top-width', 'border-bottom-width', 'box-sizing'] as const;
let sequence = 0;
interface Expansion {
  box: HTMLElement;
  height: number;
  owner: HTMLElement;
  sourceFloor: number;
  sizing: string;
  policy: string;
  gridRows?: string;
  context: { box: HTMLElement; sizing: string }[];
}
interface AppliedExpansion {
  id: string;
  style: HTMLStyleElement;
  owners: Set<HTMLElement>;
  height: number;
  sourceFloor: number;
  sizing: string;
  policy: string;
  root: Node;
  gridRows?: string;
  contexts: Map<HTMLElement, Expansion['context']>;
}
const applied = new Map<HTMLElement, AppliedExpansion>();
const retained = new Map<HTMLElement, AppliedExpansion>();
const owned = new WeakMap<HTMLElement, Set<HTMLElement>>();
const pendingRelax = new Set<HTMLElement>();
const pendingMeasure = new Set<HTMLElement>();
const pendingUpdates = new Map<HTMLElement, boolean>();
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;
let blocked = new WeakMap<HTMLElement, { sizing: string; policy: string }>();
let resizeObserver: ResizeObserver | null = null;
const resizeNodes = new Set<HTMLElement>();
const resizeSizes = new Map<Element, { width: number; height: number }>();

/** Include stylesheet inputs without confusing translated used dimensions
 * with authored sizing. The zero-height check also covers unreadable sheets. */
function pageSizing(box: HTMLElement, computed?: CSSStyleDeclaration, source?: SourceLayoutPolicy): string {
  const state = applied.get(box);
  const policy = source ?? readSourceLayoutPolicyState(box, SIZING, computed);
  const height = state?.style.isConnected ? readUnmaskedLayoutProperty(box, 'height', state.style)
    : (computed ?? getComputedStyle(box)).height;
  const collapsed = parseFloat(height) >= 0 && parseFloat(height) <= 2;
  return JSON.stringify([policy.signature, collapsed, policy.limited ? '@read-limit' : policy.complete ? null
    : readComputedSizing(box, SIZING, state?.style.isConnected ? state.style : undefined)]);
}

function policySignature(style: CSSStyleDeclaration): string {
  return JSON.stringify([style.position, style.overflowY || style.overflow, style.display, style.maxHeight,
    style.getPropertyValue('-webkit-line-clamp'), style.getPropertyValue('line-clamp')]);
}

function blockedByPage(box: HTMLElement, style?: CSSStyleDeclaration): boolean {
  const state = blocked.get(box);
  if (!state) return false;
  if (state.sizing === pageSizing(box, style) && (!style || state.policy === policySignature(style))) return true;
  blocked.delete(box);
  return false;
}

function expansionPolicy(box: HTMLElement, style: CSSStyleDeclaration): boolean {
  const maxHeight = parseFloat(style.maxHeight);
  return !box.matches(CHROME) && !/^(absolute|fixed)$/.test(style.position)
    && !/auto|scroll/.test(style.overflowY || style.overflow)
    && style.display !== 'none' && style.display !== 'inline' && style.display !== 'contents'
    && !(parseInt(style.getPropertyValue('-webkit-line-clamp'), 10) > 0)
    && !(parseInt(style.getPropertyValue('line-clamp'), 10) > 0)
    && !(maxHeight >= 0 && maxHeight <= 2);
}

function observeSize(node: HTMLElement): void {
  if (typeof ResizeObserver !== 'function' || resizeNodes.has(node)) return;
  resizeObserver ??= new ResizeObserver(entries => {
    let changed = false;
    for (const { target, contentRect: { width, height } } of entries) {
      const previous = resizeSizes.get(target);
      if (!resizeNodes.has(target as HTMLElement)) continue;
      resizeSizes.set(target, { width, height });
      if (!previous) continue;
      const widthChanged = Math.abs(previous.width - width) > 0.5;
      const heightChanged = Math.abs(previous.height - height) > 0.5;
      // Our own floor changes the box height. Width is the reflow input; owner
      // text dimensions also cover font loading and inherited typography.
      if (widthChanged && applied.has(target as HTMLElement)) { pendingRelax.add(target as HTMLElement); changed = true; }
      if (widthChanged || heightChanged) for (const box of owned.get(target as HTMLElement) || []) {
        pendingRelax.add(box); changed = true;
      }
    }
    if (changed) watcher?.refresh(false);
  });
  resizeNodes.add(node); resizeObserver.observe(node);
}

function unobserveUnused(node: HTMLElement): void {
  if (applied.has(node) || retained.has(node) || owned.get(node)?.size) return;
  resizeObserver?.unobserve(node); resizeNodes.delete(node); resizeSizes.delete(node);
}

function forgetOwner(box: HTMLElement, owner: HTMLElement): void {
  (applied.get(box) ?? retained.get(box))?.contexts.delete(owner);
  owned.get(owner)?.delete(box); unobserveUnused(owner);
}

function rememberOwner(box: HTMLElement, owner: HTMLElement, state: AppliedExpansion, context?: Expansion['context']): void {
  state.owners.add(owner);
  if (context && !state.contexts.has(owner)) state.contexts.set(owner, context);
  const boxes = owned.get(owner) ?? new Set<HTMLElement>();
  boxes.add(box);
  owned.set(owner, boxes);
  observeSize(owner);
}

/** Measure normal-flow prose spilling past a bounded container.
 * Scroll viewports, chrome, line clamps, and positioned overlays retain their
 * original policies. Horizontal carousel clipping remains in place. */
export function readBoundedLayouts(nodes: readonly HTMLElement[]): Expansion[] {
  return withSourceLayoutRead(() => readBoundedLayoutsInPass(nodes));
}

function readBoundedLayoutsInPass(nodes: readonly HTMLElement[]): Expansion[] {
  const changes: Expansion[] = [];
  // Shared ancestors need one cascade read in this pass, never a persistent
  // cache: page CSSOM edits and inherited inputs must be seen on the next read.
  const styles = new Map<Element, CSSStyleDeclaration>();
  const sources = new Map<HTMLElement, SourceLayoutPolicy>();
  const sizes = new Map<HTMLElement, string>();
  const axes = new Map<Element, boolean>();
  const style = (box: Element): CSSStyleDeclaration => {
    let value = styles.get(box);
    if (!value) { value = getComputedStyle(box); styles.set(box, value); }
    return value;
  };
  // Rectangles can be converted back to CSS lengths under positive axis-aligned
  // scaling (including ancestor scale/zoom). Rotation, skew and perspective do
  // not provide that mapping, so omit this optional correction for those trees.
  const aligned = (element: Element): boolean => {
    const cached = axes.get(element);
    if (cached !== undefined) return cached;
    const s = style(element), parent = composedParent(element);
    let result = !parent || aligned(parent);
    if (result) {
      const rotate = s.getPropertyValue('rotate'), scale = s.getPropertyValue('scale');
      result = (!s.perspective || s.perspective === 'none')
        && (!rotate || rotate === 'none' || /^0(?:deg|rad|grad|turn)?$/.test(rotate))
        && (!scale || scale === 'none' || scale.split(/\s+/).every(value => parseFloat(value) > 0));
      if (result && s.transform && s.transform !== 'none') {
        try {
          const matrix = new DOMMatrixReadOnly(s.transform);
          // GPU-promoted translate3d/scale3d can still preserve both screen axes.
          result = matrix.m11 > 0 && matrix.m22 > 0 && Math.abs(matrix.m44 - 1) < 1e-8
            && [matrix.m12, matrix.m13, matrix.m14, matrix.m21, matrix.m23, matrix.m24,
              matrix.m31, matrix.m32, matrix.m34].every(value => Math.abs(value) < 1e-8);
        } catch { result = false; }
      }
    }
    axes.set(element, result);
    return result;
  };
  const source = (box: HTMLElement): SourceLayoutPolicy => {
    let value = sources.get(box);
    if (!value) { value = readSourceLayoutPolicyState(box, SIZING, style(box)); sources.set(box, value); }
    return value;
  };
  const sizing = (box: HTMLElement): string => {
    let value = sizes.get(box);
    if (value === undefined) { value = pageSizing(box, style(box), source(box)); sizes.set(box, value); }
    return value;
  };
  for (const owner of nodes) {
    if (!owner.isConnected || owner.closest(CHROME) || !aligned(owner)) continue;
    if (owner.matches('.dual-read-target--inner, .dual-read-target--inline, .dual-read-nav-sub, .dual-read-target--compact')) continue;
    const target = owner.getBoundingClientRect();
    if (!target.width || !target.height) continue;
    const ancestors: HTMLElement[] = [];
    for (let box = owner.parentElement; box && box !== document.body; box = box.parentElement) {
      const s = style(box);
      const overflowY = s.overflowY || s.overflow;
      if (s.position === 'absolute' || s.position === 'fixed'
        || /auto|scroll/.test(overflowY) || box.matches(CHROME)) break;
      if (blockedByPage(box, s)) break;
      const bounds = box.getBoundingClientRect();
      const state = applied.get(box);
      const eligible = expansionPolicy(box, s);
      const borders = (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.borderBottomWidth) || 0);
      const padding = (parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingBottom) || 0);
      const inset = s.boxSizing === 'border-box' ? 0 : padding + borders;
      const layoutHeight = s.height.endsWith('px') ? parseFloat(s.height) + inset : box.offsetHeight || bounds.height;
      const scaleY = layoutHeight > 0 ? bounds.height / layoutHeight : 0;
      if (!(scaleY > 0)) continue;
      const spills = eligible && layoutHeight >= 24 && target.bottom > bounds.bottom + scaleY
        && target.left >= bounds.left - 1 && target.right <= bounds.right + 1;
      const required = spills ? Math.max(box.scrollHeight + borders, layoutHeight + (target.bottom - bounds.bottom) / scaleY) : 0;
      const expand = spills && required <= Math.max(layoutHeight * 2, window.innerHeight / scaleY);
      // Ordinary flow already contains its translation. Do not scan the whole
      // site's stylesheets for each of its ancestors. Only an expansion or an
      // existing owned rule needs a source contract and its inner dependencies.
      if (!state && !expand) { ancestors.push(box); continue; }
      // A sizing animation on any inner ancestor still owns the containing
      // geometry, including forwards fill and custom-property dependencies.
      if ([...ancestors, box].some(element => source(element).animated || source(element).limited)) break;
      const currentSizing = sizing(box);
      const inner = ancestors.map(element => ({box: element, sizing: sizing(element)}));
      if (state && (currentSizing !== state.sizing || !eligible)) break;
      if (state?.style.isConnected && box.getAttribute(HEIGHT) === state.id) rememberOwner(box, owner, state, inner);
      ancestors.push(box);
      if (!expand) continue;
      // Measured product/document rows may have explicit pixel tracks. Keep
      // their source minimums and named lines, while allowing content growth.
      const rows = s.gridTemplateRows;
      const gridRows = s.display === 'grid' && rows.length < 512 && !/subgrid|masonry/.test(rows)
        ? rows.replace(/(\d+(?:\.\d+)?)px/g, 'minmax($1px, auto)') : undefined;
      changes.push({ box, owner, height: Math.ceil(required - inset),
        sourceFloor: Math.max(0, layoutHeight - inset), sizing: currentSizing, policy: policySignature(s), gridRows, context: inner });
    }
  }
  return changes;
}

/** Apply owned CSS rules without overwriting any page style or class. */
export function applyBoundedLayouts(changes: readonly Expansion[]): void {
  for (const { box, height, owner, sourceFloor, sizing, policy, gridRows, context } of changes) {
    // An earlier owned write can run a custom-element callback or change an
    // author container query. Never reuse its pre-write contract afterward.
    if (!withSourceLayoutRead(() => box.isConnected && owner.isConnected
      && !blockedByPage(box) && pageSizing(box) === sizing)) continue;
    let state = applied.get(box);
    if (!state || !state.style.isConnected) {
      if (state) clearRule(box);
      const previous = retained.get(box); retained.delete(box);
      const id = `${Date.now().toString(36)}-${++sequence}`;
      const style = document.createElement('style');
      style.setAttribute(STYLE, 'true');
      style.className = `${P}-layout-style`;
      const root = box.getRootNode();
      (root instanceof ShadowRoot ? root : document.head).appendChild(style);
      state = { id, style, owners: new Set(), height: 0, sourceFloor, sizing, policy, root, contexts: new Map() };
      applied.set(box, state);
      setSourceExpansionStyle(box, style);
      box.setAttribute(HEIGHT, id);
      for (const node of previous?.owners || []) if (node.isConnected && box.contains(node)) rememberOwner(box, node, state, previous?.contexts.get(node));
    }
    rememberOwner(box, owner, state, context);
    if (height > state.height || gridRows && !state.gridRows) {
      state.height = Math.max(height, state.height);
      state.gridRows ??= gridRows;
      writeRule(state);
    }
    watcher ??= watchLayoutUpdates(readUpdates, { checkSourcePolicies: true });
    watcher.addRoot(box);
    observeSize(box);
  }
}

function writeRule(state: AppliedExpansion): void {
  // A minimum expands fixed-height boxes too. Preserve the authored height so
  // percentages, viewport units and containing-block changes still resolve in
  // the browser, including CSSOM updates while translation watching is paused.
  state.style.textContent = `[${HEIGHT}="${state.id}"] { min-height: ${state.height}px !important; ${state.gridRows ? `grid-template-rows: ${state.gridRows} !important;` : ''} }`;
}

function clearRule(box: HTMLElement, keepOwners = false): void {
  const state = applied.get(box) ?? retained.get(box);
  if (!state) return;
  if (box.getAttribute(HEIGHT) === state.id) box.removeAttribute(HEIGHT);
  state.style.remove();
  setSourceExpansionStyle(box, null);
  applied.delete(box);
  retained.delete(box);
  if (keepOwners) retained.set(box, state);
  else for (const owner of state.owners) forgetOwner(box, owner);
  unobserveUnused(box);
  pendingRelax.delete(box);
  pendingMeasure.delete(box);
  pendingUpdates.delete(box);
  if (!applied.size && !retained.size) {
    watcher?.dispose(); watcher = null;
    resizeObserver?.disconnect(); resizeObserver = null; resizeNodes.clear(); resizeSizes.clear();
  }
}

function readUpdates(mutations: readonly MutationRecord[] | null, checkSourcePolicies = false): (() => void) | undefined {
  const global = !mutations || stylesheetChanged(mutations);
  // Arbitrary attributes and sibling selectors can affect the cascade outside
  // the source ancestry. Validate these contracts in small batches, while
  // only ancestry/global reflow relaxes an existing height floor.
  const policyChange = checkSourcePolicies || global || mutations.some(record => record.type !== 'characterData');
  for (const [box] of [...applied, ...retained]) {
    const reflow = global || mutations?.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !!target && (box.contains(target) || composedContains(target, box));
    });
    if (policyChange || reflow || !box.isConnected || pendingRelax.has(box) || pendingMeasure.has(box)) {
      pendingUpdates.set(box, !!reflow || !!pendingUpdates.get(box));
    }
  }
  const selected = new Map(takeLayoutWork(pendingUpdates));
  for (const box of selected.keys()) pendingUpdates.delete(box);
  const measured = new Set([...selected.keys()].filter(box => pendingMeasure.delete(box)));
  const sources = new Map<HTMLElement, string>();
  const sourceSizing = (box: HTMLElement): string => {
    let sizing = sources.get(box);
    if (sizing === undefined) { sizing = pageSizing(box); sources.set(box, sizing); }
    return sizing;
  };
  // An outer correction must not feed a changed inner inherit/animation
  // policy. Retain the original source chain to resume only when it returns.
  const contextRemoved = (box: HTMLElement, state: AppliedExpansion, owners: HTMLElement[]): boolean => owners.some(owner =>
    state.contexts.get(owner)?.some(source => !source.box.isConnected || !box.contains(source.box)));
  const contextIntact = (state: AppliedExpansion, owners: HTMLElement[]): boolean => owners.every(owner =>
    state.contexts.get(owner)?.every(source => sourceSizing(source.box) === source.sizing) ?? true);
  // A paused page can close and reopen a translated panel. Keep only live
  // owners while its sizing is overridden, then resume the original contract
  // without recollecting text or making another translation request.
  const dormant = [...retained].filter(([box]) => selected.has(box)).map(([box, state]) => {
    const remaining = [...state.owners].filter(owner => owner.isConnected && box.contains(owner));
    const detached = !box.isConnected || box.getRootNode() !== state.root || !remaining.length || contextRemoved(box, state, remaining);
    const style = !detached && sourceSizing(box) === state.sizing && contextIntact(state, remaining) ? getComputedStyle(box) : null;
    const resume = !!style && expansionPolicy(box, style) && policySignature(style) === state.policy;
    if (resume) blocked.delete(box);
    return { box, state, remaining, detached, resume };
  });
  const resumable = new Set(dormant.filter(item => item.resume).map(item => item.box));
  const revivals = readBoundedLayouts(dormant.filter(item => item.resume).flatMap(item => item.remaining))
    .filter(change => resumable.has(change.box));
  const states = [...applied].filter(([box]) => selected.has(box)).map(([box, state]) => {
    const remaining = [...state.owners].filter(owner => owner.isConnected && box.contains(owner));
    const detached = !box.isConnected || !state.style.isConnected || box.getRootNode() !== state.style.getRootNode() || box.getAttribute(HEIGHT) !== state.id || contextRemoved(box, state, remaining);
    const style = detached ? null : getComputedStyle(box);
    const invalidPolicy = !!style && (sourceSizing(box) !== state.sizing || !contextIntact(state, remaining) || !expansionPolicy(box, style));
    const reflow = selected.get(box);
    return { box, state, remaining, invalidPolicy, detached, policy: style ? policySignature(style) : '',
      relax: pendingRelax.delete(box) || remaining.length !== state.owners.size || reflow };
  });
  const changes = readBoundedLayouts(states.filter(item => measured.has(item.box) && !item.detached && !item.invalidPolicy)
    .flatMap(item => item.remaining)).filter(change => measured.has(change.box));
  const anchors = readAnchoredLayouts(states.filter(item => measured.has(item.box) && !item.detached && !item.invalidPolicy)
    .flatMap(item => item.remaining));
  // Measure a smaller floor with our rule synchronously omitted. The source
  // probe restores styles and scroll offsets before returning; committing a
  // collapsed floor for a frame would clamp scrolling fixed-height panels.
  const floors = new Map(states.filter(item => item.relax && !item.detached && !item.invalidPolicy && item.remaining.length)
    .map(({ box, state, remaining }) => [box, readUnmaskedLayout(box, state.style, () =>
      Math.max(state.sourceFloor, ...readBoundedLayouts(remaining).filter(change => change.box === box).map(change => change.height)))]));
  return () => {
    for (const { box, state, remaining, relax, detached, invalidPolicy, policy } of states) {
      if (applied.get(box) !== state) continue;
      for (const owner of state.owners) if (!remaining.includes(owner)) forgetOwner(box, owner);
      state.owners = new Set(remaining);
      if (detached || invalidPolicy || !remaining.length) {
        clearRule(box, invalidPolicy && remaining.length > 0);
        if (invalidPolicy) blocked.set(box, { sizing: pageSizing(box), policy });
        continue;
      }
      if (!relax) continue;
      const height = floors.get(box)!;
      if (state.height !== height) { state.height = height; writeRule(state); }
      pendingMeasure.add(box);
    }
    for (const { box, state, remaining, detached } of dormant) {
      if (retained.get(box) !== state) continue;
      for (const owner of state.owners) if (!remaining.includes(owner)) forgetOwner(box, owner);
      state.owners = new Set(remaining);
      if (detached) clearRule(box);
    }
    applyBoundedLayouts(revivals.filter(change => retained.has(change.box)));
    // The containing height can also revive a previously captured absolute
    // footer. Measure that source snapshot after this owned write has settled.
    for (const { box } of revivals) if (applied.has(box)) pendingMeasure.add(box);
    applyBoundedLayouts(changes.filter(change => applied.has(change.box) && !pendingMeasure.has(change.box)));
    applyAnchoredLayouts(anchors);
    if (pendingMeasure.size || pendingUpdates.size) watcher?.refresh(false);
  };
}

export function releaseBoundedLayout(owner: Element): void {
  const boxes = owned.get(owner as HTMLElement);
  if (!boxes) return;
  for (const box of boxes) {
    const state = applied.get(box) ?? retained.get(box);
    if (!state) continue;
    state.owners.delete(owner as HTMLElement);
    forgetOwner(box, owner as HTMLElement);
    if ([...state.owners].some(node => node.isConnected && box.contains(node))) {
      if (applied.has(box)) pendingRelax.add(box);
      watcher?.refresh(false);
    } else clearRule(box);
  }
  owned.delete(owner as HTMLElement);
}

/** Also clear orphaned rules after page-side subtree replacement/reinjection. */
export function restoreBoundedLayouts(root: ParentNode): void {
  for (const [box, state] of [...applied, ...retained]) {
    if (!box.isConnected || root.contains(box) || root.contains(state.style)) clearRule(box);
  }
  root.querySelectorAll<HTMLElement>(`[${HEIGHT}]`).forEach(box => {
    box.removeAttribute(HEIGHT);
    applied.delete(box);
  });
  root.querySelectorAll(`style[${STYLE}]`).forEach(style => style.remove());
  if (!applied.size && !retained.size) blocked = new WeakMap();
}
