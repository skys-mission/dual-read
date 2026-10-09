import { P } from '../dom-const';
import { matchingSpecificity, resolveNestedSelector, resolveRootSelector } from './selector-specificity';
import { LAYOUT_SHORTHANDS, layoutLonghands, physicalLayoutProperty, relatedLayoutProperties } from './layout-properties';
import { composedParent } from '../dom-tree';

type SourceRule = CSSRule & {
  style?: CSSStyleDeclaration;
  selectorText?: string;
  cssRules?: CSSRuleList;
  styleSheet?: CSSStyleSheet;
  conditionText?: string;
  media?: MediaList;
  name?: string;
  nameList?: readonly string[];
  layerName?: string | null;
};

export interface SourceLayoutPolicy {
  signature: string;
  complete: boolean;
  /** A page animation currently owns one of the selected properties. */
  animated?: boolean;
}
type LayerPart = string | number;
const animationIds = new WeakMap<Animation, number>();
let animationSequence = 0;

/** Keep time out of the signature: a sizing effect owns the property for its
 * whole lifetime, including forwards fill. Paint-only effects stay unrelated. */
function layoutMotion(element: HTMLElement, selected: readonly string[]): unknown[] {
  if (typeof element.getAnimations !== 'function') return [];
  const properties = new Set(selected);
  return element.getAnimations().flatMap(animation => {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || effect.target !== element || effect.pseudoElement) return [];
    const frames = effect.getKeyframes().map(frame => Object.entries(frame).flatMap(([key, value]) => {
      const property = key.startsWith('--') ? key : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      return properties.has(property) ? [[property, value]] : [];
    })).filter(frame => frame.length);
    if (!frames.length) return [];
    let id = animationIds.get(animation);
    if (id === undefined) { id = ++animationSequence; animationIds.set(animation, id); }
    return [[id, frames]];
  });
}

/** Fingerprint only authored inputs to the selected layout properties. Used
 * dimensions cannot describe the page policy while our important rules mask
 * it, and change naturally when translated text reflows. */
export function readSourceLayoutPolicy(element: HTMLElement, properties: readonly string[], computed?: CSSStyleDeclaration): string {
  return readSourceLayoutPolicyState(element, properties, computed).signature;
}

/** Unknown conditions and opaque sheets cannot prove an unchanged cascade.
 * Keep that uncertainty separate from the declarations we can inspect. */
export function readSourceLayoutPolicyState(element: HTMLElement, properties: readonly string[], computed?: CSSStyleDeclaration): SourceLayoutPolicy {
  return readPolicy(element, properties, computed, 0);
}

