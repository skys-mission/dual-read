import type { Settings, SiteRule, TranslationMode, TargetLang } from '../types';
import {
  createDefaultSettings,
  normalizeCustomHeaders,
  normalizeTargetLang,
  parseSettings,
  providerAffectingChanged,
  SETTINGS_SCHEMA_VERSION,
} from './schema';

// Secrets never belong in chrome.storage.sync (it replicates to the signed-in
// account across devices). They live in chrome.storage.local instead.
export const SECRET_KEYS = ['apiKey'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];
/** Credentials often live in custom headers; never replicate them through sync. */
export const DEVICE_LOCAL_KEYS = ['customHeaders'] as const;
type DeviceLocalKey = (typeof DEVICE_LOCAL_KEYS)[number];

const META_LOCAL_KEY = 'dualReadSettingsMeta';

interface SettingsMeta {
  revision: number;
}

function isSecret(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

function isDeviceLocal(key: string): key is DeviceLocalKey {
  return (DEVICE_LOCAL_KEYS as readonly string[]).includes(key);
}

function splitPersistence(settings: Partial<Settings>): {
  secrets: Partial<Pick<Settings, SecretKey>>;
  deviceLocal: Partial<Pick<Settings, DeviceLocalKey>>;
  syncable: Record<string, unknown>;
} {
  const secrets: Partial<Pick<Settings, SecretKey>> = {};
  const deviceLocal: Partial<Pick<Settings, DeviceLocalKey>> = {};
  const syncable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isSecret(key)) (secrets as Record<string, unknown>)[key] = value;
    else if (isDeviceLocal(key)) (deviceLocal as Record<string, unknown>)[key] = value;
    else syncable[key] = value;
  }
  return { secrets, deviceLocal, syncable };
}

async function readMeta(): Promise<SettingsMeta> {
  try {
    const stored = await chrome.storage.local.get({ [META_LOCAL_KEY]: { revision: 0 } });
    const meta = stored[META_LOCAL_KEY] as SettingsMeta;
    return { revision: Number(meta?.revision) || 0 };
  } catch {
    return { revision: 0 };
  }
}

async function writeMeta(meta: SettingsMeta): Promise<void> {
  await chrome.storage.local.set({ [META_LOCAL_KEY]: meta });
}

export async function getSettings(): Promise<Settings> {
  const defaults = createDefaultSettings();
  const syncDefaults: Record<string, unknown> = { ...defaults };
  for (const key of [...SECRET_KEYS, ...DEVICE_LOCAL_KEYS]) delete syncDefaults[key];
  // revision / schemaVersion live across sync+local meta; don't require sync defaults.
  delete syncDefaults.revision;

  // Also request apiKey from sync purely to detect and migrate legacy data.
  const [syncStored, legacyHeadersStored, localStored] = await Promise.all([
    chrome.storage.sync.get({ ...syncDefaults, apiKey: '' }),
    chrome.storage.sync.get('customHeaders'),
    chrome.storage.local.get(['apiKey', 'customHeaders']),
  ]);
  const meta = await readMeta();

  let apiKey: string = (localStored.apiKey as string) || '';
  const legacyKey = (syncStored.apiKey as string) || '';
  if (!apiKey && legacyKey) {
    apiKey = legacyKey;
    await chrome.storage.local.set({ apiKey });
  }
  if (!apiKey && chrome.storage.session) {
    try {
      const sessionStored = await chrome.storage.session.get({ apiKey: '' });
      apiKey = (sessionStored.apiKey as string) || '';
    } catch {
      /* session storage unavailable */
    }
  }
  if (legacyKey) await chrome.storage.sync.remove('apiKey');

  const hasLocalHeaders = Object.prototype.hasOwnProperty.call(localStored, 'customHeaders');
  const localHeaders = normalizeCustomHeaders(localStored.customHeaders);
  const legacyHeaders = normalizeCustomHeaders(legacyHeadersStored.customHeaders);
  const customHeaders = hasLocalHeaders ? localHeaders : legacyHeaders;
  if (!hasLocalHeaders && Object.keys(legacyHeaders).length) {
    await chrome.storage.local.set({ customHeaders });
  }
  if (Object.prototype.hasOwnProperty.call(legacyHeadersStored, 'customHeaders')) {
    await chrome.storage.sync.remove('customHeaders');
  }

  const merged = {
    ...syncStored,
    apiKey,
    customHeaders,
    revision: meta.revision || Number(syncStored.revision) || 0,
  };
  const settings = parseSettings(merged);

  // Persist schema migration once (idempotent). Avoid rewriting targetLang on every read.
  const needsSchemaWrite = syncStored.schemaVersion !== settings.schemaVersion
    || syncStored.uiLocale == null;
  if (needsSchemaWrite) {
    const { syncable } = splitPersistence(settings);
    await chrome.storage.sync.set(syncable);
  }
  if (meta.revision !== settings.revision) {
    await writeMeta({ revision: settings.revision });
  }

  return settings;
}

