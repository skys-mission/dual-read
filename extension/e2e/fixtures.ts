import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(dirname, '../output/chrome-mv3');

// Loads the built Chrome MV3 extension into a persistent context. Extensions
// require the full Chromium build with the new headless mode.
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
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
    }
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extensionId = sw.url().split('/')[2] ?? '';
    await use(extensionId);
  },
});

export const expect = test.expect;
export { EXTENSION_PATH };
