/**
 * Stable user-facing error model for Dual Read.
 * UI must never parse free-text upstream bodies; classify → code → i18n.
 */

export type DualReadErrorCode =
  | 'CONFIG_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'ENDPOINT_INSECURE'
  | 'AUTH_INVALID'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RESPONSE_MALFORMED'
  | 'PAGE_RESTRICTED'
  | 'PAGE_UNSUPPORTED'
  | 'SESSION_CANCELLED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface UserFacingError {
  code: DualReadErrorCode;
  /** i18n catalog key for the short user message. */
  messageKey: string;
  /** Optional i18n key for a recommended next step. */
  actionKey?: string;
  /** Sanitized technical detail (never secrets / full upstream bodies). */
  detail?: string;
  retryable: boolean;
}

const MESSAGE_KEYS: Record<DualReadErrorCode, string> = {
  CONFIG_REQUIRED: 'errConfigRequired',
  PERMISSION_REQUIRED: 'errPermissionRequired',
  ENDPOINT_INSECURE: 'errEndpointInsecure',
  AUTH_INVALID: 'errAuthInvalid',
  MODEL_NOT_FOUND: 'errModelNotFound',
  RATE_LIMITED: 'errRateLimited',
  UPSTREAM_TIMEOUT: 'errTimeout',
  UPSTREAM_UNAVAILABLE: 'errUnavailable',
  RESPONSE_MALFORMED: 'errMalformed',
  PAGE_RESTRICTED: 'errPageRestricted',
  PAGE_UNSUPPORTED: 'errPageUnsupported',
  SESSION_CANCELLED: 'errSessionCancelled',
  NETWORK_ERROR: 'errNetwork',
  UNKNOWN: 'errUnknown',
};

const ACTION_KEYS: Partial<Record<DualReadErrorCode, string>> = {
  CONFIG_REQUIRED: 'errActionOpenSetup',
  PERMISSION_REQUIRED: 'errActionGrantPermission',
  ENDPOINT_INSECURE: 'errActionUseHttps',
  AUTH_INVALID: 'errActionCheckKey',
  MODEL_NOT_FOUND: 'errActionCheckModel',
  RATE_LIMITED: 'errActionWaitRetry',
  UPSTREAM_TIMEOUT: 'errActionRetry',
  UPSTREAM_UNAVAILABLE: 'errActionRetry',
  RESPONSE_MALFORMED: 'errActionRetry',
  NETWORK_ERROR: 'errActionRetry',
  UNKNOWN: 'errActionRetry',
};

const RETRYABLE: ReadonlySet<DualReadErrorCode> = new Set([
  'RATE_LIMITED',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'RESPONSE_MALFORMED',
  'NETWORK_ERROR',
  'UNKNOWN',
]);

/** Strip API-key-like tokens and truncate for safe display. */
export function sanitizeDetail(raw: string | undefined | null, max = 160): string | undefined {
  if (raw == null) return undefined;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  s = s
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-…')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer …')
    .replace(/api[_-]?key["\s:=]+["']?[^\s"',}]+/gi, 'api_key=…');
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

export function messageKeyFor(code: DualReadErrorCode): string {
  return MESSAGE_KEYS[code] ?? MESSAGE_KEYS.UNKNOWN;
}

export function actionKeyFor(code: DualReadErrorCode): string | undefined {
  return ACTION_KEYS[code];
}

export function isRetryableCode(code: DualReadErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function userFacing(code: DualReadErrorCode, detail?: string): UserFacingError {
  return {
    code,
    messageKey: messageKeyFor(code),
    actionKey: actionKeyFor(code),
    detail: sanitizeDetail(detail),
    retryable: isRetryableCode(code),
  };
}

/** Map HTTP status (+ optional body snippet) to a stable code. */
export function classifyHttpStatus(status: number, bodySnippet?: string): DualReadErrorCode {
  if (status === 401 || status === 403) return 'AUTH_INVALID';
  if (status === 404) {
    const msg = String(bodySnippet || '').toLowerCase();
    if (msg.includes('model')) return 'MODEL_NOT_FOUND';
    // A bare 404 usually means a wrong apiBase path (e.g. missing /v1),
    // not a missing model — don't send users chasing the wrong fix.
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'UPSTREAM_TIMEOUT';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  if (status >= 400) {
    const msg = String(bodySnippet || '').toLowerCase();
    if (msg.includes('model')) return 'MODEL_NOT_FOUND';
    if (msg.includes('auth') || msg.includes('key') || msg.includes('unauthorized')) {
      return 'AUTH_INVALID';
    }
    return 'UPSTREAM_UNAVAILABLE';
  }
  return 'UNKNOWN';
}

export class DualReadError extends Error {
  readonly code: DualReadErrorCode;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(code: DualReadErrorCode, opts?: { detail?: string; cause?: unknown }) {
    const detail = sanitizeDetail(opts?.detail);
    super(detail || code);
    this.name = 'DualReadError';
    this.code = code;
    this.detail = detail;
    this.retryable = isRetryableCode(code);
    if (opts?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }

  toUserFacing(): UserFacingError {
    return userFacing(this.code, this.detail);
  }
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  return err instanceof Error && (err.name === 'AbortError' || /aborted|abort/i.test(err.message));
}

/**
 * Normalize any thrown value into a UserFacingError.
 * Recognizes DualReadError, AbortError, and legacy "HTTP NNN: …" strings.
 */
export function toUserFacingError(err: unknown): UserFacingError {
  if (err instanceof DualReadError) return err.toUserFacing();
  if (isAbortError(err)) return userFacing('SESSION_CANCELLED');

  const message = err instanceof Error ? err.message : String(err ?? '');
  const http = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) {
    const status = Number(http[1]);
    return userFacing(classifyHttpStatus(status, message), `HTTP ${status}`);
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return userFacing('UPSTREAM_TIMEOUT', sanitizeDetail(message));
  }
  if (/network|fetch failed|failed to fetch|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return userFacing('NETWORK_ERROR', sanitizeDetail(message));
  }
  if (/malformed|empty batch|parse|json/i.test(message)) {
    return userFacing('RESPONSE_MALFORMED', sanitizeDetail(message));
  }
  if (/port disconnected|extension context invalidated/i.test(message)) {
    return userFacing('UPSTREAM_UNAVAILABLE', sanitizeDetail(message));
  }
  if (/budget exhausted/i.test(message)) {
    return userFacing('RATE_LIMITED', sanitizeDetail(message));
  }
  return userFacing('UNKNOWN', sanitizeDetail(message));
}

/** Connection-test codes share most Dual Read codes; map to connection catalog keys. */
export function connectionMessageKey(code: DualReadErrorCode | 'OK'): string {
  const map: Record<string, string> = {
    OK: 'connOk',
    CONFIG_REQUIRED: 'connConfigRequired',
    PERMISSION_REQUIRED: 'connPermissionRequired',
    ENDPOINT_INSECURE: 'connEndpointInsecure',
    AUTH_INVALID: 'connAuthInvalid',
    MODEL_NOT_FOUND: 'connModelNotFound',
    RATE_LIMITED: 'connRateLimited',
    UPSTREAM_TIMEOUT: 'connTimeout',
    UPSTREAM_UNAVAILABLE: 'connUnavailable',
    RESPONSE_MALFORMED: 'connMalformed',
    NETWORK_ERROR: 'connNetworkError',
  };
  return map[code] ?? 'connUnavailable';
}