function readPolicy(element: HTMLElement, properties: readonly string[], computed: CSSStyleDeclaration | undefined, depth: number): SourceLayoutPolicy {
  const inputs: string[][][] = [];
  let complete = true;
  const variables = new Set<string>();
  const inherited = new Set<string>();
  const layerOrder = new Map<string, LayerPart[]>();
  const usedLayers: LayerPart[][] = [];
  const specificityGroups = new Map<string, {declaration: string[]; specificity: number[]}[]>();
  let sourceStyle = computed;
  const cascadeProperty = (property: string): string => {
    if (!/^(min-|max-)?(block|inline)-size$|-(block|inline)(-|$)/.test(property)) return property;
    sourceStyle ??= getComputedStyle(element);
    return physicalLayoutProperty(property, sourceStyle);
  };
  const selected = relatedLayoutProperties(properties, cascadeProperty);
  const shorthands = LAYOUT_SHORTHANDS.filter(property =>
    layoutLonghands(property).some(longhand => selected.includes(longhand)));
  const hasSelected = (style: CSSStyleDeclaration): boolean => [...selected, ...shorthands].some(property => style.getPropertyValue(property));
  let anonymous = 0;
  const usedAnonymous = new Map<number, number>();
  // Anonymous identities are local to this read. Number only participating
  // layers so inserting/removing an unrelated paint layer cannot rename them.
  // Numeric parts also stay distinct from every authored layer name.
  const relevantPath = (path: readonly LayerPart[]): LayerPart[] => path.map(part => {
    if (typeof part === 'string') return part;
    if (!usedAnonymous.has(part)) usedAnonymous.set(part, usedAnonymous.size + 1);
    return usedAnonymous.get(part)!;
  });
  const registerLayer = (parent: readonly LayerPart[], name: string): LayerPart[] => {
    const path = [...parent];
    for (const part of name ? name.split('.') : [++anonymous]) {
      const key = JSON.stringify(path);
      const children = layerOrder.get(key) ?? [];
      if (!children.includes(part)) children.push(part);
      layerOrder.set(key, children);
      path.push(part);
    }
    return path;
  };
  const add = (style: CSSStyleDeclaration, layer: LayerPart[] = [], specificity?: number[] | null): void => {
    const localOrder = new Map<string, {declaration: string[]; order: number}[]>();
    const names = Array.from(style);
    // Pending variable substitutions and partial DOM implementations can hide
    // shorthand longhands. Retain the raw input and use the computed fallback.
    const opaque = shorthands.filter(property => style.getPropertyValue(property)
      && layoutLonghands(property).filter(longhand => selected.includes(longhand)).some(longhand => !style.getPropertyValue(longhand)));
    if (opaque.length) complete = false;
    const declarations = [...selected, ...opaque].flatMap(property => {
      const value = style.getPropertyValue(property);
      if (!value) return [];
      // Logical declarations inherit their mapped physical property, even
      // when the parent's writing mode differs from this element's mode.
      if (/(?:^|[,(])\s*inherit\s*(?:$|[,)])/i.test(value)) inherited.add(cascadeProperty(property));
      for (const match of value.matchAll(/var\(\s*(--[\w\u0080-\uffff-]+)/g)) variables.add(match[1]);
      const priority = style.getPropertyPriority(property);
      const declaration = [property, value, priority];
      const physical = cascadeProperty(property);
      // Logical/physical sizes and padding compete in the same cascade. Keep their
      // mapping and relative declaration order, excluding unrelated paint and
      // dimensions. CSSOM exposes these size longhands in authored order.
      if (physical !== property) declaration.push(physical);
      const localKey = JSON.stringify([physical, priority]);
      const local = localOrder.get(localKey) ?? [];
      const direct = names.indexOf(property);
      const order = direct >= 0 ? direct : names.findLastIndex(name => layoutLonghands(name).includes(property));
      local.push({declaration, order});localOrder.set(localKey, local);
      if (specificity) {
        const key = JSON.stringify([physical, priority, relevantPath(layer)]);
        const group = specificityGroups.get(key) ?? [];
        group.push({declaration, specificity});specificityGroups.set(key, group);
      }
      return [declaration];
    });
    for (const group of localOrder.values()) {
      if (group.length < 2) continue;
      if (group.some(item => item.order < 0)) { complete = false; continue; }
      const ordered = [...group].sort((left, right) => left.order - right.order);
      for (const item of group) item.declaration.push(`order:${ordered.indexOf(item)}`);
    }
    if (declarations.length) {
      if (layer.length) { declarations.push(['@layer', JSON.stringify(relevantPath(layer))]); usedLayers.push(layer); }
      inputs.push(declarations);
    }
  };
  const mediaMatches = (media: string): boolean => !media || typeof window.matchMedia !== 'function' || window.matchMedia(media).matches;
  const visit = (rules: CSSRuleList, parentSelector = '', conditional = false, inScope = false, layer: LayerPart[] = []): void => {
    for (const raw of Array.from(rules)) {
      const rule = raw as SourceRule;
      if (rule.type === 4 && !mediaMatches(rule.conditionText || '')) continue;
      if (rule.type === 12 && typeof CSS !== 'undefined' && !CSS.supports(rule.conditionText || '')) continue;
      const uncertain = conditional || /^\s*@(container|scope)\b/i.test(rule.cssText);
      const scoped = inScope || /^\s*@scope\b/i.test(rule.cssText);
      if (/^\s*@layer\b/i.test(rule.cssText)) {
        if (rule.cssRules) {
          if (typeof rule.name !== 'string') complete = false;
          visit(rule.cssRules, parentSelector, uncertain, scoped, registerLayer(layer, rule.name ?? ''));
        } else if (rule.nameList) {
          for (const name of rule.nameList) registerLayer(layer, name);
        } else complete = false;
        continue;
      }
      if (rule.styleSheet) {
        visitSheet(rule.styleSheet, rule.layerName == null ? layer : registerLayer(layer, rule.layerName));
        continue;
      }
      let selector = rule.selectorText;
      if (selector && parentSelector) {
        const nested = resolveNestedSelector(rule, selector, parentSelector);
        if (!nested) { complete = false; continue; }
        selector = nested;
      } else if (selector) {
        const rootSelector = resolveRootSelector(rule, selector);
        if (!rootSelector.selector) { complete = false; continue; }
        if (rootSelector.contextual && (scoped || element.getRootNode() instanceof ShadowRoot
          || /:scope\b|:host\b|::slotted\b/i.test(selector))) {
          if (rule.style && hasSelected(rule.style) || rule.cssRules) complete = false;
          continue;
        }
        selector = rootSelector.selector;
      }
      if (!selector && rule.style && hasSelected(rule.style)) {
        // Raw declarations after a nested rule, or inside a nested group,
        // retain their parent style rule's matching AND specificity behavior.
        // They are not an implicit &: wrapping a selector list in :is() would
        // give an unmatched high-specificity arm influence it did not have.
        if (rule.constructor.name === 'CSSNestedDeclarations') {
          selector = parentSelector;
          if (!selector) complete = false;
        } else if (rule.type === 0 && parentSelector) complete = false;
      }
      if (selector && rule.style && hasSelected(rule.style)) {
        // Element.matches uses the element as :scope. An author @scope uses
        // its own root, including the implicit root selected by &. A false
        // result therefore cannot prove that these declarations do not apply.
        if (scoped && /:scope\b|&/i.test(selector)) complete = false;
        try {
          if (element.matches(selector)) {
            const specificity = matchingSpecificity(rule, selector, element);
            add(rule.style, layer, specificity);
            if (uncertain || !specificity) complete = false;
          }
        }
        catch { complete = false; /* matching uncertainty must reach the computed fallback */ }
      }
      if (rule.cssRules) visit(rule.cssRules, selector || parentSelector, uncertain, scoped, layer);
    }
  };
  const seen = new Set<CSSStyleSheet>();
  const visitSheet = (sheet: CSSStyleSheet, layer: LayerPart[] = []): void => {
    if (seen.has(sheet) || sheet.disabled || !mediaMatches(sheet.media?.mediaText || '')) return;
    seen.add(sheet);
    try { visit(sheet.cssRules, '', false, false, layer); }
    catch { complete = false; /* the browser cascade can still read an opaque sheet */ }
  };
  const root = element.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) {
    // ownerNode is absent in some DOM implementations and on adopted sheets.
    const owners = new Map(Array.from(root.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel="stylesheet"]'))
      .filter(node => node.sheet).map(node => [node.sheet!, node]));
    for (const sheet of new Set([...Array.from(root.styleSheets || []), ...root.adoptedStyleSheets || []])) {
      const owner = sheet.ownerNode ?? owners.get(sheet);
      if (owner instanceof Element && Array.from(owner.attributes).some(attribute => attribute.name.startsWith(`data-${P}-`))) continue;
      visitSheet(sheet);
    }
  }
  add(element.style);
  // Only precedence among competing declarations matters. Adding classes to
  // an already stronger selector, or changing a rule in another layer/property,
  // must not retire a stable correction merely because its numeric score grew.
  const compare = (left: number[], right: number[]): number => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  for (const group of specificityGroups.values()) {
    const ordered = [...new Map(group.map(item => [JSON.stringify(item.specificity),item.specificity])).values()].sort(compare);
    for (const item of group) item.declaration.push(String(ordered.findIndex(weight => compare(weight,item.specificity) === 0)));
  }
  const style = variables.size ? computed ?? getComputedStyle(element) : undefined;
  // Only relative order among layers carrying matching sizing declarations
  // matters. Paint-only layers must not retire an otherwise stable correction.
  const used = new Map<string, Set<LayerPart>>();
  for (const layer of usedLayers) for (let index = 0; index < layer.length; index++) {
    const key = JSON.stringify(layer.slice(0, index));
    const children = used.get(key) ?? new Set<LayerPart>(); children.add(layer[index]); used.set(key, children);
  }
  const order = [...used].map(([key, children]) => [JSON.stringify(relevantPath(JSON.parse(key) as LayerPart[])),
    relevantPath(layerOrder.get(key)?.filter(name => children.has(name)) ?? [])]);
  const signature: unknown[] = [inputs, [...variables].sort().map(name => [name, style!.getPropertyValue(name)])];
  if (used.size) signature.push(order);
  let motion = layoutMotion(element, [...selected, ...variables]);
  const parent = inherited.size ? composedParent(element) : null;
  if (parent instanceof HTMLElement) {
    // Follow authored declarations, not translated used pixels. The dependency
    // is local to this read, so parent replacement and shadow/slot changes
    // cannot leave cached ownership behind.
    if (depth < 32) {
      const dependency = readPolicy(parent, [...inherited].sort(), undefined, depth + 1);
      // Keep nested data structured. Re-embedding serialized JSON would
      // double its escaping at every inherited ancestor.
      signature.push(['@inherit', JSON.parse(dependency.signature) as unknown]);
      complete &&= dependency.complete;
      if (dependency.animated) motion = [...motion, ['@inherit']];
    } else complete = false;
  }
  if (motion.length) signature.push(['@motion', motion]);
  return {signature: JSON.stringify(signature), complete, ...(motion.length ? {animated: true} : {})};
}

