import { collectVisibleTextNodes } from '../collector';
import { FLOW, STASH_ALL, STASH_TEXT } from '../dom-const';
import { composedContains } from '../dom-tree';
import type { TranslationUnit } from '../types';
import { stylesheetChanged, watchLayoutUpdates } from './layout-updates';
import { sourceLayoutReadSpent } from './source-layout-policy';

const PROPERTIES = ['color', 'font-size', 'line-height', 'font-weight', 'font-style', 'letter-spacing'] as const;
const RELOCATED_PROPERTIES = [...PROPERTIES, 'font-family', 'text-align', 'white-space', 'text-wrap', 'word-break', 'overflow-wrap'] as const;
export type SourceTypography = ReadonlyMap<string, string>;
interface SourceRun { host: HTMLElement; nodes: Text[]; parents: Element[]; relocated?: boolean }
interface TypographyState {
  run: SourceRun;
  values: Map<string, string>;
  inputs: Map<string, string>;
  baseline: Map<string, string>;
  overrides: Set<string>;
}
let prepared = new WeakMap<SourceTypography, SourceRun>();
const active = new Map<HTMLElement, TypographyState>();
const pendingUpdates = new Set<HTMLElement>();
const TYPOGRAPHY_CHUNK_SIZE = 32;
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;

function textStyleHost(node: Text, host: HTMLElement): Element | null {
  let parent = node.parentElement;
  while (parent && parent !== host && parent.matches(`[${FLOW}], [${STASH_ALL}], [${STASH_TEXT}]`)) parent = parent.parentElement;
  return parent;
}

function readTypography(run: SourceRun, styles: Map<Element, CSSStyleDeclaration>): Map<string, string> | undefined {
  const style = (element: Element): CSSStyleDeclaration => {
    let value = styles.get(element);
    if (!value) { value = getComputedStyle(element); styles.set(element, value); }
    return value;
  };
  const nodes = run.nodes.filter(node => node.isConnected && run.host.contains(node) && node.nodeValue?.trim());
  // A page can replace or normalize Text nodes while retaining their styled
  // source span. That span remains the style owner even during paused watching.
  const parents = nodes.length ? nodes.map(node => textStyleHost(node, run.host))
    : run.parents.filter(parent => parent !== run.host && parent.isConnected && run.host.contains(parent) && parent.textContent?.trim());
  const host = style(run.host);
  const changes = new Map<string, string>();
  // Outside-clamp companions no longer inherit their source host's paint or
  // metrics. Track that baseline even for direct text or a mixed rich skeleton.
  if (run.relocated) {
    for (const property of RELOCATED_PROPERTIES) {
      const value = host.getPropertyValue(property);
      if (property === 'color' && (value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || host.webkitTextFillColor === 'transparent')) continue;
      if (value) changes.set(property, value);
    }
    if (host.whiteSpace === 'nowrap' || host.whiteSpace === 'pre') {
      changes.set('white-space', host.whiteSpace === 'pre' ? 'pre-wrap' : 'normal');
      // text-wrap shares wrap-mode with white-space; copying source `nowrap`
      // would undo the prose wrapping policy in native browsers.
      changes.set('text-wrap', 'wrap');
      changes.set('overflow-wrap', 'anywhere');
    }
  }
  const first = parents[0];
  if (!first) return changes.size ? changes : undefined;
  const source = style(first);
  if (parents.some(parent => !parent || PROPERTIES.some(property => style(parent).getPropertyValue(property) !== source.getPropertyValue(property)))) return changes.size ? changes : undefined;
  for (const property of PROPERTIES) {
    const value = source.getPropertyValue(property);
    if (!value || value === host.getPropertyValue(property) && !changes.has(property)) continue;
    // Transparent gradient text needs its paint context, not a color copy.
    if (property === 'color' && (value === 'transparent' || value === 'rgba(0, 0, 0, 0)' || source.webkitTextFillColor === 'transparent')) continue;
    changes.set(property, value);
  }
  return changes;
}

/** A plain paragraph can obtain its actual typography from a nested span,
 * while the paragraph itself still inherits the page's default (often dark)
 * text color. Lift only a uniform text run, leaving mixed rich text alone. */
export function readSourceTypography(units: readonly TranslationUnit[]): Map<HTMLElement, SourceTypography> {
  const result = new Map<HTMLElement, SourceTypography>();
  const styles = new Map<Element, CSSStyleDeclaration>();
  for (const unit of units) {
    if (unit.kind !== 'block' || unit.rich) continue;
    const nodes = (unit.nodes?.length ? unit.nodes : collectVisibleTextNodes(unit.el, true)).filter(node => node.nodeValue?.trim());
    if (!nodes.length || nodes.length > 32) continue;
    const first = nodes[0].parentElement;
    if (!first || first === unit.el && nodes.every(node => node.parentElement === first)) continue;
    const run = { host: unit.el, nodes, parents: [...new Set(nodes.map(node => node.parentElement!).filter(Boolean))] };
    const changes = readTypography(run, styles);
    if (changes) { prepared.set(changes, run); result.set(unit.el, changes); }
  }
  return result;
}

