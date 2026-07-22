import { describe, expect, it } from 'vitest';
import type { Settings } from '../lib/types';
import { buildSettingsExport, prepareSettingsImport } from '../lib/settings/transfer';

function settings(): Settings {
  return {
    schemaVersion: 4,
    connectionMode: 'direct',
    apiBase: 'https://api.example.com/v1',
    apiKey: 'private-key',
    model: 'model-a',
    targetLang: 'zh-CN',
    uiLocale: 'en',
    mode: 'bilingual',
    maxConcurrent: 3,
    batchSize: 6,
    customHeaders: { 'X-Token': 'private-header' },
    siteRules: [{ host: 'example.com', auto: true }],
    revision: 2,
  };
}

describe('settings export', () => {
  it('excludes both private credential classes by default', () => {
    const output = buildSettingsExport(settings(), {
      includeApiKey: false,
      includeCustomHeaders: false,
    });
    expect(output.apiKey).toBeUndefined();
    expect(output.customHeaders).toBeUndefined();
    expect(output.siteRules).toEqual([{ host: 'example.com', auto: true }]);
  });

  it('includes each private class only when explicitly requested', () => {
    const output = buildSettingsExport(settings(), {
      includeApiKey: true,
      includeCustomHeaders: true,
    });
    expect(output.apiKey).toBe('private-key');
    expect(output.customHeaders).toEqual({ 'X-Token': 'private-header' });
  });
});

describe('settings import preview', () => {
  it('patches only fields that are explicitly in the file', () => {
    const patch = prepareSettingsImport({
      connectionMode: 'proxy',
      apiBase: 'https://api.example.com/v1',
      targetLang: 'fr',
    });
    expect(patch).toEqual({
      connectionMode: 'proxy',
      apiBase: 'https://api.example.com/v1',
      targetLang: 'fr',
    });
    expect('apiKey' in patch).toBe(false);
    expect('customHeaders' in patch).toBe(false);
  });

  it('normalizes host-only site rules and rejects non-matching rules', () => {
    const patch = prepareSettingsImport({
      siteRules: [{ host: 'https://Example.com/', auto: true }],
    });
    expect(patch.siteRules).toEqual([{ host: 'example.com', auto: true }]);
    expect(() => prepareSettingsImport({
      siteRules: [{ host: '*.example.com' }],
    })).toThrow();
  });
});
