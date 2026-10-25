import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchSubtitleExtension } from './helpers/subtitle-extension';
import { startMockServer } from './helpers/mock-server';
import { buildPublicSessionConfig } from '../lib/settings/session-config';
import { parseSettings } from '../lib/settings/schema';

for (const scenario of ['restore', 'initial-on', 'asr-switch', 'spa', 'slow-seek', 'auth-failure', 'malformed', 'source-empty', 'no-tracks', 'same-language', 'appearance', 'layout-ads', 'page-coexist', 'native-cc', 'reinject', 'cancel-prepare', 'replace-player', 'untrusted-text', 'narrow-keyboard', 'clock', 'rate-limit', 'cross-origin', 'auto-policy', 'observed-request']) {
test(`production subtitle path: ${scenario}`, async ({}, info) => {
  const mock = await startMockServer();
  const fx = await launchSubtitleExtension(info.project.name === 'firefox-ext' ? 'firefox' : 'chromium');
  try {
    const html = await fs.readFile(new URL('./fixtures/youtube-player.html', import.meta.url), 'utf8');
    const video = await fs.readFile(new URL('./fixtures/subtitle-clock.webm', import.meta.url));
    const page = fx.context.pages().find(page => page.url() === 'about:blank') ?? fx.context.pages()[0] ?? await fx.context.newPage();
    await page.route('https://www.youtube.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/timedtext') {
        if (scenario === 'cancel-prepare') await new Promise(resolve => setTimeout(resolve, 1000));
        if (scenario === 'observed-request') await new Promise(resolve => setTimeout(resolve, 150));
        const events = Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 3500,
          segs: [{ utf8: `${url.searchParams.get('v') === 'bbbbbbbbbbb' ? 'Next video' : url.searchParams.get('kind') === 'asr' ? 'Automatic' : 'Original'} caption ${i + 1}` }] }));
        const empty = scenario === 'source-empty' || scenario === 'observed-request' && !url.searchParams.has('observed');
        await route.fulfill({ contentType: 'application/json', body: empty ? '' : JSON.stringify({ events }) });
      } else if (url.pathname === '/fixture.webm') {
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
        await route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm', body: video.subarray(start, end + 1),
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
      }
      else await route.fulfill({ contentType: 'text/html', body: html,
        headers: { 'Content-Security-Policy': "script-src 'nonce-subtitle-fixture'; object-src 'none'" } });
    });
    await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(await fx.message(page, { action: 'test:seed', apiBase: mock.apiBase })).toEqual({ success: true });
    await page.bringToFront();
    await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    expect(await page.locator('[data-dual-read-subtitle-ui]').count()).toBe(0);
    if (scenario === 'initial-on') await page.locator('.ytp-subtitles-button').click();
    if (scenario === 'no-tracks') await page.evaluate(() => { (window as any).noTracks = true; });
    if (scenario === 'observed-request') await page.evaluate(() => { (window as any).requiresObservedUrl = true; });
    if (scenario === 'auth-failure') mock.setMode('auth_fail');
    if (scenario === 'rate-limit') mock.setMode('rate_limit');
    if (scenario === 'malformed') mock.setMode('malformed');
    if (scenario === 'untrusted-text') mock.setMode('xss');
    if (scenario === 'slow-seek') mock.setResponseDelay(700);
    if (scenario === 'same-language') await fx.message(page, { action: 'subtitles:preferences', preferences: { targetLang: 'en', textSize: 'medium', position: 'bottom' } });
    if (scenario === 'auto-policy') {
      await fx.message(page, { action: 'test:autoPolicy', enabled: true });
      await page.reload();
    }
    const started = scenario === 'auto-policy' ? { success: true } : await fx.message(page, { action: 'subtitles:setEnabled', enabled: true });
    expect(started).toEqual({ success: true });
    const status = () => fx.message(page, { action: 'test:status' });
    if (scenario === 'cancel-prepare') {
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
      await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      await page.waitForTimeout(1500);
      expect((await status()).enabled).toBe(false);
      expect(mock.getRequestCount()).toBe(0);
      await expect(page.locator('.lines .source')).toHaveText('');
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      return;
    }
    if (['auth-failure', 'malformed', 'no-tracks', 'rate-limit'].includes(scenario)) {
      await expect.poll(async () => (await status()).state).toBe(scenario === 'no-tracks' ? 'no-tracks' : 'translation-error');
      await expect(page.locator('.lines .source')).toHaveText('');
      const count = mock.getRequestCount();
      expect(count).toBeLessThanOrEqual(scenario === 'no-tracks' ? 0 : scenario === 'malformed' ? 4 : 2);
      await page.waitForTimeout(700);
      expect(mock.getRequestCount()).toBe(count);
      await page.getByRole('button', { name: 'Turn off subtitle translation', exact: true }).click();
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      return;
    }
    if (scenario === 'source-empty') {
      await expect.poll(async () => (await status()).state, { timeout: 12_000 }).toBe('realtime');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Native caption retained by the page');
      await page.locator('.ytp-caption-segment').evaluate(node => { node.textContent = 'A newly visible native sentence'; });
      await expect(page.locator('.lines .source')).toHaveText('A newly visible native sentence');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:A newly visible native sentence');
      expect(mock.getRequestCount()).toBeLessThanOrEqual(3);
      return;
    }
    await expect(page.locator('.lines .source')).toHaveText('Original caption 1', { timeout: 15_000 });
    await expect(page.locator('.lines .source')).toHaveCSS('color', 'rgb(255, 255, 255)');
    if (scenario === 'untrusted-text') {
      await expect(page.locator('.lines .line:not(.source)')).toContainText('<img src=x onerror=');
      expect(await page.locator('[data-dual-read-subtitle-ui] img').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
      return;
    }
    if (scenario === 'same-language') {
      await expect.poll(async () => (await status()).state).toBe('same-language');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('');
      expect(mock.getRequestCount()).toBe(0);
      expect((await fx.message(page, { action: 'test:preferences' })).targetLang).toBe('zh-CN');
      return;
    }
    if (scenario === 'slow-seek') {
      await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 75; });
      await expect(page.locator('.lines .source')).toHaveText('Original caption 19');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 19', { timeout: 5000 });
      expect(mock.getRequestCount()).toBeLessThanOrEqual(5);
      return;
    }
    await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1', { timeout: 15_000 });
    await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
    if (scenario === 'auto-policy') {
      await fx.message(page, { action: 'test:autoPolicy', enabled: false });
      await expect.poll(async () => (await status()).enabled).toBe(false);
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      await page.reload();
      await page.waitForTimeout(500);
      await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
      // Changing the automatic default must not stop an explicit manual session.
      await fx.message(page, { action: 'subtitles:setEnabled', enabled: true });
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
      await fx.message(page, { action: 'test:autoPolicy', enabled: true });
      await fx.message(page, { action: 'test:autoPolicy', enabled: false });
      await page.waitForTimeout(500);
      expect((await status()).enabled).toBe(true);
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
      return;
    }
    if (scenario === 'cross-origin') {
      await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Another origin</p>' }));
      await page.goto('https://example.com/');
      await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      await page.waitForTimeout(800);
      await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
      return;
    }
    if (scenario === 'clock') {
      const measurements = await page.evaluate(async () => {
        const video = document.querySelector('video')!;
        const host = [...document.querySelectorAll('[data-dual-read-subtitle-ui]')].find(node => node.shadowRoot?.querySelector('.source'))!;
        const source = host.shadowRoot!.querySelector('.source')!;
        const waitFor = (text: string) => new Promise<number>((resolve, reject) => {
          const start = performance.now();
          const frame = () => {
            if (source.textContent === text) resolve(performance.now() - start);
            else if (performance.now() - start > 2500) reject(new Error('Caption did not follow the media clock'));
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        video.currentTime = 8;
        const seekMs = await waitFor('Original caption 3');
        video.currentTime = 3.8;
        const transition = waitFor('Original caption 2');
        await video.play(); await transition;
        const playbackDeltaMs = video.currentTime * 1000 - 4000;
        video.pause();
        return { seekMs, playbackDeltaMs };
      });
      await info.attach('subtitle-clock-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
      expect(measurements.seekMs).toBeLessThan(250);
      expect(measurements.playbackDeltaMs).toBeGreaterThanOrEqual(0);
      expect(measurements.playbackDeltaMs).toBeLessThan(150);
      return;
    }
    if (scenario === 'replace-player') {
      await page.locator('#replace-player').click();
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
      await expect(page.locator('.lines')).toHaveCount(1);
      await page.getByRole('button', { name: 'Turn off subtitle translation', exact: true }).click();
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
      return;
    }
    if (scenario === 'narrow-keyboard') {
      await page.getByRole('button', { name: 'Subtitle options', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Subtitle options' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Subtitle options', exact: true })).toBeFocused();
      await page.setViewportSize({ width: 800, height: 300 });
      await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
      const panel = await page.getByRole('dialog', { name: 'Subtitle options' }).boundingBox();
      expect(panel!.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 360, height: 640 });
      await expect(page.getByRole('button', { name: 'Subtitle options', exact: true })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Turn off subtitle translation', exact: true })).toHaveText('CC+');
      const boxes = await page.locator('.lines').evaluate(node => ({ text: node.getBoundingClientRect().toJSON(), viewport: innerWidth }));
      expect(boxes.text.x).toBeGreaterThanOrEqual(0);
      expect(boxes.text.right).toBeLessThanOrEqual(boxes.viewport);
      return;
    }
    if (scenario === 'asr-switch') {
      await page.locator('#asr').click();
      await expect(page.locator('.lines .source')).toHaveText('Automatic caption 1');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Automatic caption 1');
      expect((await status()).kind).toBe('asr');
      await page.getByRole('button', { name: 'Turn off subtitle translation', exact: true }).click();
      // The user changed the native track; restoring the old CC preference is
      // no longer ours to do, even though our first activation turned it on.
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
      return;
    }
    if (scenario === 'spa') {
      await page.locator('#next-video').click();
      await expect(page.locator('.lines .source')).toHaveText('Next video caption 1');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Next video caption 1');
      return;
    }
    if (scenario === 'appearance') {
      await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
      const count = mock.getRequestCount();
      await page.getByLabel('Text size', { exact: true }).selectOption('large');
      await page.getByLabel('Position', { exact: true }).selectOption('top');
      await expect(page.locator('.lines')).toHaveAttribute('data-position', 'top');
      await page.getByLabel('Position', { exact: true }).press('Escape');
      await expect(page.getByRole('dialog', { name: 'Subtitle options' })).toBeHidden();
      expect(mock.getRequestCount()).toBe(count);
      await page.screenshot({ path: info.outputPath('subtitle-appearance.png') });
      return;
    }
    if (scenario === 'layout-ads') {
      await page.locator('#theater').click();
      await page.locator('#fullscreen').click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('movie_player');
      expect(await page.locator('.lines .source').isVisible()).toBe(true);
      await page.screenshot({ path: info.outputPath('subtitle-fullscreen.png') });
      await page.evaluate(() => document.exitFullscreen());
      await page.locator('#ad').click();
      await expect(page.locator('.lines .source')).toHaveText('');
      await page.locator('#ad').click();
      await expect(page.locator('.lines .source')).toHaveText('Original caption 1');
      for (const rate of [.5, 1, 2]) {
        await page.locator('video').evaluate(async (v, rate) => { const video = v as HTMLVideoElement; video.currentTime = 8; video.playbackRate = rate; await video.play(); video.pause(); }, rate);
        await expect(page.locator('.lines .source')).toHaveText('Original caption 3');
      }
      return;
    }
    if (scenario === 'native-cc') {
      await page.locator('.ytp-subtitles-button').click();
      await expect.poll(async () => (await status()).enabled).toBe(false);
      await page.locator('.ytp-subtitles-button').click();
      expect((await status()).enabled).toBe(false);
      await page.locator('#next-video').click();
      await expect(page.locator('.lines .source')).toHaveText('');
      await page.reload();
      await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
      return;
    }
    if (scenario === 'reinject') {
      await fx.message(page, { action: 'test:reinject' });
      await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
      await fx.message(page, { action: 'subtitles:setEnabled', enabled: true });
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
      await expect(page.locator('.lines')).toHaveCount(1);
      return;
    }
    if (scenario === 'page-coexist') {
      const config = await buildPublicSessionConfig(parseSettings({ apiBase: mock.apiBase, connectionMode: 'proxy', model: 'test-only', targetLang: 'zh-CN', uiLocale: 'en' }), 'www.youtube.com');
      const translated = await fx.message(page, { action: 'test:page', config });
      expect(translated.success).toBe(true);
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
      await page.locator('#page-edit').evaluate(node => node.append(document.createTextNode(' Page-owned edit.')));
      await fx.message(page, { action: 'test:pageRestore' });
      await expect(page.locator('#page-edit')).toContainText('Page-owned edit.');
      await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 1');
    }
    await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 9; });
    await expect(page.locator('.lines .source')).toHaveText('Original caption 3');
    await expect(page.locator('.lines .line:not(.source)')).toHaveText('译:Original caption 3');
    expect(mock.getSubtitleRequests().flat().every(item => !item.text.includes('caption 30'))).toBe(true);
    await page.getByRole('button', { name: 'Turn off subtitle translation', exact: true }).click();
    await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', scenario === 'initial-on' ? 'true' : 'false');
    await expect(page.locator('.lines .source')).toHaveText('');
    expect(await page.evaluate(() => (window as any).fixtureNativeNode === document.querySelector('.ytp-caption-segment'))).toBe(true);
    await expect(page.locator('.ytp-caption-segment')).toHaveText('Native caption retained by the page');
    await page.locator('#next-video').click();
    await expect(page.getByRole('button', { name: 'Enable bilingual subtitles', exact: true })).toBeVisible();
    await expect(page.locator('.lines .source')).toHaveText('');
  } catch (error) {
    const page = fx.context.pages().find(p => p.url().startsWith('https://www.youtube.com'));
    const diagnostics = page ? await fx.message(page, { action: 'test:status' }).catch(() => null) : null;
    await info.attach('fixture-diagnostics', { body: JSON.stringify(diagnostics), contentType: 'application/json' });
    console.log(JSON.stringify(diagnostics));
    throw error;
  } finally { await fx.close(); await mock.close(); }
});
}
