// Pure scheduling policy helpers — no DOM, fully unit-testable.

export const MAX_ATTEMPTS = 3;

/**
 * Soft cap on total automatic retries for one page session.
 * Prevents a pathological page from burning API quota via retry storms.
 * Manual retry (user click) does not consume this budget.
 */
export const MAX_RETRY_COST = 24;

// Exponential backoff for failed batches: 1s, 4s, 16s.
const DELAYS_MS = [1_000, 4_000, 16_000];

/**
 * Delay (ms) before the given retry attempt (1-based). Returns -1 once the
 * attempt exceeds MAX_ATTEMPTS, signalling the caller to give up.
 */
export function retryDelay(attempt: number): number {
  if (attempt < 1 || attempt > MAX_ATTEMPTS) return -1;
  return DELAYS_MS[attempt - 1] ?? -1;
}

/** Whether the page session may schedule another automatic retry. */
export function canAffordRetry(retryCostSpent: number, maxCost: number = MAX_RETRY_COST): boolean {
  return retryCostSpent < maxCost;
}

/**
 * Adaptive batch size: after every 2 consecutive malformed/failed batches,
 * halve the size (floor, min 1) so a flaky endpoint converges toward
 * single-item requests instead of repeatedly failing large batches.
 */
export function adaptiveBatchSize(base: number, consecutiveFailures: number): number {
  const safeBase = Math.max(1, Math.floor(base));
  if (consecutiveFailures < 2) return safeBase;
  const halvings = Math.floor(consecutiveFailures / 2);
  return Math.max(1, Math.floor(safeBase / 2 ** halvings));
}
