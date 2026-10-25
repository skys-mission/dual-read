import { getUiMessage } from '../i18n';
import { SUPPORTED_TARGET_LANGS } from '../settings/schema';
import type { SubtitleConfig, SubtitlePreferences } from './types';
import { YOUTUBE_PERMISSION } from './types';

export function subtitleText(config: Pick<SubtitleConfig, 'uiLocale' | 'messages'>, key: string): string {
  return config.messages?.[key] ?? getUiMessage(key, null, config.uiLocale);
}
export function languageLabel(code: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

/** Must begin in an extension-page click handler, never from an auto-start. */
export async function setSubtitleAuto(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    await chrome.runtime.sendMessage({ action: 'subtitles:autoOff' });
    return false;
  }
  // The popup may close for the native permission prompt. Background consumes
  // this short-lived intent on permissions.onAdded, just like page auto rules.
  // Firefox requires request() in the original user-input stack. Start both
  // operations before awaiting storage, then consume consent after it persists.
  const pending = chrome.storage.local.set({ dualReadSubtitleAutoPending: Date.now() });
  const request = chrome.permissions.request({ origins: [YOUTUBE_PERMISSION] }).catch(() => false);
  await pending;
  const granted = await request;
  if (!granted) { await chrome.storage.local.remove('dualReadSubtitleAutoPending'); return false; }
  await chrome.runtime.sendMessage({ action: 'subtitles:autoGranted' });
  return true;
}

export interface SubtitlePreferencesForm extends HTMLDivElement {
  update(config: SubtitleConfig): void;
}

export function subtitlePreferencesForm(config: SubtitleConfig, callbacks: {
  change: (preferences: SubtitlePreferences) => Promise<void>;
  auto: (enabled: boolean) => Promise<boolean>;
  /** Content scripts open the existing settings page for permission consent. */
  autoInSettings?: () => void;
}): SubtitlePreferencesForm {
  const root = document.createElement('div');
  root.className = 'subtitle-preferences';
  const t = (key: string) => subtitleText(config, key);
  let preferences = { ...config.preferences };
  const updates: (() => void)[] = [];
  const select = (key: keyof SubtitlePreferences, labelKey: string, values: () => [string, string][]) => {
    const label = document.createElement('label');
    const caption = document.createTextNode('');
    const control = document.createElement('select');
    for (const [value, text] of values()) {
      const option = document.createElement('option');
      option.value = value; option.textContent = text; control.append(option);
    }
    updates.push(() => {
      caption.data = t(labelKey); control.setAttribute('aria-label', t(labelKey));
      values().forEach(([, text], index) => { control.options[index].textContent = text; });
      const value = String(preferences[key] ?? '');
      if (control.value !== value) control.value = value;
    });
    control.addEventListener('change', () => {
      const before = preferences;
      preferences = { ...preferences, [key]: control.value || null };
      void callbacks.change(preferences).catch(() => { preferences = before; control.value = String(before[key] ?? ''); });
    });
    label.append(caption, control); root.append(label);
  };
  select('targetLang', 'subtitleTarget', () => [['', t('subtitleFollowDefault')], ...SUPPORTED_TARGET_LANGS.map(code => [code, languageLabel(code, config.uiLocale)] as [string, string])]);
  select('textSize', 'subtitleSize', () => [['small', t('subtitleSizeSmall')], ['medium', t('subtitleSizeMedium')], ['large', t('subtitleSizeLarge')]]);
  select('position', 'subtitlePosition', () => [['bottom', t('subtitleBottom')], ['top', t('subtitleTop')]]);
  const auto = document.createElement('label');
  if (callbacks.autoInSettings) {
    const button = document.createElement('button');
    button.type = 'button';
    updates.push(() => { button.textContent = `${t('subtitleAuto')} · ${t(config.youtubeAuto ? 'subtitleOn' : 'subtitleOff')} ↗`; });
    button.addEventListener('click', callbacks.autoInSettings);
    auto.append(button);
  } else {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const caption = document.createTextNode('');
    updates.push(() => { checkbox.checked = config.youtubeAuto; caption.data = t('subtitleAuto'); });
    checkbox.addEventListener('change', () => {
      checkbox.disabled = true;
      void callbacks.auto(checkbox.checked).then(value => { checkbox.checked = value; }, () => { checkbox.checked = config.youtubeAuto; })
        .finally(() => { checkbox.disabled = false; });
    });
    auto.append(checkbox, caption);
  }
  root.append(auto);
  const update = (next: SubtitleConfig) => {
    config = next; preferences = { ...next.preferences };
    for (const apply of updates) apply();
  };
  update(config);
  return Object.assign(root, { update });
}
