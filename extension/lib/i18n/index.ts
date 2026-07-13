// UI localization decoupled from chrome.i18n and from targetLang.
// Popup / options / overlay / content errors share one catalog keyed by uiLocale.

import { normalizeUiLocale } from '../settings/schema';
import type { UiLocale } from '../types';

const UI_LOCALE_DIRECTORIES: Record<UiLocale, string> = {
  en: 'en',
  'zh-CN': 'zh_CN',
  'zh-TW': 'zh_TW',
  ru: 'ru',
  es: 'es',
  fr: 'fr',
};
const MESSAGE_LOCALES = Object.keys(UI_LOCALE_DIRECTORIES) as UiLocale[];

const catalogs: Partial<Record<UiLocale, Record<string, string>>> = {};
let catalogsReady: Promise<void> | null = null;

/** Resolve any BCP-47-ish string to a supported UI catalog locale. */
export function catalogLocale(uiLocale: string | undefined | null): UiLocale {
  return normalizeUiLocale(uiLocale);
}

export async function ensureCatalogs(): Promise<void> {
  if (MESSAGE_LOCALES.every((locale) => catalogs[locale])) return;
  if (!catalogsReady) {
    catalogsReady = Promise.all(
      MESSAGE_LOCALES.map(async (locale) => {
        const url = chrome.runtime.getURL(`_locales/${UI_LOCALE_DIRECTORIES[locale]}/messages.json`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`failed to load ${locale} messages`);
        const raw = (await response.json()) as Record<string, { message?: string }>;
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) flat[key] = value?.message ?? '';
        catalogs[locale] = flat;
      }),
    ).then(() => undefined);
  }
  await catalogsReady;
}

function formatMessage(template: string, subs?: (string | number)[] | null): string {
  if (!subs?.length) return template;
  return subs.reduce<string>(
    (msg, sub, index) => msg.replace(new RegExp(`\\$${index + 1}`, 'g'), String(sub)),
    template,
  );
}

export function getUiMessage(
  key: string,
  subs: (string | number)[] | null | undefined,
  uiLocale: string,
): string {
  const locale = catalogLocale(uiLocale);
  const catalog = catalogs[locale] ?? catalogs.en;
  const template = catalog?.[key] ?? catalogs.en?.[key];
  if (template) return formatMessage(template, subs);
  // Content-script failure paths must remain synchronous and must not delay
  // translation. Manifest catalogs provide a localized fallback while a
  // runtime catalog is not yet loaded in that execution context.
  try {
    return chrome.i18n?.getMessage(key, subs?.map(String)) || '';
  } catch {
    return '';
  }
}

/** Resolve a message variant using the plural category for the active UI locale. */
export function getUiPluralMessage(
  key: string,
  count: number,
  subs: (string | number)[] | null | undefined,
  uiLocale: string,
): string {
  const locale = catalogLocale(uiLocale);
  const category = new Intl.PluralRules(locale).select(count);
  return getUiMessage(`${key}_${category}`, subs, locale)
    || getUiMessage(`${key}_other`, subs, locale)
    || getUiMessage(key, subs, locale);
}

export function formatUiNumber(value: number, uiLocale: string): string {
  return new Intl.NumberFormat(catalogLocale(uiLocale)).format(value);
}

export async function localizePage(uiLocale: string): Promise<void> {
  await ensureCatalogs();
  const locale = catalogLocale(uiLocale);
  document.documentElement.lang = locale;

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (!key) continue;
    const message = getUiMessage(key, null, locale);
    if (message) el.textContent = message;
  }

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label');
    if (!key) continue;
    const message = getUiMessage(key, null, locale);
    if (message) el.setAttribute('aria-label', message);
  }

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (!key) continue;
    const message = getUiMessage(key, null, locale);
    if (message) el.setAttribute('title', message);
  }

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (!key) continue;
    const message = getUiMessage(key, null, locale);
    if (message && ('placeholder' in el)) {
      (el as HTMLInputElement | HTMLTextAreaElement).placeholder = message;
    }
  }

  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    const key = el.getAttribute('data-i18n-label');
    if (!key) continue;
    const message = getUiMessage(key, null, locale);
    if (message && ('label' in el)) {
      (el as HTMLOptGroupElement).label = message;
    }
  }

  const titleEl = document.querySelector<HTMLElement>('title[data-i18n]');
  if (titleEl?.textContent) document.title = titleEl.textContent;
}

/** @deprecated Use catalogLocale — kept briefly for any external callers. */
export const resolveUiLocale = catalogLocale;
