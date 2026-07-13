/**
 * Cross-tab fair concurrency gate for background translate jobs.
 * FIFO waiters; abort removes a waiter without consuming a slot.
 */

export type GateRelease = () => void;

export interface FairGate {
  /** Current in-flight jobs. */
  readonly active: number;
  /** Waiters not yet started. */
  readonly waiting: number;
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Default global concurrent LLM calls across all tabs. */
export const GLOBAL_TRANSLATE_LIMIT = 6;

export function createFairGate(limit: number = GLOBAL_TRANSLATE_LIMIT): FairGate {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<{
    start: () => void;
    signal?: AbortSignal;
    onAbort: () => void;
  }> = [];

  const pump = (): void => {
    while (active < max && waiters.length) {
      const next = waiters.shift()!;
      next.signal?.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) continue;
      active++;
      next.start();
    }
  };

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }

        const start = () => resolve();
        const entry = {
          start,
          signal,
          onAbort: () => {
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            reject(abortError());
          },
        };

        signal?.addEventListener('abort', entry.onAbort, { once: true });

        if (active < max) {
          active++;
          signal?.removeEventListener('abort', entry.onAbort);
          start();
        } else {
          waiters.push(entry);
        }
      });

      try {
        if (signal?.aborted) throw abortError();
        return await fn();
      } finally {
        active = Math.max(0, active - 1);
        pump();
      }
    },
  };
}
