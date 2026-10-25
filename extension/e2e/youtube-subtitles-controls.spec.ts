import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchSubtitleExtension } from './helpers/subtitle-extension';
import { startMockServer } from './helpers/mock-server';

for (const scenario of ['first-load', 'reload-off', 'home-spa', 'late-controls', 'replace-controls', 'replace-player', 'disabled-site']) {
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
      await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      await fx.message(page, { action: 'test:seed', apiBase: mock.apiBase });
      // A fresh document, with host access already granted but auto-translation off.
      await page.goto(scenario === 'home-spa' ? 'https://www.youtube.com/' : 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
      if (scenario === 'home-spa') {
        await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
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
      if (scenario === 'first-load' || scenario === 'reload-off') {
        await enable.click();
        await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption');
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
