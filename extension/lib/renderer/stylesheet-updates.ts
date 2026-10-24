import { P } from '../dom-const';

type Token = Document | ShadowRoot | CSSStyleSheet | string | boolean;
const CHECK_MS = 1000;
const READ_MS = 8;
const TOKENS_PER_FRAME = 256;

/** CSSOM changes have no observer event. Compare readable author rules before
 * asking layout readers to resolve selectors/cascade for every owned box. */
function* stylesheetState(shadows: Iterable<ShadowRoot>): Generator<Token> {
  const roots = new Set<Document | ShadowRoot>([document]);
  for (const shadow of shadows) {
    for (let root: Node = shadow; root instanceof ShadowRoot; root = root.host.getRootNode()) roots.add(root);
  }
  const seen = new Set<CSSStyleSheet>();
  function* sheetState(sheet: CSSStyleSheet): Generator<Token> {
    yield sheet;
    if (seen.has(sheet)) return;
    seen.add(sheet);
    yield sheet.disabled;
    yield sheet.media?.mediaText ?? '';
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { yield 'opaque'; return; }
    for (const rule of rules) {
      // Grouping rules serialize their nested declarations too. Imports need
      // their own sheet because cssText contains only the import reference.
      yield rule.cssText;
      if (rule instanceof CSSImportRule && rule.styleSheet) yield* sheetState(rule.styleSheet);
    }
    yield 'end-sheet';
  }
  for (const root of roots) {
    yield root;
    for (const sheet of [...root.styleSheets ?? [], ...root.adoptedStyleSheets ?? []]) {
      const owner = sheet.ownerNode;
      if (owner instanceof Element && [...owner.attributes].some(attribute => attribute.name.startsWith(`data-${P}-`))) continue;
      yield* sheetState(sheet);
    }
    yield 'end-root';
  }
}

/** Only the shared layout observer with active source overrides subscribes.
 * Work yields across frames and stops entirely while the document is hidden. */
export function watchStylesheetChanges(shadows: () => Iterable<ShadowRoot>, changed: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let previous: Token[] | null = null;
  let scan: Generator<Token> | null = null;
  let current: Token[] = [];
  let disposed = false;

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    timer = null; frame = null; scan = null; current = [];
  };
  const schedule = (): void => {
    if (disposed || document.visibilityState === 'hidden') return;
    timer = setTimeout(start, CHECK_MS);
  };
  const read = (): void => {
    frame = null;
    if (disposed || document.visibilityState === 'hidden' || !scan) return;
    const start = performance.now();
    for (let count = 0; count < TOKENS_PER_FRAME; count++) {
      const next = scan.next();
      if (next.done) {
        const different = !previous || previous.length !== current.length || current.some((token, index) => token !== previous![index]);
        previous = current; current = []; scan = null;
        if (different) changed();
        schedule();
        return;
      }
      current.push(next.value);
      if (performance.now() - start >= READ_MS) break;
    }
    frame = requestAnimationFrame(read);
  };
  function start(): void {
    timer = null;
    if (disposed || document.visibilityState === 'hidden') return;
    scan = stylesheetState(shadows()); current = [];
    frame = requestAnimationFrame(read);
  }
  const visibilityChanged = (): void => { cancel(); start(); };
  document.addEventListener('visibilitychange', visibilityChanged);
  schedule();
  return () => {
    disposed = true; cancel(); previous = null;
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
