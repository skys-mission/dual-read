import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { getTabId, inspectTranslation, seedSettings, translateTab } from './helpers/ext-control';
import { startMockServer } from './helpers/mock-server';
import { startRealProxy } from './helpers/real-proxy';

const liveAPIKey = process.env.DUAL_READ_LIVE_API_KEY;

test.describe('extension through a live DeepSeek upstream', () => {
  test.skip(!liveAPIKey, 'set DUAL_READ_LIVE_API_KEY to run the live upstream acceptance');

  test('connects, caches, and translates a real page through dual-read-server', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const fixtures = await startMockServer();
    const proxy = await startRealProxy('https://api.deepseek.com', { apiKey: liveAPIKey });
    try {
      const body = JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content: 'Translate each JSON value to Simplified Chinese. Return only a JSON object with the same keys.',
          },
          { role: 'user', content: JSON.stringify({ 0: 'A short live proxy cache probe.' }) },
        ],
        temperature: 0,
        max_tokens: 128,
        thinking: { type: 'disabled' },
      });
      const first = await fetch(`${proxy.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const firstText = await first.text();
      const firstData = JSON.parse(firstText) as {
        choices?: { message?: { content?: string } }[];
      };
      expect(first.status).toBe(200);
      expect(first.headers.get('x-cache')).toBe('MISS');
      expect(first.headers.get('x-dual-read-model')).toBe('deepseek-v4-flash');
      expect(firstData.choices?.[0]?.message?.content?.trim()).toBeTruthy();

      const second = await fetch(`${proxy.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(second.status).toBe(200);
      expect(second.headers.get('x-cache')).toBe('HIT');
      expect(await second.text()).toBe(firstText);

      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.locator('#uiLocale').selectOption('en');
      await options.locator('#connectionMode').selectOption('proxy');
      await options.locator('#apiBase').fill(proxy.apiBase);
      await options.locator('#model').fill('deepseek-v4-flash');
      await options.locator('#apiKey').fill('');
      await options.locator('#testConnectionBtn').click();
      await expect
        .poll(async () => ((await options.locator('#testConnectionStatus').textContent()) ?? '').trim(), {
          timeout: 60_000,
        })
        .toMatch(/^Connected/i);
      await options.close();

      await seedSettings(extContext, extensionId, {
        connectionMode: 'proxy',
        apiBase: proxy.apiBase,
        apiKey: '',
        model: 'deepseek-v4-flash',
      });
      const page = await extContext.newPage();
      await page.goto(fixtures.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 60_000 })
        .toBeGreaterThan(0);

      const translated = await inspectTranslation(page);
      expect(translated.doneCount).toBeGreaterThan(0);
      expect(translated.errorCount).toBe(0);
      expect(translated.editorText).toBe('Do not translate this editable text.');
      expect(fixtures.getRequestCount()).toBe(0);

      const metrics = await fetch(`${proxy.origin}/metrics`).then((response) => response.text());
      expect(metrics).toContain('dual_read_cache_hits_total 1');
      expect(metrics).toContain('dual_read_requests_total');
    } finally {
      await proxy.close();
      await fixtures.close();
    }
  });
});
