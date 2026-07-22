import type { Settings, SiteRule, TranslationMode } from '../types';
import {
  normalizeCustomHeaders,
  normalizeSiteHost,
  normalizeTargetLang,
  normalizeUiLocale,
  assertSecureApiBase,
} from './schema';

const IMPORTABLE_FIELDS = [
  'connectionMode',
  'apiBase',
  'apiKey',
  'model',
  'targetLang',
  'uiLocale',
  'mode',
  'maxConcurrent',
  'batchSize',
] as const;

export interface SettingsExportOptions {
  includeApiKey: boolean;
  includeCustomHeaders: boolean;
}

/** Produce a portable settings JSON without leaking private device credentials by default. */
export function buildSettingsExport(
  settings: Settings,
  options: SettingsExportOptions,
): Partial<Settings> {
  const output: Partial<Settings> = { ...settings };
  if (!options.includeApiKey) delete output.apiKey;
  if (!options.includeCustomHeaders) delete output.customHeaders;
  return output;
}

function normalizeImportedSiteRules(raw: unknown): SiteRule[] {
  if (!Array.isArray(raw)) throw new TypeError('siteRules must be an array');
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError('siteRules must contain objects');
    }
    const candidate = item as Record<string, unknown>;
    const host = normalizeSiteHost(candidate.host);
    if (seen.has(host)) throw new TypeError('siteRules contains duplicate hosts');
    seen.add(host);
    const rule: SiteRule = { host };
    if (candidate.disabled === true) rule.disabled = true;
    if (candidate.auto === true) rule.auto = true;
    if (candidate.mode === 'bilingual' || candidate.mode === 'replace') {
      rule.mode = candidate.mode as TranslationMode;
    }
    if (candidate.targetLang !== undefined) rule.targetLang = normalizeTargetLang(candidate.targetLang);
    return rule;
  });
}

/**
 * Imports only fields explicitly present in the file. Omitted credentials and
 * headers therefore stay on the current device instead of being cleared.
 */
export function prepareSettingsImport(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Settings import must be a JSON object');
  }
  const data = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of IMPORTABLE_FIELDS) {
    if (data[field] !== undefined) patch[field] = data[field];
  }
  if (patch.connectionMode !== undefined && patch.connectionMode !== 'direct' && patch.connectionMode !== 'proxy') {
    throw new TypeError('connectionMode must be direct or proxy');
  }
  if (patch.apiBase !== undefined) patch.apiBase = assertSecureApiBase(String(patch.apiBase));
  if (patch.targetLang !== undefined) patch.targetLang = normalizeTargetLang(patch.targetLang);
  if (patch.uiLocale !== undefined) patch.uiLocale = normalizeUiLocale(patch.uiLocale);
  if (patch.mode !== undefined && patch.mode !== 'bilingual' && patch.mode !== 'replace') {
    throw new TypeError('mode must be bilingual or replace');
  }
  for (const field of ['maxConcurrent', 'batchSize'] as const) {
    if (patch[field] !== undefined && (!Number.isInteger(Number(patch[field])) || Number(patch[field]) < 1)) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  if (data.customHeaders !== undefined) patch.customHeaders = normalizeCustomHeaders(data.customHeaders);
  if (data.siteRules !== undefined) patch.siteRules = normalizeImportedSiteRules(data.siteRules);
  return patch as Partial<Settings>;
}
