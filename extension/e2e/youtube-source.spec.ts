import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { launchProbeBrowser, runSourceProbe, summarizeProbe } from '../tools/youtube-source-probe/browser.mjs';

const manual = { events: [
  { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'A synthetic caption.' }] },
  { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'A synthetic caption.' }] },
] };
const asr = { events: [
  { tStartMs: 0, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'Synthetic', tOffsetMs: 0 }, { utf8: ' speech', tOffsetMs: 600 }] },
  { tStartMs: 1000, dDurationMs: 2000, wWinId: 1, aAppend: 1, segs: [{ utf8: '\ncontinues', tOffsetMs: 0 }] },
  { tStartMs: 3000, wWinId: 1 },
] };

test.describe('G0 real extension source bridge', () => {
  for (const scenario of [
    'xhr-off', 'fetch-off', 'cc-on-midplay', 'asr', 'empty', 'no-tracks',
    'missing-metadata', 'spa', 'late-spa', 'track-change', 'user-cc', 'hooks', 'untrusted-url',
    'attribute-cc', 'replaced-cc', 'player-replaced', 'archived-live', 'live',
    'native-track-shape', 'native-track-id', 'stale-player-id', 'malformed', 'invalid-events', 'same-cc-attribute', 'ad',
    'asr-cc-off-hidden-selection', 'recorded-manual', 'recorded-asr',
  ]) {
    test(scenario, async ({}, testInfo) => {
      const fx = await launchProbeBrowser(testInfo.project.name === 'firefox-ext' ? 'firefox' : 'chromium');
      try {
        const page = await fx.context.newPage();
        const fixture = await fs.readFile(new URL('./fixtures/youtube-source.html', import.meta.url), 'utf8');
        // Real JSON3 timing/append structure, with source words replaced before
        // saving. Keep these distinct from the deliberately synthetic cases.
        const sample = scenario.startsWith('recorded-') ? JSON.parse(await fs.readFile(
          new URL(`../../docs/research/evidence/youtube-${scenario.slice('recorded-'.length)}-redacted.json`, import.meta.url), 'utf8',
        )) as typeof manual : null;
        const manualSource = scenario === 'recorded-manual' ? sample! : manual;
        const asrSource = scenario === 'recorded-asr' ? sample! : asr;
        let requests = 0;
        let unexpectedRequests = 0;
        const delayed = ['late-spa', 'track-change', 'user-cc', 'hooks', 'attribute-cc', 'replaced-cc', 'player-replaced', 'same-cc-attribute'].includes(scenario);
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'https://www.youtube.com') { unexpectedRequests++; await route.abort(); return; }
          if (url.pathname === '/api/timedtext') {
            requests++;
            if (delayed) await new Promise(resolve => setTimeout(resolve, 180));
            await route.fulfill({ status: 200, contentType: 'application/json', body: scenario === 'empty' ? ''
              : scenario === 'malformed' ? '<html>not captions</html>'
                : scenario === 'invalid-events' ? JSON.stringify({ events: [{ tStartMs: -1, dDurationMs: 1000, segs: [{ utf8: 'Invalid timing' }] }] })
              : JSON.stringify(url.searchParams.get('kind') === 'asr' ? asrSource : manualSource) });
          } else {
            await route.fulfill({ contentType: 'text/html', body: fixture,
              headers: { 'Content-Security-Policy': "script-src 'nonce-g0-fixture'; object-src 'none'" } });
          }
        });
        const query = scenario === 'fetch-off' ? '&transport=fetch' : scenario === 'cc-on-midplay' ? '&cc=on' : '';
        await page.goto(`https://www.youtube.com/watch?v=aaaaaaaaaaa${query}`);
        if (scenario === 'cc-on-midplay') {
          await expect.poll(() => page.evaluate(() => (window as any).g0NativeBodies.length)).toBe(1);
          await page.locator('video').evaluate(v => { (v as HTMLVideoElement).currentTime = 33; });
        }
        if (['asr', 'native-track-id', 'asr-cc-off-hidden-selection', 'recorded-asr'].includes(scenario)) await page.locator('#asr').click();
        if (scenario === 'asr-cc-off-hidden-selection') await page.evaluate(() => {
          const p = document.querySelector('#movie_player') as any;
          const read = p.getOption;
          p.getOption = () => p.querySelector('button').getAttribute('aria-pressed') === 'true' ? read() : {};
        });
        if (scenario === 'ad') await page.locator('#movie_player').evaluate(p => p.classList.add('ad-showing'));
        if (['native-track-shape', 'native-track-id', 'stale-player-id', 'archived-live', 'live'].includes(scenario)) await page.evaluate(kind => {
          const p = document.querySelector('#movie_player') as any;
          if (kind === 'native-track-shape') p.getOption = () => ({ languageCode: 'en', kind: '' });
          if (kind === 'native-track-id') p.getOption = () => ({ languageCode: 'en', vss_id: 'a.en', kind: 'asr' });
          if (kind === 'stale-player-id') p.getVideoData = () => ({ video_id: 'bbbbbbbbbbb' });
          if (kind === 'archived-live' || kind === 'live') {
            const read = p.getPlayerResponse;
            p.getPlayerResponse = () => {
              const data = read();
              data.videoDetails.isLiveContent = true;
              data.videoDetails.isLive = kind === 'live';
              return data;
            };
          }
        }, scenario);
        if (scenario === 'no-tracks' || scenario === 'missing-metadata') await page.evaluate(missing => {
          (document.querySelector('#movie_player') as any).getPlayerResponse = () => ({
            videoDetails: { videoId: 'aaaaaaaaaaa' },
            ...(missing ? {} : { captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } } }),
          });
        }, scenario === 'missing-metadata');
        if (scenario === 'untrusted-url') await page.evaluate(() => {
          const p = document.querySelector('#movie_player') as any;
          const original = p.getPlayerResponse;
          p.getPlayerResponse = () => {
            const data = original();
            for (const track of data.captions.playerCaptionsTracklistRenderer.captionTracks) track.baseUrl = 'https://example.org/private';
            return data;
          };
        });
        if (scenario === 'spa') await page.locator('#next-video').click();
        const pending = runSourceProbe(page, {
          expectedVideoId: scenario === 'spa' ? 'bbbbbbbbbbb' : 'aaaaaaaaaaa',
          enableNativeCC: scenario !== 'untrusted-url', timeoutMs: 600,
        });
        if (delayed) {
          await expect(page.locator('.ytp-subtitles-button')).toHaveAttribute('aria-pressed', 'true');
          if (scenario === 'late-spa') await page.locator('#next-video').click();
          if (scenario === 'track-change') await page.locator('#asr').click();
          if (scenario === 'user-cc') await page.locator('.ytp-subtitles-button').click();
          if (scenario === 'attribute-cc') await page.evaluate(() => {
            const cc = document.querySelector('.ytp-subtitles-button')!;
            cc.setAttribute('aria-pressed', 'false');
            cc.setAttribute('aria-pressed', 'true');
          });
          if (scenario === 'same-cc-attribute') await page.evaluate(() => {
            document.querySelector('.ytp-subtitles-button')!.setAttribute('aria-pressed', 'true');
          });
          if (scenario === 'replaced-cc' || scenario === 'player-replaced') await page.evaluate(kind => {
            const node = document.querySelector(kind === 'replaced-cc' ? '.ytp-subtitles-button' : '#movie_player')!;
            node.replaceWith(node.cloneNode(true));
          }, scenario);
          if (scenario === 'hooks') await page.evaluate(() => {
            const previousFetch = window.fetch;
            const previousOpen = XMLHttpRequest.prototype.open;
            (window as any).g0LaterFetch = window.fetch = (...args) => previousFetch(...args);
            (window as any).g0LaterOpen = XMLHttpRequest.prototype.open = function (
              this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null,
            ) {
              previousOpen.call(this, method, url, async, username, password);
            };
          });
        }
        const result = await pending;
        expect(result.isolated).toBe(true);
        expect(result.elapsedMs).toBeLessThan(2000);
        expect(unexpectedRequests).toBe(0);
        expect(JSON.stringify(result)).not.toMatch(/fixture-only|baseUrl|signature=|pot=/);
        const state = await page.evaluate(() => ({
          cc: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
          fetchRestored: window.fetch === (window as any).g0InitialFetch,
          xhrRestored: XMLHttpRequest.prototype.open === (window as any).g0InitialOpen,
          laterFetch: window.fetch === (window as any).g0LaterFetch,
          laterXHR: XMLHttpRequest.prototype.open === (window as any).g0LaterOpen,
          nativeBodies: (window as any).g0NativeBodies,
          time: document.querySelector('video')?.currentTime,
        }));
        if (scenario === 'hooks') {
          expect(state.laterFetch).toBe(true);
          expect(state.laterXHR).toBe(true);
        } else {
          expect(state.fetchRestored).toBe(true);
          expect(state.xhrRestored).toBe(true);
        }
        if (['late-spa', 'track-change', 'player-replaced'].includes(scenario)) {
          expect(result.status).toBe('stale');
          expect(result.events).toEqual([]);
          expect(result.cc.restored).toBe(false);
          expect(state.cc).toBe('true');
        } else if (['no-tracks', 'live', 'stale-player-id', 'ad'].includes(scenario)) {
          expect(result.status).toBe(scenario === 'no-tracks' ? 'no-tracks' : scenario === 'live' ? 'unsupported' : scenario === 'ad' ? 'unavailable' : 'stale');
          expect(requests).toBe(0);
        } else if (['empty', 'missing-metadata', 'untrusted-url', 'malformed', 'invalid-events'].includes(scenario)) {
          expect(result.status).toBe('unavailable');
          expect(result.events).toEqual([]);
          if (scenario === 'empty') {
            expect(result.reason).toBe('empty-caption-body');
            expect(requests).toBeLessThanOrEqual(2);
            expect(result.cc.restored).toBe(true);
          } else if (scenario === 'malformed' || scenario === 'invalid-events') {
            expect(result.reason).toBe('caption-source-unavailable');
            expect(requests).toBeLessThanOrEqual(2);
            expect(result.cc.restored).toBe(true);
          } else expect(requests).toBe(0);
        } else {
          expect(result.status).toBe('ready');
          const isASR = ['asr', 'native-track-id', 'asr-cc-off-hidden-selection', 'recorded-asr'].includes(scenario);
          const expected = isASR ? asrSource : manualSource;
          expect(result.trackId).toBe(isASR ? 'a.en' : '.en');
          expect(result.events).toEqual(expected.events);
          expect(state.nativeBodies[0]).toBe(JSON.stringify(expected));
          if (scenario === 'cc-on-midplay') {
            expect(result.cc.enabledByProbe).toBe(false);
            expect(state.cc).toBe('true');
            expect(state.time).toBe(33);
            expect(result.observations.some((o: { via: string }) => o.via === 'replay')).toBe(true);
          } else if (scenario === 'user-cc') {
            expect(result.cc.externalChange).toBe(true);
            expect(result.cc.restored).toBe(false);
            expect(state.cc).toBe('false');
          } else if (scenario === 'attribute-cc' || scenario === 'replaced-cc') {
            if (scenario === 'attribute-cc') expect(result.cc.externalChange).toBe(true);
            expect(result.cc.restored).toBe(false);
            expect(state.cc).toBe('true');
          } else {
            expect(result.cc.externalChange).toBe(false);
            expect(result.cc.restored).toBe(true);
            expect(state.cc).toBe('false');
          }
        }
        const report = summarizeProbe(result);
        expect(JSON.stringify(report)).not.toContain('synthetic caption');
        await testInfo.attach('source-probe', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
      } finally { await fx.close(); }
    });
  }
});
