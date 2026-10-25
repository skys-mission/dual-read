// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../lib/settings/schema';
import { getSettings } from '../lib/settings/storage';
import { installSubtitleBackground } from '../lib/subtitles/background';

vi.mock('../lib/settings/storage', async importOriginal => ({ ...await importOriginal<typeof import('../lib/settings/storage')>(), getSettings: vi.fn(), saveSettings: vi.fn(async () => {}) }));
vi.mock('../lib/settings/session-config', () => ({ buildPublicSessionConfig: vi.fn(async (_settings, _host, options) => ({ ...options, disabled: false })), settingsForBatch: vi.fn() }));
vi.mock('../lib/i18n', () => ({ getUiMessagesByPrefix: vi.fn(async () => ({})) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function prepare(granted: boolean) {
  vi.mocked(getSettings).mockResolvedValue(createDefaultSettings());
  const events: Record<string, (...args: unknown[]) => unknown> = {};
  const on = (name: string) => ({ addListener: (fn: (...args: unknown[]) => unknown) => { events[name] = fn; } });
  const memory: Record<string, unknown> = {};
  let injected = false;
  let scripts: { id: string }[] = [];
  const send = vi.fn(async (_id, m) => {
    if (m.action === 'subtitle:ping') return injected ? { instanceId: 'doc' } : null;
    if (m.action === 'subtitle:destroy') injected = false;
    return { success: true };
  });
  const register = vi.fn(async (value: { id: string }[]) => { scripts = value; });
  const unregister = vi.fn(async () => { scripts = []; });
  const execute = vi.fn(async () => { injected = true; return []; });
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: on('message'), onStartup: on('startup') },
    permissions: { contains: vi.fn(async () => granted), onAdded: on('added'), onRemoved: on('removed') },
    scripting: { executeScript: execute, getRegisteredContentScripts: async () => scripts, registerContentScripts: register, unregisterContentScripts: unregister },
    tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }],
      get: async (id: number) => ({ id, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }), sendMessage: send, onRemoved: on('tabRemoved'), onUpdated: on('tabUpdated') },
    storage: { local: { get: async () => ({}), remove: vi.fn() }, session: {
      get: async () => memory, set: async (value: Record<string, unknown>) => Object.assign(memory, value), remove: async () => {},
    }, onChanged: on('storage') },
  });
  installSubtitleBackground();
  return { events, execute, send, register, unregister, grant: (value: boolean) => { granted = value; } };
}

it('registers an idle YouTube entry point with host access while automatic translation remains off', async () => {
  const { send, register } = prepare(true);
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(1, expect.objectContaining({ action: 'subtitle:controls' }), { frameId: 0 }));
  expect(register).toHaveBeenCalledWith([expect.objectContaining({ matches: ['https://www.youtube.com/*'], js: ['youtube-start.js'], allFrames: false })]);
  expect(send.mock.calls.some(([, m]) => m.action === 'subtitle:apply')).toBe(false);
});

it('does not inject without host access, but an explicit popup can show current-tab controls', async () => {
  const { events, execute, register, send } = prepare(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(execute).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  const reply = await new Promise<unknown>(resolve => events.message({ action: 'subtitles:describe', tabId: 1 }, { id: 'test', url: 'chrome-extension://test/popup.html' }, resolve));
  expect(reply).toMatchObject({ success: true, persistentAccess: false });
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ files: ['youtube-subtitles.js'] }));
  expect(send.mock.calls.some(([, m]) => m.action === 'subtitle:apply')).toBe(false);
});

it('mounts after a new host grant and removes idle UI when it is revoked', async () => {
  const { events, send, register, unregister, grant } = prepare(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  grant(true); events.added();
  await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(send.mock.calls.some(([, m]) => m.action === 'subtitle:controls')).toBe(true));
  grant(false); events.removed();
  await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(send.mock.calls.some(([, m]) => m.action === 'subtitle:destroy')).toBe(true));
});
