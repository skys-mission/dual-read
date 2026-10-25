// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=aaaaaaaaaaa"}
import { afterEach, expect, it, vi } from 'vitest';
import { SubtitleSession } from '../lib/subtitles/session';
import { translateBatchViaPort } from '../lib/messaging';
import type { SubtitleConfig } from '../lib/subtitles/types';

vi.mock('../lib/cache', () => ({ lookup: vi.fn(async (texts: string[]) => texts.map(() => null)), store: vi.fn(async () => {}) }));
vi.mock('../lib/messaging', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/messaging')>(), translateBatchViaPort: vi.fn(),
}));

let session: SubtitleSession;
afterEach(() => { session?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren(); });

function prepare(targetLang: SubtitleConfig['targetLang'] = 'en') {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="movie_player"><video></video><div class="ytp-right-controls"><button class="ytp-subtitles-button" aria-pressed="true">CC</button><button>Fullscreen</button></div><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Native words</span></div></div>';
  let failMount = false;
  vi.stubGlobal('ResizeObserver', class {
    observe() { if (failMount) { failMount = false; throw new Error('Mount failed'); } }
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 100));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `Translated ${text}`));
  let config: SubtitleConfig = {
    sessionId: 'first', revision: 1, providerFingerprint: 'test', targetLang,
    uiLocale: 'en', mode: 'bilingual', maxConcurrent: 1, batchSize: 5, disabled: false,
    youtubeAuto: false, preferences: { targetLang: null, textSize: 'medium', position: 'bottom' }, messages: {},
  };
  const state = { videoId: 'aaaaaaaaaaa', trackId: '.en', sourceLanguage: 'en', hasTracks: true, ad: false, live: false, autoTranslated: false };
  let hold = false;
  let finish: ((reply: unknown) => void) | undefined;
  const send = vi.fn(async (message: { action: string; sessionId?: string; generation?: number }) => {
    if (message.action === 'subtitles:state') {
      if (hold) { hold = false; return new Promise(resolve => { finish = resolve; }); }
      return { success: true, config, state };
    }
    if (message.action === 'subtitles:source') return { success: true, result: {
      status: 'ready', videoId: 'aaaaaaaaaaa', trackId: '.en', sourceLanguage: 'en',
      tracks: [{ id: '.en', language: 'en', kind: 'manual' }],
      events: [{ tStartMs: 0, dDurationMs: 30000, segs: [{ utf8: 'Original caption' }] }],
    } };
    return { success: true };
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage: send }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  session = new SubtitleSession(); session.apply(true, config);
  return {
    send,
    failNextMount: () => { failMount = true; },
    restart: () => { session.apply(false); config = { ...config, sessionId: 'second' }; session.apply(true, config); },
    holdPoll: async () => { hold = true; await vi.advanceTimersByTimeAsync(500); expect(finish).toBeTypeOf('function'); },
    finishPoll: (code?: string) => finish!(code ? { success: false, code } : { success: true, state, config: { ...config, sessionId: 'first' } }),
  };
}

function owned(selector: string): Element[] {
  return [...document.querySelectorAll('[data-dual-read-subtitle-ui]')].flatMap(node => [...node.shadowRoot?.querySelectorAll(selector) ?? []]);
}

it.each(['restart', 'seek'].flatMap(reset => ['success', 'SESSION_CANCELLED', 'UPSTREAM_UNAVAILABLE'].map(outcome => [reset, outcome])))('ignores an obsolete poll after %s: %s', async (reset, outcome) => {
  const fixture = prepare(); await vi.advanceTimersByTimeAsync(100);
  await fixture.holdPoll();
  if (reset === 'restart') fixture.restart();
  else document.querySelector('video')!.dispatchEvent(new Event('seeking'));
  await vi.advanceTimersByTimeAsync(100);
  expect(session.getStatus()).toMatchObject({ enabled: true, state: 'same-language' });
  fixture.finishPoll(outcome === 'success' ? undefined : outcome);
  await vi.advanceTimersByTimeAsync(100);
  expect(session.getStatus()).toMatchObject({ enabled: true, state: 'same-language' });
  expect(owned('.source')[0].textContent).toBe('Original caption');
});

it('still stops on a cancellation belonging to the current session', async () => {
  const fixture = prepare(); await vi.advanceTimersByTimeAsync(100);
  await fixture.holdPoll(); fixture.finishPoll('SESSION_CANCELLED'); await vi.advanceTimersByTimeAsync(100);
  expect(session.getStatus()).toMatchObject({ enabled: false, state: 'off' });
  expect(owned('.source')[0].textContent).toBe('');
});

