import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSessionConfig } from '../lib/types';

type FrameProbe = {
  frameId: number;
  result: { version: string | null; runtimeId: string | null } | null;
};

const sendMessage = vi.fn();
const executeScript = vi.fn();
const insertCSS = vi.fn();
const getManifest = vi.fn(() => ({ version: '1.2.3' }));
const RUNTIME_ID = 'test-extension-id';

vi.stubGlobal('chrome', {
  runtime: {
    id: RUNTIME_ID,
    getManifest,
    lastError: undefined as chrome.runtime.LastError | undefined,
  },
  tabs: { sendMessage },
  scripting: { executeScript, insertCSS },
});

describe('ensureContentScript', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMessage.mockReset();
    executeScript.mockReset();
    insertCSS.mockReset();
    getManifest.mockReturnValue({ version: '1.2.3' });
    chrome.runtime.lastError = undefined;
  });

  function pingOk(version = '1.2.3', runtimeId: string | null = RUNTIME_ID): void {
    sendMessage.mockImplementation((...args: unknown[]) => {
      const cb = args.at(-1) as (r: unknown) => void;
      cb({ pong: true, version, runtimeId });
    });
  }

  it('reuses a live selected-frame binding without re-executing the script', async () => {
    pingOk();

    const { ensureFrameContentScript } = await import('../lib/inject');
    await expect(ensureFrameContentScript(17, 3)).resolves.toBe(true);
    await expect(ensureFrameContentScript(17, 3)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2]).toEqual({ frameId: 3 });
    expect(executeScript).not.toHaveBeenCalled();
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it('injects a selected frame once when missing, then reuses it', async () => {
    sendMessage
      .mockImplementationOnce((...args: unknown[]) => {
        const cb = args.at(-1) as (r: unknown) => void;
        chrome.runtime.lastError = { message: 'no receiver' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      })
      .mockImplementation((...args: unknown[]) => {
        const cb = args.at(-1) as (r: unknown) => void;
        cb({ pong: true, version: '1.2.3', runtimeId: RUNTIME_ID });
      });
    executeScript.mockResolvedValueOnce([]);
    insertCSS.mockResolvedValueOnce(undefined);

    const { ensureFrameContentScript } = await import('../lib/inject');
    await expect(ensureFrameContentScript(21, 4)).resolves.toBe(true);
    await expect(ensureFrameContentScript(21, 4)).resolves.toBe(true);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 21, frameIds: [4] },
      files: ['dual-read.js'],
    });
    expect(insertCSS).toHaveBeenCalledTimes(1);
  });

  it('reports failure when a disposed selection handler declines without replying', async () => {
    let frameResult: unknown;
    executeScript.mockImplementationOnce(async (options: {
      func: (...args: unknown[]) => unknown;
      args: unknown[];
    }) => {
      const scope = globalThis as typeof globalThis & {
        __DUAL_READ__?: {
          handleMessage: (
            request: unknown,
            sender: unknown,
            reply: (response: unknown) => void,
          ) => boolean;
        };
      };
      const previous = scope.__DUAL_READ__;
      scope.__DUAL_READ__ = {
        // Mirrors a binding whose onDestroy set disposed=true.
        version: '1.2.3',
        runtimeId: RUNTIME_ID,
        restore: () => undefined,
        stopWatch: () => undefined,
        handleMessage: () => false,
      };
      try {
        frameResult = await options.func(...options.args);
        return [{ frameId: 4, result: frameResult }];
      } finally {
        if (previous) scope.__DUAL_READ__ = previous;
        else delete scope.__DUAL_READ__;
      }
    });
    const config: PublicSessionConfig = {
      sessionId: 'selection-test',
      revision: 1,
      targetLang: 'zh-CN',
      uiLocale: 'en',
      mode: 'bilingual',
      maxConcurrent: 3,
      batchSize: 6,
      providerFingerprint: 'test-provider',
      disabled: false,
    };

    const { runSelectionInFrame } = await import('../lib/inject');
    await expect(runSelectionInFrame(31, 4, config, 'selected text')).resolves.toBe(false);
    expect(frameResult).toEqual({
      ok: false,
      payload: {
        success: false,
        error: 'selection handler declined without a reply',
      },
    });
  });

  it('does not re-execute dual-read.js on frames that already have this build', async () => {
    pingOk();
    executeScript.mockResolvedValueOnce([
      { frameId: 0, result: { version: '1.2.3', runtimeId: RUNTIME_ID } },
      { frameId: 2, result: { version: '1.2.3', runtimeId: RUNTIME_ID } },
    ] satisfies FrameProbe[]);

    const { ensureContentScript } = await import('../lib/inject');
    await expect(ensureContentScript(42)).resolves.toBe(true);

    // Probe only — no files inject when every frame is current.
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].files).toBeUndefined();
    expect(insertCSS).not.toHaveBeenCalled();
  });

  it('injects only into frames missing the current build', async () => {
    pingOk();
    executeScript
      .mockResolvedValueOnce([
        { frameId: 0, result: { version: '1.2.3', runtimeId: RUNTIME_ID } },
        { frameId: 5, result: null },
        { frameId: 9, result: { version: '0.9.0', runtimeId: RUNTIME_ID } },
      ] satisfies FrameProbe[])
      .mockResolvedValueOnce([]);
    insertCSS.mockResolvedValueOnce(undefined);

    const { ensureContentScript } = await import('../lib/inject');
    await expect(ensureContentScript(7)).resolves.toBe(true);

    expect(executeScript).toHaveBeenCalledTimes(2);
    const injectCall = executeScript.mock.calls[1][0];
    expect(injectCall.files).toEqual(['dual-read.js']);
    expect(injectCall.target).toEqual({ tabId: 7, frameIds: [5, 9] });
    expect(insertCSS).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [5, 9] },
      files: ['dual-read.css'],
    });
  });

  it('re-injects frames orphaned after an extension reload', async () => {
    pingOk();
    executeScript
      .mockResolvedValueOnce([
        { frameId: 0, result: { version: '1.2.3', runtimeId: RUNTIME_ID } },
        { frameId: 4, result: { version: '1.2.3', runtimeId: 'dead-old-context' } },
      ] satisfies FrameProbe[])
      .mockResolvedValueOnce([]);
    insertCSS.mockResolvedValueOnce(undefined);

    const { ensureContentScript } = await import('../lib/inject');
    await expect(ensureContentScript(11)).resolves.toBe(true);

    const injectCall = executeScript.mock.calls[1][0];
    expect(injectCall.target).toEqual({ tabId: 11, frameIds: [4] });
  });

  it('fully injects when the main frame has no content script', async () => {
    sendMessage
      .mockImplementationOnce((_tabId, _msg, cb: (r: unknown) => void) => {
        chrome.runtime.lastError = { message: 'no receiver' };
        cb(undefined);
        chrome.runtime.lastError = undefined;
      })
      .mockImplementationOnce((_tabId, _msg, cb: (r: unknown) => void) => {
        cb({ pong: true, version: '1.2.3', runtimeId: RUNTIME_ID });
      });
    executeScript.mockResolvedValueOnce([]);
    insertCSS.mockResolvedValueOnce(undefined);

    const { ensureContentScript } = await import('../lib/inject');
    await expect(ensureContentScript(3)).resolves.toBe(true);

    const injectCall = executeScript.mock.calls[0][0];
    expect(injectCall.files).toEqual(['dual-read.js']);
    expect(injectCall.target).toEqual({ tabId: 3, allFrames: true });
  });

  it('fully injects when ping lacks runtimeId (legacy orphan)', async () => {
    sendMessage
      .mockImplementationOnce((_tabId, _msg, cb: (r: unknown) => void) => {
        cb({ pong: true, version: '1.2.3' });
      })
      .mockImplementationOnce((_tabId, _msg, cb: (r: unknown) => void) => {
        cb({ pong: true, version: '1.2.3', runtimeId: RUNTIME_ID });
      });
    executeScript.mockResolvedValueOnce([]);
    insertCSS.mockResolvedValueOnce(undefined);

    const { ensureContentScript } = await import('../lib/inject');
    await expect(ensureContentScript(8)).resolves.toBe(true);

    expect(executeScript.mock.calls[0][0].files).toEqual(['dual-read.js']);
  });
});
