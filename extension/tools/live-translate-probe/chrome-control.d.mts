import type { Worker } from '@playwright/test';

export function chromeTranslate(worker: Worker, tabId: number): Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}>;
