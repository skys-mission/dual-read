// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readYouTubeState } from '../lib/subtitles/background';
import { manageYouTubeCaptionLease } from '../lib/subtitles/youtube-lease';
import { subtitlePreferencesForm } from '../lib/subtitles/preferences-ui';
import type { SubtitleConfig } from '../lib/subtitles/types';

const videoId = 'aaaaaaaaaaa';
function prepare() {
  history.replaceState({}, '', `/watch?v=${videoId}`);
  document.body.innerHTML = '<div id="movie_player"><button class="ytp-subtitles-button" aria-pressed="false"></button><div class="ytp-settings-menu"><button>Setting</button></div><div class="ytp-caption-segment">Original words</div></div>';
  const player = document.querySelector<HTMLElement>('#movie_player')!;
  const cc = player.querySelector<HTMLButtonElement>('.ytp-subtitles-button')!;
  const menu = player.querySelector<HTMLButtonElement>('.ytp-settings-menu button')!;
  const track: { vssId: string; languageCode: string; translationLanguage?: { languageCode: string } } = { vssId: '.en', languageCode: 'en' };
  const response: { videoDetails: { videoId: string }; captions?: { playerCaptionsTracklistRenderer: { captionTracks: unknown[] } } } = {
    videoDetails: { videoId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [track] } },
  };
  Object.assign(player, { getPlayerResponse: () => response, getOption: () => track });
  cc.onclick = () => cc.setAttribute('aria-pressed', String(cc.getAttribute('aria-pressed') !== 'true'));
  return { player, cc, menu, track, response };
}
const acquire = (token: string, deferActivation = false) => manageYouTubeCaptionLease({ action: 'acquire', token, videoId, deferActivation });
const release = (token: string) => manageYouTubeCaptionLease({ action: 'release', token, videoId });
afterEach(() => { document.dispatchEvent(new Event('dual-read:subtitles-destroy')); vi.useRealTimers(); document.body.replaceChildren(); });

