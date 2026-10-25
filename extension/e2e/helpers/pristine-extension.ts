import { chromium, firefox, type BrowserContext } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install the actual bundle without adding permissions, scripts or settings. */
export async function launchPristineExtension(name: 'chromium' | 'firefox') {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-read-pristine-e2e-'));
  const addon = fileURLToPath(new URL(name === 'firefox' ? '../../output/firefox-mv3/' : '../../output/chrome-mv3/', import.meta.url));
  let context: BrowserContext | undefined;
  try {
    if (name === 'firefox') {
      const launcher = withExtension(firefox, addon);
      // This library normally pre-grants content-script origins in the profile.
      // Skip that hook so the browser decides access from the shipped manifest.
      if (!('overridePermissions' in launcher)) throw new Error('Firefox permission override hook changed');
      launcher.overridePermissions = async () => {};
      context = await launcher.launchPersistentContext(profile, { headless: true });
    } else {
      context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${addon}`, `--load-extension=${addon}`] });
    }
    return { context,
      async close() { await context!.close(); await fs.rm(profile, { recursive: true, force: true }); } };
  } catch (error) {
    await context?.close(); await fs.rm(profile, { recursive: true, force: true }); throw error;
  }
}
