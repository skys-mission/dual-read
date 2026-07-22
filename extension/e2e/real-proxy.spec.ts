import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { getTabId, inspectTranslation, seedSettings, translateTab } from './helpers/ext-control';
import { startMockServer } from './helpers/mock-server';
import { startRealProxy } from './helpers/real-proxy';

test.describe('extension through the real dual-read-server', () => {
  test('translates in proxy mode and exposes cache and health contracts', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const upstream = await startMockServer();
    const proxy = await startRealProxy(upstream.origin);
    try {
      for (const endpoint of ['/livez', '/readyz', '/health']) {
        const response = await fetch(`${proxy.origin}${endpoint}`);
        expect(response.ok, `${endpoint} returned ${response.status}`).toBeTruthy();
        expect(response.headers.get('x-request-id')).toMatch(/^dr-/);
      }

      const body = JSON.stringify({
        model: 'e2e-mock',
        messages: [{ role: 'user', content: JSON.stringify({ 0: 'cache probe' }) }],
        temperature: 0.3,
      });
      const first = await fetch(`${proxy.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(first.status).toBe(200);
      expect(first.headers.get('x-cache')).toBe('MISS');
      expect(first.headers.get('x-dual-read-model')).toBe('e2e-mock');

      const second = await fetch(`${proxy.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(second.status).toBe(200);
      expect(second.headers.get('x-cache')).toBe('HIT');
      expect(upstream.getRequestCount()).toBe(1);

      await seedSettings(extContext, extensionId, {
        connectionMode: 'proxy',
        apiBase: proxy.apiBase,
        apiKey: '',
      });
      const page = await extContext.newPage();
      await page.goto(upstream.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const translated = await inspectTranslation(page);
      expect(translated.doneCount).toBeGreaterThan(0);
      expect(translated.targetSamples.some((text) => text.includes('译:'))).toBeTruthy();
      expect(upstream.getRequestCount()).toBeGreaterThan(1);

      const metrics = await fetch(`${proxy.origin}/metrics`).then((response) => response.text());
      expect(metrics).toContain('dual_read_requests_total');
      expect(metrics).toContain('dual_read_cache_hits_total');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
