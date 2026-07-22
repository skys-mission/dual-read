import type { PublicSessionConfig, TranslateStatus } from './types';
import { DualReadError, isAbortError, type DualReadErrorCode } from './errors';

export const PORT_NAME = 'dual-read-translate';
export const PORT_TIMEOUT_MS = 60_000;

export interface BatchRequestMsg {
  action: 'translateBatch';
  requestId: string;
  sessionId: string;
  texts: string[];
}

export interface BatchCancelMsg {
  action: 'translateCancel';
  requestId: string;
  sessionId: string;
}

export interface BatchResultMsg {
  action: 'batchResult';
  requestId: string;
  sessionId: string;
  success: boolean;
  translations?: string[];
  error?: string;
  code?: DualReadErrorCode;
}

export type PortInboundMsg = BatchRequestMsg | BatchCancelMsg;
export type PortOutboundMsg = BatchResultMsg;

export type ContentRequest =
  | { action: 'ping' }
  | { action: 'getStatus' }
  | { action: 'restoreOriginal' }
  | { action: 'stopWatch' }
  | { action: 'retryFailed' }
  | { action: 'translatePage'; config: PublicSessionConfig }
  | { action: 'translateSelection'; config: PublicSessionConfig; text?: string }
  | { action: 'toggleMode'; config: PublicSessionConfig };

export interface PingResponse {
  pong: true;
  version: string;
  /** chrome.runtime.id at ping time — missing/mismatch means orphaned inject. */
  runtimeId?: string | null;
}

export type TranslatePageResult =
  | ({ success: true; watching: boolean; aborted?: boolean } & Omit<TranslateStatus, 'translating' | 'watching'>)
  | { success: false; error: string; code?: DualReadErrorCode };

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isBatchResult(m: unknown): m is BatchResultMsg {
  return Boolean(m && typeof m === 'object' && (m as BatchResultMsg).action === 'batchResult');
}

export { isAbortError };

/**
 * Translate one batch through a background port. Cancellation flows:
 * - opts.signal abort → translateCancel + disconnect → background AbortController → fetch
 * - timeout → translateCancel + reject
 * - port disconnect → reject (and background aborts remaining controllers)
 */
export function translateBatchViaPort(
  texts: string[],
  opts?: {
    sessionId?: string;
    ports?: Set<chrome.runtime.Port>;
    signal?: AbortSignal;
  },
): Promise<string[]> {
  const sessionId = opts?.sessionId || 'anonymous';
  const ports = opts?.ports;
  const signal = opts?.signal;
  const requestId = newRequestId();

  return new Promise<string[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const port = chrome.runtime.connect({ name: PORT_NAME });
    ports?.add(port);
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: (v: never) => void, value: unknown) => {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onAbort);
      ports?.delete(port);
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      (fn as (v: unknown) => void)(value);
    };

    const sendCancel = () => {
      try {
        port.postMessage({
          action: 'translateCancel',
          requestId,
          sessionId,
        } satisfies BatchCancelMsg);
      } catch {
        /* ignore */
      }
    };

    const onAbort = () => {
      sendCancel();
      finish(reject as never, new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      sendCancel();
      finish(reject as never, new DualReadError('UPSTREAM_TIMEOUT', { detail: 'translation timed out' }));
    }, PORT_TIMEOUT_MS);

    port.onMessage.addListener((m: unknown) => {
      if (!isBatchResult(m) || m.requestId !== requestId) return;
      if (m.success) finish(resolve as never, m.translations ?? []);
      else {
        const code = m.code || 'UNKNOWN';
        finish(
          reject as never,
          new DualReadError(code, { detail: m.error || code }),
        );
      }
    });
    port.onDisconnect.addListener(() => {
      if (done) return;
      // If we aborted locally, prefer AbortError over disconnect noise.
      if (signal?.aborted) {
        finish(reject as never, new DOMException('Aborted', 'AbortError'));
        return;
      }
      finish(
        reject as never,
        new DualReadError('UPSTREAM_UNAVAILABLE', {
          detail: chrome.runtime.lastError?.message || 'translation port disconnected',
        }),
      );
    });

    try {
      port.postMessage({
        action: 'translateBatch',
        requestId,
        sessionId,
        texts,
      } satisfies BatchRequestMsg);
    } catch (err) {
      finish(reject as never, err instanceof Error ? err : new Error(String(err)));
    }
  });
}
