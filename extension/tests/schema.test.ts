import { describe, expect, it } from 'vitest';
import {
  buildRequestHeaders, normalizeCustomHeaders, normalizeTargetLang, parseSettings, resolveTargetLang,
  assertSecureApiBase, normalizeSiteHost, normalizeUiLocale, providerFingerprint, resolveUiLocale,
  SETTINGS_SCHEMA_VERSION,
  SettingsValidationError,
} from '../lib/settings/schema';

describe('resolveTargetLang', () => {
  it('maps zh variants to zh-CN', () => {
    expect(resolveTargetLang('zh')).toBe('zh-CN');
    expect(resolveTargetLang('zh-TW')).toBe('zh-CN');
    expect(resolveTargetLang('zh_CN')).toBe('zh-CN');
  });
  it('maps by primary subtag', () => {
    expect(resolveTargetLang('fr-FR')).toBe('fr');
    expect(resolveTargetLang('ru-RU')).toBe('ru');
  });
  it('falls back to en for unknown locales', () => {
    expect(resolveTargetLang('ja')).toBe('en');
    expect(resolveTargetLang('')).toBe('en');
  });
});

describe('normalizeTargetLang', () => {
  it('keeps supported codes as-is', () => {
    expect(normalizeTargetLang('es')).toBe('es');
  });
  it('normalizes unsupported input', () => {
    expect(normalizeTargetLang('de')).toBe('en');
    expect(normalizeTargetLang(42)).toBe('en');
  });
});

describe('UI locale migration', () => {
  it('supports every shipped locale and keeps legacy zh readable', () => {
    expect(normalizeUiLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeUiLocale('zh-TW')).toBe('zh-TW');
    expect(resolveUiLocale('zh-HK')).toBe('zh-TW');
    expect(resolveUiLocale('de-DE')).toBe('en');
    expect(parseSettings({ uiLocale: 'zh' }).uiLocale).toBe('zh-CN');
  });
});

describe('normalizeCustomHeaders', () => {
  it('drops empty names/values and stringifies', () => {
    expect(normalizeCustomHeaders({ 'X-A': 1, '': 'skip', 'X-B': '', 'X-C': 'ok' })).toEqual({
      'X-A': '1',
      'X-C': 'ok',
    });
  });
  it('rejects non-objects', () => {
    expect(normalizeCustomHeaders(['a'])).toEqual({});
    expect(normalizeCustomHeaders(null)).toEqual({});
  });
});

describe('parseSettings', () => {
  it('fills defaults and coerces numbers', () => {
    const s = parseSettings({ maxConcurrent: '5', batchSize: 0 });
    expect(s.maxConcurrent).toBe(5);
    expect(s.batchSize).toBe(6); // 0 fails min(1) → catch default
    expect(s.mode).toBe('bilingual');
    expect(Array.isArray(s.siteRules)).toBe(true);
    expect(s.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fr']).toContain(s.uiLocale);
  });
  it('migrates v1 blobs without requiring schemaVersion', () => {
    const s = parseSettings({
      apiBase: 'https://api.deepseek.com',
      targetLang: 'fr',
      mode: 'replace',
    });
    expect(s.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.targetLang).toBe('fr');
    expect(s.mode).toBe('replace');
    expect(typeof s.revision).toBe('number');
  });
  it('migrates legacy loopback endpoints to the proxy route', () => {
    expect(parseSettings({
      apiBase: 'http://127.0.0.1:8080/v1',
    }).connectionMode).toBe('proxy');
    expect(parseSettings({
      apiBase: 'https://api.deepseek.com',
    }).connectionMode).toBe('direct');
  });
  it('recovers from a totally invalid blob', () => {
    const s = parseSettings('garbage');
    expect(s.apiBase).toBe('https://api.deepseek.com');
  });
  it('rejects insecure remote http apiBase and falls back to defaults', () => {
    const s = parseSettings({ apiBase: 'http://evil.example/v1' });
    expect(s.apiBase).toBe('https://api.deepseek.com');
  });
});

describe('providerFingerprint', () => {
  it('changes when apiBase or headers change', async () => {
    const a = await providerFingerprint({
      apiBase: 'https://api.deepseek.com',
      model: 'm',
      customHeaders: {},
    });
    const b = await providerFingerprint({
      apiBase: 'https://api.openai.com/v1',
      model: 'm',
      customHeaders: {},
    });
    const c = await providerFingerprint({
      apiBase: 'https://api.deepseek.com',
      model: 'm',
      customHeaders: { 'X-A': '1' },
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('assertSecureApiBase', () => {
  it('allows https and loopback http', () => {
    expect(assertSecureApiBase('https://api.deepseek.com/')).toBe('https://api.deepseek.com');
    expect(assertSecureApiBase('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080/v1');
    expect(assertSecureApiBase('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
  });
  it('rejects remote http', () => {
    expect(() => assertSecureApiBase('http://example.com/v1')).toThrow(SettingsValidationError);
  });
});

describe('normalizeSiteHost', () => {
  it('accepts exact hostnames and normalizes a host-only URL', () => {
    expect(normalizeSiteHost('Example.COM')).toBe('example.com');
    expect(normalizeSiteHost('https://example.com/')).toBe('example.com');
  });

  it('rejects rules that cannot match an exact hostname', () => {
    expect(() => normalizeSiteHost('https://example.com/docs')).toThrow(SettingsValidationError);
    expect(() => normalizeSiteHost('*.example.com')).toThrow(SettingsValidationError);
    expect(() => normalizeSiteHost('example.com:8080')).toThrow(SettingsValidationError);
  });
});

describe('buildRequestHeaders', () => {
  it('adds Authorization only when a key is present', () => {
    expect(buildRequestHeaders({ apiKey: '', customHeaders: {} }).Authorization).toBeUndefined();
    expect(buildRequestHeaders({ apiKey: 'sk-x', customHeaders: {} }).Authorization).toBe('Bearer sk-x');
  });
  it('merges custom headers', () => {
    const h = buildRequestHeaders({ apiKey: '', customHeaders: { 'X-Trace': '1' } });
    expect(h['X-Trace']).toBe('1');
    expect(h['Content-Type']).toBe('application/json');
  });
});
