import type { PublicSessionConfig } from '../lib/types';
import {
  getStatus,
  restoreOriginal,
  stopWatch,
  retryFailed,
  translatePage,
  getActiveSession,
} from '../lib/scheduler';
import { isAbortError, translateBatchViaPort, type ContentRequest } from '../lib/messaging';
import { ensureCatalogs, getUiMessage } from '../lib/i18n';
import {
  hideOverlay,
  showError,
  showLoading,
  showResult,
  type OverlayLabels,
} from '../lib/overlay';

/** Dispatched before every inject so prior bindings can drop dead listeners. */
const DESTROY_EVENT = 'dual-read:destroy';

interface DualReadGlobal {
  version: string;
  runtimeId: string | null;
  sessionId?: string;
  restore: () => void;
  stopWatch: () => void;
  handleMessage: (req: ContentRequest, sender: unknown, reply: (r: unknown) => void) => boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __DUAL_READ__: DualReadGlobal | undefined;
}

function currentRuntimeId(): string | null {
  try {
    return chrome.runtime?.id ?? null;
  } catch {
    return null;
  }
}

export default defineUnlistedScript(() => {
  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '0';
    }
  })();
  const RUNTIME_ID = currentRuntimeId();

  // Always notify prior injects (including orphans after extension reload).
  // chrome.runtime.id is stable across reloads, so it cannot detect orphans —
  // a DOM event can.
  document.documentElement.dispatchEvent(
    new CustomEvent(DESTROY_EVENT, { bubbles: true }),
  );

  const prev = globalThis.__DUAL_READ__;
  // New extension version → clear translated DOM. Same version re-bind keeps
  // the page session (held on globalThis in the scheduler).
  if (prev && prev.version !== VERSION) {
    try {
      prev.restore();
    } catch {
      /* ignore */
    }
  }

  let disposed = false;
  let selectionAbort: AbortController | null = null;
  const onDestroy = (): void => {
    if (disposed) return;
    disposed = true;
    selectionAbort?.abort();
    selectionAbort = null;
    hideOverlay();
    document.documentElement.removeEventListener(DESTROY_EVENT, onDestroy);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* orphaned extension context */
    }
  };
  document.documentElement.addEventListener(DESTROY_EVENT, onDestroy);

  function overlayLabels(config: PublicSessionConfig): OverlayLabels {
    const locale = config.uiLocale || 'en';
    return {
      title: getUiMessage('overlayTitle', null, locale),
      copy: getUiMessage('overlayCopy', null, locale),
      close: getUiMessage('overlayClose', null, locale),
    };
  }

  function selectionCancelled(): { success: false; error: string; code: string } {
    return {
      success: false,
      error: 'selection superseded',
      code: 'SESSION_CANCELLED',
    };
  }

  async function translateSelection(
    config: PublicSessionConfig,
    selectedText?: string,
  ): Promise<{ success: boolean; error?: string; code?: string }> {
    // A newer selection supersedes the previous in-flight request and reuses
    // the single overlay owned by this binding.
    selectionAbort?.abort();
    selectionAbort = null;

    const locale = config.uiLocale || 'en';
    // Prefer text from the context-menu click (survives selection clear).
    const text = (selectedText || window.getSelection()?.toString() || '').trim();

    // Show chrome immediately so a slow/failing catalog or port is never "no reaction".
    const fallbackLabels: OverlayLabels = {
      title: 'Dual Read',
      copy: 'Copy',
      close: '×',
    };
    let labels = fallbackLabels;
    // Disabled-site selections are rejected after catalogs load; do not flash
    // a loading state for work we already know will never be dispatched.
    if (!disposed && text && !config.disabled) showLoading(text, labels);

    try {
      await ensureCatalogs();
      labels = overlayLabels(config);
    } catch {
      /* keep fallback labels */
    }

    // destroy may run while locale catalogs are loading. Never let that dead
    // closure recreate UI or open a port after the async boundary.
    if (disposed) return selectionCancelled();

    if (!text) {
      showError('', getUiMessage('errorNoText', null, locale) || 'No text selected', labels);
      return { success: false };
    }
    if (config.disabled) {
      const msg = getUiMessage('errPageUnsupported', null, locale);
      showError(text, msg, labels);
      return { success: false, error: msg, code: 'PAGE_UNSUPPORTED' };
    }

    // Refresh labels on the loading panel once catalogs are ready.
    showLoading(text, labels);
    const controller = new AbortController();
    selectionAbort = controller;
    try {
      const beforeId = getActiveSession()?.id;
      const [tr] = await translateBatchViaPort([text], {
        sessionId: config.sessionId,
        signal: controller.signal,
      });
      if (disposed || controller.signal.aborted) {
        return selectionCancelled();
      }
      const afterId = getActiveSession()?.id;
      // Only drop when a different *live* page session replaced ours.
      if (beforeId && afterId && beforeId !== afterId) {
        return { success: false, error: 'session superseded', code: 'SESSION_CANCELLED' };
      }
      showResult(text, tr ?? '', labels);
      return { success: true };
    } catch (err) {
      if (disposed || controller.signal.aborted || isAbortError(err)) {
        return selectionCancelled();
      }
      const { toUserFacingError } = await import('../lib/errors');
      // The dynamic import is another async boundary; destroy can happen while
      // the error module is resolving.
      if (disposed || controller.signal.aborted) return selectionCancelled();
      const uf = toUserFacingError(err);
      const msg = getUiMessage(uf.messageKey, null, locale);
      const action = uf.actionKey ? getUiMessage(uf.actionKey, null, locale) : '';
      showError(text, action ? `${msg} — ${action}` : msg, labels);
      return { success: false, error: msg, code: uf.code };
    } finally {
      if (selectionAbort === controller) selectionAbort = null;
    }
  }

  function replyAsync(
    work: Promise<unknown>,
    reply: (r: unknown) => void,
  ): boolean {
    work.then(reply).catch((err) => {
      reply({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return true;
  }

  function handleMessage(req: ContentRequest, _sender: unknown, reply: (r: unknown) => void): boolean {
    if (disposed) return false;
    switch (req.action) {
      case 'ping':
        reply({ pong: true, version: VERSION, runtimeId: currentRuntimeId() });
        return false;
      case 'getStatus':
        reply(getStatus());
        return false;
      case 'restoreOriginal':
        restoreOriginal();
        reply({ success: true });
        return false;
      case 'stopWatch':
        stopWatch();
        reply({ success: true, ...getStatus() });
        return false;
      case 'retryFailed':
        reply(retryFailed());
        return false;
      case 'translatePage':
        return replyAsync(
          translatePage(req.config).then((result) => {
            const g = globalThis.__DUAL_READ__;
            if (g && !disposed) g.sessionId = result.sessionId;
            return result;
          }),
          reply,
        );
      case 'toggleMode':
        return replyAsync(
          translatePage(req.config).then((result) => {
            const g = globalThis.__DUAL_READ__;
            if (g && !disposed) g.sessionId = result.sessionId;
            return result;
          }),
          reply,
        );
      case 'translateSelection':
        return replyAsync(translateSelection(req.config, req.text), reply);
      default:
        return false;
    }
  }

  globalThis.__DUAL_READ__ = {
    version: VERSION,
    runtimeId: RUNTIME_ID,
    sessionId: getActiveSession()?.id,
    restore: restoreOriginal,
    stopWatch,
    handleMessage,
  };

  function onRuntimeMessage(
    req: unknown,
    sender: chrome.runtime.MessageSender,
    reply: (response?: unknown) => void,
  ): boolean {
    if (disposed) return false;
    const g = globalThis.__DUAL_READ__;
    if (!g || g.handleMessage !== handleMessage) return false;
    return handleMessage(req as ContentRequest, sender, reply);
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
});
