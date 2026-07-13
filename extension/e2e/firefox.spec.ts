import { test, expect, firefox } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './helpers/mock-server';
import { startRealProxy } from './helpers/real-proxy';
import {
  FIREFOX_EXT_PATH,
  launchFirefoxGeckoContext,
  installFirefoxDualRead,
  firefoxTranslatePage,
  firefoxRestore,
  firefoxStopWatch,
  inspectTranslation,
} from './helpers/firefox-gecko';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const FIREFOX_EXT = path.resolve(dirname, '../output/firefox-mv3');

/**
 * Firefox E2E:
 * 1) Temporary-addon load smoke via playwright-webextext (real gecko.id).
 * 2) Translate main path on Gecko via content harness — Playwright cannot drive
 *    moz-extension:// / Firefox MV3 service workers like Chromium.
 *    Harness loads built firefox-mv3 dual-read.js (same artifact users ship).
 */

test.describe('firefox extension load', () => {
  test('builds output exists', () => {
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'manifest.json'))).toBeTruthy();
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'popup.html'))).toBeTruthy();
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'dual-read.js'))).toBeTruthy();
    const manifest = JSON.parse(fs.readFileSync(path.join(FIREFOX_EXT, 'manifest.json'), 'utf8'));
    expect(manifest.browser_specific_settings?.gecko?.id).toBe('dual-read@skysmission.github.io');
    expect(FIREFOX_EXT_PATH).toBe(FIREFOX_EXT);
  });

  test('loads temporary addon and browses without crash', async () => {
    // launch() (not persistent) avoids a playwright-webextext bug when the MV3
    // manifest has neither content_scripts nor optional_permissions arrays.
    const browserType = withExtension(firefox, FIREFOX_EXT);
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('https://example.com/');
      await expect(page).toHaveTitle(/Example Domain/i);
    } finally {
      await browser.close();
    }
  });
});

test.describe('firefox translate main path (Gecko content harness)', () => {
  test('Gecko reaches the real proxy contract', async () => {
    const upstream = await startMockServer();
    const proxy = await startRealProxy(upstream.origin);
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(`${proxy.origin}/livez`);
      const result = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'e2e-mock',
            messages: [{ role: 'user', content: JSON.stringify({ 0: 'firefox proxy smoke' }) }],
          }),
        });
        return {
          status: response.status,
          cache: response.headers.get('x-cache'),
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      }, `${proxy.apiBase}/chat/completions`);
      expect(result.status).toBe(200);
      expect(result.cache).toBe('MISS');
      expect(result.contentType).toContain('application/json');
      expect(result.body).toContain('firefox proxy smoke');
      expect(upstream.getRequestCount()).toBe(1);
    } finally {
      await fx.close();
      await proxy.close();
      await upstream.close();
    }
  });

  test('bilingual → restore leaves original DOM', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      await expect(page.locator('#title')).toHaveText('Hello World');

      await installFirefoxDualRead(page);
      const result = await firefoxTranslatePage(page, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      expect(Number(result.total) || Number(result.count) || 0).toBeGreaterThan(0);

      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.targetSamples.some((t) => t.includes('译:'))).toBeTruthy();
      expect(after.editorText).toBe('Do not translate this editable text.');

      await firefoxRestore(page);
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 10_000 })
        .toBe(0);

      const restored = await inspectTranslation(page);
      expect(restored.doneCount).toBe(0);
      expect(restored.titleText).toBe('Hello World');
      expect(restored.p1Text).toContain('first paragraph');
      expect(restored.editorText).toBe('Do not translate this editable text.');
    } finally {
      await fx.close();
      await mock.close();
    }
  });

  test('replace mode hides original and shows translation', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await installFirefoxDualRead(page);

      const result = await firefoxTranslatePage(page, 'replace');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => {
          const i = await inspectTranslation(page);
          return i.replaceCount + i.hideCount + i.targetCount;
        }, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.hideCount + after.replaceCount + after.targetCount).toBeGreaterThan(0);
      expect(after.editorText).toBe('Do not translate this editable text.');
      await firefoxStopWatch(page);
    } finally {
      await fx.close();
      await mock.close();
    }
  });

  test('API auth failure surfaces errors without mutating editable', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await installFirefoxDualRead(page, { batchMode: 'auth_fail' });

      const result = await firefoxTranslatePage(page, 'bilingual');
      // start() may still succeed (indexed); failures appear as error chrome.
      expect(String(result.error || ''), JSON.stringify(result)).not.toMatch(/timed out/i);

      await expect
        .poll(async () => (await inspectTranslation(page)).errorCount, { timeout: 45_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.editorText).toBe('Do not translate this editable text.');
      expect(after.targetSamples.every((t) => !t.includes('译:'))).toBeTruthy();
      await firefoxStopWatch(page);
    } finally {
      await fx.close();
      await mock.close();
    }
  });
});
