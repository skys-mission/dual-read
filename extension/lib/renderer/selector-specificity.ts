import selectorParser from 'postcss-selector-parser';
import {compare, selectorSpecificity, type Specificity} from '@csstools/selector-specificity';

interface SelectorArm { selector: string; specificity: Specificity }
interface CachedSelector { source: string; arms: SelectorArm[] | null }
const parsed = new WeakMap<CSSRule, CachedSelector>();
const expanded = new WeakMap<CSSRule, {source: string; parent: string; selector: string | null}>();
const PARSE_OPTIONS = {maxNestingDepth:64};
const rooted = new WeakMap<CSSRule, {source: string; selector: string | null; contextual: boolean}>();

/** A document stylesheet's top-level & is its root scope, with zero nesting
 * specificity. Scope rules/shadow sheets require browser-resolved fallback. */
export function resolveRootSelector(rule: CSSRule, source: string): {selector: string | null; contextual: boolean} {
  const cached = rooted.get(rule);
  if (cached?.source === source) return cached;
  let selector: string | null = null, contextual = false;
  try {
    if (source.length > 16384) throw new Error('Selector exceeds parsing budget');
    const root = selectorParser().astSync(source, PARSE_OPTIONS);
    const scope = selectorParser().astSync(':where(:root)', PARSE_OPTIONS).nodes[0].nodes[0];
    root.walkNesting(node => {contextual = true;node.replaceWith(scope.clone());});
    root.walkPseudos(node => {if (node.value === ':scope' || node.value === ':host' || node.value === ':host-context' || node.value === '::slotted') contextual = true;});
    selector = root.toString();
  } catch { /* an unknown selector cannot prove an unchanged cascade */ }
  const result = {source, selector, contextual};rooted.set(rule,result);return result;
}

/** Expand only AST nesting nodes. Literal ampersands in attributes/escaped
 * names remain source syntax; each implicit list arm gets its own parent. */
export function resolveNestedSelector(rule: CSSRule, source: string, parent: string): string | null {
  const cached = expanded.get(rule);
  if (cached?.source === source && cached.parent === parent) return cached.selector;
  let selector: string | null = null;
  try {
    if (source.length + parent.length > 16384) throw new Error('Selector exceeds parsing budget');
    const root = selectorParser().astSync(source, PARSE_OPTIONS);
    const ancestors = selectorParser().astSync(parent, PARSE_OPTIONS);
    const scope = selectorParser.pseudo({value:':is', nodes:ancestors.nodes.map(node => node.clone())});
    for (const arm of root.nodes) {
      let explicit = false;
      arm.walkNesting(node => {explicit = true;node.replaceWith(scope.clone());});
      if (!explicit) {
        arm.prepend(selectorParser.combinator({value:' '}));
        arm.prepend(scope.clone());
      }
    }
    const result = root.toString();
    if (result.length > 16384) throw new Error('Expanded selector exceeds parsing budget');
    selector = result;
  } catch { /* unknown nesting cannot prove an unchanged author cascade */ }
  expanded.set(rule, {source, parent, selector});
  return selector;
}

/** A rule list uses the most specific matching arm. Functional pseudo-classes
 * have different rules; use the standards parser rather than counting tokens.
 * Cache syntax only: matching still follows the current DOM on every read. */
export function matchingSpecificity(rule: CSSRule, source: string, element: Element): number[] | null {
  let cached = parsed.get(rule);
  if (!cached || cached.source !== source) {
    let arms: SelectorArm[] | null = null;
    try {
      if (source.length > 16384) throw new Error('Selector exceeds parsing budget');
      arms = selectorParser().astSync(source, PARSE_OPTIONS).nodes.map(arm => ({
        selector:arm.toString(), specificity:selectorSpecificity(arm),
      }));
    } catch { /* an unsupported selector cannot prove an unchanged cascade */ }
    cached = {source, arms};
    parsed.set(rule, cached);
  }
  if (!cached.arms) return null;
  let highest: Specificity | null = null;
  try {
    for (const arm of cached.arms) {
      if (element.matches(arm.selector) && (!highest || compare(arm.specificity, highest) > 0)) highest = arm.specificity;
    }
  } catch { return null; }
  return highest ? [highest.a, highest.b, highest.c] : null;
}
