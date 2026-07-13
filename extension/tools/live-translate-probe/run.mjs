// Real-browser live translation probe (Chromium + Firefox/Gecko).
//
// Chrome: loads the real MV3 extension (service worker + scripting + storage).
// Firefox: Playwright cannot open moz-extension:// pages reliably, so we drive
 // the same dual-read.js content script on Gecko with a chrome.* API shim that
// talks to DeepSeek the same way the background provider does. This validates
// collector / renderer / scheduler / IntersectionObserver on Firefox.
//
// Usage (from extension/):
//   node tools/live-translate-probe/run.mjs [--browser=chrome|firefox|both] [url ...]
//
// Env:
//   LIVE_BROWSER=chrome|firefox|both
//   LIVE_HEADLESS=0
//   LIVE_TIMEOUT_MS=90000
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(dirname, '../..');
const OUT_ROOT = path.join(EXT_ROOT, 'test-results/live-translate');
const HEADLESS = process.env.LIVE_HEADLESS !== '0';
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 90_000);

const DEFAULT_URLS = [
  'https://example.com/',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a',
  'https://docs.python.org/3/tutorial/introduction.html',
  'https://doc.rust-lang.org/book/ch01-00-getting-started.html',
  'https://vuejs.org/guide/introduction.html',
  'https://react.dev/learn',
  'https://tailwindcss.com/docs/installation',
  'https://kubernetes.io/docs/concepts/overview/',
  'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
  'https://overreacted.io/a-complete-guide-to-useeffect/',
  'https://news.ycombinator.com/',
  'https://lobste.rs/',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
  'https://github.com/golang/go',
  'https://en.wikipedia.org/wiki/Web_browser',
];

function parseBrowserArg(argv) {
  const flag = argv.find((a) => a.startsWith('--browser='));
  if (flag) return flag.slice('--browser='.length).toLowerCase();
  return (process.env.LIVE_BROWSER || 'both').toLowerCase();
}

function slug(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
  } catch {
    return String(url).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80);
  }
}

function loadSettings() {
  const p = path.join(EXT_ROOT, 'public/dev-settings.json');
  if (!fs.existsSync(p)) throw new Error('missing public/dev-settings.json');
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!settings.apiKey || !settings.apiBase) throw new Error('dev-settings.json incomplete');
  return settings;
}

function prepareChromeExtension() {
  const src = path.join(EXT_ROOT, 'output/chrome-mv3');
  const dest = path.join(EXT_ROOT, 'output/chrome-mv3-live');
  if (!fs.existsSync(src)) throw new Error(`missing ${src}; run npm run build`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  const settingsPath = path.join(dest, 'dev-settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.copyFileSync(path.join(EXT_ROOT, 'public/dev-settings.json'), settingsPath);
  }
  const manifestPath = path.join(dest, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://localhost/*', 'http://127.0.0.1/*', 'https://*/*', 'http://*/*'];
  delete manifest.optional_host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dest;
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const targets = [...document.querySelectorAll('.dual-read-target')];
    const errors = [...document.querySelectorAll('.dual-read-error')];
    const done = [...document.querySelectorAll('[data-dual-read-done]')];
    const samples = targets.slice(0, 12).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80));
    const errSamples = errors.slice(0, 5).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120));
    const overflowSamples = targets
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
        const parent = el.parentElement?.getBoundingClientRect();
        const outsideParent = parent
          ? rect.left < parent.left - 1 || rect.right > parent.right + 1
          : false;
        return el.scrollWidth > el.clientWidth + 1 || outsideParent || rect.right > innerWidth + 1;
      })
      .slice(0, 8)
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100));
    const verticalStripCount = targets.filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
      return rect.width > 0 && rect.width < 36 && rect.height > rect.width * 3;
    }).length;
    const cjk = /[\u4e00-\u9fff]/;
    return {
      targetCount: targets.length,
      errorCount: errors.length,
      doneCount: done.length,
      emptyTargets: targets.filter((el) => !(el.textContent || '').trim()).length,
      overflowCount: overflowSamples.length,
      overflowSamples,
      verticalStripCount,
      cjkSampleCount: samples.filter((t) => cjk.test(t)).length,
      samples,
      errSamples,
      title: document.title,
    };
  });
}

