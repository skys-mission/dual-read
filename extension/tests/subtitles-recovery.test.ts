// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=aaaaaaaaaaa"}
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitleSession } from '../lib/subtitles/session';
import type { SubtitleConfig } from '../lib/subtitles/types';

let session: SubtitleSession;
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function prepare(invalidTimeline = false) {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="movie_player"><video></video><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true"></button></div></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 100));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const config: SubtitleConfig = { sessionId: 'test', revision: 1, providerFingerprint: 'test', mode: 'bilingual', targetLang: 'zh-CN',
    uiLocale: 'en', maxConcurrent: 1, batchSize: 5, disabled: false, youtubeAuto: false,
    preferences: { targetLang: null, textSize: 'medium', position: 'bottom' }, messages: {} };
  const send = vi.fn(async (m: { action: string }) => {
    if (m.action === 'subtitles:state') return { success: true, config, state: {
      videoId: 'aaaaaaaaaaa', trackId: 'a.en', sourceLanguage: 'en', hasTracks: true,
      ad: false, live: false, autoTranslated: false, captionText: '',
    } };
    if (m.action === 'subtitles:source') return { success: true, result: {
      status: invalidTimeline ? 'ready' : 'unavailable', videoId: 'aaaaaaaaaaa', trackId: 'a.en', sourceLanguage: 'en',
      tracks: [{ id: 'a.en', language: 'en', kind: 'asr' }],
      events: invalidTimeline ? [{ tStartMs: 0, segs: [{ utf8: 'Untimed text' }] }] : [],
    } };
    return { success: true };
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage: send }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  session = new SubtitleSession(); session.apply(true, config);
  return send;
}

it('limits automatic recovery to three attempts without restarting the realtime session', async () => {
  const send = prepare(); await vi.advanceTimersByTimeAsync(200000);
  const sources = send.mock.calls.filter(([m]) => m.action === 'subtitles:source');
  expect(sources).toHaveLength(4);
  expect(sources.slice(1).every(([m]) => (m as { recovery?: boolean }).recovery)).toBe(true);
  expect(new Set(sources.map(([m]) => (m as { generation?: number }).generation)).size).toBe(1);
  expect(session.getStatus()).toMatchObject({ enabled: true, state: 'realtime' });
  session.stop(); await vi.advanceTimersByTimeAsync(200000);
  expect(send.mock.calls.filter(([m]) => m.action === 'subtitles:source')).toHaveLength(4);
});

it('falls back to native captions when full-track timing cannot be normalized', async () => {
  prepare(true); await vi.advanceTimersByTimeAsync(1000);
  expect(session.getStatus()).toMatchObject({ enabled: true, state: 'realtime', sourceLanguage: 'en', kind: 'asr' });
});
