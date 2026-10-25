// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=aaaaaaaaaaa"}
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitleSession } from '../lib/subtitles/session';
import { initSubtitlePopup } from '../lib/subtitles/popup';
import { createDefaultSettings } from '../lib/settings/schema';
import type { SubtitleConfig } from '../lib/subtitles/types';

let session: SubtitleSession | undefined;
afterEach(() => {
  session?.dispose(); session = undefined;
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

function prepare() {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="movie_player"><video></video><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true"></button></div><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Original</span></div></div><main class="popup-body"><div class="link-row"></div></main>';
  let config: SubtitleConfig = {
    sessionId: 'first', revision: 1, providerFingerprint: 'test', mode: 'bilingual', targetLang: 'zh-CN',
    uiLocale: 'en', maxConcurrent: 1, batchSize: 5, disabled: false, youtubeAuto: false,
    preferences: { targetLang: null, textSize: 'medium', position: 'bottom' }, messages: {},
  };
  let fail = true;
  const observe = vi.fn(() => { if (fail) throw new Error('Renderer initialization failed'); });
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect; });
  const sendMessage = vi.fn(async (message: { action: string; enabled?: boolean }) => {
    if (message.action === 'subtitles:state') return { success: true, config,
      state: { videoId: 'aaaaaaaaaaa', trackId: 'a.en', sourceLanguage: 'en', hasTracks: true, ad: false, live: false, autoTranslated: false } };
    if (message.action === 'subtitles:describe') return { success: true, config, configured: true, disabled: false, status: session!.getStatus() };
    if (message.action === 'subtitles:setEnabled') {
      config = { ...config, sessionId: 'retry' }; session!.apply(message.enabled === true, config);
    }
    if (message.action === 'subtitles:source') return { success: true,
      result: { status: 'no-tracks', videoId: 'aaaaaaaaaaa', tracks: [], events: [] } };
    return { success: true };
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  session = new SubtitleSession(); session.apply(true, config);
  return { observe, disconnect, sendMessage, recover: () => { fail = false; } };
}

it('removes partially mounted UI when renderer initialization fails', async () => {
  const { disconnect } = prepare();
  const native = document.querySelector('.ytp-caption-segment');
  await vi.advanceTimersByTimeAsync(0);
  expect(session!.getStatus().state).toBe('source-error');
  expect(document.querySelectorAll('[data-dual-read-subtitle-ui]')).toHaveLength(0);
  expect(document.querySelector('.ytp-caption-segment')).toBe(native);
  expect(native?.textContent).toBe('Original');
  expect(disconnect).toHaveBeenCalledOnce();
});

it('lets the popup retry a failed initialization after one fixed cooldown', async () => {
  const { observe, sendMessage, recover } = prepare();
  await vi.advanceTimersByTimeAsync(0);
  const retryAt = session!.getStatus().retryAt;
  await initSubtitlePopup(1, createDefaultSettings(), () => {});
  const retry = document.querySelector<HTMLButtonElement>('#subtitlePrimary')!;
  expect(retry.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(observe).toHaveBeenCalledOnce();
  expect(session!.getStatus()).toMatchObject({ state: 'source-error', retryAt });
  expect(retry.disabled).toBe(false);
  expect(sendMessage.mock.calls.some(([m]) => m.action === 'subtitles:source')).toBe(false);
  recover(); retry.click(); await vi.advanceTimersByTimeAsync(0);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(sendMessage.mock.calls.filter(([m]) => m.action === 'subtitles:source')).toHaveLength(1);
  expect(session!.getStatus().state).toBe('no-tracks');
});
