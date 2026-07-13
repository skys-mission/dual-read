import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSettings, saveSettings } from '../lib/settings/storage';

function mockChromeStorage(initial?: {
  sync?: Record<string, unknown>;
  local?: Record<string, unknown>;
}) {
  const sync = new Map<string, unknown>(Object.entries(initial?.sync ?? {}));
  const local = new Map<string, unknown>(Object.entries(initial?.local ?? {}));
  let releaseLanguageWrite: (() => void) | undefined;
  const languageWriteStarted = new Promise<void>((resolve) => {
    releaseLanguageWrite = resolve;
  });
  let signalLanguageWrite: (() => void) | undefined;
  const waitForLanguageWrite = new Promise<void>((resolve) => {
    signalLanguageWrite = resolve;
  });

  const read = (store: Map<string, unknown>, keys?: string | string[] | Record<string, unknown>) => {
    if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
    }
    return { ...(keys ?? {}), ...Object.fromEntries(store) };
  };
  vi.stubGlobal('chrome', {
    storage: {
      sync: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => read(sync, keys)),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          if (patch.targetLang === 'fr') {
            signalLanguageWrite?.();
            await languageWriteStarted;
          }
          for (const [key, value] of Object.entries(patch)) sync.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) sync.delete(key);
        }),
      },
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => read(local, keys)),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(patch)) local.set(key, value);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key);
        }),
      },
    },
  });

  return {
    releaseLanguageWrite: () => releaseLanguageWrite?.(),
    waitForLanguageWrite,
    sync,
    local,
  };
}

describe('settings storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves a site rule when an unrelated save completes later', async () => {
    const storage = mockChromeStorage();

    const languageSave = saveSettings({ targetLang: 'fr' });
    await storage.waitForLanguageWrite;
    await saveSettings({ siteRules: [{ host: 'example.com', auto: true }] });
    storage.releaseLanguageWrite();
    await languageSave;

    const settings = await getSettings();
    expect(settings.targetLang).toBe('fr');
    expect(settings.siteRules).toEqual([{ host: 'example.com', auto: true }]);
  });

  it('migrates legacy synced custom headers to local storage once', async () => {
    const storage = mockChromeStorage({
      sync: { customHeaders: { 'X-Token': 'secret' } },
    });

    const settings = await getSettings();

    expect(settings.customHeaders).toEqual({ 'X-Token': 'secret' });
    expect(storage.local.get('customHeaders')).toEqual({ 'X-Token': 'secret' });
    expect(storage.sync.has('customHeaders')).toBe(false);
  });

  it('keeps local custom headers authoritative and never syncs a new value', async () => {
    const storage = mockChromeStorage({
      sync: { customHeaders: { 'X-Old': 'legacy' } },
      local: { customHeaders: { 'X-Local': 'device-only' } },
    });

    await saveSettings({ customHeaders: { 'X-New': 'private' } });
    const settings = await getSettings();

    expect(settings.customHeaders).toEqual({ 'X-New': 'private' });
    expect(storage.local.get('customHeaders')).toEqual({ 'X-New': 'private' });
    expect(storage.sync.has('customHeaders')).toBe(false);
  });
});
