import { HIDE, OURS_SEL, P } from '../dom-const';

/** Read all subscribed layouts before applying any owned style writes. */
type LayoutRead = (mutations: readonly MutationRecord[] | null) => (() => void) | undefined;
const readers = new Map<LayoutRead, Set<ShadowRoot>>();
const observed = new Set<ShadowRoot>();
let observer: MutationObserver | null = null;
let frame: number | null = null;
let records: MutationRecord[] = [];
let globalChange = false;
let colorScheme: MediaQueryList | null = null;
const MOTION_EVENTS = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'] as const;

function watchMotion(root: Document | ShadowRoot, add: boolean): void {
  for (const event of MOTION_EVENTS) {
    if (add) root.addEventListener(event, motionUpdate, true);
    else root.removeEventListener(event, motionUpdate, true);
  }
}

/** A frame at transition start sees an intermediate paint. Re-read its final
 * state without polling, ignoring motion produced by our own companions. */
function motionUpdate(event: Event): void {
  const element = event.target;
  if (!(element instanceof Element)) return;
  const chrome = element.closest(OURS_SEL);
  if (element.matches(OURS_SEL) || chrome && !chrome.classList.contains(HIDE)) return;
  globalUpdate();
}

function ownedStyle(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  const style = element?.closest('style');
  return !!style && Array.from(style.attributes).some(attribute => attribute.name.startsWith(`data-${P}-`));
}

function pageMutation(record: MutationRecord): boolean {
  if (record.type === 'attributes' && record.attributeName?.startsWith(`data-${P}-`)) return false;
  if (ownedStyle(record.target)) return false;
  const element = record.target instanceof Element ? record.target : record.target.parentElement;
  const chrome = element?.closest(OURS_SEL);
  if (chrome && !chrome.classList.contains(HIDE)) return false;
  if (record.type === 'attributes' && element?.matches(OURS_SEL)) return false;
  if (record.type === 'childList') {
    const changed = [...record.addedNodes, ...record.removedNodes];
    if (changed.length && changed.every(ownedStyle)) return false;
  }
  return true;
}

function retainRecords(mutations: MutationRecord[]): void {
  records.push(...mutations.filter(pageMutation));
  if (records.length) queueUpdate();
}

/** disconnect discards undelivered records, including page callbacks triggered
 * synchronously by another reader's restoration. Preserve them for survivors. */
function reconnectObserver(): void {
  if (!observer) return;
  retainRecords(observer.takeRecords());
  observer.disconnect();
  observer.observe(document.documentElement, OPTIONS);
  for (const root of observed) observer.observe(root, OPTIONS);
}

function queueUpdate(): void {
  if (frame !== null || !readers.size) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const batch = globalChange ? null : records;
    records = [];
    globalChange = false;
    // A long-lived translated feed can remove whole shadow components. Drop
    // their subscriptions rather than retaining detached roots until restore.
    let disconnected = false;
    for (const root of observed) {
      if (root.host.isConnected) continue;
      root.removeEventListener('load', loadUpdate, true);
      root.removeEventListener('input', globalUpdate, true);
      root.removeEventListener('change', globalUpdate, true);
      watchMotion(root, false);
      observed.delete(root);
      for (const roots of readers.values()) roots.delete(root);
      disconnected = true;
    }
    if (disconnected) reconnectObserver();
    const writes = [...readers.keys()].map(read => read(batch));
    for (const write of writes) write?.();
  });
}

function globalUpdate(): void {
  globalChange = true;
  queueUpdate();
}

function loadUpdate(event: Event): void {
  if (event.target instanceof HTMLImageElement || event.target instanceof HTMLLinkElement) globalUpdate();
}

const OPTIONS: MutationObserverInit = {
  subtree: true, childList: true, characterData: true, attributes: true,
  // CSS can select arbitrary page attributes (including data-* themes).
  // Readers restrict work to their actual source ancestry and installed rules.
};

function observeShadow(root: ShadowRoot): void {
  if (observed.has(root) || !observer) return;
  observed.add(root);
  observer.observe(root, OPTIONS);
  root.addEventListener('load', loadUpdate, true);
  root.addEventListener('input', globalUpdate, true);
  root.addEventListener('change', globalUpdate, true);
  watchMotion(root, true);
}

/** Exists only while a rendered companion or media rule needs live styling.
 * Independent of translation watching, so a paused page still follows themes. */
export function watchLayoutUpdates(read: LayoutRead): { addRoot: (root: Node) => void; refresh: (global?: boolean) => void; dispose: () => void } {
  const roots = new Set<ShadowRoot>();
  readers.set(read, roots);
  if (!observer) {
    observer = new MutationObserver(retainRecords);
    observer.observe(document.documentElement, OPTIONS);
    document.addEventListener('load', loadUpdate, true);
    document.addEventListener('input', globalUpdate, true);
    document.addEventListener('change', globalUpdate, true);
    watchMotion(document, true);
    window.addEventListener('resize', globalUpdate);
    if (typeof window.matchMedia === 'function') {
      colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
      colorScheme.addEventListener?.('change', globalUpdate);
    }
  }
  return {
    // An owned write can need a follow-up read without invalidating every
    // source again. Page/browser events still request a global refresh.
    refresh: (global = true) => global ? globalUpdate() : queueUpdate(),
    addRoot(root) {
      if (!(root instanceof ShadowRoot)) return;
      roots.add(root);
      observeShadow(root);
    },
    dispose() {
      readers.delete(read);
      if (readers.size) {
        const retained = new Set([...readers.values()].flatMap(roots => [...roots]));
        for (const root of observed) {
          if (retained.has(root)) continue;
          root.removeEventListener('load', loadUpdate, true);
          root.removeEventListener('input', globalUpdate, true);
          root.removeEventListener('change', globalUpdate, true);
          watchMotion(root, false);
          observed.delete(root);
        }
        reconnectObserver();
        return;
      }
      observer?.disconnect();
      observer = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      records = [];
      globalChange = false;
      for (const root of observed) {
        root.removeEventListener('load', loadUpdate, true);
        root.removeEventListener('input', globalUpdate, true);
        root.removeEventListener('change', globalUpdate, true);
        watchMotion(root, false);
      }
      observed.clear();
      document.removeEventListener('load', loadUpdate, true);
      document.removeEventListener('input', globalUpdate, true);
      document.removeEventListener('change', globalUpdate, true);
      watchMotion(document, false);
      window.removeEventListener('resize', globalUpdate);
      colorScheme?.removeEventListener?.('change', globalUpdate);
      colorScheme = null;
    },
  };
}

/** Head stylesheet changes can affect every source without touching its DOM. */
export function stylesheetChanged(mutations: readonly MutationRecord[]): boolean {
  return mutations.some(record => {
    const element = record.target instanceof Element ? record.target : record.target.parentElement;
    return !!element?.closest('head, style, link[rel="stylesheet"]');
  });
}
