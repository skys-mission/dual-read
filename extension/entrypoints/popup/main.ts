import type { Settings } from '../../lib/types';
import {
  getSettings, saveSettings, effectiveForHost, hostOf, upsertSiteRule,
} from '../../lib/settings/storage';
import { normalizeTargetLang } from '../../lib/settings/schema';
import { buildPublicSessionConfig } from '../../lib/settings/session-config';
import {
  clearPendingSiteAuto, stagePendingSiteAuto,
} from '../../lib/settings/pending-site-auto';
import {
  ensureCatalogs, formatUiNumber, getUiMessage, getUiPluralMessage, localizePage,
} from '../../lib/i18n';
import { ensureContentScript, isRestrictedUrl, originPattern, sendToContentFrames } from '../../lib/inject';
import { isConnectionConfigured } from '../../lib/provider/connection';
import { openOnboardingPage } from '../../lib/settings/onboarding';
import { derivePopupView, type PopupSnapshot, type PrimaryAction } from '../../lib/popup/state';

const els = {
  status: document.getElementById('statusText') as HTMLElement,
  count: document.getElementById('countText') as HTMLElement,
  progressWrap: document.getElementById('progressWrap') as HTMLElement,
  progressBar: document.getElementById('progressBar') as HTMLElement,
  targetLang: document.getElementById('targetLang') as HTMLSelectElement,
  mode: document.getElementById('mode') as HTMLSelectElement,
  sitePolicy: document.getElementById('sitePolicy') as HTMLSelectElement,
  primaryBtn: document.getElementById('primaryBtn') as HTMLButtonElement,
  secondaryBtn: document.getElementById('secondaryBtn') as HTMLButtonElement,
  secondaryRow: document.getElementById('secondaryRow') as HTMLElement,
  optionsLink: document.getElementById('optionsLink') as HTMLAnchorElement,
};

let currentHost = '';
let uiLocale = 'en';
let siteDisabled = false;
let snap: PopupSnapshot = {
  configured: false,
  hasTab: false,
  restricted: false,
  siteDisabled: false,
  translating: false,
  watching: false,
  count: 0,
  total: 0,
  failed: 0,
};
let pollTimer: ReturnType<typeof setInterval> | null = null;
let primaryAction: PrimaryAction = 'none';
let sitePolicySaving = false;

function t(key: string, subs?: (string | number)[]): string {
  return getUiMessage(key, subs ?? null, uiLocale);
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToContent(
  tabId: number,
  message: Parameters<typeof sendToContentFrames>[1],
): Promise<Record<string, unknown>> {
  return sendToContentFrames(tabId, message);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startProgressPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => { void refreshFromPage(); }, 400);
}

/** Keep polling while the page session is still draining units. */
function shouldPollProgress(s: PopupSnapshot = snap): boolean {
  if (s.busy || s.translating) return true;
  // start() resolves after the first visible batch; remaining work may still
  // be in flight under watching — keep the popup progress line alive.
  if (s.watching && s.total > 0 && s.count + s.failed < s.total) return true;
  return false;
}

function syncProgressPolling(): void {
  if (shouldPollProgress()) startProgressPolling();
  else stopPolling();
}

function renderView(): void {
  const view = derivePopupView(snap);
  primaryAction = view.primary;

  els.status.textContent = t(view.statusKey, view.statusSubs);
  if (view.detailText) {
    els.count.textContent = view.detailText;
  } else if (view.detailKey) {
    const translatedCount = view.detailKey === 'statusTranslated'
      ? Number(view.detailSubs?.[0] ?? 0)
      : null;
    const detail = translatedCount != null
      ? getUiPluralMessage(
        'statusTranslatedItems',
        translatedCount,
        [formatUiNumber(translatedCount, uiLocale)],
        uiLocale,
      )
      : t(view.detailKey, view.detailSubs);
    const action = view.actionKey ? t(view.actionKey) : '';
    els.count.textContent = action ? `${detail} — ${action}` : detail;
  } else {
    els.count.textContent = '';
  }

  if (view.progress && view.progress.total > 0) {
    const pct = Math.min(100, Math.round((view.progress.count / view.progress.total) * 100));
    els.progressWrap.hidden = false;
    els.progressBar.style.width = `${pct}%`;
    els.progressWrap.setAttribute('aria-valuenow', String(pct));
  } else {
    els.progressWrap.hidden = true;
    els.progressBar.style.width = '0%';
    els.progressWrap.setAttribute('aria-valuenow', '0');
  }

  els.primaryBtn.hidden = view.primary === 'none';
  els.primaryBtn.disabled = view.primaryDisabled;
  els.primaryBtn.textContent = t(view.primaryKey);
  els.primaryBtn.classList.toggle('primary', view.primary !== 'none');

  els.secondaryRow.hidden = !view.showSecondaryRestore;
  els.targetLang.disabled = !view.controlsEnabled;
  els.mode.disabled = !view.controlsEnabled;
  els.sitePolicy.disabled = !view.controlsEnabled || !snap.configured || sitePolicySaving;
}

