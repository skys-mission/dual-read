// Shadow-DOM isolated floating layer for selection translation. Replaces the
// blocking, unstyleable alert() with a copyable, dismissible panel that cannot
// be affected by (or leak into) host-page CSS.

const HOST_ID = 'dual-read-overlay-host';

interface OverlayRefs {
  host: HTMLElement;
  root: ShadowRoot;
  panel: HTMLElement;
  body: HTMLElement;
  original: HTMLElement;
  title: HTMLElement;
  copyBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

let refs: OverlayRefs | null = null;
let onCopy: (() => void) | null = null;
let listenerAttachTimer: ReturnType<typeof setTimeout> | null = null;
/** Ignore outside clicks until this time — context-menu dismiss mousedown
 *  otherwise closes the overlay in the same gesture that opened it. */
let ignoreOutsideUntil = 0;
const OUTSIDE_GRACE_MS = 400;

const STYLE = `
:host { all: initial; }
.dr-panel {
  position: fixed;
  z-index: 2147483647;
  max-width: 360px;
  min-width: 200px;
  box-sizing: border-box;
  padding: 12px 14px;
  border-radius: 10px;
  background: #ffffff;
  color: #1f2937;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.18), 0 1px 2px rgba(15, 23, 42, 0.1);
  border: 1px solid #e5e7eb;
}
.dr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.dr-title { font-size: 12px; font-weight: 600; color: #6b7280; letter-spacing: 0.02em; }
.dr-actions { display: flex; gap: 4px; }
.dr-btn {
  all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px;
  font-size: 12px; color: #6b7280;
}
.dr-btn:hover { background: #f3f4f6; color: #111827; }
.dr-btn:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.dr-original { font-size: 12px; color: #9ca3af; margin: 0 0 6px; max-height: 60px; overflow: auto; }
.dr-body { margin: 0; white-space: pre-wrap; word-break: break-word; }
.dr-loading { color: #6b7280; }
.dr-error { color: #b91c1c; }
@media (prefers-reduced-motion: reduce) {
  .dr-panel { transition: none !important; }
}
@media (prefers-color-scheme: dark) {
  .dr-panel { background: #1f2937; color: #f3f4f6; border-color: #374151; }
  .dr-btn:hover { background: #374151; color: #fff; }
  .dr-original { color: #9ca3af; }
  .dr-btn:focus-visible { outline-color: #93c5fd; }
}
@media (prefers-contrast: more) {
  .dr-panel { border-width: 2px; }
  .dr-btn { color: inherit; }
}
`;

function updateLabels(r: OverlayRefs, labels: OverlayLabels): void {
  r.title.textContent = labels.title;
  r.copyBtn.textContent = labels.copy;
  r.copyBtn.setAttribute('aria-label', labels.copy);
  r.closeBtn.textContent = labels.close;
  r.closeBtn.setAttribute('aria-label', labels.close);
}

function ensureOverlay(labels: OverlayLabels): OverlayRefs {
  if (refs && document.documentElement.contains(refs.host)) {
    updateLabels(refs, labels);
    return refs;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = document.createElement('div');
  panel.className = 'dr-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'dr-head';
  const title = document.createElement('span');
  title.className = 'dr-title';
  title.id = 'dr-overlay-title';
  panel.setAttribute('aria-labelledby', 'dr-overlay-title');
  const actions = document.createElement('div');
  actions.className = 'dr-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'dr-btn';
  copyBtn.addEventListener('click', () => onCopy?.());
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dr-btn';
  closeBtn.addEventListener('click', hideOverlay);
  actions.append(copyBtn, closeBtn);
  head.append(title, actions);

  const original = document.createElement('p');
  original.className = 'dr-original';
  const body = document.createElement('p');
  body.className = 'dr-body';
  body.id = 'dr-overlay-body';
  panel.setAttribute('aria-describedby', 'dr-overlay-body');

  panel.append(head, original, body);
  root.append(style, panel);
  document.documentElement.appendChild(host);

  refs = { host, root, panel, body, original, title, copyBtn, closeBtn };
  updateLabels(refs, labels);

  // Dismiss on outside click / Escape; focus dialog for keyboard users.
  // Grace period: the click that chose the context-menu item often lands on
  // the document right after showLoading and would instantly hide the panel.
  ignoreOutsideUntil = Date.now() + OUTSIDE_GRACE_MS;
  listenerAttachTimer = setTimeout(() => {
    listenerAttachTimer = null;
    // hideOverlay may have run before this deferred callback.
    if (!refs || refs.host !== host || !document.documentElement.contains(host)) return;
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    panel.focus();
  }, 0);

  return refs;
}

function onOutside(e: Event): void {
  if (!refs) return;
  if (Date.now() < ignoreOutsideUntil) return;
  const path = e.composedPath();
  if (!path.includes(refs.host)) hideOverlay();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') hideOverlay();
}

function position(panel: HTMLElement): void {
  const sel = window.getSelection();
  let rect: DOMRect | null = null;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) rect = r;
  }
  const margin = 12;
  const pw = Math.min(360, window.innerWidth - margin * 2);
  panel.style.maxWidth = `${pw}px`;
  if (rect) {
    let top = rect.bottom + 8;
    let left = rect.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;
    if (top + 160 > window.innerHeight) top = Math.max(margin, rect.top - 168);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  } else {
    panel.style.top = `${margin}px`;
    panel.style.right = `${margin}px`;
    panel.style.left = 'auto';
  }
}

export interface OverlayLabels {
  title: string;
  copy: string;
  close: string;
}

function armOutsideGrace(): void {
  ignoreOutsideUntil = Date.now() + OUTSIDE_GRACE_MS;
}

export function showLoading(text: string, labels: OverlayLabels): void {
  const r = ensureOverlay(labels);
  armOutsideGrace();
  r.original.textContent = text;
  r.body.className = 'dr-body dr-loading';
  r.body.textContent = '…';
  onCopy = null;
  position(r.panel);
}

export function showResult(original: string, translation: string, labels: OverlayLabels): void {
  const r = ensureOverlay(labels);
  armOutsideGrace();
  r.original.textContent = original;
  r.body.className = 'dr-body';
  r.body.textContent = translation;
  onCopy = () => {
    void navigator.clipboard?.writeText(translation).catch(() => undefined);
  };
  position(r.panel);
}

export function showError(original: string, message: string, labels: OverlayLabels): void {
  const r = ensureOverlay(labels);
  armOutsideGrace();
  r.original.textContent = original;
  r.body.className = 'dr-body dr-error';
  r.body.textContent = message;
  onCopy = null;
  position(r.panel);
}

export function hideOverlay(): void {
  if (listenerAttachTimer != null) {
    clearTimeout(listenerAttachTimer);
    listenerAttachTimer = null;
  }
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  refs?.host.remove();
  refs = null;
  onCopy = null;
}
