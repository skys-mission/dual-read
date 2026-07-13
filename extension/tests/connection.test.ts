import { afterEach, describe, expect, it, vi } from 'vitest';
import { isConnectionConfigured, testConnection } from '../lib/provider/connection';

describe('isConnectionConfigured', () => {
  it('requires an API key', () => {
    expect(isConnectionConfigured({
      connectionMode: 'direct', apiBase: 'https://api.deepseek.com', apiKey: '',
    })).toBe(false);
    expect(isConnectionConfigured({
      connectionMode: 'direct', apiBase: 'https://api.deepseek.com', apiKey: 'sk-x',
    })).toBe(true);
  });

  it('allows a proxy to manage the upstream API key', () => {
    expect(isConnectionConfigured({
      connectionMode: 'proxy', apiBase: 'https://proxy.example.com/v1', apiKey: '',
    })).toBe(true);
  });
});

describe('testConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires API credentials before testing', async () => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const result = await testConnection({
      connectionMode: 'direct',
      apiBase: 'https://api.deepseek.com',
      apiKey: '',
      model: 'x',
      customHeaders: {},
      targetLang: 'en',
    });
    expect(result.code).toBe('CONFIG_REQUIRED');
  });

  it('returns OK on a healthy chat completion', async () => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"0":"pong"}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const result = await testConnection({
      connectionMode: 'direct',
      apiBase: 'https://api.deepseek.com',
      apiKey: 'test-key',
      model: 'x',
      customHeaders: {},
      targetLang: 'en',
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe('OK');
  });

  it('disables thinking for DeepSeek models on the connection probe', async () => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"0":"pong"}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await testConnection({
      connectionMode: 'direct',
      apiBase: 'https://api.deepseek.com',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      customHeaders: {},
      targetLang: 'zh-CN',
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { thinking?: { type: string } };
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('does not force thinking off for non-DeepSeek probe models', async () => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await testConnection({
      connectionMode: 'direct',
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      customHeaders: {},
      targetLang: 'zh-CN',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  });

  it('maps 401 to AUTH_INVALID', async () => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    const result = await testConnection({
      connectionMode: 'direct',
      apiBase: 'https://api.deepseek.com',
      apiKey: 'bad',
      model: 'x',
      customHeaders: {},
      targetLang: 'en',
    });
    expect(result.code).toBe('AUTH_INVALID');
  });
});