function judge(inspect) {
  const hasTranslation = inspect.targetCount > 0 && inspect.cjkSampleCount > 0;
  const denom = inspect.targetCount + inspect.errorCount;
  const errorRatio = denom > 0 ? inspect.errorCount / denom : 1;
  return hasTranslation && errorRatio < 0.25 && inspect.emptyTargets === 0;
}

async function apiSanity(settings) {
  const url = `${String(settings.apiBase).replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: settings.model || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'Translate to Simplified Chinese. Reply with JSON object {"0":"..."} only.' },
      { role: 'user', content: JSON.stringify({ '0': 'Hello world' }) },
    ],
    temperature: 0.3,
    max_tokens: 256,
    thinking: { type: 'disabled' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return {
    status: res.status,
    url,
    content: parsed?.choices?.[0]?.message?.content ?? null,
    rawHead: text.slice(0, 240),
  };
}

// ─── Chrome (full extension) ───────────────────────────────────────────────

async function waitForServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 1500));
  return sw;
}

async function ensureChromeSettings(context, extensionId, settings) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.waitForSelector('#apiBase', { timeout: 15_000 });
    await page.evaluate(async (s) => {
      await chrome.storage.local.set({
        apiKey: s.apiKey,
        customHeaders: s.customHeaders || {},
      });
      const { apiKey: _drop, customHeaders: _headers, ...rest } = s;
      await chrome.storage.sync.set({
        apiBase: rest.apiBase,
        model: rest.model,
        targetLang: rest.targetLang || 'zh-CN',
        mode: rest.mode || 'bilingual',
        maxConcurrent: rest.maxConcurrent || 3,
        batchSize: rest.batchSize || 6,
        siteRules: rest.siteRules || [],
      });
    }, settings);
  } finally {
    await page.close();
  }
}

async function chromeTranslate(sw, tabId) {
  return sw.evaluate(async (id) => {
    const sync = await chrome.storage.sync.get(null);
    const ping = () =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(id, { action: 'ping' }, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response?.pong ? response : null);
        });
      });
    let existing = await ping();
    if (!existing) {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['dual-read.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: id }, files: ['dual-read.css'] });
      existing = await ping();
      if (!existing) return { ok: false, error: 'content script did not respond' };
    }
    const config = {
      sessionId: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      revision: Number(sync.revision) || 1,
      targetLang: sync.targetLang || 'zh-CN',
      uiLocale: sync.uiLocale || 'zh-CN',
      mode: sync.mode || 'bilingual',
      maxConcurrent: Number(sync.maxConcurrent) || 3,
      batchSize: Number(sync.batchSize) || 6,
      providerFingerprint: [
        sync.apiBase || '',
        sync.model || '',
        sync.targetLang || 'zh-CN',
      ].join('|'),
      disabled: false,
    };
    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(id, { action: 'translatePage', config }, (response) => {
        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
        else resolve(response ?? { success: false, error: 'no response' });
      });
    });
    return { ok: Boolean(result?.success), result };
  }, tabId);
}

async function chromePoll(sw, tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sw.evaluate(
      async (id) =>
        new Promise((resolve) => {
          chrome.tabs.sendMessage(id, { action: 'getStatus' }, (response) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(response ?? null);
          });
        }),
      tabId,
    );
    if (last && !last.error) {
      if (((last.count ?? 0) > 0 && !last.translating) || ((last.failed ?? 0) > 0 && (last.count ?? 0) === 0 && !last.translating)) {
        return last;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function runChrome(sites, settings) {
  const outDir = path.join(OUT_ROOT, 'chrome');
  fs.mkdirSync(outDir, { recursive: true });
  const extPath = prepareChromeExtension();
  console.log(`\n════════ CHROME ════════`);
  console.log(`sites: ${sites.length}  ext: ${extPath}`);

  const userDataDir = path.join(outDir, 'profile');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: HEADLESS,
    viewport: { width: 1400, height: 900 },
    args: [
      ...(HEADLESS ? ['--headless=new'] : []),
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });

  const reports = [];
  try {
    const sw = await waitForServiceWorker(context);
    const extensionId = sw.url().split('/')[2];
    console.log(`extensionId: ${extensionId}`);
    await ensureChromeSettings(context, extensionId, settings);

    for (const url of sites) {
      const name = slug(url);
      console.log(`\n── [chrome] ${url}`);
      const page = await context.newPage();
      const report = { browser: 'chrome', url, name, ok: false };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(2000);
        await page.bringToFront();
        const tabId = await sw.evaluate(async (targetUrl) => {
          const tabs = await chrome.tabs.query({});
          const hit =
            tabs.find((t) => t.url === targetUrl) ||
            tabs.find((t) => t.active && t.url && t.url.startsWith(targetUrl.split('#')[0]));
          return hit?.id ?? null;
        }, page.url());
        if (tabId == null) throw new Error('could not resolve tab id');

        const started = await chromeTranslate(sw, tabId);
        if (!started.ok) throw new Error(started.error || started.result?.error || 'translate failed');
        console.log(`  translatePage count=${started.result?.count} total=${started.result?.total} failed=${started.result?.failed}`);

        let status = await chromePoll(sw, tabId, TIMEOUT_MS);
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
        await page.waitForTimeout(2500);
        status = await chromePoll(sw, tabId, Math.min(TIMEOUT_MS, 45_000));
        await page.waitForTimeout(600);

        const inspect = await inspectPage(page);
        report.status = status;
        report.inspect = inspect;
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
        const shotPath = path.join(outDir, `${name}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        report.screenshot = shotPath;
        report.ok = judge(inspect);
        console.log(
          `  [${report.ok ? 'OK ' : 'BAD'}] targets=${inspect.targetCount} errors=${inspect.errorCount} ` +
            `cjk=${inspect.cjkSampleCount}/${Math.min(12, inspect.targetCount)} count=${status?.count} failed=${status?.failed}`,
        );
        inspect.samples.slice(0, 4).forEach((s) => console.log(`      ~ ${s}`));
        if (inspect.errSamples.length) inspect.errSamples.forEach((s) => console.log(`      ! ${s}`));
      } catch (err) {
        report.error = String(err?.message || err);
        console.log(`  [ERR] ${report.error}`);
        try {
          const shotPath = path.join(outDir, `${name}-error.png`);
          await page.screenshot({ path: shotPath, fullPage: false });
          report.screenshot = shotPath;
        } catch {
          /* ignore */
        }
      } finally {
        reports.push(report);
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(`\n── chrome summary: ok=${reports.filter((r) => r.ok).length} bad=${reports.filter((r) => !r.ok).length}`);
  return reports;
}

