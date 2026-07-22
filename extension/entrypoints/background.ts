import {
  getSettings, saveSettings, effectiveForHost, hostOf, upsertSiteRule,
} from '../lib/settings/storage';
import { createDefaultSettings } from '../lib/settings/schema';
import { buildPublicSessionConfig } from '../lib/settings/session-config';
import {
  clearPendingSiteAuto, readPendingSiteAutos,
} from '../lib/settings/pending-site-auto';
import { translateTexts } from '../lib/provider';
import { ensureCatalogs, getUiMessage } from '../lib/i18n';
import {
  ensureContentScript,
  ensureFrameContentScript,
  isRestrictedUrl,
  originPattern,
  runSelectionInFrame,
  sendToContentFrames,
} from '../lib/inject';
import {
  PORT_NAME,
  type BatchRequestMsg,
  type BatchCancelMsg,
  type PortInboundMsg,
} from '../lib/messaging';
import { createFairGate, GLOBAL_TRANSLATE_LIMIT } from '../lib/scheduler/global-gate';
import { getOnboardingState, openOnboardingPage } from '../lib/settings/onboarding';
import { isConnectionConfigured } from '../lib/provider/connection';
import { createContextMenuManager } from '../lib/context-menu';

const CONTEXT_MENU_ID = 'dual-read-translate-selection';
const translateGate = createFairGate(GLOBAL_TRANSLATE_LIMIT);

function isBatchRequest(msg: PortInboundMsg): msg is BatchRequestMsg {
  return msg.action === 'translateBatch';
}

function isBatchCancel(msg: PortInboundMsg): msg is BatchCancelMsg {
  return msg.action === 'translateCancel';
}

function isActivatePendingSiteAutoMessage(message: unknown): message is { action: 'activatePendingSiteAuto'; tabId: number } {
  return Boolean(
    message
    && typeof message === 'object'
    && (message as { action?: unknown }).action === 'activatePendingSiteAuto'
    && typeof (message as { tabId?: unknown }).tabId === 'number',
  );
}

