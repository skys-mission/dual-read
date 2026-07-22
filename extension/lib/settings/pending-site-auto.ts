/**
 * A short-lived handoff from the popup's permission gesture to the background
 * worker. Permission prompts may close an action popup before its async
 * continuation runs, while permissions.onAdded still wakes the worker.
 */
export const PENDING_SITE_AUTO_PREFIX = 'dualReadPendingSiteAuto:';
// Must outlive a distracted user: the native permission dialog can sit open
// for minutes, and expiry meant "granted but nothing happens".
const MAX_PENDING_AGE_MS = 10 * 60_000;

export interface PendingSiteAuto {
  tabId: number;
  host: string;
  origin: string;
  createdAt: number;
}

function keyFor(tabId: number): string {
  return `${PENDING_SITE_AUTO_PREFIX}${tabId}`;
}

function pendingStore(): chrome.storage.StorageArea {
  // session is available in supported MV3 browsers. local is a bounded,
  // expiry-cleaned fallback for older implementations.
  return chrome.storage.session ?? chrome.storage.local;
}

export function stagePendingSiteAuto(intent: PendingSiteAuto): Promise<void> {
  return pendingStore().set({ [keyFor(intent.tabId)]: intent });
}

export async function clearPendingSiteAuto(tabId: number): Promise<void> {
  await pendingStore().remove(keyFor(tabId));
}

export async function readPendingSiteAutos(): Promise<PendingSiteAuto[]> {
  const store = pendingStore();
  const stored = await store.get(null) as Record<string, unknown>;
  const now = Date.now();
  const valid: PendingSiteAuto[] = [];
  const expired: string[] = [];

  for (const [key, raw] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_SITE_AUTO_PREFIX)) continue;
    const item = raw as Partial<PendingSiteAuto>;
    if (
      typeof item.tabId !== 'number'
      || typeof item.host !== 'string'
      || typeof item.origin !== 'string'
      || typeof item.createdAt !== 'number'
      || now - item.createdAt > MAX_PENDING_AGE_MS
    ) {
      expired.push(key);
      continue;
    }
    valid.push(item as PendingSiteAuto);
  }

  if (expired.length) await store.remove(expired);
  return valid;
}
