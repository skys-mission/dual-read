/**
 * DOM root discovery for Dual Read.
 *
 * - Open (and feature-detected closed) ShadowRoots are indexed in-page.
 * - Same-origin iframes get their own content-script session via allFrames inject;
 *   the parent only diagnoses them and never double-indexes contentDocument.
 * - Cross-origin / opaque frames are reported honestly as unsupported barriers.
 */

export type WatchRoot = Document | ShadowRoot | Element;

export interface FrameBarrier {
  kind: 'same-origin' | 'cross-origin' | 'opaque';
  src: string;
}

export interface RootDiagnostics {
  shadowRoots: number;
  frames: {
    sameOrigin: number;
    crossOrigin: number;
    opaque: number;
  };
}

/** Prefer open shadowRoot; fall back to chrome.dom.openOrClosedShadowRoot when present. */
export function getShadowRoot(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    const openOrClosed = chrome?.dom?.openOrClosedShadowRoot;
    if (typeof openOrClosed === 'function' && el instanceof HTMLElement) {
      return openOrClosed(el) ?? null;
    }
  } catch {
    /* API absent or denied */
  }
  return null;
}

/** Depth-first walk of open (or feature-detected) shadow roots under `scope`. */
export function walkOpenShadowRoots(scope: ParentNode): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const seen = new Set<ShadowRoot>();

  const visitElement = (el: Element): void => {
    const sr = getShadowRoot(el);
    if (sr && !seen.has(sr)) {
      seen.add(sr);
      out.push(sr);
      visitRoot(sr);
    }
  };

  const visitRoot = (root: ParentNode): void => {
    if (root instanceof Element) visitElement(root);
    const kids = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    for (const el of kids) visitElement(el);
  };

  visitRoot(scope);
  return out;
}

/**
 * Classify iframes on the page. Same-origin frames are injectable via allFrames;
 * cross-origin/opaque frames cannot be translated from this document.
 */
export function diagnoseFrames(doc: Document = document): FrameBarrier[] {
  const out: FrameBarrier[] = [];
  for (const iframe of Array.from(doc.querySelectorAll('iframe'))) {
    const src = iframe.getAttribute('src') || (iframe as HTMLIFrameElement).src || '';
    try {
      const child = (iframe as HTMLIFrameElement).contentDocument;
      if (child) out.push({ kind: 'same-origin', src });
      else out.push({ kind: 'cross-origin', src });
    } catch {
      out.push({ kind: 'opaque', src });
    }
  }
  return out;
}

export function summarizeDiagnostics(
  shadowRoots: number,
  frames: FrameBarrier[] = diagnoseFrames(),
): RootDiagnostics {
  const summary = { sameOrigin: 0, crossOrigin: 0, opaque: 0 };
  for (const f of frames) {
    if (f.kind === 'same-origin') summary.sameOrigin++;
    else if (f.kind === 'cross-origin') summary.crossOrigin++;
    else summary.opaque++;
  }
  return { shadowRoots, frames: summary };
}

export type MutationHandler = (mutations: MutationRecord[], source: WatchRoot) => void;
export type RootsChangedHandler = (added: WatchRoot[]) => void;

/**
 * Owns MutationObservers for the top document body and every discovered shadow root.
 * Does not enter iframe documents (those are separate content-script realms).
 */
export class RootRegistry {
  private readonly watchers = new Map<WatchRoot, MutationObserver>();
  private readonly onMutations: MutationHandler;
  private readonly onRootsChanged: RootsChangedHandler | null;
  private disposed = false;

  constructor(onMutations: MutationHandler, onRootsChanged?: RootsChangedHandler) {
    this.onMutations = onMutations;
    this.onRootsChanged = onRootsChanged ?? null;
  }

  get size(): number {
    return this.watchers.size;
  }

  get roots(): WatchRoot[] {
    return Array.from(this.watchers.keys());
  }

  /** Initial discover + watch. Returns every collection scope (body + shadows). */
  bootstrap(doc: Document = document): WatchRoot[] {
    if (this.disposed) return [];
    const scopes: WatchRoot[] = [];
    if (doc.body) {
      this.watch(doc.body);
      scopes.push(doc.body);
    }
    for (const sr of walkOpenShadowRoots(doc.body ?? doc.documentElement)) {
      this.watch(sr);
      scopes.push(sr);
    }
    return scopes;
  }

  /** Watch a root if not already watched. Returns true when newly added. */
  watch(root: WatchRoot): boolean {
    if (this.disposed || this.watchers.has(root)) return false;
    const mo = new MutationObserver((mutations) => {
      if (this.disposed) return;
      const newly = this.discoverFromMutations(mutations);
      if (newly.length) this.onRootsChanged?.(newly);
      this.onMutations(mutations, root);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    this.watchers.set(root, mo);
    return true;
  }

  /** Find shadow roots under mutation-added subtrees and start watching them. */
  discoverFromMutations(mutations: MutationRecord[]): WatchRoot[] {
    const added: WatchRoot[] = [];
    for (const m of mutations) {
      for (const n of Array.from(m.addedNodes)) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        for (const sr of [getShadowRoot(el), ...walkOpenShadowRoots(el)].filter(Boolean) as ShadowRoot[]) {
          if (this.watch(sr)) added.push(sr);
        }
      }
    }
    return added;
  }

  /** Re-walk the document for late-attached open shadows (custom element upgrade). */
  rescan(doc: Document = document): WatchRoot[] {
    if (this.disposed) return [];
    const added: WatchRoot[] = [];
    const scope = doc.body ?? doc.documentElement;
    if (!scope) return added;
    for (const sr of walkOpenShadowRoots(scope)) {
      if (this.watch(sr)) added.push(sr);
    }
    return added;
  }

  /** Drop watchers whose root left the document. */
  pruneDisconnected(): void {
    for (const [root, mo] of Array.from(this.watchers.entries())) {
      const alive =
        root instanceof ShadowRoot
          ? Boolean(root.host?.isConnected)
          : root instanceof Document
            ? true
            : (root as Element).isConnected;
      if (!alive) {
        mo.disconnect();
        this.watchers.delete(root);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const mo of this.watchers.values()) mo.disconnect();
    this.watchers.clear();
  }
}