/** A narrow fallback for inaccessible author sheets: inspect the cascade with
 * only our rule omitted. CSSOM writes emit no DOM mutation records; restore
 * every declaration synchronously before yielding or painting. */
export function readUnmaskedLayoutProperty(element: Element, property: string, ownedStyle: HTMLStyleElement): string {
  return readUnmaskedLayout(element, ownedStyle, style => style.getPropertyValue(property));
}

/** Copy the needed values during the callback: computed declarations are live. */
export function readUnmaskedLayout<T>(element: Element, ownedStyle: HTMLStyleElement, read: (style: CSSStyleDeclaration) => T): T {
  const rules = Array.from(ownedStyle.sheet?.cssRules || []).filter((rule): rule is CSSStyleRule => 'style' in rule);
  const saved = rules.map(rule => rule.style.cssText);
  try {
    for (const rule of rules) rule.style.cssText = '';
    return read(getComputedStyle(element));
  } finally {
    rules.forEach((rule, index) => {rule.style.cssText = saved[index];});
  }
}

let probeSequence = 0;
const PROBE = `data-${P}-sizing-probe`;
interface SizingRead {
  width: number;
  height: number;
  actual: Map<string, string>;
  fingerprint: Map<string, string>;
}
const sizingReads = new WeakMap<HTMLElement, Map<string, SizingRead>>();

