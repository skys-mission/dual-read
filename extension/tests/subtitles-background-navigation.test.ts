// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../lib/settings/schema';
import { getSettings, saveSettings } from '../lib/settings/storage';
import { settingsForBatch } from '../lib/settings/session-config';
import { authorizeSubtitleBatch, installSubtitleBackground, readYouTubeState, type SubtitleBatchIdentity } from '../lib/subtitles/background';
import { probeYouTubeSource } from '../lib/subtitles/youtube-adapter';
import { YOUTUBE_ORIGIN } from '../lib/subtitles/types';

vi.mock('../lib/settings/storage', async importOriginal => ({ ...await importOriginal<typeof import('../lib/settings/storage')>(),
  getSettings: vi.fn(), saveSettings: vi.fn(async () => {}) }));
vi.mock('../lib/settings/session-config', () => ({
  buildPublicSessionConfig: vi.fn(async (_settings, _host, options) => ({ ...options, disabled: false })),
  settingsForBatch: vi.fn(async settings => settings),
}));
vi.mock('../lib/i18n', () => ({ getUiMessagesByPrefix: vi.fn(async () => ({})) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function prepare() {
  const settings = { ...createDefaultSettings(), connectionMode: 'proxy' as const, targetLang: 'zh-CN' as const };
  vi.mocked(getSettings).mockResolvedValue(settings);
  const events: Record<string, (...args: unknown[]) => unknown> = {};
  const on = (name: string) => ({ addListener: (fn: (...args: unknown[]) => unknown) => { events[name] = fn; } });
  const memory: Record<string, { sessionId: string }> = {};
  let tabUrl = `${YOUTUBE_ORIGIN}/watch?v=aaaaaaaaaaa`;
  const tab = (): chrome.tabs.Tab => ({ id: 1, url: tabUrl, index: 0, windowId: 1, pinned: false,
    highlighted: true, active: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1 });
  const send = vi.fn(async (_id, message) => message.action === 'subtitle:ping' ? { instanceId: 'document' } : { success: true });
  const execute = vi.fn(async (injection: { func?: unknown }) => [{ result: injection.func === readYouTubeState
    ? { videoId: 'aaaaaaaaaaa', hasTracks: true, trackId: '.en', sourceLanguage: 'en' }
    : injection.func === probeYouTubeSource ? { status: 'ready', videoId: 'aaaaaaaaaaa', trackId: '.en', sourceLanguage: 'en', tracks: [], events: [] } : true }]);
  const createTab = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: on('message'), onStartup: on('startup') },
    permissions: { contains: vi.fn(async () => true), onAdded: on('added'), onRemoved: on('removed') },
    scripting: { executeScript: execute, getRegisteredContentScripts: async () => [{ id: 'dual-read-youtube-auto' }] },
    tabs: { query: async () => [tab()], get: async () => tab(), sendMessage: send, create: createTab, onRemoved: on('removedTab'), onUpdated: on('updatedTab') },
    storage: { local: { get: async () => ({}), remove: vi.fn() }, session: {
      get: async () => memory, set: async (value: Record<string, unknown>) => Object.assign(memory, value),
      remove: async (key: string) => { delete memory[key]; },
    }, onChanged: on('storage') },
  });
  installSubtitleBackground();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(1, expect.objectContaining({ action: 'subtitle:controls' }), { frameId: 0 }));
  const sender: chrome.runtime.MessageSender = { id: 'test', frameId: 0, tab: tab(), url: `${YOUTUBE_ORIGIN}/`, origin: YOUTUBE_ORIGIN };
  const ui: chrome.runtime.MessageSender = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const message = (value: Record<string, unknown>, from = sender) => new Promise<unknown>(resolve => events.message(value, from, resolve));
  const intent = () => memory['dualReadSubtitleIntent:1'];
  const batch = (): SubtitleBatchIdentity => ({
    sessionId: intent().sessionId, videoId: 'aaaaaaaaaaa', trackId: '.en', generation: 1,
    sourceLanguage: 'en', targetLang: 'zh-CN', providerFingerprint: 'test', items: [{ id: 'cue-1', revision: 1, text: 'Original', context: '' }],
  });
  return { settings, sender, ui, message, intent, batch, execute, createTab, navigate: (url: string) => { tabUrl = url; } };
}

