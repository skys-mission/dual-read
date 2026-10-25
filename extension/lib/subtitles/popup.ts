import { openOnboardingPage } from '../settings/onboarding';
import type { Settings } from '../types';
import type { SubtitleConfig, SubtitleStatus } from './types';
import { subtitleStateKey } from './renderer';
import { languageLabel, setSubtitleAuto, subtitlePreferencesForm, subtitleText } from './preferences-ui';

interface Snapshot {
  success: boolean;
  configured: boolean;
  disabled: boolean;
  config: SubtitleConfig;
  status: SubtitleStatus;
}

/** Adds a scope selector only on supported watch pages. Selecting a scope is inert. */
export async function initSubtitlePopup(tabId: number, settings: Settings, selectScope: (subtitles: boolean) => void): Promise<void> {
  const main = document.querySelector<HTMLElement>('.popup-body')!;
  const footer = main.querySelector('.link-row');
  const pagePanel = document.createElement('section'); pagePanel.id = 'pagePanel'; pagePanel.hidden = true;
  pagePanel.setAttribute('role', 'tabpanel'); pagePanel.setAttribute('aria-labelledby', 'pageScope');
  for (const child of [...main.children]) if (child !== footer) pagePanel.append(child);
  const panel = document.createElement('section'); panel.id = 'subtitlePanel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'subtitleScope');
  const tabs = document.createElement('div'); tabs.className = 'scope-tabs'; tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Dual Read');
  const t = (key: string) => subtitleText({ uiLocale: settings.uiLocale }, key);
  const subtitleTab = document.createElement('button'); const pageTab = document.createElement('button');
  for (const [button, id, target, label] of [[subtitleTab, 'subtitleScope', 'subtitlePanel', 'subtitleTab'], [pageTab, 'pageScope', 'pagePanel', 'subtitlePageTab']] as const) {
    button.id = id; button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', target);
    button.textContent = t(label); tabs.append(button);
  }
  const activate = (subtitles: boolean) => {
    panel.hidden = !subtitles; pagePanel.hidden = subtitles;
    subtitleTab.setAttribute('aria-selected', String(subtitles)); pageTab.setAttribute('aria-selected', String(!subtitles));
    subtitleTab.tabIndex = subtitles ? 0 : -1; pageTab.tabIndex = subtitles ? -1 : 0;
    selectScope(subtitles);
  };
  subtitleTab.addEventListener('click', () => activate(true)); pageTab.addEventListener('click', () => activate(false));
  tabs.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); const subtitles = panel.hidden; activate(subtitles); (subtitles ? subtitleTab : pageTab).focus();
  });
  const status = document.createElement('p'); status.className = 'subtitle-status'; status.setAttribute('role', 'status');
  const source = document.createElement('p'); source.className = 'hint';
  const language = document.createElement('div');
  const primary = document.createElement('button'); primary.id = 'subtitlePrimary'; primary.type = 'button';
  const stop = document.createElement('button'); stop.id = 'subtitleStop'; stop.type = 'button'; stop.className = 'subtitle-stop'; stop.hidden = true;
  stop.textContent = t('subtitleDisable');
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = t('subtitleUsesService');
  const options = document.createElement('details'); options.id = 'subtitleOptions';
  const summary = document.createElement('summary'); summary.textContent = t('subtitleOptions'); options.append(summary);
  panel.append(status, source, language, primary, stop, hint, options);
  main.prepend(tabs, panel, pagePanel);
  activate(true);
  let snapshot: Snapshot | undefined;
  let preferencesKey = '';
  let busy = false;
  let refreshing = false;
  const render = () => {
    if (!snapshot) return;
    const { config, status: current } = snapshot;
    status.textContent = snapshot.disabled ? t('sitePolicyNever') : !snapshot.configured ? t('subtitleSetup') : t(subtitleStateKey(current.state));
    source.textContent = current.sourceLanguage
      ? `${languageLabel(current.sourceLanguage, config.uiLocale)}${current.kind ? ` · ${t(current.kind === 'asr' ? 'subtitleASR' : 'subtitleManual')}` : ''}` : '';
    source.hidden = !source.textContent;
    const error = ['source-error', 'translation-error', 'no-tracks', 'unsupported'].includes(current.state);
    primary.textContent = snapshot.disabled ? t('openSettings') : !snapshot.configured ? t('subtitleSetup')
      : error ? t('subtitleRetry') : current.enabled ? t('subtitleDisable') : t('subtitleEnable');
    primary.className = current.enabled && !error ? '' : 'primary';
    primary.disabled = busy || error && Date.now() < (current.retryAt ?? 0);
    stop.hidden = !current.enabled || !error; stop.disabled = busy;
    const key = JSON.stringify([config.preferences, config.youtubeAuto, config.uiLocale]);
    if (key !== preferencesKey) {
      preferencesKey = key;
      const form = subtitlePreferencesForm(config, {
        change: async preferences => {
          const result = await chrome.runtime.sendMessage({ action: 'subtitles:preferences', preferences });
          if (!result?.success) throw new Error('Preferences not saved');
          await refresh();
        },
        auto: async enabled => { const result = await setSubtitleAuto(enabled); await refresh(); return result; },
      });
      language.replaceChildren(form.firstElementChild!);
      language.className = 'subtitle-preferences';
      options.querySelector('.subtitle-preferences')?.remove(); options.append(form);
    }
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const reply = await chrome.runtime.sendMessage({ action: 'subtitles:describe', tabId });
      if (reply?.success) { snapshot = reply as Snapshot; render(); }
      else { status.textContent = t('subtitleStateUnsupported'); primary.disabled = true; }
    } finally { refreshing = false; }
  };
  const toggle = async (enabled: boolean) => {
    busy = true; render();
    try {
      const result = await chrome.runtime.sendMessage({ action: 'subtitles:setEnabled', tabId, enabled });
      if (!result?.success) status.textContent = t('subtitleStateSourceError');
    } finally { busy = false; await refresh(); }
  };
  primary.addEventListener('click', () => {
    if (!snapshot || busy) return;
    if (snapshot.disabled) { void chrome.runtime.openOptionsPage(); return; }
    if (!snapshot.configured) { openOnboardingPage(); return; }
    const retry = ['source-error', 'translation-error', 'no-tracks', 'unsupported'].includes(snapshot.status.state);
    void toggle(retry || !snapshot.status.enabled);
  });
  stop.addEventListener('click', () => { void toggle(false); });
  await refresh();
  const timer = setInterval(() => { if (!panel.hidden) void refresh(); }, 500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
