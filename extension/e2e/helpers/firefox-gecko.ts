/**
 * Firefox Gecko content-path harness for Playwright.
 *
 * Playwright cannot drive moz-extension:// or Firefox MV3 service workers the
 * way Chromium does. This harness loads the *built* firefox-mv3 dual-read.js
 * into a real Gecko page with a minimal chrome.* shim + Forced IntersectionObserver
 * (headless Firefox often never fires IO for already-visible nodes).
 *
 * What it validates: collector / session / renderer / restore on Gecko DOM.
 * What it does NOT validate: background SW, chrome.scripting, popup UI.
 */
import type { BrowserContext, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from '@playwright/test';
import type { PublicSessionConfigLite } from './ext-control';
import { inspectTranslation } from './ext-control';

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIREFOX_EXT_PATH = path.resolve(dirname, '../../output/firefox-mv3');

export type FirefoxBatchMode = 'ok' | 'auth_fail';

function readFirefoxAssets(): { js: string; css: string } {
  const jsPath = path.join(FIREFOX_EXT_PATH, 'dual-read.js');
  const cssPath = path.join(FIREFOX_EXT_PATH, 'dual-read.css');
  if (!fs.existsSync(jsPath) || !fs.existsSync(cssPath)) {
    throw new Error(
      `Firefox build missing under ${FIREFOX_EXT_PATH}; run: npm run build:firefox`,
    );
  }
  return {
    js: fs.readFileSync(jsPath, 'utf8'),
    css: fs.readFileSync(cssPath, 'utf8'),
  };
}

/** chrome.* shim: storage + runtime.connect → page.__drTranslateBatch. */
export function buildChromeShim(): string {
  return `(() => {
  if (globalThis.chrome?.runtime?.connect) return;
  const listeners = [];
  const storageData = Object.create(null);
  const storageArea = {
    get(keys) {
      return Promise.resolve((() => {
        if (keys == null) return { ...storageData };
        if (typeof keys === 'string') return { [keys]: storageData[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = storageData[k];
          return out;
        }
        const out = { ...keys };
        for (const k of Object.keys(keys)) if (k in storageData) out[k] = storageData[k];
        return out;
      })());
    },
    set(obj) {
      Object.assign(storageData, obj);
      return Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete storageData[k];
      return Promise.resolve();
    },
  };
  globalThis.chrome = {
    runtime: {
      id: 'dual-read@skysmission.github.io',
      lastError: null,
      getManifest() { return { version: '1.0.0' }; },
      getURL(p) { return 'about:blank#' + p; },
      connect() {
        const port = {
          name: 'dual-read-translate',
          _onMessage: null,
          onMessage: { addListener(fn) { port._onMessage = fn; } },
          onDisconnect: { addListener() {} },
          postMessage(msg) {
            if (msg?.action === 'translateCancel') return;
            if (msg?.action !== 'translateBatch') return;
            Promise.resolve(globalThis.__drTranslateBatch(msg.texts))
              .then((translations) => {
                port._onMessage?.({
                  action: 'batchResult',
                  requestId: msg.requestId,
                  sessionId: msg.sessionId,
                  success: true,
                  translations,
                });
              })
              .catch((err) => {
                port._onMessage?.({
                  action: 'batchResult',
                  requestId: msg.requestId,
                  sessionId: msg.sessionId,
                  success: false,
                  error: String(err?.message || err),
                  code: err?.code || 'AUTH_INVALID',
                });
              });
          },
          disconnect() {},
        };
        return port;
      },
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(msg, cb) {
        let replied = false;
        const reply = (r) => { if (!replied) { replied = true; cb?.(r); } };
        for (const fn of listeners) {
          try { fn(msg, {}, reply); } catch (e) { reply({ success: false, error: String(e) }); }
        }
      },
    },
    storage: { local: storageArea, sync: storageArea },
    i18n: { getUILanguage() { return 'en'; } },
  };
  globalThis.browser = globalThis.chrome;
})();`;
}

/** Headless Firefox often skips IO for already-visible nodes. */
export function buildForcedIOScript(): string {
  return `(() => {
  class ForcedIO {
    constructor(cb) { this._cb = cb; this._els = new Set(); }
    observe(el) {
      this._els.add(el);
      queueMicrotask(() => {
        if (this._els.has(el)) this._cb([{ isIntersecting: true, target: el }], this);
      });
    }
    unobserve(el) { this._els.delete(el); }
    disconnect() { this._els.clear(); }
    takeRecords() { return []; }
  }
  globalThis.IntersectionObserver = ForcedIO;
})();`;
}

function sessionConfig(
  mode: 'bilingual' | 'replace',
  targetLang = 'zh-CN',
): PublicSessionConfigLite {
  return {
    sessionId: `ff-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    revision: 1,
    targetLang,
    uiLocale: 'en',
    mode,
    maxConcurrent: 3,
    batchSize: 6,
    providerFingerprint: 'e2e-firefox-shim-fp',
    disabled: false,
  };
}

export async function launchFirefoxGeckoContext(): Promise<{
  context: BrowserContext;
  userDataDir: string;
  close: () => Promise<void>;
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-read-ff-e2e-'));
  const context = await firefox.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  return {
    context,
    userDataDir,
    async close() {
      await Promise.race([
        context.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Wire Node-side batch translation (mock) and inject dual-read into the page.
 * Call after page.goto(fixture).
 */
export async function installFirefoxDualRead(
  page: Page,
  opts?: { batchMode?: FirefoxBatchMode },
): Promise<void> {
  const batchMode = opts?.batchMode ?? 'ok';
  const { js, css } = readFirefoxAssets();

  await page.exposeFunction('__drTranslateBatch', async (texts: string[]) => {
    if (batchMode === 'auth_fail') {
      const err = new Error('invalid api key') as Error & { code?: string };
      err.code = 'AUTH_INVALID';
      throw err;
    }
    return texts.map((t) => `译:${t}`);
  });

  await page.evaluate((code) => {
    (0, eval)(code);
  }, buildChromeShim());
  await page.evaluate((code) => {
    (0, eval)(code);
  }, buildForcedIOScript());
  await page.evaluate((cssText) => {
    const s = document.createElement('style');
    s.setAttribute('data-dual-read-e2e', '1');
    s.textContent = cssText;
    (document.head || document.documentElement).appendChild(s);
  }, css);
  await page.evaluate((code) => {
    (0, eval)(code);
  }, js);

  await page.waitForFunction(() => Boolean((globalThis as { __DUAL_READ__?: { handleMessage?: unknown } }).__DUAL_READ__?.handleMessage), {
    timeout: 15_000,
  });
}

export async function firefoxTranslatePage(
  page: Page,
  mode: 'bilingual' | 'replace' = 'bilingual',
): Promise<Record<string, unknown>> {
  const config = sessionConfig(mode);
  return page.evaluate(async (cfg) => {
    const g = (globalThis as {
      __DUAL_READ__?: {
        handleMessage: (
          req: unknown,
          sender: unknown,
          reply: (r: unknown) => void,
        ) => boolean;
      };
    }).__DUAL_READ__;
    if (!g?.handleMessage) return { success: false, error: 'no __DUAL_READ__' };
    return await new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      const reply = (r: unknown) => {
        if (settled) return;
        settled = true;
        resolve((r && typeof r === 'object' ? r : { success: false }) as Record<string, unknown>);
      };
      const keep = g.handleMessage({ action: 'translatePage', config: cfg }, null, reply);
      if (!keep && !settled) reply({ success: false, error: 'sync empty reply' });
    });
  }, config);
}

export async function firefoxRestore(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = (globalThis as {
      __DUAL_READ__?: {
        handleMessage: (
          req: unknown,
          sender: unknown,
          reply: (r: unknown) => void,
        ) => boolean;
      };
    }).__DUAL_READ__;
    if (!g?.handleMessage) return;
    await new Promise<void>((resolve) => {
      const reply = () => resolve();
      const keep = g.handleMessage({ action: 'restoreOriginal' }, null, reply);
      if (!keep) resolve();
    });
  });
}

export async function firefoxStopWatch(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = (globalThis as {
      __DUAL_READ__?: {
        handleMessage: (
          req: unknown,
          sender: unknown,
          reply: (r: unknown) => void,
        ) => boolean;
        stopWatch?: () => void;
      };
    }).__DUAL_READ__;
    if (g?.stopWatch) {
      g.stopWatch();
      return;
    }
    if (!g?.handleMessage) return;
    await new Promise<void>((resolve) => {
      const reply = () => resolve();
      const keep = g.handleMessage({ action: 'stopWatch' }, null, reply);
      if (!keep) resolve();
    });
  });
}

export { inspectTranslation };
