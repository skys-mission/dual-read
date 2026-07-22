import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_SITE_AUTO_PREFIX,
  clearPendingSiteAuto,
  readPendingSiteAutos,
  stagePendingSiteAuto,
} from '../lib/settings/pending-site-auto';

function mockSessionStorage(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
  });
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async () => Object.fromEntries(store)),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(patch)) store.set(key, value);
        }),
        remove,
      },
    },
  });
  return { store, remove };
}

describe('pending site-auto handoff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps a tab-specific intent until the background consumes it', async () => {
    const { store } = mockSessionStorage();
    await stagePendingSiteAuto({
      tabId: 42,
      host: 'example.com',
      origin: 'https://example.com/*',
      createdAt: Date.now(),
    });

    expect(await readPendingSiteAutos()).toEqual([{
      tabId: 42,
      host: 'example.com',
      origin: 'https://example.com/*',
      createdAt: expect.any(Number),
    }]);

    await clearPendingSiteAuto(42);
    expect(store.has(`${PENDING_SITE_AUTO_PREFIX}42`)).toBe(false);
  });

  it('removes stale intents before a future permission grant', async () => {
    const staleKey = `${PENDING_SITE_AUTO_PREFIX}99`;
    const { remove } = mockSessionStorage({
      [staleKey]: {
        tabId: 99,
        host: 'example.com',
        origin: 'https://example.com/*',
        // TTL is 10min — a slow user at the permission dialog must not expire.
        createdAt: Date.now() - 10 * 60_000 - 1,
      },
    });

    expect(await readPendingSiteAutos()).toEqual([]);
    expect(remove).toHaveBeenCalledWith([staleKey]);
  });

  it('keeps intents fresh enough for a slow permission dialog', async () => {
    const key = `${PENDING_SITE_AUTO_PREFIX}100`;
    mockSessionStorage({
      [key]: {
        tabId: 100,
        host: 'example.com',
        origin: 'https://example.com/*',
        createdAt: Date.now() - 5 * 60_000,
      },
    });

    expect(await readPendingSiteAutos()).toHaveLength(1);
  });
});