function patchSnap(partial: Partial<PopupSnapshot>): void {
  snap = { ...snap, ...partial };
  renderView();
}

async function refreshFromPage(): Promise<void> {
  const tab = await getCurrentTab();
  const restricted = isRestrictedUrl(tab?.url);
  patchSnap({
    hasTab: Boolean(tab?.id),
    restricted,
    siteDisabled,
    injectFailed: false,
  });

  if (!snap.configured || !tab?.id || restricted || siteDisabled) {
    syncProgressPolling();
    return;
  }

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    patchSnap({ injectFailed: true, translating: false, watching: false });
    syncProgressPolling();
    return;
  }

  const status = await sendToContent(tab.id, { action: 'getStatus' });
  patchSnap({
    injectFailed: false,
    translating: Boolean(status?.translating),
    watching: Boolean(status?.watching),
    count: Number(status?.count) || 0,
    total: Number(status?.total) || 0,
    failed: Number(status?.failed) || 0,
    lastError: null,
  });
  syncProgressPolling();
}

async function loadSettings(settings: Settings): Promise<void> {
  const eff = effectiveForHost(settings, currentHost);
  uiLocale = settings.uiLocale || 'en';
  siteDisabled = Boolean(eff.disabled);
  els.targetLang.value = eff.targetLang || 'en';
  els.mode.value = eff.mode;
  els.sitePolicy.value = eff.disabled ? 'never' : eff.auto ? 'auto' : 'global';
  patchSnap({
    configured: isConnectionConfigured(settings),
    siteDisabled,
  });
}

async function savePopupSettings(): Promise<Settings> {
  return saveSettings({
    targetLang: normalizeTargetLang(els.targetLang.value),
    mode: els.mode.value as Settings['mode'],
  });
}

async function runTranslate(): Promise<void> {
  const settings = await savePopupSettings();
  await loadSettings(settings);
  if (!snap.configured) {
    openOnboardingPage();
    return;
  }

  const tab = await getCurrentTab();
  if (!tab?.id) {
    patchSnap({ hasTab: false, lastError: null, lastErrorCode: null });
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    patchSnap({ restricted: true });
    return;
  }
  if (siteDisabled) {
    patchSnap({ siteDisabled: true });
    return;
  }

  patchSnap({ busy: true, lastError: null, lastErrorCode: null, lastEmpty: false });
  startProgressPolling();

  try {
    if (!(await ensureContentScript(tab.id))) {
      patchSnap({ busy: false, injectFailed: true });
      return;
    }
    const eff = effectiveForHost(settings, currentHost);
    const config = await buildPublicSessionConfig(settings, currentHost, {
      mode: eff.mode,
      targetLang: normalizeTargetLang(els.targetLang.value),
    });
    const result = await sendToContent(tab.id, { action: 'translatePage', config });
    if (!result?.success) {
      if (result?.error) console.info('[Dual Read] translation detail:', result.code, result.error);
      patchSnap({
        busy: false,
        translating: false,
        lastError: t('errorTranslationFailed'),
        lastErrorCode: typeof result?.code === 'string' ? result.code : null,
        lastEmpty: false,
      });
      await refreshFromPage();
      return;
    }
    // translatePage resolves after the first visible batch — do not force
    // translating:false; refreshFromPage reads the live session status.
    const empty = (result.count === 0 && result.total === 0);
    patchSnap({
      busy: false,
      watching: Boolean(result.watching),
      count: Number(result.count) || 0,
      total: Number(result.total) || 0,
      failed: Number(result.failed) || 0,
      lastEmpty: empty,
      lastError: null,
      lastErrorCode: null,
    });
    await refreshFromPage();
  } finally {
    patchSnap({ busy: false });
    await refreshFromPage();
  }
}

async function runStop(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  if (!(await ensureContentScript(tab.id))) return;
  await sendToContent(tab.id, { action: 'stopWatch' });
  patchSnap({ busy: false, translating: false });
  await refreshFromPage();
}

