import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { manualSamples, asrSamples } from './samples.mjs';

/** Only the player/source is controlled. The configured model origin is real. */
export async function installControlledSource(page, root) {
  const original = await fs.readFile(path.join(root, 'e2e/fixtures/youtube-player.html'), 'utf8');
  const html = original.replace('<div id="movie_player">', '<div id="movie_player"><div style="position:absolute;top:12px;left:12px;z-index:5;padding:6px;background:#111;color:#fff;font:14px system-ui">Controlled subtitle source · Real translation service</div>');
  const video = await fs.readFile(path.join(root, 'e2e/fixtures/subtitle-clock.webm'));
  await page.route('https://www.youtube.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/timedtext') {
      const asr = url.searchParams.get('kind') === 'asr';
      const events = (asr ? asrSamples : manualSamples).flatMap((text, index) => {
        if (!asr) return [{ tStartMs: index * 4000, dDurationMs: 4000, segs: [{ utf8: text }] }];
        const boundary = text.indexOf(' ', text.indexOf(' ') + 1);
        return [
          { tStartMs: index * 4000, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: text.slice(0, boundary) }] },
          { tStartMs: index * 4000 + 100, dDurationMs: 3900, wWinId: 1, aAppend: 1, segs: [{ utf8: text.slice(boundary), tOffsetMs: 0 }] },
        ];
      });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events }) });
    } else if (url.pathname === '/fixture.webm') {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
      await route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm', body: video.subarray(start, end + 1),
        headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
    } else {
      await route.fulfill({ contentType: 'text/html', body: html,
        headers: { 'Content-Security-Policy': "script-src 'nonce-subtitle-fixture'; object-src 'none'" } });
    }
  });
}

export async function runControlledValidation({ page, root, message, record, state }) {
  const source = page.locator('.lines .source');
  const translation = page.locator('.lines .line:not(.source)');
  const cc = page.locator('.ytp-subtitles-button');
  const status = () => message({ action: 'validation:status' });
  const metrics = () => message({ action: 'validation:metrics' });
  const setEnabled = async enabled => assert.deepEqual(await message({ action: 'subtitles:setEnabled', enabled }), { success: true });
  const seek = time => page.locator('video').evaluate((video, time) => { video.pause(); video.currentTime = time; }, time);
  const translated = async text => {
    await expect(source).toHaveText(text, { timeout: 20_000 });
    await expect(translation).not.toHaveText('', { timeout: 60_000 });
    const value = await translation.textContent();
    assert.notEqual(value, text);
    assert.match(value, /\p{Script=Han}/u);
    return value;
  };
  const pairs = async samples => {
    const result = [];
    for (const [index, text] of samples.entries()) {
      await seek(index * 4 + 0.15);
      result.push({ source: text, translation: await translated(text) });
    }
    return result;
  };
  const screenshot = async name => {
    const destination = path.join(root, 'test-results/youtube-live', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await page.locator('#movie_player').screenshot({ path: destination });
    return destination;
  };

  await expect.poll(async () => (await message({ action: 'subtitles:describe' })).configured, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(cc).toHaveAttribute('aria-pressed', 'false');
  assert.equal((await metrics()).requests.length, 0);
  const began = performance.now();
  await setEnabled(true);
  await translated(manualSamples[0]);
  const firstTranslationMs = Math.round(performance.now() - began);
  const manual = await pairs(manualSamples);
  await seek(0.15);
  await translated(manualSamples[0]);
  await record('controlled-manual', { fixture: true, realProvider: true, firstTranslationMs,
    status: await status(), page: await state(), metrics: await metrics(), pairs: manual,
    screenshot: await screenshot('firefox-real-provider-manual.png') });
  await setEnabled(false);
  await expect(cc).toHaveAttribute('aria-pressed', 'false');
  await expect(source).toHaveText('');
  const warmedCount = (await metrics()).requests.length;
  const restarted = performance.now();
  await setEnabled(true);
  await translated(manualSamples[0]);
  const cachedFirstTranslationMs = Math.round(performance.now() - restarted);
  await seek(8.15);
  await translated(manualSamples[2]);
  assert.equal((await metrics()).requests.length, warmedCount);
  await record('controlled-cache', { cachedFirstTranslationMs, requestsBefore: warmedCount,
    requestsAfterRestartAndSeek: (await metrics()).requests.length, ccRestoredOnFirstStop: true });

  await seek(0.15);
  const switched = performance.now();
  await page.locator('#asr').click();
  await translated(asrSamples[0]);
  const trackSwitchFirstTranslationMs = Math.round(performance.now() - switched);
  assert.equal((await status()).kind, 'asr');
  const automatic = await pairs(asrSamples);
  await seek(0.15);
  await translated(asrSamples[0]);
  await record('controlled-asr', { fixture: true, realProvider: true, trackSwitchFirstTranslationMs,
    status: await status(), page: await state(), metrics: await metrics(), pairs: automatic,
    screenshot: await screenshot('firefox-real-provider-asr.png') });
  await setEnabled(false);
  await expect(cc).toHaveAttribute('aria-pressed', 'true');
  await expect(source).toHaveText('');
  const nativeRestored = await page.evaluate(() => window.fixtureNativeNode === document.querySelector('.ytp-caption-segment')
    && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible');
  assert.equal(nativeRestored, true);
  assert.equal((await state()).muted, true);
  const final = await metrics();
  assert.ok(final.requests.length >= 2 && final.requests.length <= 4);
  assert.ok(final.requests.every(request => request.status === 200));
  await record('controlled-complete', { passed: true, fixture: true, authenticated: false,
    nativeNodeAndVisibilityRestored: nativeRestored, userSelectedTrackPreserved: true,
    page: await state(), status: await status(), metrics: final });
}
