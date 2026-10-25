import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchSubtitleExtension } from './helpers/subtitle-extension';
import { startMockServer } from './helpers/mock-server';
import { launchPristineExtension } from './helpers/pristine-extension';

test('packaged subtitle controls appear without popup or optional grants', async ({}, info) => {
  const fx = await launchPristineExtension(info.project.name === 'firefox-ext' ? 'firefox' : 'chromium');
  try {
    const html = await fs.readFile(new URL('./fixtures/youtube-player.html', import.meta.url), 'utf8');
    const video = await fs.readFile(new URL('./fixtures/subtitle-clock.webm', import.meta.url));
    const unexpectedRequests: string[] = [];
    await fx.context.route(/^https?:/, async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/fixture.webm') {
        await route.fulfill({ contentType: 'video/webm', body: video });
      } else if (route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: 'text/html', body: html });
      } else {
        unexpectedRequests.push(`${url.origin}${url.pathname}`);
        await route.abort();
      }
    });
    const page = fx.context.pages().find(p => p.url() === 'about:blank') ?? await fx.context.newPage();
    const expectIdle = async () => {
      const toggle = page.locator('[data-dual-read-subtitle-ui] button.toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveCount(1);
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await page.waitForTimeout(650);
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
      expect(await page.evaluate(() => (window as any).fixtureNativeNode === document.querySelector('.ytp-caption-segment'))).toBe(true);
      expect(unexpectedRequests).toEqual([]);
    };
    // No popup, relay messages, settings seeding or permissions.request calls.
    await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    await expectIdle();
    await page.reload();
    await expectIdle();
    await page.goto('https://www.youtube.com/');
    await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
    await page.locator('#next-video').click();
    await expectIdle();
    await page.screenshot({ path: info.outputPath('packaged-idle-controls.png') });
    await page.goto('https://example.com/');
    await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
  } finally { await fx.close(); }
});