// ─── Firefox (Gecko + content-script shim) ─────────────────────────────────

function buildFirefoxShim(settings) {
  // Injected before dual-read.js. Provides the chrome APIs the content script
  // needs, routing translateBatch through page.__drTranslateBatch (exposed from Node).
  return `
(() => {
  if (globalThis.chrome?.runtime?.connect) return;
  const listeners = [];
  const storageData = ${JSON.stringify({
    apiBase: settings.apiBase,
    model: settings.model,
    targetLang: settings.targetLang || 'zh-CN',
    mode: settings.mode || 'bilingual',
    maxConcurrent: settings.maxConcurrent || 3,
    batchSize: settings.batchSize || 6,
    customHeaders: settings.customHeaders || {},
    siteRules: [],
    apiKey: settings.apiKey,
  })};

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
      id: 'dual-read-firefox-shim',
      lastError: null,
      getManifest() { return { version: '1.0.0' }; },
      getURL(p) { return 'about:blank#' + p; },
      connect({ name }) {
        const port = {
          name,
          _onMessage: null,
          onMessage: {
            addListener(fn) {
              port._onMessage = fn;
            },
          },
          onDisconnect: { addListener() {} },
          postMessage(msg) {
            if (msg?.action !== 'translateBatch') return;
            Promise.resolve(globalThis.__drTranslateBatch(msg.texts))
              .then((translations) => {
                port._onMessage?.({ action: 'batchResult', success: true, translations });
              })
              .catch((err) => {
                port._onMessage?.({
                  action: 'batchResult',
                  success: false,
                  error: String(err?.message || err),
                });
              });
          },
          disconnect() {},
        };
        return port;
      },
      onMessage: {
        addListener(fn) { listeners.push(fn); },
      },
      sendMessage(msg, cb) {
        let replied = false;
        const reply = (r) => { if (!replied) { replied = true; cb?.(r); } };
        for (const fn of listeners) {
          try {
            const keep = fn(msg, {}, reply);
            if (keep !== true && !replied) {/* async may still reply */}
          } catch (e) {
            reply({ success: false, error: String(e) });
          }
        }
      },
    },
    storage: { local: storageArea, sync: storageArea },
    i18n: { getUILanguage() { return 'zh-CN'; } },
  };
  globalThis.browser = globalThis.chrome;
})();`;
}

