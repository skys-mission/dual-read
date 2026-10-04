import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildPublicSessionConfig, settingsForBatch } from '../lib/settings/session-config';
import { createDefaultSettings } from '../lib/settings/schema';
import { translateTexts } from '../lib/provider';

afterEach(() => vi.unstubAllGlobals());

describe('batch configuration', () => {
  it('uses a site target in the provider prompt without exposing credentials or changing globals', async () => {
    const settings = { ...createDefaultSettings(), apiKey: 'test-secret', customHeaders: { 'X-Private': 'private' }, targetLang: 'zh-CN' as const, siteRules: [{ host: 'example.com', targetLang: 'fr' as const }] };
    const config = await buildPublicSessionConfig(settings, 'example.com');
    expect(config.targetLang).toBe('fr');
    expect(config).not.toHaveProperty('apiKey');
    expect(config).not.toHaveProperty('customHeaders');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"0":"Bonjour"}' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    await translateTexts(['Hello'], await settingsForBatch(settings, config));
    const request = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(request.messages[0].content).toContain('French');
    expect(settings.targetLang).toBe('zh-CN');
  });

  it('rejects a stale provider instead of storing a new-provider response under the old fingerprint', async () => {
    const settings = createDefaultSettings();
    const config = await buildPublicSessionConfig(settings, 'example.com');
    await expect(settingsForBatch({ ...settings, model: 'another-model' }, config)).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
  });

  it('keeps a session target stable when another tab changes the global language', async () => {
    const settings = createDefaultSettings();
    const config = await buildPublicSessionConfig(settings, 'example.com', { targetLang: 'es' });
    expect((await settingsForBatch({ ...settings, targetLang: 'ru' }, config)).targetLang).toBe('es');
  });
});
