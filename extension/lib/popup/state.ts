/**
 * Pure popup view-model. Maps page/session facts → one phase + one primary CTA.
 * No DOM / chrome APIs — fully unit-testable.
 */

import { actionKeyFor, messageKeyFor, type DualReadErrorCode } from '../errors';

export type PopupPhase =
  | 'config-required'
  | 'unsupported'
  | 'idle'
  | 'translating'
  | 'watching'
  | 'partial'
  | 'error'
  | 'empty';

export type PrimaryAction =
  | 'setup'
  | 'translate'
  | 'stop'
  | 'restore'
  | 'retryFailed'
  | 'none';

export type UnsupportedReason = 'restricted' | 'disabled' | 'no-tab' | 'inject';

export interface PopupSnapshot {
  configured: boolean;
  hasTab: boolean;
  restricted: boolean;
  siteDisabled: boolean;
  injectFailed?: boolean;
  translating: boolean;
  watching: boolean;
  count: number;
  total: number;
  failed: number;
  /** Local UI action in flight (e.g. waiting for translatePage reply). */
  busy?: boolean;
  /** Last hard failure message from translatePage / inject. */
  lastError?: string | null;
  /** Stable error code when available (preferred over parsing lastError). */
  lastErrorCode?: string | null;
  /** Last translate finished with zero units. */
  lastEmpty?: boolean;
}

export interface PopupViewModel {
  phase: PopupPhase;
  /** i18n key for the main status line. */
  statusKey: string;
  statusSubs?: (string | number)[];
  /** Optional secondary detail line (progress / error). */
  detailKey?: string;
  detailSubs?: (string | number)[];
  /** Free-form detail when we only have a raw error string. */
  detailText?: string;
  /** Optional recommended-action i18n key (shown under detail). */
  actionKey?: string;
  primary: PrimaryAction;
  primaryKey: string;
  primaryDisabled: boolean;
  /** Show a quiet secondary restore control (never competes as primary). */
  showSecondaryRestore: boolean;
  controlsEnabled: boolean;
  progress: { count: number; total: number } | null;
  unsupportedReason?: UnsupportedReason;
}

const PRIMARY_KEYS: Record<PrimaryAction, string> = {
  setup: 'openSetup',
  translate: 'translatePage',
  stop: 'stopTranslate',
  restore: 'restoreOriginal',
  retryFailed: 'retryFailed',
  none: 'translatePage',
};

function asErrorCode(raw: string | null | undefined): DualReadErrorCode | null {
  if (!raw) return null;
  const known: DualReadErrorCode[] = [
    'CONFIG_REQUIRED',
    'PERMISSION_REQUIRED',
    'ENDPOINT_INSECURE',
    'AUTH_INVALID',
    'MODEL_NOT_FOUND',
    'RATE_LIMITED',
    'UPSTREAM_TIMEOUT',
    'UPSTREAM_UNAVAILABLE',
    'RESPONSE_MALFORMED',
    'PAGE_RESTRICTED',
    'PAGE_UNSUPPORTED',
    'SESSION_CANCELLED',
    'NETWORK_ERROR',
    'UNKNOWN',
  ];
  return (known as string[]).includes(raw) ? (raw as DualReadErrorCode) : null;
}