export default defineBackground(() => {
  const activatingSiteAutoTabs = new Set<number>();

  // MV3 kills the service worker after ~30s of *extension* idleness — and an
  // in-flight fetch does not reset that clock, while chrome API calls do.
  // Slow upstream batches (the port protocol allows 60s) would otherwise die
  // mid-flight, so ping a cheap API on an interval while batches are active.
  let activeBatches = 0;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  function trackBatchStart(): void {
    activeBatches += 1;
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      try {
        chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
      } catch {
        /* worker tearing down */
      }
    }, 20_000);
  }

  function trackBatchEnd(): void {
    activeBatches = Math.max(0, activeBatches - 1);
    if (activeBatches > 0 || !keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  const contextMenuManager = createContextMenuManager(CONTEXT_MENU_ID, async (uiLocale) => {
    await ensureCatalogs();
    return getUiMessage('contextMenuTranslateSelection', null, uiLocale);
  });

  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      if (details.reason === 'install') {
        const stored = await getSettings();
        await saveSettings({ ...createDefaultSettings(), ...stored });
        const onboarding = await getOnboardingState();
        if (!onboarding.completed) openOnboardingPage();
      }
      const settings = await getSettings();
      // Install/update/reload is the only lifecycle that creates the item.
      // Context menus persist across ordinary MV3 service-worker cold starts.
      await contextMenuManager.recreate(settings.uiLocale);
    })();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.uiLocale) {
      void (async () => {
        const settings = await getSettings();
        await contextMenuManager.updateOrRecreate(settings.uiLocale);
      })();
    }
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
    const tabId = tab.id;
    const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
    // Prefer menu-provided selectionText: clicking the item often clears
    // window.getSelection() before the content script runs.
    const selectedText = typeof info.selectionText === 'string' ? info.selectionText : '';

    // Start the target-frame liveness check immediately. It reuses a current
    // binding and injects only when missing/orphaned; repeated selections must
    // not re-execute dual-read.js and accumulate overlay listeners.
    const frameReady = ensureFrameContentScript(tabId, frameId);

    void (async () => {
      const settings = await getSettings();
      const config = await buildPublicSessionConfig(settings, hostOf(tab.url));
      const targetReady = await frameReady;
      if (!targetReady && !(await ensureContentScript(tabId))) {
        console.warn('[Dual Read] selection translate: inject failed for tab', tabId);
        try {
          await chrome.action.setBadgeText({ tabId, text: '!' });
          await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' });
        } catch {
          /* ignore */
        }
        return;
      }
      // Deliver via executeScript (same pattern as frame relay). tabs.sendMessage
      // to a just-injected frame is flaky after context-menu activeTab races.
      const delivered = await runSelectionInFrame(tabId, frameId, config, selectedText);
      if (!delivered) {
        console.warn('[Dual Read] selection translate: frame did not handle message', {
          tabId,
          frameId,
        });
        try {
          await chrome.action.setBadgeText({ tabId, text: '!' });
          await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' });
        } catch {
          /* ignore */
        }
      } else {
        try {
          await chrome.action.setBadgeText({ tabId, text: '' });
        } catch {
          /* ignore */
        }
      }
    })();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    // Content-script ports must come from a tab. Reject extension-page abuse.
    if (!port.sender?.tab?.id) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      return;
    }

    const controllers = new Map<string, AbortController>();

    port.onDisconnect.addListener(() => {
      for (const ac of controllers.values()) ac.abort();
      controllers.clear();
    });

    port.onMessage.addListener((raw: PortInboundMsg) => {
      if (isBatchCancel(raw)) {
        controllers.get(raw.requestId)?.abort();
        controllers.delete(raw.requestId);
        return;
      }
      if (!isBatchRequest(raw)) return;

      void (async () => {
        const ac = new AbortController();
        controllers.set(raw.requestId, ac);
        trackBatchStart();
        try {
          const settings = await getSettings();
          const translations = await translateGate.run(
            () => translateTexts(raw.texts, settings, ac.signal),
            ac.signal,
          );
          if (ac.signal.aborted) return;
          port.postMessage({
            action: 'batchResult',
            requestId: raw.requestId,
            sessionId: raw.sessionId,
            success: true,
            translations,
          });
        } catch (err) {
          if (ac.signal.aborted) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const { DualReadError, toUserFacingError } = await import('../lib/errors');
          const uf = toUserFacingError(err);
          const message = err instanceof DualReadError
            ? (err.detail || err.code)
            : (err instanceof Error ? err.message : String(err));
          console.error('[Dual Read] batch translation failed:', uf.code, message);
          try {
            port.postMessage({
              action: 'batchResult',
              requestId: raw.requestId,
              sessionId: raw.sessionId,
              success: false,
              error: uf.detail || uf.code,
              code: uf.code,
            });
          } catch {
            /* port gone */
          }
        } finally {
          controllers.delete(raw.requestId);
          trackBatchEnd();
        }
      })();
    });
  });

  async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function sendToContent(tabId: number, message: Parameters<typeof sendToContentFrames>[1]): Promise<unknown> {
    return sendToContentFrames(tabId, message);
  }

  async function activatePendingSiteAuto(tabId: number): Promise<void> {
    if (activatingSiteAutoTabs.has(tabId)) return;
    activatingSiteAutoTabs.add(tabId);
    try {
      const pending = (await readPendingSiteAutos()).find((item) => item.tabId === tabId);
      if (!pending) return;

      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (
        !tab?.url
        || isRestrictedUrl(tab.url)
        || hostOf(tab.url) !== pending.host
        || originPattern(tab.url) !== pending.origin
      ) {
        await clearPendingSiteAuto(tabId);
        return;
      }

      const granted = await chrome.permissions.contains({ origins: [pending.origin] }).catch(() => false);
      if (!granted) return;

      const settings = await upsertSiteRule(pending.host, { auto: true, disabled: false });
      // The durable setting is written; no stale intent can enable a later tab.
      await clearPendingSiteAuto(tabId);
      if (!isConnectionConfigured(settings)) return;

      const eff = effectiveForHost(settings, pending.host);
      if (!eff.auto || eff.disabled) return;
      if (!(await ensureContentScript(tabId))) return;
      const config = await buildPublicSessionConfig(settings, pending.host, {
        mode: eff.mode,
        targetLang: eff.targetLang,
      });
      await sendToContent(tabId, { action: 'translatePage', config });
    } finally {
      activatingSiteAutoTabs.delete(tabId);
    }
  }

  async function activateSiteAutosForAddedOrigins(origins: string[]): Promise<void> {
    // The popup queues its intent immediately before opening the native
    // permission dialog. Retry briefly in case permissions.onAdded reaches the
    // worker before that storage write has become observable.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = await readPendingSiteAutos();
      const matching = pending.filter((item) => origins.includes(item.origin));
      if (matching.length) {
        await Promise.all(matching.map((item) => activatePendingSiteAuto(item.tabId)));
        return;
      }
      if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  chrome.permissions.onAdded.addListener((permissions) => {
    if (permissions.origins?.length) {
      void activateSiteAutosForAddedOrigins(permissions.origins);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isActivatePendingSiteAutoMessage(message)) return undefined;
    void activatePendingSiteAuto(message.tabId).then(
      () => sendResponse({ success: true }),
      () => sendResponse({ success: false }),
    );
    return true;
  });

  // Auto-translate on navigation for sites the user opted in (and already
  // granted host permission for). Never prompts for permission here.
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete' || isRestrictedUrl(tab.url)) return;
    void (async () => {
      const settings = await getSettings();
      if (!isConnectionConfigured(settings)) return;
      const host = hostOf(tab.url);
      const eff = effectiveForHost(settings, host);
      if (!eff.auto || eff.disabled) return;

      const pattern = originPattern(tab.url!);
      if (!pattern) return;
      const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
      if (!granted) return;

      if (!(await ensureContentScript(tabId))) return;
      const config = await buildPublicSessionConfig(settings, host, {
        mode: eff.mode,
        targetLang: eff.targetLang,
      });
      await sendToContent(tabId, { action: 'translatePage', config });
    })();
  });

  chrome.commands?.onCommand.addListener((command) => {
    void (async () => {
      const tab = await activeTab();
      if (!tab?.id) return;
      const settings = await getSettings();
      if (!isConnectionConfigured(settings)) {
        openOnboardingPage();
        return;
      }
      const host = hostOf(tab.url);
      const eff = effectiveForHost(settings, host);
      if (eff.disabled) return;
      if (!(await ensureContentScript(tab.id))) return;

      if (command === 'toggle-translate') {
        const status = (await sendToContent(tab.id, { action: 'getStatus' })) as
          | { count?: number; watching?: boolean }
          | null;
        if (status && (status.watching || (status.count ?? 0) > 0)) {
          await sendToContent(tab.id, { action: 'restoreOriginal' });
        } else {
          const config = await buildPublicSessionConfig(settings, host, {
            mode: eff.mode,
            targetLang: eff.targetLang,
          });
          await sendToContent(tab.id, { action: 'translatePage', config });
        }
      } else if (command === 'toggle-mode') {
        const mode = eff.mode === 'bilingual' ? 'replace' : 'bilingual';
        const next = await saveSettings({ mode });
        const config = await buildPublicSessionConfig(next, host, {
          mode,
          targetLang: eff.targetLang,
        });
        await sendToContent(tab.id, { action: 'toggleMode', config });
      }
    })();
  });
});
