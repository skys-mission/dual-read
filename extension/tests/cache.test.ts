import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, clearMemoryCache, isIncognitoContext, lookup, store, _cacheTest } from '../lib/cache';

function mockChrome(incognito: boolean) {
  const storeMap = new Map<string, unknown>();
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  const notify = (changes: Record<string, chrome.storage.StorageChange>) => listeners.forEach((listener) => listener(changes, 'local'));
  const chromeMock = {
    extension: { inIncognitoContext: incognito },
    storage: {
      onChanged: { addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.add(listener), removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.delete(listener) },
      local: {
        get: vi.fn(async (keys: string[] | null) => {
          if (keys == null) {
            return Object.fromEntries(storeMap.entries());
          }
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (storeMap.has(k)) out[k] = storeMap.get(k);
          }
          return out;
        }),
        set: vi.fn(async (payload: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [k, v] of Object.entries(payload)) {
            changes[k] = { oldValue: storeMap.get(k), newValue: v };
            storeMap.set(k, v);
          }
          notify(changes);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            changes[k] = { oldValue: storeMap.get(k) };
            storeMap.delete(k);
          }
          notify(changes);
        }),
      },
    },
  };
  vi.stubGlobal('chrome', chromeMock);
  return { storeMap, chromeMock, notify };
}

describe('cache v4', () => {
  beforeEach(() => {
    clearMemoryCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hits L1 after store in normal mode and persists to storage', async () => {
    const { storeMap, chromeMock } = mockChrome(false);
    const settings = { targetLang: 'zh-CN' as const, providerFingerprint: 'fp-1' };

    await store([{ text: 'Hello world', translation: '你好世界' }], settings);
    expect(chromeMock.storage.local.set).toHaveBeenCalled();
    expect([...storeMap.keys()].some((k) => k.startsWith(_cacheTest.NS))).toBe(true);

    clearMemoryCache();
    const hits = await lookup(['Hello world'], settings);
    expect(hits[0]).toBe('你好世界');
  });

  it('never persists in incognito (L1 only)', async () => {
    const { chromeMock } = mockChrome(true);
    expect(isIncognitoContext()).toBe(true);
    const settings = { targetLang: 'zh-CN' as const, providerFingerprint: 'fp-1' };

    await store([{ text: 'Secret', translation: '秘密' }], settings);
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();

    expect(await lookup(['Secret'], settings)).toEqual(['秘密']);
    clearMemoryCache();
    expect(await lookup(['Secret'], settings)).toEqual([null]);
  });

  it('expires memory entries even in incognito', async () => {
    vi.useFakeTimers();
    mockChrome(true);
    const settings = { targetLang: 'zh-CN' as const, providerFingerprint: 'fp-1' };
    await store([{ text: 'Hello', translation: '你好' }], settings);
    vi.setSystemTime(Date.now() + _cacheTest.TTL_MS + 1);
    expect(await lookup(['Hello'], settings)).toEqual([null]);
  });

  it('clearCache removes current and legacy namespaces', async () => {
    const { storeMap } = mockChrome(false);
    storeMap.set('dr:c:old', { t: 'x', at: 1 });
    storeMap.set('dr:c2:old', { t: 'y', at: 1 });
    storeMap.set('dr:c3:old', { t: 'wrong-language', at: Date.now() });
    storeMap.set(`${_cacheTest.NS}abc`, { t: 'z', at: Date.now(), b: 1 });
    storeMap.set('settings', { keep: true });

    await clearCache();
    expect(storeMap.has('dr:c:old')).toBe(false);
    expect(storeMap.has('dr:c2:old')).toBe(false);
    expect(storeMap.has('dr:c3:old')).toBe(false);
    expect(storeMap.has(`${_cacheTest.NS}abc`)).toBe(false);
    expect(storeMap.has('settings')).toBe(true);
  });

  it('propagates a clear from another context even when this context only has memory entries', async () => {
    const { chromeMock, notify } = mockChrome(true);
    const settings = { targetLang: 'zh-CN' as const, providerFingerprint: 'fp-1' };
    await store([{ text: 'Secret', translation: '秘密' }], settings);
    notify({ [_cacheTest.CLEAR_KEY]: { newValue: 'clear-from-options' } });
    expect(await lookup(['Secret'], settings)).toEqual([null]);
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });

  it('does not return a stale disk lookup that finishes after a clear', async () => {
    const { chromeMock, notify } = mockChrome(false);
    let complete!: (value: Record<string, unknown>) => void;
    chromeMock.storage.local.get.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const read = lookup(['Hello'], { targetLang: 'zh-CN', providerFingerprint: 'fp-1' });
    await vi.waitFor(() => expect(chromeMock.storage.local.get).toHaveBeenCalled());
    const key = chromeMock.storage.local.get.mock.calls[0]![0] as string[];
    notify({ [_cacheTest.CLEAR_KEY]: { newValue: 'cleared' } });
    complete({ [key[0]]: { t: 'stale', at: Date.now(), b: 5 } });
    expect(await read).toEqual([null]);
  });

  it('bounds memory by bytes and retains recent entries', async () => {
    mockChrome(true);
    const settings = { targetLang: 'zh-CN' as const, providerFingerprint: 'fp-1' };
    const large = 'x'.repeat(_cacheTest.MAX_BYTES / 2);
    await store([{ text: 'old', translation: large }, { text: 'middle', translation: large }], settings);
    // Reading an entry makes it recent without extending its TTL.
    expect((await lookup(['old'], settings))[0]?.length).toBe(large.length);
    await store([{ text: 'new', translation: '最新' }], settings);
    expect(await lookup(['middle', 'new'], settings)).toEqual([null, '最新']);
    expect((await lookup(['old'], settings))[0]?.length).toBe(large.length);
  });
});