async function translateBatchNode(texts, settings) {
  const url = `${String(settings.apiBase).replace(/\/$/, '')}/chat/completions`;
  const indexed = {};
  texts.forEach((t, i) => {
    indexed[String(i)] = t;
  });
  const chars = texts.reduce((n, t) => n + t.length, 0);
  const maxTokens = Math.min(8192, Math.max(1024, Math.ceil((chars / 4) * 3) + 128));
  const body = {
    model: settings.model || 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content:
          'You are a professional translation engine embedded in a browser extension.\n' +
          'Translate each value in the user\'s JSON object into Simplified Chinese.\n' +
          'Return ONLY a JSON object with exactly the same keys ("0","1",...) mapped to translated strings.\n' +
          'Do not add explanations, notes, or markdown code fences.',
      },
      { role: 'user', content: JSON.stringify(indexed) },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content || '';
  if (!content.trim()) {
    const reasoning = data?.choices?.[0]?.message?.reasoning_content || '';
    const m = reasoning.match(/\{[\s\S]*\}/);
    if (m) content = m[0];
  }
  if (!content.trim()) throw new Error('empty batch response from API');
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const obj = JSON.parse(cleaned);
  return texts.map((_, i) => String(obj[String(i)] ?? obj[i] ?? ''));
}

async function firefoxPoll(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => {
      const g = globalThis.__DUAL_READ__;
      if (!g?.handleMessage) return { error: 'no dual-read global' };
      return await new Promise((resolve) => {
        const keep = g.handleMessage({ action: 'getStatus' }, null, resolve);
        if (keep !== true) {
          /* sync reply already happened */
        }
      });
    });
    if (last && !last.error) {
      if (((last.count ?? 0) > 0 && !last.translating) || ((last.failed ?? 0) > 0 && (last.count ?? 0) === 0 && !last.translating)) {
        return last;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function runFirefox(sites, settings) {
  const outDir = path.join(OUT_ROOT, 'firefox');
  fs.mkdirSync(outDir, { recursive: true });
  const css = fs.readFileSync(path.join(EXT_ROOT, 'output/firefox-mv3/dual-read.css'), 'utf8');
  const script = fs.readFileSync(path.join(EXT_ROOT, 'output/firefox-mv3/dual-read.js'), 'utf8');
  const shim = buildFirefoxShim(settings);

  console.log(`\n════════ FIREFOX (Gecko + content shim) ════════`);
  console.log(`sites: ${sites.length}`);
  console.log(`note: Playwright cannot drive moz-extension://; validating Gecko DOM/render path`);

  const userDataDir = path.join(outDir, 'profile');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await firefox.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    viewport: { width: 1400, height: 900 },
  });

  const reports = [];
  try {
    for (const url of sites) {
      const name = slug(url);
      console.log(`\n── [firefox] ${url}`);
      const page = await context.newPage();
      const report = { browser: 'firefox', mode: 'gecko-shim', url, name, ok: false };
      try {
        await page.exposeFunction('__drTranslateBatch', (texts) => translateBatchNode(texts, settings));

        // Navigate first — huge init scripts stall Firefox page load.
        await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // Inject shim + CSS + content script after navigation (CSP-safe via evaluate).
        await page.evaluate((code) => {
          // eslint-disable-next-line no-new-func
          (0, eval)(code);
        }, shim);
        // Firefox headless often never fires IntersectionObserver for already-visible
        // nodes. Force immediate "intersecting" callbacks so the viewport scheduler
        // drains (production Chrome/Firefox with a real window do not need this).
        await page.evaluate(() => {
          class ForcedIO {
            constructor(cb) {
              this._cb = cb;
              this._els = new Set();
            }
            observe(el) {
              this._els.add(el);
              queueMicrotask(() => {
                if (this._els.has(el)) this._cb([{ isIntersecting: true, target: el }], this);
              });
            }
            unobserve(el) {
              this._els.delete(el);
            }
            disconnect() {
              this._els.clear();
            }
            takeRecords() {
              return [];
            }
          }
          globalThis.IntersectionObserver = ForcedIO;
        });
        await page.evaluate((cssText) => {
          const s = document.createElement('style');
          s.textContent = cssText;
          (document.head || document.documentElement).appendChild(s);
        }, css);
        await page.evaluate((code) => {
          // eslint-disable-next-line no-new-func
          (0, eval)(code);
        }, script);

        await page.waitForFunction(() => Boolean(globalThis.__DUAL_READ__?.handleMessage), null, {
          timeout: 15_000,
        });

        const started = await page.evaluate(async (s) => {
          const g = globalThis.__DUAL_READ__;
          return await new Promise((resolve) => {
            g.handleMessage({ action: 'translatePage', settings: s }, null, resolve);
          });
        }, {
          ...settings,
          targetLang: settings.targetLang || 'zh-CN',
          mode: settings.mode || 'bilingual',
        });
        if (!started?.success) throw new Error(started?.error || 'translatePage failed');
        console.log(`  translatePage count=${started.count} total=${started.total} failed=${started.failed}`);

        // ForcedIO already marks observed units intersecting; a light scroll still
        // exercises MutationObserver / incremental paths.
        await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);

        let status = await firefoxPoll(page, TIMEOUT_MS);
        await page.waitForTimeout(800);

        const inspect = await inspectPage(page);
        report.status = status;
        report.inspect = inspect;
        const shotPath = path.join(outDir, `${name}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        report.screenshot = shotPath;
        report.ok = judge(inspect);
        console.log(
          `  [${report.ok ? 'OK ' : 'BAD'}] targets=${inspect.targetCount} errors=${inspect.errorCount} ` +
            `cjk=${inspect.cjkSampleCount}/${Math.min(12, inspect.targetCount)} count=${status?.count} failed=${status?.failed}`,
        );
        inspect.samples.slice(0, 4).forEach((s) => console.log(`      ~ ${s}`));
        if (inspect.errSamples.length) inspect.errSamples.forEach((s) => console.log(`      ! ${s}`));
      } catch (err) {
        report.error = String(err?.message || err);
        console.log(`  [ERR] ${report.error}`);
        try {
          const shotPath = path.join(outDir, `${name}-error.png`);
          await page.screenshot({ path: shotPath, fullPage: false });
          report.screenshot = shotPath;
        } catch {
          /* ignore */
        }
      } finally {
        reports.push(report);
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(reports, null, 2));
  console.log(`\n── firefox summary: ok=${reports.filter((r) => r.ok).length} bad=${reports.filter((r) => !r.ok).length}`);
  return reports;
}

async function main() {
  const argv = process.argv.slice(2);
  const browserSel = parseBrowserArg(argv);
  const urls = argv.filter((a) => !a.startsWith('--'));
  const sites = urls.length ? urls : DEFAULT_URLS;
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const settings = loadSettings();
  const check = await apiSanity(settings);
  console.log(`[api-check] ${check.status} ${check.url}`);
  console.log(`[api-check] content=${JSON.stringify(check.content)}`);
  if (check.status !== 200 || !check.content) {
    console.log(`[api-check] raw=${check.rawHead}`);
    throw new Error('API sanity check failed');
  }

  const browsers =
    browserSel === 'both' ? ['chrome', 'firefox'] : browserSel === 'firefox' ? ['firefox'] : ['chrome'];

  const all = [];
  for (const b of browsers) {
    const reports = b === 'firefox' ? await runFirefox(sites, settings) : await runChrome(sites, settings);
    all.push(...reports);
  }

  const combinedPath = path.join(OUT_ROOT, 'summary-all.json');
  fs.writeFileSync(combinedPath, JSON.stringify(all, null, 2));
  const ok = all.filter((r) => r.ok).length;
  const bad = all.length - ok;
  console.log('\n════════ COMBINED ════════');
  console.log(`total: ${all.length}   ok: ${ok}   bad: ${bad}`);
  for (const b of browsers) {
    const subset = all.filter((r) => r.browser === b);
    console.log(`  ${b}: ${subset.filter((r) => r.ok).length}/${subset.length}`);
  }
  console.log(`summary: ${combinedPath}`);
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