/** Relative viewport lengths become pixels in computed styles. Preserve their
 * observed fingerprint across ordinary viewport reflow; author declarations
 * still have their own signature, and changes at a stable viewport remain
 * observable. Keywords and transitions into/out of collapsed sizes still
 * invalidate the contract. This is a narrow fallback for incomplete CSSOM. */
function sizingFingerprint(element: HTMLElement, values: [string, string][]): string {
  const key = values.map(([property]) => property).join('|');
  const reads = sizingReads.get(element) ?? new Map<string, SizingRead>();
  const previous = reads.get(key);
  const resized = previous && (previous.width !== innerWidth || previous.height !== innerHeight);
  const pixels = (value: string): string => value.replace(/(?:\d+(?:\.\d+)?|\.\d+)px/g,
    length => parseFloat(length) > 2 ? '<px>' : '<small-px>');
  const fingerprint = new Map(values.map(([property, value]) => {
    const before = previous?.actual.get(property);
    const retain = before === value || !!resized && !!before && before !== pixels(before) && pixels(before) === pixels(value);
    return [property, retain ? previous!.fingerprint.get(property)! : value];
  }));
  reads.set(key, {width: innerWidth, height: innerHeight, actual: new Map(values), fingerprint});
  sizingReads.set(element, reads);
  return JSON.stringify([...fingerprint]);
}