async function runRestore(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  if (!(await ensureContentScript(tab.id))) return;
  await sendToContent(tab.id, { action: 'restoreOriginal' });
  patchSnap({
    translating: false,
    watching: false,
    count: 0,
    total: 0,
    failed: 0,
    lastError: null,
    lastEmpty: false,
    busy: false,
  });
  els.status.textContent = t('statusRestored');
  els.count.textContent = '';
  // Re-derive idle after a tick so restored message is visible briefly.
  setTimeout(() => { void refreshFromPage(); }, 600);
}

async function runRetryFailed(): Promise<void> {
  const tab = await getCurrentTab();
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  if (!(await ensureContentScript(tab.id))) return;
  patchSnap({ busy: true });
  startProgressPolling();
  try {
    await sendToContent(tab.id, { action: 'retryFailed' });
  } finally {
    patchSnap({ busy: false });
    await refreshFromPage();
  }
}

els.primaryBtn.addEventListener('click', () => {
  void (async () => {
    switch (primaryAction) {
      case 'setup':
        openOnboardingPage();
        break;
      case 'translate':
        await runTranslate();
        break;
      case 'stop':
        await runStop();
        break;
      case 'restore':
        await runRestore();
        break;
      case 'retryFailed':
        await runRetryFailed();
        break;
      default:
        break;
    }
  })();
});

els.secondaryBtn.addEventListener('click', () => {
  void runRestore();
});

els.targetLang.addEventListener('change', async () => {
  await savePopupSettings();
  await refreshFromPage();
});
els.mode.addEventListener('change', () => { void savePopupSettings(); });
els.sitePolicy.addEventListener('change', () => {
  void (async () => {
    if (!currentHost || !snap.configured) {
      els.sitePolicy.value = 'global';
      return;
    }
    const selected = els.sitePolicy.value as 'global' | 'auto' | 'never';
    sitePolicySaving = true;
    renderView();
    try {
      if (selected === 'auto') {
        const tab = await getCurrentTab();
        const pattern = tab?.url ? originPattern(tab.url) : null;
        if (!tab?.id || !pattern) {
          els.sitePolicy.value = 'global';
          return;
        }

        // Start the durable handoff before requesting permission. The browser
        // may tear down an action popup for its native permission dialog; the
        // background's permissions.onAdded listener then persists the rule and
        // starts translating this exact tab. Await the write: otherwise the
        // already-granted nudge below can reach the background before the
        // staged intent is observable and the rule is silently lost.
        const staged = await stagePendingSiteAuto({
          tabId: tab.id,
          host: currentHost,
          origin: pattern,
          createdAt: Date.now(),
        }).then(() => true).catch(() => false);
        if (!staged) {
          // Without the handoff the background cannot persist the rule after a
          // grant — fail honestly (revert the UI) instead of faking success.
          console.warn('[Dual Read] failed to stage site-auto intent');
          els.sitePolicy.value = 'global';
          return;
        }
        const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
        if (!granted) {
          await clearPendingSiteAuto(tab.id).catch(() => undefined);
          els.sitePolicy.value = 'global';
          return;
        }

        // Also nudge the background when the permission was already granted
        // (permissions.onAdded only fires for a new grant).
        void chrome.runtime.sendMessage({ action: 'activatePendingSiteAuto', tabId: tab.id })
          .catch(() => undefined);
        els.sitePolicy.value = 'auto';
      } else if (selected === 'never') {
        const settings = await upsertSiteRule(currentHost, { disabled: true, auto: false });
        siteDisabled = effectiveForHost(settings, currentHost).disabled;
        els.sitePolicy.value = siteDisabled ? 'never' : 'global';
      } else {
        const settings = await upsertSiteRule(currentHost, { auto: false, disabled: false });
        const effective = effectiveForHost(settings, currentHost);
        siteDisabled = effective.disabled;
        els.sitePolicy.value = effective.disabled ? 'never' : effective.auto ? 'auto' : 'global';
      }
    } catch {
      // Storage errors must not leave a successful-looking but unsaved policy.
      try {
        const settings = await getSettings();
        const effective = effectiveForHost(settings, currentHost);
        siteDisabled = effective.disabled;
        els.sitePolicy.value = effective.disabled ? 'never' : effective.auto ? 'auto' : 'global';
      } catch {
        els.sitePolicy.value = 'global';
      }
    } finally {
      sitePolicySaving = false;
      renderView();
      await refreshFromPage();
    }
  })();
});
els.optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void (async () => {
  await ensureCatalogs();
  const tab = await getCurrentTab();
  currentHost = hostOf(tab?.url);
  const settings = await getSettings();
  await loadSettings(settings);
  await localizePage(uiLocale);
  // localizePage may overwrite primary button text — re-apply view.
  renderView();
  await refreshFromPage();
})();
