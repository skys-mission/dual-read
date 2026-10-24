import { OURS_SEL } from '../dom-const';
import { composedParent } from '../dom-tree';

const MACHINE_TEXT = new Set(['CODE', 'PRE', 'KBD', 'VAR', 'SAMP']);

/** Code renderer/editor roots, independent of any website or source language. */
const CODE_CONTENT = [
  'pre', '.hljs', '.prism-code', '.shiki', '.CodeMirror', '.cm-editor',
  '.cm-content', '.monaco-editor', '.ace_editor', '.sp-code-editor',
].join(',');

/**
 * Exclude the complete machine-text subtree, including syntax spans, links and
 * shadow/slot descendants. A parent's own prose remains collectable. The memo
 * belongs to one collection so editor hydration cannot leave stale answers.
 */
export function isNonProseElement(el: Element, memo?: WeakMap<Element, boolean>): boolean {
  const path: Element[] = [];
  let excluded = false;
  for (let current: Element | null = el; current; current = composedParent(current)) {
    const cached = memo?.get(current);
    if (cached !== undefined) {
      excluded = cached;
      break;
    }
    path.push(current);
    if (MACHINE_TEXT.has(current.tagName) || current.matches(CODE_CONTENT)) {
      excluded = true;
      break;
    }
  }
  for (const current of path) memo?.set(current, excluded);
  return excluded;
}

function isCodeBlock(el: Element): boolean {
  if (el.matches(CODE_CONTENT)) return true;
  if (el.tagName !== 'CODE') return false;
  if (/[\r\n]/.test(el.textContent || '') || el.querySelector('br, div, p, li')) return true;
  return el.isConnected && /^(block|flex|grid|flow-root)$/.test(getComputedStyle(el).display);
}

/** Keep code blocks in mixed containers outside any hide-all rich replacement. */
export function hasCodeBlock(el: Element, memo?: WeakMap<Element, boolean>): boolean {
  const cached = memo?.get(el);
  if (cached !== undefined) return cached;
  const result = isCodeBlock(el) || Array.from(el.children).some(child =>
    !child.matches(OURS_SEL) && hasCodeBlock(child, memo),
  );
  memo?.set(el, result);
  return result;
}
