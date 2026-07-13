import { describe, expect, it } from 'vitest';
import {
  adaptiveBatchSize,
  canAffordRetry,
  MAX_ATTEMPTS,
  MAX_RETRY_COST,
  retryDelay,
} from '../lib/scheduler/backoff';

describe('retryDelay', () => {
  it('follows the 1s/4s/16s schedule', () => {
    expect(retryDelay(1)).toBe(1_000);
    expect(retryDelay(2)).toBe(4_000);
    expect(retryDelay(3)).toBe(16_000);
  });
  it('gives up past MAX_ATTEMPTS', () => {
    expect(retryDelay(MAX_ATTEMPTS + 1)).toBe(-1);
    expect(retryDelay(0)).toBe(-1);
  });
});

describe('canAffordRetry', () => {
  it('allows retries under the page budget', () => {
    expect(canAffordRetry(0)).toBe(true);
    expect(canAffordRetry(MAX_RETRY_COST - 1)).toBe(true);
    expect(canAffordRetry(MAX_RETRY_COST)).toBe(false);
  });
});

describe('adaptiveBatchSize', () => {
  it('keeps base size below 2 consecutive failures', () => {
    expect(adaptiveBatchSize(6, 0)).toBe(6);
    expect(adaptiveBatchSize(6, 1)).toBe(6);
  });
  it('halves after 2 consecutive failures', () => {
    expect(adaptiveBatchSize(6, 2)).toBe(3);
    expect(adaptiveBatchSize(8, 3)).toBe(4);
  });
  it('halves again after 4 consecutive failures', () => {
    expect(adaptiveBatchSize(8, 4)).toBe(2);
  });
  it('never drops below 1', () => {
    expect(adaptiveBatchSize(1, 10)).toBe(1);
    expect(adaptiveBatchSize(6, 100)).toBe(1);
  });
});
