import { collectVisibleTextNodes } from '../collector';
import { FLOW, STASH_ALL, STASH_TEXT } from '../dom-const';
import { composedContains } from '../dom-tree';
import type { TranslationUnit } from '../types';
import { stylesheetChanged, watchLayoutUpdates } from './layout-updates';

const PROPERTIES = ['color', 'font-size', 'line-height', 'font-weight', 'font-style', 'letter-spacing'] as const;
export type SourceTypography = ReadonlyMap<string, string>;
interface SourceRun { host: HTMLElement; nodes: Text[]; parents: Element[] }
interface TypographyState {
  run: SourceRun;
  values: Map<string, string>;
  inputs: Map<string, string>;
  baseline: Map<string, string>;
  overrides: Set<string>;
}
let prepared = new WeakMap<SourceTypography, SourceRun>();
const active = new Map<HTMLElement, TypographyState>();
let watcher: ReturnType<typeof watchLayoutUpdates> | null = null;

function textStyleHost(node: Text, host: HTMLElement): Element | null {
  let parent = node.parentElement;
  while (parent && parent !== host && parent.matches(`[${FLOW}], [${STASH_ALL}], [${STASH_TEXT}]`)) parent = parent.parentElement;
  return parent;
}

function readTypography(run: SourceRun, styles: Map<Element, CSSStyleDeclaration>, baseline?: SourceTypography): Map<string, string> | undefined {
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
  // Outside-clamp companions cannot inherit these copied metrics from their
  // source host. Keep its current baseline even when a nested run becomes mixed.
  for (const [property, value] of baseline ?? []) {
    const current = host.getPropertyValue(property);
    if (value && current) changes.set(property, current);
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
export function applySourceTypography(node: HTMLElement, typography: SourceTypography | undefined): void {
  if (!typography) return;
  const run = prepared.get(typography);
  if (!run) return;
  let state = active.get(node);
  if (!state) {
    state = { run, values: new Map(), inputs: new Map(), baseline: new Map(PROPERTIES.map(property => [property, node.style.getPropertyValue(property)])), overrides: new Set() };
    active.set(node, state);
  } else state.run = run;
  writeTypography(node, state, typography);
  watcher ??= watchLayoutUpdates(readUpdates);
  watcher.addRoot(node.getRootNode());
  for (const source of run.nodes) watcher.addRoot(source.getRootNode());
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

function readUpdates(mutations: readonly MutationRecord[] | null): (() => void) | undefined {
  const changes: { node: HTMLElement; state: TypographyState; typography?: SourceTypography }[] = [];
  const styles = new Map<Element, CSSStyleDeclaration>();
  // CSS sibling selectors and :has() can change a source's paint without
  // mutating any of its ancestors. Re-read retained runs once per frame;
  // writeTypography still skips unchanged values and respects page overrides.
  const global = !mutations || stylesheetChanged(mutations)
    || mutations.some(record => record.type === 'attributes' || record.type === 'childList');
  for (const [node, state] of active) {
    if (!node.isConnected) { changes.push({ node, state }); continue; }
    const affected = global || mutations?.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !!target && (state.run.nodes.some(source => composedContains(target, source))
        || state.run.parents.some(parent => composedContains(target, parent))
        || record.type === 'childList' && (target === state.run.host
          || [...record.removedNodes].some(removed => state.run.nodes.some(source => removed === source || removed.contains(source)))));
    });
    if (affected) changes.push({ node, state, typography: readTypography(state.run, styles, state.baseline) });
  }
  if (!changes.length) return;
  return () => {
    for (const { node, state, typography } of changes) {
      if (active.get(node) !== state) continue;
      if (!node.isConnected) releaseSourceTypography(node);
      else writeTypography(node, state, typography);
    }
  };
}

export function releaseSourceTypography(node: Element): void {
  active.delete(node as HTMLElement);
  if (active.size) return;
  watcher?.dispose();
  watcher = null;
}

export function restoreSourceTypography(): void {
  active.clear();
  prepared = new WeakMap();
  watcher?.dispose();
  watcher = null;
}