describe('native caption state and ownership', () => {
  for (const initiallyOn of [false, true]) {
    it(`refreshes native CC once without changing ownership (initial on: ${initiallyOn})`, async () => {
      const { cc } = prepare();
      if (initiallyOn) cc.click();
      const off = vi.fn();
      document.addEventListener('dual-read:subtitles-cc-off:refresh', off, { once: true });
      acquire('refresh');
      const lease = (window as Window & { __dualReadSubtitleCCLease?: { refresh: () => boolean } }).__dualReadSubtitleCCLease!;
      expect(lease.refresh()).toBe(true); await Promise.resolve();
      expect(off).not.toHaveBeenCalled(); expect(lease.refresh()).toBe(false);
      release('refresh'); expect(cc.getAttribute('aria-pressed')).toBe(String(initiallyOn));
    });
  }
  it('does not refresh after a user changes native captions', async () => {
    const { cc } = prepare(); acquire('no-refresh'); cc.click(); await Promise.resolve();
    const lease = (window as Window & { __dualReadSubtitleCCLease?: { refresh: () => boolean } }).__dualReadSubtitleCCLease!;
    expect(lease.refresh()).toBe(false); expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
  it('distinguishes absent metadata, an empty track list, and ready tracks', () => {
    const { response } = prepare();
    expect(readYouTubeState().hasTracks).toBe(true);
    response.captions!.playerCaptionsTracklistRenderer.captionTracks = [];
    expect(readYouTubeState().hasTracks).toBe(false);
    delete response.captions;
    expect(readYouTubeState().hasTracks).toBeNull();
  });
  it('resolves language-only native selection only when its track is unambiguous', () => {
    const { player, response } = prepare();
    Object.assign(player, { getOption: () => ({ languageCode: 'en' }) });
    expect(readYouTubeState().trackId).toBe('.en');
    response.captions!.playerCaptionsTracklistRenderer.captionTracks.push({ vssId: '.en.second', languageCode: 'en' });
    expect(readYouTubeState().trackId).toBeUndefined();
  });
  it('does not expose automatically translated DOM as original text', () => {
    const { track } = prepare();
    expect(readYouTubeState().captionText).toBeUndefined();
    expect(readYouTubeState({ includeText: true }).captionText).toBe('Original words');
    track.translationLanguage = { languageCode: 'es' };
    expect(readYouTubeState({ includeText: true })).toMatchObject({ autoTranslated: true, sourceLanguage: 'en' });
    expect(readYouTubeState({ includeText: true }).captionText).toBeUndefined();
  });
  it('notifies external CC off, but not its own activation or restoration', async () => {
    const { cc } = prepare();
    const off = vi.fn();
    document.addEventListener('dual-read:subtitles-cc-off:notify', off, { once: true });
    acquire('notify'); await Promise.resolve();
    expect(off).not.toHaveBeenCalled();
    cc.setAttribute('aria-pressed', 'false'); await Promise.resolve();
    expect(off).toHaveBeenCalledOnce();
    release('notify'); expect(cc.getAttribute('aria-pressed')).toBe('false');
    const restored = vi.fn();
    document.addEventListener('dual-read:subtitles-cc-off:restore', restored, { once: true });
    acquire('restore'); release('restore'); await Promise.resolve();
    expect(restored).not.toHaveBeenCalled();
  });
  it('preserves pending external changes when released before observer delivery', async () => {
    const { cc } = prepare();
    acquire('pending');
    cc.setAttribute('aria-pressed', 'false'); cc.setAttribute('aria-pressed', 'true');
    release('pending'); await Promise.resolve();
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps ownership after a non-caption settings action', async () => {
    vi.useFakeTimers();
    const { cc, menu } = prepare();
    acquire('speed'); menu.click(); await vi.runAllTimersAsync(); release('speed');
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
  it('preserves an automatic-translation selection even if later changed back', async () => {
    vi.useFakeTimers();
    const { cc, menu, track } = prepare();
    acquire('translation');
    menu.onclick = () => { track.translationLanguage = { languageCode: 'es' }; };
    menu.click(); await vi.runAllTimersAsync();
    delete track.translationLanguage; release('translation');
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });
  it('ignores temporary CC state changes during an advertisement', async () => {
    const { cc, player } = prepare();
    const off = vi.fn();
    document.addEventListener('dual-read:subtitles-cc-off:ad', off, { once: true });
    acquire('ad'); player.classList.add('ad-showing');
    cc.setAttribute('aria-pressed', 'false'); await Promise.resolve();
    cc.setAttribute('aria-pressed', 'true'); await Promise.resolve();
    player.classList.remove('ad-showing');
    expect(off).not.toHaveBeenCalled(); release('ad');
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
  it('does not treat turning native CC on as an off event before activation', async () => {
    const { cc } = prepare();
    const off = vi.fn();
    document.addEventListener('dual-read:subtitles-cc-off:deferred-on', off, { once: true });
    acquire('deferred-on', true); cc.click(); await Promise.resolve(); release('deferred-on');
    expect(off).not.toHaveBeenCalled();
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });
  it('ignores state changes from a CC button replaced by the page', async () => {
    const { cc } = prepare();
    const off = vi.fn();
    document.addEventListener('dual-read:subtitles-cc-off:replaced', off, { once: true });
    acquire('replaced');
    const replacement = cc.cloneNode(true) as HTMLButtonElement;
    cc.replaceWith(replacement); cc.setAttribute('aria-pressed', 'false');
    await Promise.resolve(); release('replaced');
    expect(off).not.toHaveBeenCalled();
    expect(replacement.getAttribute('aria-pressed')).toBe('true');
  });
});

it('updates preferences in place and uses the latest values for the next change', async () => {
  const config: SubtitleConfig = {
    sessionId: 'test', revision: 1, providerFingerprint: 'test', mode: 'bilingual', targetLang: 'zh-CN',
    uiLocale: 'en', maxConcurrent: 2, batchSize: 5, disabled: false, youtubeAuto: false,
    preferences: { targetLang: null, textSize: 'medium', position: 'bottom' }, messages: { subtitleSize: 'Size' },
  };
  const change = vi.fn(async () => {});
  const form = subtitlePreferencesForm(config, { change, auto: async value => value });
  document.body.append(form);
  const controls = [...form.querySelectorAll('select')];
  // The popup displays the language field outside the collapsed options.
  const language = document.createElement('div'); language.append(form.firstElementChild!);
  document.body.prepend(language);
  controls[1].focus();
  form.update({ ...config, youtubeAuto: true, messages: { subtitleSize: '字号' }, preferences: { targetLang: 'fr', textSize: 'large', position: 'top' } });
  expect([...document.querySelectorAll('select')]).toEqual(controls);
  expect(controls[0].value).toBe('fr');
  expect(document.activeElement).toBe(controls[1]);
  expect(controls[1].getAttribute('aria-label')).toBe('字号');
  expect(form.querySelector('input')?.checked).toBe(true);
  controls[1].value = 'small'; controls[1].dispatchEvent(new Event('change'));
  await Promise.resolve();
  expect(change).toHaveBeenCalledWith({ targetLang: 'fr', textSize: 'small', position: 'top' });
});
