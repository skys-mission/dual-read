import { test as base, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(dirname, '../../output/chrome-mv3');

/**
 * Persistent Chromium context with the built MV3 extension loaded.
 * Unique user-data-dir per test; teardown never blocks on extension ports.
 */
export const extTest = base.extend<{
  extContext: BrowserContext;
  extensionId: string;
  sw: Worker;
}>({
  extContext: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-read-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        '--headless=new',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await Promise.race([
        context.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  },
  sw: async ({ extContext }, use) => {
    let [sw] = extContext.serviceWorkers();
    if (!sw) sw = await extContext.waitForEvent('serviceworker', { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 500));
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    const extensionId = sw.url().split('/')[2] ?? '';
    expect(extensionId).not.toEqual('');
    await use(extensionId);
  },
});

export const expectExt = extTest.expect;
