/**
 * Cooperative scheduling helpers for content-script work on large pages.
 * Prefer `scheduler.yield` when present; fall back to a macrotask so the
 * browser can paint and Long Tasks stay under the 50ms threshold.
 */

export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') {
    return sched.yield();
  }
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(undefined);
  });
}

/** True when the current slice should pause (default ~12ms leaves room under 50ms LT). */
export function sliceExceeded(startedAt: number, budgetMs: number): boolean {
  return performance.now() - startedAt >= budgetMs;
}
