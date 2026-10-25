// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cueAt, nearbyCues, normalizeYouTubeEvents } from '../lib/subtitles/normalize';
import { parseSubtitleTranslations, translateSubtitleItems } from '../lib/subtitles/translate';
import { sameSubtitleLanguage, youtubeVideoId } from '../lib/subtitles/types';
import { createDefaultSettings, parseSettings } from '../lib/settings/schema';
import { buildSettingsExport, prepareSettingsImport } from '../lib/settings/transfer';
import { collectUnits, isOursElement } from '../lib/collector';
import { walkOpenShadowRoots } from '../lib/roots';
import type { YouTubeCaptionEvent } from '../lib/subtitles/youtube-adapter';
import { setSubtitleAuto } from '../lib/subtitles/preferences-ui';
import { manageYouTubeCaptionLease } from '../lib/subtitles/youtube-lease';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('native CC ownership after permission revocation', () => {
  const prepare = () => {
    history.replaceState({}, '', '/watch?v=aaaaaaaaaaa');
    document.body.innerHTML = '<div id="movie_player"><button class="ytp-subtitles-button" aria-pressed="false"></button></div>';
    let track = '.en';
    const player = document.querySelector('#movie_player')!;
    const cc = player.querySelector<HTMLButtonElement>('button')!;
    Object.assign(player, { getPlayerResponse: () => ({ videoDetails: { videoId: 'aaaaaaaaaaa' } }), getOption: () => ({ vssId: track }) });
    cc.onclick = () => cc.setAttribute('aria-pressed', String(cc.getAttribute('aria-pressed') !== 'true'));
    return { cc, changeTrack: () => { track = 'a.en'; } };
  };
  it('releases through the existing page listener without new script permission', () => {
    const { cc } = prepare();
    expect(manageYouTubeCaptionLease({ action: 'acquire', token: 'test-one', videoId: 'aaaaaaaaaaa' })).toBe(true);
    document.dispatchEvent(new Event('dual-read:subtitles-release:test-one'));
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
  it('preserves a native track changed after activation', () => {
    const { cc, changeTrack } = prepare();
    manageYouTubeCaptionLease({ action: 'acquire', token: 'test-two', videoId: 'aaaaaaaaaaa' });
    changeTrack();
    document.dispatchEvent(new Event('dual-read:subtitles-release:test-two'));
    expect(cc.getAttribute('aria-pressed')).toBe('true');
  });
  it('does not release a newer lease when an older session stops', () => {
    const { cc } = prepare();
    manageYouTubeCaptionLease({ action: 'acquire', token: 'old', videoId: 'aaaaaaaaaaa' });
    manageYouTubeCaptionLease({ action: 'acquire', token: 'new', videoId: 'aaaaaaaaaaa' });
    document.dispatchEvent(new Event('dual-read:subtitles-release:old'));
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    document.dispatchEvent(new Event('dual-read:subtitles-release:new'));
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
  it('does not activate CC after a deferred lease has been cancelled', () => {
    const { cc } = prepare();
    manageYouTubeCaptionLease({ action: 'acquire', token: 'deferred', videoId: 'aaaaaaaaaaa', deferActivation: true });
    const lease = (window as Window & { __dualReadSubtitleCCLease?: { activate: () => boolean } }).__dualReadSubtitleCCLease!;
    expect(cc.getAttribute('aria-pressed')).toBe('false');
    document.dispatchEvent(new Event('dual-read:subtitles-release:deferred'));
    expect(lease.activate()).toBe(false);
    expect(cc.getAttribute('aria-pressed')).toBe('false');
  });
});

it('requests optional permission before yielding the original click stack', async () => {
  let persist!: () => void;
  const write = new Promise<void>(resolve => { persist = resolve; });
  const request = vi.fn(async () => true);
  const sendMessage = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('chrome', { storage: { local: { set: () => write, remove: vi.fn() } }, permissions: { request }, runtime: { sendMessage } });
  const result = setSubtitleAuto(true);
  expect(request).toHaveBeenCalledWith({ origins: ['https://www.youtube.com/*'] });
  expect(sendMessage).not.toHaveBeenCalled();
  persist();
  expect(await result).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith({ action: 'subtitles:autoGranted' });
});

describe('subtitle identity and normalization', () => {
  it('accepts only desktop watch video identities', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=M7lc1UVf-VE')).toBe('M7lc1UVf-VE');
    for (const url of ['https://evil.example/watch?v=M7lc1UVf-VE', 'https://www.youtube.com/shorts/M7lc1UVf-VE', 'http://www.youtube.com/watch?v=M7lc1UVf-VE', 'https://www.youtube.com/watch?v=short']) expect(youtubeVideoId(url)).toBeNull();
  });
  it('keeps Traditional Chinese distinct and handles regional source languages', () => {
    expect(sameSubtitleLanguage('en-US', 'en')).toBe(true);
    expect(sameSubtitleLanguage('zh-Hans', 'zh-CN')).toBe(true);
    expect(sameSubtitleLanguage('zh-TW', 'zh-CN')).toBe(false);
  });
  it('preserves repeated text at separate times and clears gaps / exact ends', () => {
    const cues = normalizeYouTubeEvents([
      { tStartMs: 100, dDurationMs: 200, segs: [{ utf8: 'Again' }] },
      { tStartMs: 500, dDurationMs: 200, segs: [{ utf8: 'Again' }] },
    ], 'manual');
    expect(cues).toHaveLength(2); expect(cues[0].id).not.toBe(cues[1].id);
    expect(cueAt(cues, 100)?.text).toBe('Again'); expect(cueAt(cues, 300)).toBeNull();
    expect(cueAt(cues, 450)).toBeNull(); expect(cueAt(cues, 500)?.id).toBe(cues[1].id);
  });
  it('composes overlapping manual windows without discarding either speaker', () => {
    const cues = normalizeYouTubeEvents([
      { tStartMs: 0, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'Speaker A' }] },
      { tStartMs: 1000, dDurationMs: 3000, wWinId: 2, segs: [{ utf8: 'Speaker B' }] },
    ], 'manual');
    expect(cueAt(cues, 500)?.text).toBe('Speaker A');
    expect(cueAt(cues, 2000)?.text).toBe('Speaker A\nSpeaker B');
    expect(cueAt(cues, 3500)?.text).toBe('Speaker B');
  });
  it('merges ASR append text, ignores rolling newlines, and honors explicit clear', () => {
    const cues = normalizeYouTubeEvents([
      { tStartMs: 0, dDurationMs: 4000, wWinId: 1, segs: [{ utf8: 'First', tOffsetMs: 0 }] },
      { tStartMs: 1000, dDurationMs: 3000, wWinId: 1, aAppend: 1, segs: [{ utf8: ' sentence', tOffsetMs: 0 }] },
      { tStartMs: 1500, dDurationMs: 1000, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 2000, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: 'Next sentence' }] },
      { tStartMs: 3500, wWinId: 1 },
    ], 'asr');
    expect(cues.map(c => c.text)).toEqual(['First sentence', 'Next sentence']);
    expect(cues[0].endMs).toBe(2000); expect(cues[1].endMs).toBe(3500);
  });
  for (const kind of ['manual', 'asr'] as const) {
    it(`preserves every word in the real redacted ${kind} sample`, () => {
      const sample = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../../docs/research/evidence/youtube-${kind}-redacted.json`), 'utf8')) as { events: YouTubeCaptionEvent[] };
      const cues = normalizeYouTubeEvents(sample.events, kind);
      const words = (text: string) => text.match(/word\d+/g) ?? [];
      expect(cues.flatMap(c => words(c.text))).toEqual(sample.events.flatMap(e => words(e.segs?.map(s => s.utf8).join('') ?? '')));
      expect(cues.every((c, i) => c.endMs > c.startMs && (!i || c.startMs >= cues[i - 1].endMs))).toBe(true);
      expect(new Set(cues.map(c => c.id)).size).toBe(cues.length);
      expect(nearbyCues(cues, 10_000, 2).every(c => c.startMs <= 70_000)).toBe(true);
      expect(nearbyCues(cues, 0, 20).length).toBeLessThanOrEqual(24);
    });
  }
});

describe('strict subtitle translation', () => {
  const items = [{ id: 'c0', revision: 1, text: 'First', context: 'Next' }, { id: 'c1', revision: 1, text: 'Next', context: 'First' }];
  it('aligns by explicit ID, never by return order', () => {
    expect(parseSubtitleTranslations('{"translations":[{"id":"c1","text":"乙"},{"id":"c0","text":"甲"}]}', items))
      .toEqual([{ id: 'c1', revision: 1, text: '乙' }, { id: 'c0', revision: 1, text: '甲' }]);
  });
  it('rejects unknown IDs and filters duplicate or invalid entries', () => {
    expect(() => parseSubtitleTranslations('{"translations":[{"id":"c9","text":"wrong"}]}', items)).toThrow();
    expect(parseSubtitleTranslations('{"translations":[{"id":"c0","text":"A"},{"id":"c0","text":"B"},{"id":"c1","text":2}]}', items)).toEqual([]);
  });
  it('retries only missing IDs with unchanged context', async () => {
    const bodies: { messages: { content: string }[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const translations = bodies.length === 1 ? [{ id: 'c0', text: '甲' }] : [{ id: 'c1', text: '乙' }];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
    }));
    expect(await translateSubtitleItems(items, 'en', createDefaultSettings())).toEqual([{ id: 'c0', revision: 1, text: '甲' }, { id: 'c1', revision: 1, text: '乙' }]);
    expect(JSON.parse(bodies[1].messages[1].content)).toEqual({ items: [items[1]] });
  });
  it('stops after two malformed results without broadcasting raw text', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'unstructured reply' } }] })));
    vi.stubGlobal('fetch', fetcher);
    await expect(translateSubtitleItems(items, 'en', createDefaultSettings())).rejects.toMatchObject({ code: 'RESPONSE_MALFORMED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('subtitle settings and page coexistence', () => {
  it('migrates v4 without changing page settings and cannot import auto opt-in', () => {
    const old = { schemaVersion: 4, apiKey: 'test-only', targetLang: 'es', mode: 'replace', siteRules: [{ host: 'example.com', disabled: true }] };
    const settings = parseSettings(old);
    expect(settings).toMatchObject({ ...old, schemaVersion: 5, subtitles: { targetLang: null, textSize: 'medium', position: 'bottom' }, youtubeAuto: false });
    expect(prepareSettingsImport({ youtubeAuto: true, subtitles: { targetLang: 'fr', textSize: 'large', position: 'top' } }))
      .toEqual({ subtitles: { targetLang: 'fr', textSize: 'large', position: 'top' } });
    expect(buildSettingsExport({ ...settings, youtubeAuto: true }, { includeApiKey: false, includeCustomHeaders: false })).not.toHaveProperty('youtubeAuto');
  });
  it('excludes subtitle UI shadow roots and native CC without changing page text', () => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-caption-window-container"><span>Native text</span></div></div><p>Ordinary article text is still available.</p>';
    const host = document.createElement('div'); host.setAttribute('data-dual-read-subtitle-ui', '');
    host.attachShadow({ mode: 'open' }).innerHTML = '<p>Owned subtitle text</p>';
    document.body.append(host);
    expect(isOursElement(host)).toBe(true);
    expect(walkOpenShadowRoots(document.body)).toEqual([]);
    expect(isOursElement(document.querySelector('.ytp-caption-window-container'))).toBe(true);
    expect(collectUnits(document.body).map(u => u.text).join(' ')).not.toMatch(/Native text|Owned subtitle text/);
    expect(document.querySelector('.ytp-caption-window-container span')?.textContent).toBe('Native text');
  });
});