it.each(['direct', 'nested', 'delayed'])('restores active controls while preserving page nodes and the caption lease: %s', async shape => {
  const { send } = prepare(); await vi.advanceTimersByTimeAsync(100);
  const player = document.querySelector('#movie_player')!;
  const controls = player.querySelector('.ytp-right-controls')!;
  const original = player.querySelector('.ytp-caption-segment')!;
  original.append(document.createTextNode(' Page edit.'));
  const added = document.createElement('span'); added.className = 'ytp-caption-segment'; added.textContent = 'Added words'; original.before(added);
  const nativeControls = [...controls.childNodes].filter(node => !(node instanceof Element && node.hasAttribute('data-dual-read-subtitle-ui')));
  const replacement = document.createElement('div'); replacement.className = 'ytp-right-controls';
  const group = shape === 'nested' ? document.createElement('div') : replacement;
  if (group !== replacement) replacement.append(group);
  group.append(...nativeControls);
  if (shape === 'delayed') {
    controls.remove(); await vi.advanceTimersByTimeAsync(1000);
    expect(owned('.toggle')).toHaveLength(0);
    expect(owned('.source')[0].textContent).toBe('Original caption');
    player.append(replacement);
  } else controls.replaceWith(replacement);
  await vi.advanceTimersByTimeAsync(1000);
  expect(owned('.toggle')).toHaveLength(1);
  expect(owned('.toggle')[0].getAttribute('aria-pressed')).toBe('true');
  expect(owned('.source')[0].textContent).toBe('Original caption');
  expect([...group.childNodes].filter(node => !(node instanceof Element && node.hasAttribute('data-dual-read-subtitle-ui')))).toEqual(nativeControls);
  expect([...player.querySelectorAll('.ytp-caption-segment')]).toEqual([added, original]);
  expect(original.textContent).toBe('Native words Page edit.');
  const sources = send.mock.calls.filter(([m]) => m.action === 'subtitles:source');
  expect(sources).toHaveLength(1);
  const identity = sources[0][0];
  // The original MAIN-world lease must still be able to stop this session.
  document.dispatchEvent(new Event(`dual-read:subtitles-cc-off:${identity.sessionId}-${identity.generation}`));
  expect(session.getStatus()).toMatchObject({ enabled: false, state: 'off' });
  expect(owned('.toggle')[0].getAttribute('aria-pressed')).toBe('false');
  expect(player.hasAttribute('data-dual-read-subtitle-source')).toBe(false);
});

it('keeps in-flight translation and its source identity across a control remount', async () => {
  const { send } = prepare('zh-CN');
  let finish: ((texts: string[]) => void) | undefined;
  vi.mocked(translateBatchViaPort).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(200);
  expect(finish).toBeTypeOf('function');
  const signal = vi.mocked(translateBatchViaPort).mock.calls[0][1].signal!;
  const controls = document.querySelector('.ytp-right-controls')!;
  const replacement = document.createElement('div'); replacement.className = 'ytp-right-controls';
  replacement.append(controls.querySelector('.ytp-subtitles-button')!); controls.replaceWith(replacement);
  await vi.advanceTimersByTimeAsync(1000);
  expect(owned('.toggle')).toHaveLength(1); expect(signal.aborted).toBe(false);
  finish!(['Translated original']); await vi.advanceTimersByTimeAsync(100);
  expect(owned('.line:not(.source)')[0].textContent).toBe('Translated original');
  expect(translateBatchViaPort).toHaveBeenCalledOnce();
  expect(send.mock.calls.filter(([m]) => m.action === 'subtitles:source')).toHaveLength(1);
});

it('cleans up a failed remount and retries without restarting caption acquisition', async () => {
  const { send, failNextMount } = prepare(); await vi.advanceTimersByTimeAsync(100);
  const cc = document.querySelector('.ytp-subtitles-button')!;
  const controlHost = cc.nextElementSibling!;
  controlHost.remove(); failNextMount();
  await vi.advanceTimersByTimeAsync(500);
  expect(owned('.toggle')).toHaveLength(0);
  expect(document.querySelectorAll('[data-dual-read-subtitle-ui]')).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(owned('.toggle')).toHaveLength(1);
  expect(document.querySelectorAll('[data-dual-read-subtitle-ui]')).toHaveLength(3);
  expect(owned('.source')[0].textContent).toBe('Original caption');
  expect(document.querySelector('.ytp-subtitles-button')).toBe(cc);
  expect(send.mock.calls.filter(([m]) => m.action === 'subtitles:source')).toHaveLength(1);
});
