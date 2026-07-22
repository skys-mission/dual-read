import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { startMockServer } from './helpers/mock-server';
import {
  seedSettings,
  getTabId,
  translateTab,
  restoreTab,
  stopWatchTab,
  inspectTranslation,
  translateSelectionInTab,
  inspectSelectionOverlay,
  reinjectFrame,
} from './helpers/ext-control';

// Main path: local fixture page + loopback mock OpenAI API.

test.describe('translate main path', () => {
  test('bilingual → restore leaves original DOM', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await expect(page.locator('#title')).toHaveText('Hello World');

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      expect(Number(result.count) || 0).toBeGreaterThan(0);

      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.targetSamples.some((t) => t.includes('译:'))).toBeTruthy();
      expect(after.editorText).toBe('Do not translate this editable text.');

      await restoreTab(sw, tabId);
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 10_000 })
        .toBe(0);

      const restored = await inspectTranslation(page);
      expect(restored.doneCount).toBe(0);
      expect(restored.titleText).toBe('Hello World');
      expect(restored.p1Text).toContain('first paragraph');
      expect(restored.editorText).toBe('Do not translate this editable text.');
    } finally {
      await mock.close();
    }
  });

  test('replace mode hides original and shows translation', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, {
        apiBase: mock.apiBase,
        mode: 'replace',
      });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'replace');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => {
          const i = await inspectTranslation(page);
          return i.replaceCount + i.hideCount + i.targetCount;
        }, { timeout: 15_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.hideCount + after.replaceCount + after.targetCount).toBeGreaterThan(0);
      expect(after.editorText).toBe('Do not translate this editable text.');
      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('rich replace restore preserves host language attributes', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, {
        apiBase: mock.apiBase,
        mode: 'replace',
      });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.locator('#p1').evaluate((el) => {
        el.innerHTML = 'Read <a href="/docs">the docs</a> before continuing.';
        el.setAttribute('lang', 'en');
        el.setAttribute('dir', 'ltr');
      });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'replace');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(() => page.locator('#p1').getAttribute('data-dual-read-mode'), { timeout: 15_000 })
        .toBe('replace');
      await expect(page.locator('#p1')).toHaveAttribute('lang', 'zh-CN');
      await expect(page.locator('#p1')).toHaveAttribute('dir', 'auto');

      await restoreTab(sw, tabId);

      await expect(page.locator('#p1')).toHaveAttribute('lang', 'en');
      await expect(page.locator('#p1')).toHaveAttribute('dir', 'ltr');
      await expect(page.locator('#p1')).not.toHaveAttribute('data-dual-read-stash-language-attrs', /.+/);
      await expect(page.locator('#p1')).toContainText('Read the docs before continuing.');
    } finally {
      await mock.close();
    }
  });

  test('repeated selection translate reuses one overlay and binding', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);

      // Mimic context-menu selectionText after the DOM selection is cleared.
      const result = await translateSelectionInTab(sw, tabId, 'Hello World');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => (await inspectSelectionOverlay(page)).present, { timeout: 15_000 })
        .toBeTruthy();

      const overlay = await inspectSelectionOverlay(page);
      expect(overlay.originalText).toContain('Hello World');
      expect(overlay.isLoading).toBeFalsy();
      expect(overlay.isError).toBeFalsy();
      expect(overlay.bodyText.length).toBeGreaterThan(0);
      expect(overlay.bodyText).toMatch(/译:|Hello/);

      const second = await translateSelectionInTab(sw, tabId, 'Read the docs');
      expect(second.success, JSON.stringify(second)).toBeTruthy();
      const afterSecond = await inspectSelectionOverlay(page);
      expect(afterSecond.hostCount).toBe(1);
      expect(afterSecond.originalText).toBe('Read the docs');
      expect(afterSecond.isLoading).toBeFalsy();
      expect(afterSecond.isError).toBeFalsy();
      expect(afterSecond.bodyText.length).toBeGreaterThan(0);
    } finally {
      await mock.close();
    }
  });

  test('disabled-site selection shows an error without flashing loading', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __sawDualReadLoading?: boolean;
          __dualReadLoadingObserver?: MutationObserver;
        };
        state.__sawDualReadLoading = false;
        const inspect = () => {
          const hosts = document.querySelectorAll('#dual-read-overlay-host');
          for (const host of hosts) {
            if (host.shadowRoot?.querySelector('.dr-loading')) {
              state.__sawDualReadLoading = true;
            }
          }
        };
        const observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        });
        state.__dualReadLoadingObserver = observer;
      });

      const tabId = await getTabId(page, sw);
      const result = await translateSelectionInTab(sw, tabId, 'Blocked selection', {
        disabled: true,
      });
      expect(result.success).toBeFalsy();
      expect(result.code).toBe('PAGE_UNSUPPORTED');

      const overlay = await inspectSelectionOverlay(page);
      expect(overlay.present).toBeTruthy();
      expect(overlay.isError).toBeTruthy();
      expect(overlay.isLoading).toBeFalsy();
      const sawLoading = await page.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __sawDualReadLoading?: boolean;
          __dualReadLoadingObserver?: MutationObserver;
        };
        state.__dualReadLoadingObserver?.disconnect();
        return Boolean(state.__sawDualReadLoading);
      });
      expect(sawLoading).toBeFalsy();
    } finally {
      await mock.close();
    }
  });

  test('selection destroyed mid-flight cannot recreate an orphan overlay', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    mock.setResponseDelay(1_000);
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);

      const pending = translateSelectionInTab(sw, tabId, 'Slow selection');
      await expect
        .poll(async () => (await inspectSelectionOverlay(page)).isLoading, { timeout: 10_000 })
        .toBeTruthy();

      await reinjectFrame(sw, tabId);
      const cancelled = await pending;
      expect(cancelled.success).toBeFalsy();
      expect(cancelled.code).toBe('SESSION_CANCELLED');
      await page.waitForTimeout(1_200);

      const afterDestroy = await inspectSelectionOverlay(page);
      expect(afterDestroy.present).toBeFalsy();
      expect(afterDestroy.hostCount).toBe(0);

      // The replacement binding remains usable.
      mock.setResponseDelay(0);
      const next = await translateSelectionInTab(sw, tabId, 'Fresh selection');
      expect(next.success, JSON.stringify(next)).toBeTruthy();
      const afterNext = await inspectSelectionOverlay(page);
      expect(afterNext.hostCount).toBe(1);
      expect(afterNext.originalText).toBe('Fresh selection');
    } finally {
      await mock.close();
    }
  });

  test('API 401 surfaces failures without mutating editable', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    mock.setMode('auth_fail');
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });

      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(String(result.error || ''), JSON.stringify(result)).not.toMatch(/timed out/i);

      // Poll DOM only — avoid status relays that could disturb in-flight retries.
      await expect
        .poll(async () => (await inspectTranslation(page)).errorCount, { timeout: 45_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.editorText).toBe('Do not translate this editable text.');
      expect(after.targetSamples.every((t) => !t.includes('译:'))).toBeTruthy();
      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });
});
