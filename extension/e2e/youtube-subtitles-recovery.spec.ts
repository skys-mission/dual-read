import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchSubtitleExtension } from './helpers/subtitle-extension';
import { startMockServer } from './helpers/mock-server';

for (const scenario of ['native-refresh', 'source-recovery', 'rolling-delayed', 'late-native-text', 'realtime-seek', 'realtime-track', 'realtime-stop', 'recovery-stop']) {
  test(`subtitle source recovery: ${scenario}`, async ({}, info) => {
    const mock = await startMockServer();
    const fx = await launchSubtitleExtension(info.project.name === 'firefox-ext' ? 'firefox' : 'chromium');
    try {
      const page = fx.context.pages().find(p => p.url() === 'about:blank') ?? await fx.context.newPage();
      const html = await fs.readFile(new URL('./fixtures/youtube-player.html', import.meta.url), 'utf8');
      const video = await fs.readFile(new URL('./fixtures/subtitle-clock.webm', import.meta.url));
      let available = false;
      let sourceRequests = 0;
      const seen = new Set<string>();
      await page.route('https://www.youtube.com/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/timedtext') {
          sourceRequests++;
          const fresh = url.searchParams.get('fresh');
          const valid = available || scenario === 'native-refresh' && fresh && !seen.has(fresh);
          if (fresh) seen.add(fresh);
          const events = Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 3500, segs: [{ utf8: `Full caption ${i + 1}` }] }));
          await route.fulfill({ contentType: 'application/json', body: valid ? JSON.stringify({ events }) : '' });
        } else if (url.pathname === '/fixture.webm') {
          await route.fulfill({ contentType: 'video/webm', body: video });
        } else await route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      await fx.message(page, { action: 'test:seed', apiBase: mock.apiBase });
      await page.locator('#asr').click();
      await page.evaluate(() => {
        const cc = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button')!;
        let serial = 0;
        cc.onclick = () => {
          const on = cc.getAttribute('aria-pressed') !== 'true';
          cc.setAttribute('aria-pressed', String(on));
          if (on) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', `https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en&kind=asr&fmt=json3&fresh=${++serial}`);
            xhr.send();
          }
        };
        (window as any).nativeNode = document.querySelector('.ytp-caption-segment');
        (window as any).nativeFetch = window.fetch;
        (window as any).nativeOpen = XMLHttpRequest.prototype.open;
      });
      await page.locator('.ytp-subtitles-button').click();
      await expect.poll(() => sourceRequests).toBe(1);
      if (scenario === 'late-native-text') await page.locator('.ytp-caption-segment').evaluate(n => { n.textContent = ''; });
      await fx.message(page, { action: 'subtitles:setEnabled', enabled: true });
      const status = () => fx.message(page, { action: 'test:status' });
      const source = page.locator('.lines .source');
      const translated = page.locator('.lines .line:not(.source)');
      if (scenario === 'native-refresh') {
        await expect(translated).toHaveText('译:Full caption 1', { timeout: 12000 });
        expect((await status()).state).not.toBe('realtime');
        expect(sourceRequests).toBeLessThanOrEqual(4);
      } else {
        await expect.poll(async () => (await status()).state, { timeout: 12000 }).toBe('realtime');
        if (scenario === 'late-native-text') {
          await page.locator('.ytp-caption-segment').evaluate(n => { n.textContent = 'Late original caption'; });
          await expect(translated).toHaveText('译:Late original caption');
        } else if (scenario === 'source-recovery') {
          await expect(translated).toHaveText('译:Native caption retained by the page');
          const before = sourceRequests;
          available = true;
          await expect(translated).toHaveText('译:Full caption 1', { timeout: 18000 });
          expect((await status()).state).not.toBe('realtime');
          expect(sourceRequests - before).toBeLessThanOrEqual(2);
        } else if (scenario === 'rolling-delayed') {
          await expect(translated).toHaveText('译:Native caption retained by the page');
          mock.setResponseDelay(1800);
          const frames = await page.evaluate(async () => {
            const native = document.querySelector('.ytp-caption-segment')!;
            const root = [...document.querySelectorAll('[data-dual-read-subtitle-ui]')].find(n => n.shadowRoot?.querySelector('.source'))!.shadowRoot!;
            const frames: { source: string; translation: string }[] = [];
            let index = 1; native.textContent = 'Rolling caption 1';
            const roll = setInterval(() => { if (index < 12) native.textContent = `Rolling caption ${++index}`; }, 700);
            const sample = setInterval(() => frames.push({ source: root.querySelector('.source')!.textContent!, translation: root.querySelector('.line:not(.source)')!.textContent! }), 100);
            await new Promise(resolve => setTimeout(resolve, 8000));
            clearInterval(roll); clearInterval(sample); return frames;
          });
          const bilingual = frames.filter(f => f.source.startsWith('Rolling') && f.translation);
          expect(new Set(bilingual.map(f => f.source)).size).toBeGreaterThanOrEqual(4);
          expect(bilingual.every(f => f.translation === `译:${f.source}`)).toBe(true);
          // After warmup, moving captions must not clear the last aligned pair.
          expect(frames.slice(35).filter(f => !f.translation).length).toBeLessThan(5);
          await info.attach('continuity', { contentType: 'application/json', body: JSON.stringify({
            captionUpdateMs: 700, providerDelayMs: 1800, distinctPairs: new Set(bilingual.map(f => f.source)).size,
            warmSamples: frames.slice(35).length, warmSamplesWithoutTranslation: frames.slice(35).filter(f => !f.translation).length,
            allPairsAligned: bilingual.every(f => f.translation === `译:${f.source}`),
          }) });
          await expect(translated).toHaveText('译:Rolling caption 12', { timeout: 8000 });
          expect(mock.getRequestCount()).toBeLessThanOrEqual(12);
        } else if (scenario.startsWith('realtime-')) {
          await expect(translated).toHaveText('译:Native caption retained by the page');
          mock.setResponseDelay(1800);
          await page.locator('.ytp-caption-segment').evaluate(n => { n.textContent = 'Before seek'; });
          const before = mock.getRequestCount();
          await expect.poll(() => mock.getRequestCount()).toBeGreaterThan(before);
          if (scenario === 'realtime-stop') {
            await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
            await page.waitForTimeout(2300);
            expect((await status()).enabled).toBe(false);
            await expect(source).toHaveText('');
          } else {
            if (scenario === 'realtime-track') await page.locator('#manual').click();
            await page.evaluate(seek => {
              if (seek) document.querySelector<HTMLVideoElement>('video')!.currentTime = 80;
              document.querySelector('.ytp-caption-segment')!.textContent = 'After change';
            }, scenario === 'realtime-seek');
            await expect(source).not.toHaveText('Before seek');
            await expect(translated).toHaveText('译:After change', { timeout: 12000 });
            await page.waitForTimeout(2000);
            await expect(translated).toHaveText('译:After change');
            if (scenario === 'realtime-track') expect((await status()).kind).toBe('manual');
          }
        } else if (scenario === 'recovery-stop') {
          const before = sourceRequests;
          await expect.poll(() => sourceRequests, { timeout: 18000 }).toBeGreaterThan(before);
          await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
          available = true;
          await page.waitForTimeout(6500);
          expect((await status()).enabled).toBe(false);
          await expect(source).toHaveText('');
          expect(await page.evaluate(() => window.fetch === (window as any).nativeFetch && XMLHttpRequest.prototype.open === (window as any).nativeOpen)).toBe(true);
        }
      }
      await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => (window as any).nativeNode === document.querySelector('.ytp-caption-segment'))).toBe(true);
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
    } finally { await fx.close(); await mock.close(); }
  });
}