/** Whether the current API key is persisted beyond the active browser session. */
export async function isApiKeyPersisted(): Promise<boolean> {
  const stored = await chrome.storage.local.get({ apiKey: '' });
  return Boolean(String(stored.apiKey || '').trim());
}

export async function saveSettings(
  patch: Partial<Settings>,
  opts?: { persistApiKey?: boolean },
): Promise<Settings> {
  const current = await getSettings();
  const merged = parseSettings({ ...current, ...patch, schemaVersion: SETTINGS_SCHEMA_VERSION });
  const bump = Object.keys(patch).some((k) => {
    if (k === 'revision' || k === 'schemaVersion') return false;
    return true;
  }) && (
    providerAffectingChanged(current, merged)
    || current.connectionMode !== merged.connectionMode
    || current.maxConcurrent !== merged.maxConcurrent
    || current.batchSize !== merged.batchSize
    || current.uiLocale !== merged.uiLocale
    || JSON.stringify(current.siteRules) !== JSON.stringify(merged.siteRules)
  );

  const next: Settings = {
    ...merged,
    revision: bump ? current.revision + 1 : current.revision,
  };

  const { secrets, deviceLocal } = splitPersistence(next);
  // Write only fields the caller changed. Extension pages and the background
  // run in separate contexts, so a full settings snapshot can overwrite a
  // newer, unrelated change (for example, a site auto-translation rule).
  const syncPatch: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (!isSecret(key) && !isDeviceLocal(key) && key !== 'revision') {
      syncPatch[key] = next[key as keyof Settings];
    }
  }
  // All writes keep persisted settings on the current schema. The revision is
  // deliberately local: its source of truth is the local metadata record.
  syncPatch.schemaVersion = next.schemaVersion;

  const ops: Promise<void>[] = [
    chrome.storage.sync.set(syncPatch),
    writeMeta({ revision: next.revision }),
  ];
  if ('apiKey' in patch) {
    const key = secrets.apiKey ?? '';
    const persist = opts?.persistApiKey !== false;
    if (persist) {
      ops.push(chrome.storage.local.set({ apiKey: key }));
      if (chrome.storage.session) {
        ops.push(chrome.storage.session.remove('apiKey').then(() => undefined));
      }
    } else if (chrome.storage.session) {
      ops.push(chrome.storage.session.set({ apiKey: key }));
      ops.push(chrome.storage.local.set({ apiKey: '' }));
    } else {
      // Fallback when session storage is missing: still persist so the key is usable.
      ops.push(chrome.storage.local.set({ apiKey: key }));
    }
  }
  if ('customHeaders' in patch) {
    ops.push(chrome.storage.local.set({
      customHeaders: normalizeCustomHeaders(deviceLocal.customHeaders),
    }));
    // Defensive cleanup prevents a concurrently running old extension page
    // from leaving credentials in sync after this version has saved.
    ops.push(chrome.storage.sync.remove('customHeaders'));
  }
  await Promise.all(ops);
  return next;
}

export function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function findSiteRule(settings: Settings, host: string): SiteRule | undefined {
  if (!host) return undefined;
  return settings.siteRules.find((r) => r.host === host);
}

/** Effective per-site settings, folding a matching site rule over globals. */
export function effectiveForHost(
  settings: Settings,
  host: string,
): { disabled: boolean; auto: boolean; mode: TranslationMode; targetLang: TargetLang } {
  const rule = findSiteRule(settings, host);
  return {
    disabled: rule?.disabled ?? false,
    auto: rule?.auto ?? false,
    mode: rule?.mode ?? settings.mode,
    targetLang: normalizeTargetLang(rule?.targetLang ?? settings.targetLang),
  };
}

export async function upsertSiteRule(host: string, patch: Partial<SiteRule>): Promise<Settings> {
  if (!host) return getSettings();
  const settings = await getSettings();
  const rules = settings.siteRules.slice();
  const idx = rules.findIndex((r) => r.host === host);
  if (idx >= 0) {
    rules[idx] = { ...rules[idx], ...patch, host };
  } else {
    rules.push({ host, ...patch });
  }
  const pruned = rules.filter(
    (r) => r.disabled || r.auto || r.mode != null || r.targetLang != null,
  );
  return saveSettings({ siteRules: pruned });
}
