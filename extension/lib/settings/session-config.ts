import type { PublicSessionConfig, Settings, SiteRule, TranslationMode, TargetLang } from '../types';
import { providerFingerprint, SUPPORTED_TARGET_LANGS } from './schema';
import { DualReadError } from '../errors';
import { normalizeTargetLang } from './schema';
import { effectiveForHost } from './storage';

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the public config that content scripts are allowed to receive. */
export async function buildPublicSessionConfig(
  settings: Settings,
  host: string,
  overrides?: Partial<Pick<PublicSessionConfig, 'mode' | 'targetLang' | 'sessionId'>>,
): Promise<PublicSessionConfig> {
  const eff = effectiveForHost(settings, host);
  return {
    sessionId: overrides?.sessionId || newSessionId(),
    revision: settings.revision,
    targetLang: normalizeTargetLang(overrides?.targetLang ?? eff.targetLang),
    uiLocale: settings.uiLocale,
    mode: (overrides?.mode ?? eff.mode) as TranslationMode,
    maxConcurrent: settings.maxConcurrent,
    batchSize: settings.batchSize,
    providerFingerprint: await providerFingerprint(settings),
    disabled: eff.disabled,
  };
}

export type { SiteRule, TargetLang };

/** Resolve a public batch identity against trusted, device-local credentials. */
export async function settingsForBatch(
  settings: Settings,
  identity: Pick<PublicSessionConfig, 'targetLang' | 'providerFingerprint'>,
): Promise<Settings> {
  if (!(SUPPORTED_TARGET_LANGS as readonly unknown[]).includes(identity.targetLang)) {
    throw new DualReadError('CONFIG_REQUIRED', { detail: 'unsupported translation target' });
  }
  if (identity.providerFingerprint !== await providerFingerprint(settings)) {
    throw new DualReadError('SESSION_CANCELLED', { detail: 'translation provider changed; start a new session' });
  }
  return { ...settings, targetLang: identity.targetLang };
}