for (const scenario of ['first-load', 'reload-off', 'home-spa', 'search-spa', 'channel-spa', 'watch-spa', 'home-spa-popup', 'home-spa-retry', 'late-controls', 'replace-controls', 'replace-player', 'disabled-site']) {
  test(`idle subtitle controls: ${scenario}`, async ({}, info) => {
    const mock = await startMockServer();
    const fx = await launchSubtitleExtension(info.project.name === 'firefox-ext' ? 'firefox' : 'chromium');
    try {
      const page = fx.context.pages().find(p => p.url() === 'about:blank') ?? await fx.context.newPage();
      const html = await fs.readFile(new URL('./fixtures/youtube-player.html', import.meta.url), 'utf8');
      const video = await fs.readFile(new URL('./fixtures/subtitle-clock.webm', import.meta.url));
      let sourceRequests = 0;
      await page.route('https://www.youtube.com/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/timedtext') {
          sourceRequests++;
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: [
            { tStartMs: 0, dDurationMs: 100000, segs: [{ utf8: 'Original caption' }] },
          ] }) });
        } else if (url.pathname === '/fixture.webm') await route.fulfill({ contentType: 'video/webm', body: video });
        else await route.fulfill({ contentType: 'text/html', body: html });
      });
      const landing = scenario.startsWith('home-spa') ? '/'
        : scenario === 'search-spa' ? '/results?search_query=captions'
          : scenario === 'channel-spa' ? '/@fixture' : '/watch?v=aaaaaaaaaaa';
      await page.goto(`https://www.youtube.com${landing}`);
      await fx.message(page, { action: 'test:seed', apiBase: mock.apiBase });
      // The first YouTube document after installation, without a warm-up reload.
      const spa = scenario.includes('spa');
      if (spa) {
        if (scenario !== 'watch-spa') await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
        await page.locator('#next-video').click();
      }
      if (scenario === 'late-controls') await page.evaluate(() => {
        const controls = document.querySelector('.ytp-right-controls')!;
        controls.remove(); setTimeout(() => document.querySelector('#movie_player')!.append(controls), 700);
      });
      const enable = page.getByRole('button', { name: 'Enable bilingual subtitles', exact: true });
      await expect(enable).toBeVisible();
      await expect(enable).toHaveAttribute('aria-pressed', 'false');
      const native = await page.locator('.ytp-caption-segment').elementHandle();
      await page.waitForTimeout(650);
      expect(sourceRequests).toBe(0); expect(mock.getRequestCount()).toBe(0);
      // A page script cannot turn the idle entry point into automatic billing.
      await enable.evaluate(button => (button as HTMLButtonElement).click());
      await page.waitForTimeout(100);
      expect(mock.getRequestCount()).toBe(0);
      await expect(enable).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
      if (scenario === 'replace-controls') await page.evaluate(() => {
        const controls = document.querySelector('.ytp-right-controls')!;
        const replacement = controls.cloneNode(true) as HTMLElement;
        replacement.querySelectorAll('[data-dual-read-subtitle-ui]').forEach(n => n.remove());
        controls.replaceWith(replacement);
      });
      if (scenario === 'replace-player') await page.locator('#replace-player').click();
      if (scenario === 'disabled-site') {
        await fx.message(page, { action: 'test:siteDisabled', disabled: true });
        await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
        await page.reload(); await page.waitForTimeout(700);
        await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
        expect(sourceRequests).toBe(0); expect(mock.getRequestCount()).toBe(0);
        return;
      }
      await expect(enable).toBeVisible(); await expect(enable).toHaveCount(1);
      if (spa) {
        const sender = await fx.message(page, { action: 'test:sender' });
        await info.attach('sender-after-spa.json', { body: JSON.stringify(sender), contentType: 'application/json' });
        expect(sender).toMatchObject({ url: `https://www.youtube.com${landing}`, tabUrl: page.url(), frameId: 0 });
      }
      if (scenario === 'first-load' || scenario === 'reload-off' || spa) {
        const popup = (message: Record<string, unknown>) => fx.message(page, { action: 'test:popupCommand', message });
        if (scenario === 'home-spa-retry') {
          // A genuine source failure after initialization, followed by Retry in
          // the same document. The unmatched selection cannot authorize text.
          await page.evaluate(() => {
            const player = document.querySelector('#movie_player') as any;
            (window as any).originalGetOption = player.getOption;
            player.getOption = () => ({ vssId: 'missing', languageCode: 'en' });
          });
          expect(await popup({ action: 'subtitles:setEnabled', enabled: true })).toEqual({ success: true });
          await expect.poll(async () => (await popup({ action: 'subtitles:describe' })).status.state).toBe('source-error');
          const failed = (await popup({ action: 'subtitles:describe' })).status;
          expect(sourceRequests).toBe(0); expect(mock.getRequestCount()).toBe(0);
          await page.waitForTimeout(Math.max(0, failed.retryAt - Date.now()));
          await page.evaluate(() => {
            (document.querySelector('#movie_player') as any).getOption = (window as any).originalGetOption;
          });
        }
        if (scenario === 'home-spa-popup' || scenario === 'home-spa-retry') {
          expect(await popup({ action: 'subtitles:setEnabled', enabled: true })).toEqual({ success: true });
        } else await enable.click();
        await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption');
        if (spa) {
          await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
          await page.getByLabel('Position', { exact: true }).selectOption('top');
          await expect.poll(async () => (await fx.message(page, { action: 'test:preferences' })).subtitles.position).toBe('top');
          await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
          // Continue in the same document after the initial successful start.
          await page.locator('#next-video').click();
          await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption');
        }
        await page.getByRole('button', { name: 'Turn off subtitle translation', exact: true }).click();
        await expect(enable).toBeVisible();
        await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
        expect(await native!.evaluate(n => n === document.querySelector('.ytp-caption-segment'))).toBe(true);
        if (scenario === 'reload-off') {
          const before = sourceRequests;
          await page.reload(); await expect(enable).toBeVisible(); await page.waitForTimeout(700);
          expect(sourceRequests).toBe(before);
          expect((await fx.message(page, { action: 'test:status' })).enabled).toBe(false);
        }
      } else { expect(sourceRequests).toBe(0); expect(mock.getRequestCount()).toBe(0); }
      await page.screenshot({ path: info.outputPath(`idle-${scenario}.png`) });
    } finally { await fx.close(); await mock.close(); }
  });
}
