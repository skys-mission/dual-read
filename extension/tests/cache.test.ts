import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCache, clearMemoryCache, isIncognitoContext, lookup, store, _cacheTest } from '../lib/cache';

function mockChrome(incognito: boolean) {
  const storeMap = new Map<string, unknown>();
  const chromeMock = {
    extension: { inIncognitoContext: incognito },
    storage: {
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
          for (const [k, v] of Object.entries(payload)) storeMap.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) storeMap.delete(k);
        }),
      },
    },
  };
  vi.stubGlobal('chrome', chromeMock);
  return { storeMap, chromeMock };
}

describe('cache v2', () => {
  beforeEach(() => {
    clearMemoryCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('clearCache removes v2 and legacy namespaces', async () => {
    const { storeMap } = mockChrome(false);
    storeMap.set('dr:c:old', { t: 'x', at: 1 });
    storeMap.set('dr:c2:old', { t: 'y', at: 1 });
    storeMap.set(`${_cacheTest.NS}abc`, { t: 'z', at: Date.now(), b: 1 });
    storeMap.set('settings', { keep: true });

    await clearCache();
    expect(storeMap.has('dr:c:old')).toBe(false);
    expect(storeMap.has('dr:c2:old')).toBe(false);
    expect(storeMap.has(`${_cacheTest.NS}abc`)).toBe(false);
    expect(storeMap.has('settings')).toBe(true);
  });
});