it.each(['/', '/results?search_query=captions', '/@fixture', '/shorts/bbbbbbbbbbb', '/watch?v=bbbbbbbbbbb'])(
  'authorizes the entire subtitle path after a same-document navigation from %s', async path => {
    const f = await prepare(); f.sender.url = YOUTUBE_ORIGIN + path;
    expect(await f.message({ action: 'subtitles:autoStart' })).toEqual({ success: true });
    expect(await f.message({ action: 'subtitles:setEnabled', enabled: true })).toEqual({ success: true });
    const sessionId = f.intent().sessionId;
    expect(await f.message({ action: 'subtitles:state', sessionId })).toMatchObject({ success: true, state: { videoId: 'aaaaaaaaaaa' } });
    expect(await f.message({ action: 'subtitles:source', sessionId, videoId: 'aaaaaaaaaaa', generation: 1 })).toMatchObject({ success: true, result: { status: 'ready' } });
    await expect(authorizeSubtitleBatch(f.batch(), f.sender, f.settings)).resolves.toBe(f.settings);
    expect(settingsForBatch).toHaveBeenCalledOnce();
    expect(await f.message({ action: 'subtitles:preferences', preferences: { targetLang: null, textSize: 'large', position: 'top' } })).toEqual({ success: true });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(await f.message({ action: 'subtitles:openOptions' })).toEqual({ success: true });
    expect(f.createTab).toHaveBeenCalledOnce();
    expect(await f.message({ action: 'subtitles:release', token: `${sessionId}-1`, videoId: 'aaaaaaaaaaa' })).toEqual({ success: true });
    expect(await f.message({ action: 'subtitles:setEnabled', enabled: false })).toEqual({ success: true });
  },
);

it('allows popup start and retry to use the same home-page document without accepting the previous session', async () => {
  const f = await prepare();
  expect(await f.message({ action: 'subtitles:setEnabled', tabId: 1, enabled: true }, f.ui)).toEqual({ success: true });
  const previous = f.intent().sessionId;
  expect(await f.message({ action: 'subtitles:state', sessionId: previous })).toMatchObject({ success: true });
  expect(await f.message({ action: 'subtitles:setEnabled', tabId: 1, enabled: true }, f.ui)).toEqual({ success: true });
  expect(f.intent().sessionId).not.toBe(previous);
  expect(await f.message({ action: 'subtitles:state', sessionId: f.intent().sessionId })).toMatchObject({ success: true });
  expect(await f.message({ action: 'subtitles:state', sessionId: previous })).toMatchObject({ success: false, code: 'SESSION_CANCELLED' });
});

it.each([
  { url: 'https://www.youtube.com.evil.example/watch?v=aaaaaaaaaaa' },
  { url: 'http://www.youtube.com/watch?v=aaaaaaaaaaa' },
  { url: 'https://example.com/' }, { url: 'about:blank' }, { url: undefined },
  { origin: 'https://example.com' }, { frameId: 1 }, { frameId: undefined }, { id: 'another-extension' }, { tab: undefined },
])('rejects an untrusted sender: %j', async override => {
  const f = await prepare(); Object.assign(f.sender, override);
  for (const action of ['subtitles:setEnabled', 'subtitles:preferences', 'subtitles:openOptions']) {
    expect(await f.message({ action, enabled: true, preferences: f.settings.subtitles })).toMatchObject({ success: false, code: 'PAGE_UNSUPPORTED' });
  }
  expect(f.execute).not.toHaveBeenCalled(); expect(saveSettings).not.toHaveBeenCalled(); expect(f.createTab).not.toHaveBeenCalled();
});

it.each([`${YOUTUBE_ORIGIN}/`, `${YOUTUBE_ORIGIN}/results?search_query=captions`, 'https://example.com/'])(
  'uses the live tab to reject actions after leaving watch for %s', async url => {
    const f = await prepare(); f.sender.url = `${YOUTUBE_ORIGIN}/watch?v=aaaaaaaaaaa`; f.navigate(url);
    for (const action of ['subtitles:setEnabled', 'subtitles:preferences', 'subtitles:openOptions']) {
      expect(await f.message({ action, enabled: true, preferences: f.settings.subtitles })).toMatchObject({ success: false, code: 'PAGE_UNSUPPORTED' });
    }
    expect(f.execute).not.toHaveBeenCalled(); expect(saveSettings).not.toHaveBeenCalled(); expect(f.createTab).not.toHaveBeenCalled();
  },
);

it('retains current video, track and generation authorization after trusting the document origin', async () => {
  const f = await prepare();
  await f.message({ action: 'subtitles:setEnabled', tabId: 1, enabled: true }, f.ui);
  // Establish a complete authorized session independently of the sender route.
  Object.assign(f.intent(), { videoId: 'aaaaaaaaaaa', trackId: '.en', sourceLanguage: 'en', generation: 1 });
  const original = f.batch();
  for (const override of [{ videoId: 'bbbbbbbbbbb' }, { trackId: 'a.en' }, { generation: 0 }, { sessionId: 'old' }]) {
    await expect(authorizeSubtitleBatch({ ...original, ...override }, f.sender, f.settings)).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
  }
  f.navigate(`${YOUTUBE_ORIGIN}/watch?v=bbbbbbbbbbb`);
  await expect(authorizeSubtitleBatch(original, f.sender, f.settings)).rejects.toMatchObject({ code: 'SESSION_CANCELLED' });
  expect(settingsForBatch).not.toHaveBeenCalled();
});
