import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchSubtitleExtension } from './helpers/subtitle-extension';
import { startMockServer } from './helpers/mock-server';

const scenarios = [
  'reload-manual', 'reload-auto', 'native-menu-off', 'native-keyboard-off', 'native-off-preparing',
  'unrelated-settings', 'caption-selection', 'late-metadata', 'missing-metadata', 'empty-metadata',
  'translated-dom', 'translated-dom-switch', 'translated-full-track', 'preference-focus', 'ad-cc', 'replace-cc',
  'nested-controls', 'stale-poll', 'language-only-off', 'language-only-on', 'language-only-switch',
  'active-controls-replace', 'active-controls-nested', 'active-controls-delayed', 'active-controls-pending',
] as const;

async function installNativeControls(page: Page) {
  await page.evaluate(() => {
    const p = document.querySelector('#movie_player') as any;
    const read = p.getOption;
    p.getOption = () => ({ ...read(), ...((window as any).autoTranslated ? { translationLanguage: { languageCode: 'es' } } : {}) });
    const add = (id: string, change: () => void) => {
      const button = document.createElement('button'); button.id = id; button.textContent = id; button.onclick = change;
      p.querySelector('.ytp-settings-menu').append(button);
    };
    const off = () => p.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false');
    add('cc-off', off);
    add('speed', () => { p.querySelector('video').playbackRate = 2; });
    add('translate-native', () => {
      (window as any).autoTranslated = true;
      p.querySelector('.ytp-caption-segment').textContent = 'Texto traducido por YouTube.';
    });
    add('original-native', () => {
      (window as any).autoTranslated = false;
      p.querySelector('.ytp-caption-segment').textContent = 'Original native caption.';
    });
    document.addEventListener('keydown', event => { if (event.key === 'c') off(); });
  });
}

