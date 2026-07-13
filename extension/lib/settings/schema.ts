import { z } from 'zod';
import type {
  Settings, SiteRule, TargetLang, TranslationMode, UiLocale,
} from '../types';
import { PROMPT_VERSION } from '../provider/version';

export const SUPPORTED_TARGET_LANGS = ['zh-CN', 'en', 'ru', 'es', 'fr'] as const;
export const SUPPORTED_UI_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'fr'] as const;
export const SETTINGS_SCHEMA_VERSION = 4 as const;
export const MAX_CONCURRENT_BATCHES = 8;
export const MAX_BATCH_SIZE = 20;
export const DEFAULT_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_PROXY_API_BASE = 'http://127.0.0.1:8080/v1';

export type SettingsValidationCode =
  | 'API_BASE_REQUIRED'
  | 'API_BASE_INVALID'
  | 'API_BASE_INSECURE'
  | 'SITE_HOST_REQUIRED'
  | 'SITE_HOST_INVALID'
  | 'SITE_HOST_DUPLICATE';

export class SettingsValidationError extends Error {
  constructor(readonly code: SettingsValidationCode) {
    super(code);
    this.name = 'SettingsValidationError';
  }
}

export function validationCodeOf(error: unknown): SettingsValidationCode | null {
  return error instanceof SettingsValidationError ? error.code : null;
}

/** Full English names improve LLM translation quality (Prompt v2). */
export const TARGET_LANG_NAMES: Record<TargetLang, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
};

export function getSystemUiLanguage(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
  } catch {
    /* ignore */
  }
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return 'en';
}

/** Map a BCP 47 / UI locale to a supported target language; unmatched → en. */
export function resolveTargetLang(locale: string | undefined | null): TargetLang {
  const raw = String(locale || '').trim().replace(/_/g, '-');
  if (!raw) return 'en';
  const lower = raw.toLowerCase();

  for (const code of SUPPORTED_TARGET_LANGS) {
    if (code.toLowerCase() === lower) return code;
  }
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh-CN';

  const primary = lower.split('-')[0] ?? '';
  const byPrimary: Record<string, TargetLang> = { en: 'en', ru: 'ru', es: 'es', fr: 'fr' };
  return byPrimary[primary] ?? 'en';
}

export function resolveUiLocale(locale: string | undefined | null): UiLocale {
  const raw = String(locale || '').trim().replace(/_/g, '-').toLowerCase();
  if (raw === 'zh-tw' || raw.startsWith('zh-tw-') || raw === 'zh-hk' || raw.startsWith('zh-hk-') || raw === 'zh-mo' || raw.startsWith('zh-mo-')) {
    return 'zh-TW';
  }
  if (raw === 'zh' || raw.startsWith('zh-')) return 'zh-CN';
  const primary = raw.split('-')[0] ?? '';
  const byPrimary: Record<string, UiLocale> = {
    en: 'en',
    ru: 'ru',
    es: 'es',
    fr: 'fr',
  };
  return byPrimary[primary] ?? 'en';
}

export function normalizeTargetLang(value: unknown): TargetLang {
  if (typeof value === 'string' && (SUPPORTED_TARGET_LANGS as readonly string[]).includes(value)) {
    return value as TargetLang;
  }
  return resolveTargetLang(typeof value === 'string' ? value : '');
}

export function normalizeUiLocale(value: unknown): UiLocale {
  if (typeof value === 'string' && (SUPPORTED_UI_LOCALES as readonly string[]).includes(value)) {
    return value as UiLocale;
  }
  return resolveUiLocale(typeof value === 'string' ? value : getSystemUiLanguage());
}

export function normalizeCustomHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(key).trim();
    if (!name || value == null || value === '') continue;
    out[name] = String(value);
  }
  return out;
}

/**
 * A site rule applies to one exact hostname. URLs are accepted for convenience,
 * but paths, ports and wildcards are deliberately rejected rather than silently
 * creating a rule that can never match.
 */
export function normalizeSiteHost(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new SettingsValidationError('SITE_HOST_REQUIRED');
  if (value.includes('*')) throw new SettingsValidationError('SITE_HOST_INVALID');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new SettingsValidationError('SITE_HOST_INVALID');
  }
  if (
    !url.hostname
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname && url.pathname !== '/')
  ) {
    throw new SettingsValidationError('SITE_HOST_INVALID');
  }
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function normalizeSiteRules(raw: unknown): SiteRule[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SiteRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    let host: string;
    try {
      host = normalizeSiteHost(candidate.host);
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    const mode = candidate.mode === 'bilingual' || candidate.mode === 'replace'
      ? candidate.mode as TranslationMode
      : undefined;
    const targetLang = (SUPPORTED_TARGET_LANGS as readonly unknown[]).includes(candidate.targetLang)
      ? candidate.targetLang as TargetLang
      : undefined;
    out.push({
      host,
      ...(candidate.disabled === true ? { disabled: true } : {}),
      ...(candidate.auto === true ? { auto: true } : {}),
      ...(mode ? { mode } : {}),
      ...(targetLang ? { targetLang } : {}),
    });
    seen.add(host);
  }
  return out;
}

/** Remote endpoints must be HTTPS; HTTP is allowed only for loopback. */
export function assertSecureApiBase(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) throw new SettingsValidationError('API_BASE_REQUIRED');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsValidationError('API_BASE_INVALID');
  }
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const loopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1';
  if (protocol === 'https:') return value.replace(/\/$/, '');
  if (protocol === 'http:' && loopback) return value.replace(/\/$/, '');
  throw new SettingsValidationError('API_BASE_INSECURE');
}

