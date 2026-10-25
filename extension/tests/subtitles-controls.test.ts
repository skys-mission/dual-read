// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=aaaaaaaaaaa"}
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitleSession } from '../lib/subtitles/session';
import type { SubtitleConfig } from '../lib/subtitles/types';
import { initSubtitlePopup } from '../lib/subtitles/popup';
import { createDefaultSettings } from '../lib/settings/schema';

let session: SubtitleSession | undefined;
afterEach(() => { session?.dispose(); session = undefined; window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const config: SubtitleConfig = { sessionId: 'idle', revision: 1, providerFingerprint: 'test', mode: 'bilingual', targetLang: 'zh-CN',
  uiLocale: 'en', maxConcurrent: 1, batchSize: 5, disabled: false, youtubeAuto: false,
  preferences: { targetLang: null, textSize: 'medium', position: 'bottom' }, messages: {} };
function prepare() {
  vi.useFakeTimers(); history.replaceState({}, '', '/watch?v=aaaaaaaaaaa');
  document.body.innerHTML = '<div id="movie_player"><video></video><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="false"></button></div><span class="ytp-caption-segment">Page original</span></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const sendMessage = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  session = new SubtitleSession();
  return { sendMessage, native: document.querySelector('.ytp-caption-segment')! };
}
const buttons = () => [...document.querySelectorAll('[data-dual-read-subtitle-ui]')].flatMap(n => [...n.shadowRoot?.querySelectorAll<HTMLButtonElement>('.toggle') ?? []]);

it('mounts idle controls without reading captions, toggling CC, or issuing service messages', async () => {
  const { native, sendMessage } = prepare(); session!.showControls(config);
  await vi.advanceTimersByTimeAsync(1500);
  expect(buttons()).toHaveLength(1); expect(buttons()[0].getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('.ytp-caption-segment')).toBe(native);
  expect(native.textContent).toBe('Page original');
  expect(document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelector('[data-dual-read-subtitle-source]')).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  buttons()[0].click();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('waits for late controls and remounts only its own nodes after controls are replaced', async () => {
  const { native, sendMessage } = prepare();
  const player = document.querySelector('#movie_player')!;
  const controls = player.querySelector('.ytp-right-controls')!; controls.remove();
  session!.showControls(config); expect(buttons()).toHaveLength(0);
  player.append(controls); await vi.advanceTimersByTimeAsync(500); expect(buttons()).toHaveLength(1);
  const replacement = document.createElement('div'); replacement.className = 'ytp-right-controls';
  const newCC = document.createElement('button'); newCC.className = 'ytp-subtitles-button'; replacement.append(newCC);
  controls.replaceWith(replacement); await vi.advanceTimersByTimeAsync(500);
  expect(buttons()).toHaveLength(1); expect(replacement.firstChild).toBe(newCC);
  expect(document.querySelector('.ytp-caption-segment')).toBe(native); expect(sendMessage).not.toHaveBeenCalled();
});

it('removes idle UI outside watch pages and when the site policy is disabled', async () => {
  const { native, sendMessage } = prepare(); session!.showControls(config);
  history.replaceState({}, '', '/'); await vi.advanceTimersByTimeAsync(500); expect(buttons()).toHaveLength(0);
  history.replaceState({}, '', '/watch?v=bbbbbbbbbbb'); document.dispatchEvent(new Event('yt-navigate-finish'));
  expect(buttons()).toHaveLength(1);
  session!.showControls({ ...config, disabled: true }); await vi.advanceTimersByTimeAsync(1000);
  expect(buttons()).toHaveLength(0); expect(document.querySelector('.ytp-caption-segment')).toBe(native);
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([true, false])('requests withheld YouTube access in the click stack; consent=%s does not gate the manual action', async granted => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main class="popup-body"><div class="link-row"></div></main>';
  const request = vi.fn(async () => granted);
  const sendMessage = vi.fn(async (m: { action: string }) => m.action === 'subtitles:describe'
    ? { success: true, configured: true, disabled: false, persistentAccess: false, config, status: { enabled: false, state: 'off' } }
    : { success: true });
  vi.stubGlobal('chrome', { runtime: { sendMessage }, permissions: { request } });
  await initSubtitlePopup(1, createDefaultSettings(), () => {});
  expect(request).not.toHaveBeenCalled();
  document.querySelector<HTMLButtonElement>('#subtitlePrimary')!.click();
  expect(request).toHaveBeenCalledWith({ origins: ['https://www.youtube.com/*'] });
  expect(sendMessage).toHaveBeenCalledWith({ action: 'subtitles:setEnabled', tabId: 1, enabled: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage.mock.calls.some(([m]) => m.action === 'subtitles:autoGranted')).toBe(false);
});