export function derivePopupView(snap: PopupSnapshot): PopupViewModel {
  const count = Math.max(0, snap.count | 0);
  const total = Math.max(0, snap.total | 0);
  const failed = Math.max(0, snap.failed | 0);
  const progress = total > 0 ? { count, total } : null;

  if (!snap.configured) {
    return {
      phase: 'config-required',
      statusKey: 'statusConfigRequired',
      primary: 'setup',
      primaryKey: PRIMARY_KEYS.setup,
      primaryDisabled: false,
      showSecondaryRestore: false,
      controlsEnabled: false,
      progress: null,
    };
  }

  if (!snap.hasTab) {
    return unsupported('no-tab', 'statusError');
  }
  if (snap.restricted) {
    return unsupported('restricted', 'statusRestricted');
  }
  if (snap.siteDisabled) {
    return unsupported('disabled', 'statusSiteDisabled');
  }
  if (snap.injectFailed) {
    return {
      phase: 'error',
      statusKey: 'statusError',
      detailKey: 'errorContentScript',
      primary: 'translate',
      primaryKey: PRIMARY_KEYS.translate,
      primaryDisabled: false,
      showSecondaryRestore: false,
      controlsEnabled: true,
      progress: null,
    };
  }

  if (snap.translating || snap.busy) {
    return {
      phase: 'translating',
      // Prefer concrete progress on the primary status line when totals exist.
      statusKey: total > 0 ? 'statusProgress' : 'statusTranslating',
      statusSubs: total > 0 ? [count, total] : undefined,
      primary: 'stop',
      primaryKey: PRIMARY_KEYS.stop,
      primaryDisabled: false,
      showSecondaryRestore: false,
      controlsEnabled: true,
      progress,
    };
  }

  if (failed > 0 && (snap.watching || count > 0 || total > 0)) {
    return {
      phase: 'partial',
      statusKey: 'statusPartial',
      statusSubs: [count, failed],
      detailKey: total > 0 ? 'statusProgress' : undefined,
      detailSubs: total > 0 ? [count, total] : undefined,
      primary: 'retryFailed',
      primaryKey: PRIMARY_KEYS.retryFailed,
      primaryDisabled: false,
      showSecondaryRestore: true,
      controlsEnabled: true,
      progress,
    };
  }

  if (snap.watching) {
    return {
      phase: 'watching',
      statusKey: 'statusWatching',
      detailKey: total > 0 ? 'statusProgress' : count > 0 ? 'statusTranslated' : undefined,
      detailSubs: total > 0 ? [count, total] : count > 0 ? [count] : undefined,
      primary: 'restore',
      primaryKey: PRIMARY_KEYS.restore,
      primaryDisabled: false,
      showSecondaryRestore: false,
      controlsEnabled: true,
      progress,
    };
  }

  if (snap.lastError || snap.lastErrorCode) {
    const code = asErrorCode(snap.lastErrorCode);
    return {
      phase: 'error',
      statusKey: 'statusError',
      detailKey: code ? messageKeyFor(code) : undefined,
      detailText: code ? undefined : (snap.lastError || undefined),
      actionKey: code ? actionKeyFor(code) : undefined,
      primary: 'translate',
      primaryKey: PRIMARY_KEYS.translate,
      primaryDisabled: false,
      showSecondaryRestore: count > 0,
      controlsEnabled: true,
      progress,
    };
  }

  if (snap.lastEmpty) {
    return {
      phase: 'empty',
      statusKey: 'statusNoContent',
      primary: 'translate',
      primaryKey: PRIMARY_KEYS.translate,
      primaryDisabled: false,
      showSecondaryRestore: false,
      controlsEnabled: true,
      progress: null,
    };
  }

  return {
    phase: 'idle',
    statusKey:
      count > 0
        ? failed > 0
          ? 'statusTranslatedWithFailed'
          : total > 0
            ? 'statusProgress'
            : 'statusTranslated'
        : 'statusReady',
    statusSubs:
      count > 0
        ? failed > 0
          ? [count, failed]
          : total > 0
            ? [count, total]
            : [count]
        : undefined,
    primary: 'translate',
    primaryKey: PRIMARY_KEYS.translate,
    primaryDisabled: false,
    showSecondaryRestore: count > 0,
    controlsEnabled: true,
    progress: count > 0 || total > 0 ? progress : null,
  };
}

function unsupported(reason: UnsupportedReason, statusKey: string): PopupViewModel {
  return {
    phase: 'unsupported',
    statusKey,
    primary: 'none',
    primaryKey: PRIMARY_KEYS.none,
    primaryDisabled: true,
    showSecondaryRestore: false,
    controlsEnabled: reason === 'disabled',
    progress: null,
    unsupportedReason: reason,
  };
}