const targetLangSchema = z.unknown().transform((v) => normalizeTargetLang(v));
const uiLocaleSchema = z.unknown().transform((v) => normalizeUiLocale(v));
const connectionModeSchema = z.enum(['direct', 'proxy']).catch('direct').default('direct');

export const settingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  connectionMode: connectionModeSchema,
  apiBase: z
    .string()
    .default(DEFAULT_API_BASE)
    .transform((v, ctx) => {
      if (!String(v).trim()) return DEFAULT_API_BASE;
      try {
        return assertSecureApiBase(v);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: err instanceof Error ? err.message : 'Invalid API base URL',
        });
        return z.NEVER;
      }
    }),
  apiKey: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
  targetLang: targetLangSchema,
  uiLocale: uiLocaleSchema,
  mode: z.enum(['bilingual', 'replace']).catch('bilingual').default('bilingual'),
  maxConcurrent: z.coerce.number().int().min(1).max(MAX_CONCURRENT_BATCHES).catch(3).default(3),
  batchSize: z.coerce.number().int().min(1).max(MAX_BATCH_SIZE).catch(6).default(6),
  customHeaders: z.unknown().transform(normalizeCustomHeaders).default({}),
  siteRules: z.unknown().transform(normalizeSiteRules).default([]),
  revision: z.coerce.number().int().min(0).catch(0).default(0),
});

export function createDefaultSettings(): Settings {
  const systemLang = getSystemUiLanguage();
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    connectionMode: 'direct',
    apiBase: DEFAULT_API_BASE,
    apiKey: '',
    model: DEFAULT_MODEL,
    targetLang: resolveTargetLang(systemLang),
    uiLocale: resolveUiLocale(systemLang),
    mode: 'bilingual',
    maxConcurrent: 3,
    batchSize: 6,
    customHeaders: {},
    siteRules: [],
    revision: 0,
  };
}

/** Migrate v1/v2 (or unknown) blobs into the current settings shape before parse. */
export function migrateSettingsRaw(raw: unknown): Record<string, unknown> {
  const base = createDefaultSettings();
  const incoming = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};

  const version = Number(incoming.schemaVersion ?? 1);
  if (incoming.connectionMode !== 'direct' && incoming.connectionMode !== 'proxy') {
    try {
      const legacyUrl = new URL(String(incoming.apiBase || ''));
      const legacyHost = legacyUrl.hostname.toLowerCase();
      incoming.connectionMode = (
        legacyHost === 'localhost'
        || legacyHost === '127.0.0.1'
        || legacyHost === '[::1]'
        || legacyHost === '::1'
      ) ? 'proxy' : 'direct';
    } catch {
      incoming.connectionMode = 'direct';
    }
  }
  if (!incoming.uiLocale) {
    // v1 coupled UI language to targetLang; seed uiLocale from browser, not target.
    incoming.uiLocale = resolveUiLocale(getSystemUiLanguage());
  } else if (incoming.uiLocale === 'zh') {
    // v2 used a generic Chinese locale. Preserve a Traditional-Chinese browser
    // preference when upgrading; otherwise retain the historical Simplified UI.
    incoming.uiLocale = resolveUiLocale(getSystemUiLanguage()) === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  }
  if (incoming.revision == null || Number.isNaN(Number(incoming.revision))) {
    incoming.revision = 0;
  }
  if (!String(incoming.apiBase ?? '').trim()) {
    incoming.apiBase = base.apiBase;
  }
  if (!String(incoming.model ?? '').trim()) {
    incoming.model = base.model;
  }
  incoming.schemaVersion = SETTINGS_SCHEMA_VERSION;

  // Preserve intentional v1 targetLang; only fill missing fields from defaults.
  return { ...base, ...incoming, schemaVersion: SETTINGS_SCHEMA_VERSION, _migratedFrom: version };
}

/** Parse an untrusted object (storage/import) into a valid Settings. */
export function parseSettings(raw: unknown): Settings {
  const migrated = migrateSettingsRaw(raw);
  delete migrated._migratedFrom;
  const result = settingsSchema.safeParse(migrated);
  if (result.success) return result.data as Settings;
  return createDefaultSettings();
}

export function buildRequestHeaders(settings: Pick<Settings, 'apiKey' | 'customHeaders'>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [name, value] of Object.entries(normalizeCustomHeaders(settings.customHeaders))) {
    headers[name] = value;
  }
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function stableHeadersFingerprint(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
    .join('\n');
}

async function sha256Hex(material: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Irreversible provider identity used by content-side caches.
 * Includes endpoint, model, prompt version, and normalized custom headers.
 */
export async function providerFingerprint(
  settings: Pick<Settings, 'apiBase' | 'model' | 'customHeaders'>,
): Promise<string> {
  const material = [
    'v1',
    assertSecureApiBase(settings.apiBase),
    settings.model || '',
    PROMPT_VERSION,
    stableHeadersFingerprint(normalizeCustomHeaders(settings.customHeaders)),
  ].join('\u0000');
  return sha256Hex(material);
}

/** Fields that invalidate translation results / cache namespaces when changed. */
export function providerAffectingChanged(
  before: Pick<Settings, 'apiBase' | 'model' | 'customHeaders' | 'targetLang' | 'mode'>,
  after: Pick<Settings, 'apiBase' | 'model' | 'customHeaders' | 'targetLang' | 'mode'>,
): boolean {
  if (before.apiBase !== after.apiBase) return true;
  if (before.model !== after.model) return true;
  if (before.targetLang !== after.targetLang) return true;
  if (before.mode !== after.mode) return true;
  return (
    stableHeadersFingerprint(normalizeCustomHeaders(before.customHeaders)) !==
    stableHeadersFingerprint(normalizeCustomHeaders(after.customHeaders))
  );
}
