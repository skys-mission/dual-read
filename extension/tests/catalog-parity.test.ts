import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const localeDirectories = ['en', 'zh_CN', 'zh_TW', 'ru', 'es', 'fr'] as const;
const manifestKeys = ['extName', 'extDescription', 'cmdToggleTranslate', 'cmdToggleMode'];
const catalogPath = (locale: string) =>
  new URL(`../public/_locales/${locale}/messages.json`, import.meta.url);
const placeholders = (message: string) => (message.match(/\$\d+/g) ?? []).sort();

describe('shipped locale catalogs', () => {
  it('have matching keys, substitutions, and manifest strings', () => {
    const catalogs = Object.fromEntries(localeDirectories.map((locale) => [
      locale,
      JSON.parse(fs.readFileSync(catalogPath(locale), 'utf8')) as Record<string, { message: string }>,
    ])) as Record<(typeof localeDirectories)[number], Record<string, { message: string }>>;
    const english = catalogs.en;
    const englishKeys = Object.keys(english).sort();

    for (const locale of localeDirectories) {
      const catalog = catalogs[locale];
      expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
      for (const key of manifestKeys) expect(catalog[key]?.message.trim(), `${locale}:${key}`).not.toBe('');
      for (const key of englishKeys) {
        expect(placeholders(catalog[key]!.message), `${locale}:${key}`).toEqual(
          placeholders(english[key]!.message),
        );
      }
    }
  });
});