for (const scenario of scenarios) {
  test(`subtitle review regression: ${scenario}`, async ({}, info) => {
    const mock = await startMockServer();
    const fx = await launchSubtitleExtension(info.project.name === 'firefox-ext' ? 'firefox' : 'chromium', { subtitleStateBarrier: scenario === 'stale-poll' });
    try {
      const html = await fs.readFile(new URL('./fixtures/youtube-player.html', import.meta.url), 'utf8');
      const video = await fs.readFile(new URL('./fixtures/subtitle-clock.webm', import.meta.url));
      const page = fx.context.pages().find(p => p.url() === 'about:blank') ?? fx.context.pages()[0] ?? await fx.context.newPage();
      let sourceRequests = 0;
      await page.route('https://www.youtube.com/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/timedtext') {
          sourceRequests++;
          if (scenario === 'native-off-preparing') await new Promise(resolve => setTimeout(resolve, 1000));
          const events = Array.from({ length: 30 }, (_, i) => ({ tStartMs: i * 4000, dDurationMs: 3500,
            segs: [{ utf8: `${url.searchParams.get('kind') === 'asr' ? 'Automatic' : 'Original'} caption ${i + 1}` }] }));
          await route.fulfill({ contentType: 'application/json', body: scenario.startsWith('translated-dom') ? '' : JSON.stringify({ events }) });
        } else if (url.pathname === '/fixture.webm') {
          const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
          await route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm', body: video.subarray(start, end + 1),
            headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${video.length}` } : {}) } });
        } else await route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('https://www.youtube.com/watch?v=aaaaaaaaaaa');
      await fx.message(page, { action: 'test:seed', apiBase: mock.apiBase });
      await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
      await installNativeControls(page);
      if (scenario.startsWith('language-only-')) await page.evaluate(() => {
        const player = document.querySelector('#movie_player') as any;
        const read = player.getOption;
        player.getOption = () => {
          const track = { ...read() }; delete track.vssId; delete track.vss_id; return track;
        };
      });
      if (scenario === 'language-only-on') await page.locator('.ytp-subtitles-button').click();
      if (scenario === 'active-controls-pending') mock.setResponseDelay(1800);
      if (scenario === 'nested-controls') await page.evaluate(() => {
        const controls = document.querySelector('.ytp-right-controls')!;
        const group = document.createElement('div'); group.className = 'ytp-right-controls-left';
        group.style.cssText = 'display:flex;height:100%';
        group.append(...controls.childNodes); controls.append(group);
        // Idle extension UI can already exist before this page-owned regrouping.
        // Restoration must retain only the native nodes, in their original order.
        (window as any).expectedControlNodes = [...group.childNodes].filter(node =>
          !(node instanceof Element && node.matches('[data-dual-read-subtitle-ui]')));
      });
      if (scenario === 'late-metadata' || scenario === 'missing-metadata') await page.evaluate(() => {
        const p = document.querySelector('#movie_player') as any;
        const read = p.getPlayerResponse;
        p.getPlayerResponse = () => { const value = read(); if (!(window as any).metadataReady) delete value.captions; return value; };
      });
      if (scenario === 'empty-metadata') await page.evaluate(() => { (window as any).noTracks = true; });
      if (scenario === 'translated-dom' || scenario === 'translated-full-track') {
        await page.locator('.ytp-subtitles-button').click();
        await page.locator('#translate-native').click();
      }
      if (scenario === 'reload-auto') {
        await fx.message(page, { action: 'test:autoPolicy', enabled: true });
        await page.reload();
      } else expect(await fx.message(page, { action: 'subtitles:setEnabled', enabled: true })).toEqual({ success: true });
      const status = () => fx.message(page, { action: 'test:status' });
      const source = page.locator('.lines .source');
      const translation = page.locator('.lines .line:not(.source)');
      if (scenario === 'late-metadata' || scenario === 'missing-metadata' || scenario === 'empty-metadata') {
        await expect.poll(async () => (await status()).state).toBe(scenario === 'empty-metadata' ? 'no-tracks' : 'source-error');
        expect(sourceRequests).toBe(0); expect(mock.getRequestCount()).toBe(0);
        if (scenario === 'missing-metadata') {
          await page.waitForTimeout(1500);
          expect((await status()).state).toBe('source-error');
          expect(sourceRequests).toBe(0); return;
        }
        await page.evaluate(() => { (window as any).metadataReady = true; (window as any).noTracks = false; });
        await expect(translation).toHaveText('译:Original caption 1');
        return;
      }
      if (scenario === 'native-off-preparing') {
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('#cc-off').click();
        await expect.poll(async () => (await status()).enabled).toBe(false);
        await page.waitForTimeout(1400);
        expect(mock.getRequestCount()).toBe(0);
        await expect(source).toHaveText('');
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
        return;
      }
      if (scenario.startsWith('translated-dom')) {
        if (scenario === 'translated-dom-switch') {
          await expect(translation).toHaveText('译:Native caption retained by the page', { timeout: 12000 });
          await page.locator('#translate-native').click();
        }
        await expect.poll(async () => (await status()).state, { timeout: 12000 }).toBe('original-required');
        await expect(source).toHaveText('');
        await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
        expect(mock.getSubtitleRequests().flat().some(item => item.text.includes('Texto'))).toBe(false);
        if (scenario === 'translated-dom') expect(mock.getRequestCount()).toBe(0);
        const count = mock.getRequestCount();
        await page.waitForTimeout(650); expect(mock.getRequestCount()).toBe(count);
        await page.locator('#original-native').click();
        await expect(translation).toHaveText('译:Original native caption.', { timeout: 12000 });
        expect((await status()).state).toBe('realtime');
        expect(mock.getSubtitleRequests().flat().some(item => item.text.includes('Texto'))).toBe(false);
        return;
      }
      if (scenario.startsWith('active-controls-')) {
        await expect(source).toHaveText('Original caption 1');
        if (scenario === 'active-controls-pending') await expect.poll(() => mock.getRequestCount()).toBeGreaterThan(0);
        else await expect(translation).toHaveText('译:Original caption 1');
        const sourceCount = sourceRequests;
        await page.evaluate(scenario => {
          const player = document.querySelector('#movie_player')!;
          const controls = player.querySelector('.ytp-right-controls')!;
          const native = [...controls.childNodes].filter(node => !(node instanceof Element && node.hasAttribute('data-dual-read-subtitle-ui')));
          const added = document.createElement('button'); added.textContent = 'Page control';
          // Reorder and insert page-owned nodes before recording the contract.
          const expected = [added, ...native.reverse()];
          const replacement = document.createElement('div'); replacement.className = 'ytp-right-controls';
          const group = scenario === 'active-controls-nested' ? document.createElement('div') : replacement;
          if (group !== replacement) { group.className = 'ytp-right-controls-left'; replacement.append(group); }
          group.append(...expected);
          (window as any).expectedControlNodes = expected;
          (window as any).expectedControlContainer = group;
          (window as any).expectedCaptionLease = (window as any).__dualReadSubtitleCCLease;
          const original = player.querySelector('.ytp-caption-segment')!;
          original.append(document.createTextNode(' Page edit.'));
          const caption = document.createElement('span'); caption.className = 'ytp-caption-segment'; caption.textContent = 'Page-added caption'; original.before(caption);
          (window as any).expectedNativeNodes = [caption, original];
          if (scenario === 'active-controls-delayed') {
            controls.remove(); (window as any).replacementControls = replacement;
          } else controls.replaceWith(replacement);
        }, scenario);
        if (scenario === 'active-controls-delayed') {
          await page.waitForTimeout(1000);
          await expect(page.getByRole('button', { name: 'Turn off subtitle translation', exact: true })).toHaveCount(0);
          await expect(translation).toHaveText('译:Original caption 1');
          await page.evaluate(() => document.querySelector('#movie_player')!.append((window as any).replacementControls));
        }
        const toggle = page.getByRole('button', { name: 'Turn off subtitle translation', exact: true });
        await expect(toggle).toBeVisible(); await expect(toggle).toHaveCount(1);
        await expect(translation).toHaveText('译:Original caption 1');
        expect((await status()).enabled).toBe(true);
        expect(sourceRequests).toBe(sourceCount);
        expect(mock.getSubtitleRequests().flat().filter(item => item.text === 'Original caption 1')).toHaveLength(1);
        expect(await page.evaluate(() => (window as any).expectedCaptionLease === (window as any).__dualReadSubtitleCCLease)).toBe(true);
        await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
        await page.getByLabel('Position', { exact: true }).selectOption('top');
        await expect(page.locator('.lines')).toHaveAttribute('data-position', 'top');
        await page.getByLabel('Position', { exact: true }).press('Escape');
        if (scenario === 'active-controls-nested') {
          await page.locator('#asr').click();
          await expect(translation).toHaveText('译:Automatic caption 1');
          await toggle.click();
        } else if (scenario === 'active-controls-delayed') await page.locator('#cc-off').click();
        else await toggle.click();
        await expect.poll(async () => (await status()).enabled).toBe(false);
        await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', scenario === 'active-controls-nested' ? 'true' : 'false');
        await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
        await fx.message(page, { action: 'test:reinject' });
        await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).expectedControlNodes.every((node: Node, i: number) =>
          node === (window as any).expectedControlContainer.childNodes[i]))).toBe(true);
        expect(await page.evaluate(() => (window as any).expectedNativeNodes.every((node: Node, i: number) =>
          node === document.querySelectorAll('.ytp-caption-segment')[i]))).toBe(true);
        await expect(page.locator('.ytp-caption-segment')).toHaveText(['Page-added caption', 'Native caption retained by the page Page edit.']);
        return;
      }
      await expect(translation).toHaveText('译:Original caption 1');
      if (scenario === 'stale-poll') {
        await fx.message(page, { action: 'test:holdSubtitleState' });
        await expect.poll(async () => (await fx.message(page, { action: 'test:subtitleStateBarrier' })).held).toBe(true);
        await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
        await fx.message(page, { action: 'subtitles:setEnabled', enabled: true });
        await expect(translation).toHaveText('译:Original caption 1');
        await fx.message(page, { action: 'test:releaseSubtitleState' });
        await expect.poll(async () => (await fx.message(page, { action: 'test:subtitleStateBarrier' })).result?.code).toBe('SESSION_CANCELLED');
        await page.waitForTimeout(600);
        expect((await status()).enabled).toBe(true);
        await expect(translation).toHaveText('译:Original caption 1');
        await page.locator('video').evaluate(video => { (video as HTMLVideoElement).currentTime = 8; });
        await expect(translation).toHaveText('译:Original caption 3');
        return;
      }
      if (scenario.startsWith('language-only-')) {
        if (scenario === 'language-only-switch') {
          await page.locator('#asr').click();
          await expect(translation).toHaveText('译:Automatic caption 1');
        }
        for (let i = 0; i < 2; i++) await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
        await expect.poll(async () => (await status()).enabled).toBe(false);
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', scenario === 'language-only-off' ? 'false' : 'true');
        await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
        expect(await page.evaluate(() => (window as any).fixtureNativeNode === document.querySelector('.ytp-caption-segment'))).toBe(true);
        return;
      }
      if (scenario === 'replace-cc') {
        await page.locator('.ytp-subtitles-button').evaluate(cc => {
          const replacement = cc.cloneNode(true);
          cc.replaceWith(replacement); cc.setAttribute('aria-pressed', 'false');
        });
        await page.waitForTimeout(600);
        expect((await status()).enabled).toBe(true);
        await expect(translation).toHaveText('译:Original caption 1');
        // The old lease must not make the replacement's real off state inert.
        await page.locator('.ytp-subtitles-button').evaluate(cc => cc.setAttribute('aria-pressed', 'false'));
        await expect.poll(async () => (await status()).enabled).toBe(false);
        const count = mock.getRequestCount();
        await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 80; });
        await page.waitForTimeout(600); expect(mock.getRequestCount()).toBe(count);
        await expect(source).toHaveText('');
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'false');
        return;
      }
      if (scenario.startsWith('reload-')) {
        await page.locator('#asr').click();
        await expect(translation).toHaveText('译:Automatic caption 1');
        const before = (await fx.message(page, { action: 'subtitles:describe' })).config.sessionId;
        await page.reload();
        await expect(translation).toHaveText('译:Original caption 1');
        const after = (await fx.message(page, { action: 'subtitles:describe' })).config.sessionId;
        expect(after).not.toBe(before);
        expect(await fx.message(page, { action: 'subtitles:source', sessionId: before, generation: 999, videoId: 'aaaaaaaaaaa' }))
          .toMatchObject({ success: false, code: 'SESSION_CANCELLED' });
        await expect(translation).toHaveText('译:Original caption 1');
        await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
        await page.reload();
        await page.waitForTimeout(750);
        await expect(page.getByRole('button', { name: 'Enable bilingual subtitles', exact: true })).toBeVisible();
        expect((await status()).enabled).toBe(false);
        return;
      }
      if (scenario === 'native-menu-off' || scenario === 'native-keyboard-off') {
        if (scenario === 'native-menu-off') await page.locator('#cc-off').click();
        else await page.keyboard.press('c');
        await expect.poll(async () => (await status()).enabled).toBe(false);
        const count = mock.getRequestCount();
        await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 80; });
        await page.waitForTimeout(750);
        expect(mock.getRequestCount()).toBe(count);
        await expect(source).toHaveText('');
        await page.locator('.ytp-subtitles-button').click();
        expect((await status()).enabled).toBe(false);
        await page.reload();
        await expect(page.getByRole('button', { name: 'Enable bilingual subtitles', exact: true })).toBeVisible();
        expect((await status()).enabled).toBe(false);
        return;
      }
      if (scenario === 'preference-focus') {
        await page.getByRole('button', { name: 'Subtitle options', exact: true }).click();
        const size = page.getByLabel('Text size', { exact: true });
        await size.focus();
        const originalControl = await size.elementHandle();
        await size.selectOption('large');
        await expect.poll(async () => (await fx.message(page, { action: 'test:preferences' })).subtitles.textSize).toBe('large');
        await page.waitForTimeout(600);
        await expect(size).toBeFocused();
        expect(await originalControl!.evaluate(node => node.isConnected)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Subtitle options' })).toBeHidden();
        await expect(page.getByRole('button', { name: 'Subtitle options', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Subtitle options', exact: true }).press('Enter');
        const position = page.getByLabel('Position', { exact: true });
        await position.focus(); await position.selectOption('top');
        await expect(page.locator('.lines')).toHaveAttribute('data-position', 'top');
        await expect(position).toBeFocused();
        await page.locator('#movie_player').screenshot({ path: info.outputPath('settings-focus.png') });
        return;
      }
      if (scenario === 'translated-full-track') {
        await expect(source).toHaveText('Original caption 1');
        expect(mock.getSubtitleRequests().flat().some(item => item.text.includes('Texto'))).toBe(false);
        await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
        await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
        return;
      }
      if (scenario === 'ad-cc') {
        await page.locator('#ad').click();
        await page.locator('.ytp-subtitles-button').evaluate(cc => cc.setAttribute('aria-pressed', 'false'));
        await expect(source).toHaveText('');
        await page.waitForTimeout(600);
        expect((await status()).enabled).toBe(true);
        await page.locator('.ytp-subtitles-button').evaluate(cc => cc.setAttribute('aria-pressed', 'true'));
        await page.waitForTimeout(50);
        await page.locator('#ad').click();
        await expect(translation).toHaveText('译:Original caption 1');
      }
      // Page edits and node identities must survive both owned restoration and
      // a user-owned track change. Expectations come from the page operations.
      await page.evaluate(() => {
        const node = document.querySelector('.ytp-caption-segment')!;
        node.append(document.createTextNode(' Page edit.'));
        const added = document.createElement('span'); added.className = 'ytp-caption-segment'; added.textContent = 'Page-added caption';
        node.before(added);
        (window as any).expectedNativeNodes = [added, node];
      });
      if (scenario === 'caption-selection' || scenario === 'nested-controls') {
        await page.locator('#asr').click();
        await expect(translation).toHaveText('译:Automatic caption 1');
      } else await page.locator('#speed').click();
      for (let i = 0; i < 2; i++) await fx.message(page, { action: 'subtitles:setEnabled', enabled: false });
      await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', scenario === 'caption-selection' || scenario === 'nested-controls' ? 'true' : 'false');
      expect(await page.evaluate(() => (window as any).expectedNativeNodes.every((n: Node, i: number) => n === document.querySelectorAll('.ytp-caption-segment')[i]))).toBe(true);
      await expect(page.locator('.ytp-caption-segment')).toHaveText(['Page-added caption', 'Native caption retained by the page Page edit.']);
      await expect(page.locator('.ytp-caption-window-container')).toHaveCSS('visibility', 'visible');
      if (scenario === 'nested-controls') {
        await expect(page.getByRole('button', { name: 'Enable bilingual subtitles', exact: true })).toHaveCount(1);
        await fx.message(page, { action: 'test:reinject' });
        await expect(page.locator('[data-dual-read-subtitle-ui]')).toHaveCount(0);
        expect(await page.evaluate(() => (window as any).expectedControlNodes.every((node: Node, i: number) =>
          node === document.querySelector('.ytp-right-controls-left')!.childNodes[i]))).toBe(true);
      }
    } finally { await fx.close(); await mock.close(); }
  });
}
