import type { Settings } from '../types';
import { assertSecureApiBase, buildRequestHeaders } from '../settings/schema';
import { withThinkingDisabled } from './thinking';

export type ConnectionCode =
  | 'OK'
  | 'CONFIG_REQUIRED'
  | 'PERMISSION_REQUIRED'
  | 'ENDPOINT_INSECURE'
  | 'AUTH_INVALID'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'RESPONSE_MALFORMED'
  | 'NETWORK_ERROR';

export interface ConnectionTestResult {
  ok: boolean;
  code: ConnectionCode;
  /** Short user-facing message key (i18n). */
  messageKey: string;
  /** Optional technical detail (never secrets / full bodies). */
  detail?: string;
  latencyMs?: number;
}

export type ConnectionSettings = Pick<
  Settings,
  'connectionMode' | 'apiBase' | 'apiKey' | 'model' | 'customHeaders' | 'targetLang'
>;

/** Whether the user has enough config to attempt translation (not yet verified live). */
export function isConnectionConfigured(
  settings: Pick<Settings, 'connectionMode' | 'apiBase' | 'apiKey'>,
): boolean {
  try {
    assertSecureApiBase(settings.apiBase);
  } catch {
    return false;
  }
  return settings.connectionMode === 'proxy' || Boolean(String(settings.apiKey || '').trim());
}

function messageKeyFor(code: ConnectionCode): string {
  const map: Record<ConnectionCode, string> = {
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
  return map[code];
}

function result(
  code: ConnectionCode,
  extra: Partial<ConnectionTestResult> = {},
): ConnectionTestResult {
  return {
    ok: code === 'OK',
    code,
    messageKey: messageKeyFor(code),
    ...extra,
  };
}

async function originPermissionGranted(apiBase: string): Promise<boolean> {
  try {
    const url = new URL(apiBase);
    const origin = `${url.protocol}//${url.host}/*`;
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Probe the configured endpoint with a minimal chat completion.
 * Classifies common failures for novice-friendly UI.
 */
export async function testConnection(
  settings: ConnectionSettings,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> {
  if (!isConnectionConfigured(settings)) {
    return result('CONFIG_REQUIRED');
  }

  let apiBase: string;
  try {
    apiBase = assertSecureApiBase(settings.apiBase);
  } catch (err) {
    return result('ENDPOINT_INSECURE', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (!(await originPermissionGranted(apiBase))) {
    return result('PERMISSION_REQUIRED', { detail: apiBase });
  }

  const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
  // Same thinking disable as translateTexts: DeepSeek V4 otherwise spends the
  // tiny probe max_tokens on reasoning_content and returns empty content.
  const body = withThinkingDisabled(
    {
      model: settings.model || 'dual-read-probe',
      messages: [
        { role: 'system', content: 'Reply with a JSON object {"0":"<translation>"} only.' },
        { role: 'user', content: JSON.stringify({ '0': 'ping' }) },
      ],
      temperature: 0,
      max_tokens: 64,
    },
    settings,
  );

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildRequestHeaders(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      return result('UPSTREAM_TIMEOUT', { detail: 'aborted' });
    }
    const detail = err instanceof Error ? err.message : String(err);
    return result('NETWORK_ERROR', { detail: detail.slice(0, 200) });
  }

  const latencyMs = Date.now() - started;
  if (response.status === 401 || response.status === 403) {
    return result('AUTH_INVALID', { latencyMs, detail: `HTTP ${response.status}` });
  }
  if (response.status === 404) {
    return result('MODEL_NOT_FOUND', { latencyMs, detail: 'HTTP 404' });
  }
  if (response.status === 429) {
    return result('RATE_LIMITED', { latencyMs, detail: 'HTTP 429' });
  }
  if (response.status >= 500) {
    return result('UPSTREAM_UNAVAILABLE', { latencyMs, detail: `HTTP ${response.status}` });
  }
  if (!response.ok) {
    return result('UPSTREAM_UNAVAILABLE', { latencyMs, detail: `HTTP ${response.status}` });
  }

  try {
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string; code?: string };
    };
    if (data.error?.message) {
      const msg = data.error.message.toLowerCase();
      if (msg.includes('model')) {
        return result('MODEL_NOT_FOUND', { latencyMs, detail: data.error.message.slice(0, 160) });
      }
      if (msg.includes('auth') || msg.includes('key') || msg.includes('unauthorized')) {
        return result('AUTH_INVALID', { latencyMs, detail: data.error.message.slice(0, 160) });
      }
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return result('RESPONSE_MALFORMED', { latencyMs });
    }
    return result('OK', { latencyMs });
  } catch {
    return result('RESPONSE_MALFORMED', { latencyMs });
  }
}

/** Request optional host permission for the configured API origin. */
export async function ensureApiHostPermission(apiBase: string): Promise<boolean> {
  try {
    const url = new URL(assertSecureApiBase(apiBase));
    const origin = `${url.protocol}//${url.host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}
