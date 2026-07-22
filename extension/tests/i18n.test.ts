import { describe, expect, it } from 'vitest';
import { catalogLocale } from '../lib/i18n';
import { normalizeUiLocale, resolveTargetLang, resolveUiLocale } from '../lib/settings/schema';

describe('UI / target language decoupling', () => {
  it('uiLocale catalogs normalize browser language families to supported catalogs', () => {
    expect(catalogLocale('en')).toBe('en');
    expect(catalogLocale('en-US')).toBe('en');
    expect(catalogLocale('zh')).toBe('zh-CN');
    expect(catalogLocale('zh-CN')).toBe('zh-CN');
    expect(catalogLocale('zh-TW')).toBe('zh-TW');
    expect(catalogLocale('zh-HK')).toBe('zh-TW');
    expect(catalogLocale('fr')).toBe('fr');
    expect(catalogLocale('ru-RU')).toBe('ru');
  });

  it('targetLang resolution does not drive uiLocale defaults', () => {
    expect(resolveTargetLang('zh-CN')).toBe('zh-CN');
    expect(resolveTargetLang('fr')).toBe('fr');
    // French target must not imply Chinese UI.
    expect(normalizeUiLocale('fr')).toBe('fr');
    expect(resolveUiLocale('fr')).toBe('fr');
  });

  it('schema normalizeUiLocale supports every shipped UI language', () => {
    expect(normalizeUiLocale('es')).toBe('es');
    expect(normalizeUiLocale('en-US')).toBe('en');
  });
});