/** A non-rendered pseudo inherits computed sizing, rather than the element's
 * used pixels. Thus auto/percent sizing stays stable as translated prose
 * grows, while the browser resolves conditional author declarations for us.
 * Only owned CSS and a temporary private marker change, synchronously. */
export function readComputedSizing(element: HTMLElement, properties: readonly string[], ownedStyle?: HTMLStyleElement): string {
  const probe = (): string => {
    const previous = element.getAttribute(PROBE);
    const id = `dr-sizing-${++probeSequence}`;
    const temporary = document.createElement('style');
    temporary.setAttribute(`data-${P}-sizing-style`, 'true');
    const root = element.getRootNode();
    // Important author declarations reverse layer order. A first, private
    // layer also wins over layered pseudo styling, without editing that CSS.
    (root instanceof ShadowRoot ? root : document.head).prepend(temporary);
    const sheet = temporary.sheet;
    let index: number | undefined;
    try {
      element.setAttribute(PROBE, id);
      if (!sheet) throw new Error('Sizing probe requires a connected stylesheet');
      index = sheet.cssRules.length;
      // The ID arm increases specificity without selecting another element.
      const selector = `[${PROBE}="${id}"]:is(*, #${id}#${id}#${id}#${id})::before`;
      // Width resolves to zero under border-style:none. Preserve the style
      // dependency while reading a border width on the non-rendered pseudo.
      const inherited = [...new Set([...properties, ...properties.flatMap(layoutLonghands)
        .filter(property => /^border-.+-width$/.test(property)).map(property => property.replace(/-width$/,'-style'))])];
      sheet.insertRule(`@layer ${id} {${selector} {content:none!important;display:none!important;${inherited.map(property => `${property}:inherit!important;`).join('')}}}`, index);
      const computed = getComputedStyle(element, '::before');
      return sizingFingerprint(element, properties.map(property => [property, computed.getPropertyValue(property)]));
    } finally {
      if (sheet && index !== undefined && sheet.cssRules.length > index) sheet.deleteRule(index);
      if (previous === null) element.removeAttribute(PROBE);
      else element.setAttribute(PROBE, previous);
      temporary.remove();
    }
  };
  // Another layout reader can inspect a containing block whose expansion is
  // already installed. Its computed sizing must describe author declarations,
  // not any matching correction from another module.
  const styles = ownedStyle ? [ownedStyle] : Array.from((element.getRootNode() as ParentNode).querySelectorAll<HTMLStyleElement>('style'))
    .filter(style => Array.from(style.attributes).some(attribute => attribute.name.startsWith(`data-${P}-`)))
    .filter(style => Array.from(style.sheet?.cssRules || []).some(raw => {
      const rule = raw as SourceRule;
      if (!rule.style || !rule.selectorText || !properties.some(property => rule.style!.getPropertyValue(property))) return false;
      try {return element.matches(rule.selectorText);} catch {return false;}
    }));
  const read = (index: number): string => index < styles.length
    ? readUnmaskedLayout(element, styles[index], () => read(index + 1)) : probe();
  return read(0);
}