/** Write only our companion; the page's source style and nodes stay intact. */
export function applySourceTypography(node: HTMLElement, typography: SourceTypography | undefined, host?: HTMLElement): void {
  let run = typography && prepared.get(typography);
  if (host && !host.contains(node)) {
    run = { ...(run ?? { host, nodes: [], parents: [] }), relocated: true };
    typography = readTypography(run, new Map());
  }
  if (!run) return;
  let state = active.get(node);
  if (!state) {
    state = { run, values: new Map(), inputs: new Map(), baseline: new Map(RELOCATED_PROPERTIES.map(property => [property, node.style.getPropertyValue(property)])), overrides: new Set() };
    active.set(node, state);
  } else state.run = run;
  writeTypography(node, state, typography);
  watcher ??= watchLayoutUpdates(readUpdates, { checkSourcePolicies: true });
  watcher.addRoot(node);
  watcher.addRoot(run.host);
  for (const source of run.nodes) watcher.addRoot(source);
}

function writeTypography(node: HTMLElement, state: TypographyState, typography: SourceTypography | undefined): void {
  for (const [property, previous] of state.values) {
    if (node.style.getPropertyValue(property) !== previous || node.style.getPropertyPriority(property)) {
      state.overrides.add(property);
      state.values.delete(property);
      state.inputs.delete(property);
    } else if (!typography?.has(property)) {
      node.style.removeProperty(property);
      state.values.delete(property);
      state.inputs.delete(property);
    }
  }
  for (const [property, value] of typography ?? []) {
    if (state.overrides.has(property)) continue;
    if (state.values.has(property) && state.inputs.get(property) === value) continue;
    const current = node.style.getPropertyValue(property);
    if (!state.values.has(property) && (node.style.getPropertyPriority(property)
      || current && current !== state.baseline.get(property))) {
      state.overrides.add(property);
      continue;
    }
    const painted = property === 'color' ? `color-mix(in srgb, ${value} 84%, transparent)` : value;
    if (current !== painted) node.style.setProperty(property, painted);
    state.values.set(property, node.style.getPropertyValue(property));
    state.inputs.set(property, value);
  }
}

function readUpdates(mutations: readonly MutationRecord[] | null, checkSourcePolicies = false): (() => void) | undefined {
  const changes: { node: HTMLElement; state: TypographyState; typography?: SourceTypography }[] = [];
  const styles = new Map<Element, CSSStyleDeclaration>();
  // CSS sibling selectors and :has() can change a source's paint without
  // mutating any of its ancestors. Refresh retained runs in bounded batches;
  // writeTypography still skips unchanged values and respects page overrides.
  // Copied paint is an override too: CSSOM edits can change its source without
  // a DOM record or resize. Reuse the shared stylesheet-change notification.
  const global = checkSourcePolicies || !mutations || stylesheetChanged(mutations)
    || mutations.some(record => record.type === 'attributes' || record.type === 'childList');
  // A continuation only drains the queue; it need not scan every active owner.
  if (global || mutations?.length) for (const [node, state] of active) {
    // Relocated layouts retain paused, detached cards for reuse. Their owner
    // releases this subscription on drop/full restore; do not lose its copied
    // style tracking just because both nodes temporarily leave the document.
    if (state.run.relocated && !node.isConnected && !state.run.host.isConnected) continue;
    if (!node.isConnected && !state.run.host.isConnected) { pendingUpdates.add(node); continue; }
    const affected = global || mutations?.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !!target && (state.run.nodes.some(source => composedContains(target, source))
        || state.run.parents.some(parent => composedContains(target, parent))
        || record.type === 'childList' && (target === state.run.host
          || [...record.removedNodes].some(removed => state.run.nodes.some(source => removed === source || removed.contains(source)))));
    });
    if (affected) pendingUpdates.add(node);
  }
  // Keep unfinished owners at the front under repeated input. A new global
  // refresh appends already-processed owners without starving the queue tail.
  let processed = 0;
  for (const node of pendingUpdates) {
    if (processed >= TYPOGRAPHY_CHUNK_SIZE || processed && sourceLayoutReadSpent()) break;
    processed++;
    pendingUpdates.delete(node);
    const state = active.get(node);
    if (!state || state.run.relocated && !node.isConnected && !state.run.host.isConnected) continue;
    changes.push({ node, state, typography: node.isConnected ? readTypography(state.run, styles) : undefined });
  }
  if (!changes.length && !pendingUpdates.size) return;
  return () => {
    for (const { node, state, typography } of changes) {
      if (active.get(node) !== state) continue;
      if (!node.isConnected) releaseSourceTypography(node);
      else {
        writeTypography(node, state, typography);
        watcher?.addRoot(node);
        watcher?.addRoot(state.run.host);
      }
    }
    if (pendingUpdates.size) watcher?.refresh(false);
  };
}

export function releaseSourceTypography(node: Element): void {
  active.delete(node as HTMLElement);
  pendingUpdates.delete(node as HTMLElement);
  if (active.size) return;
  watcher?.dispose();
  watcher = null;
}

export function restoreSourceTypography(): void {
  active.clear();
  pendingUpdates.clear();
  prepared = new WeakMap();
  watcher?.dispose();
  watcher = null;
}
