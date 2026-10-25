import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from '@playwright/test';
import { withExtension } from 'playwright-webextext';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A disposable diagnostic addon, not the shipping manifest. Its only host
 * permission is YouTube. It waits for an explicit test command before probing.
 * Both browsers run real ISOLATED -> background -> MAIN -> ISOLATED messaging;
 * there is no chrome.* shim. This does not simulate the toolbar activeTab grant.
 */
export async function launchProbeBrowser(name, { headless = true } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-read-youtube-g0-'));
  const addon = path.join(temporary, 'addon');
  const profile = path.join(temporary, 'profile');
  await fs.mkdir(addon);
  await fs.mkdir(profile);
  const manifest = {
    manifest_version: 3,
    name: 'Dual Read G0 source diagnostic',
    version: '0.0.1',
    permissions: ['scripting'],
    host_permissions: ['https://www.youtube.com/*'],
    optional_permissions: [],
    background: name === 'firefox' ? { scripts: ['background.js'] } : { service_worker: 'background.js' },
    content_scripts: [{ matches: ['https://www.youtube.com/*'], js: ['relay.js'], run_at: 'document_idle' }],
    ...(name === 'firefox' ? { browser_specific_settings: { gecko: {
      id: 'dual-read-g0@skysmission.github.io',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    } } } : {}),
  };
  await fs.writeFile(path.join(addon, 'manifest.json'), JSON.stringify(manifest));
  await build({
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `import { probeYouTubeSource } from './lib/subtitles/youtube-adapter';
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (request?.action !== 'g0:probe' || !sender.tab?.id || sender.frameId !== 0) return;
  if (!sender.url?.startsWith('https://www.youtube.com/watch?')) return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [0] }, world: 'MAIN',
    func: probeYouTubeSource, args: [request.options],
  }).then(results => reply({ result: results[0]?.result, error: results[0]?.error ? 'MAIN execution failed' : undefined }))
    .catch(() => reply({ error: 'MAIN injection failed' }));
  return true;
});`,
    },
    outfile: path.join(addon, 'background.js'), bundle: true, format: 'iife', target: 'es2022',
  });
  await fs.writeFile(path.join(addon, 'relay.js'), `
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'dual-read-g0:probe') return;
  const { id, options } = event.data;
  chrome.runtime.sendMessage({ action: 'g0:probe', options }, reply => {
    const error = chrome.runtime.lastError ? 'background relay failed' : reply?.error;
    window.postMessage({ type: 'dual-read-g0:result', id, result: reply?.result, error,
      isolated: typeof document.querySelector('#movie_player')?.getPlayerResponse === 'undefined' }, location.origin);
  });
});
document.documentElement.dataset.dualReadG0 = 'ready';
`);
  let context;
  try {
    context = name === 'firefox'
      ? await withExtension(firefox, addon).launchPersistentContext(profile, { headless })
      : await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless,
        args: [`--disable-extensions-except=${addon}`, `--load-extension=${addon}`],
      });
    return {
      context,
      version: context.browser()?.version() ?? 'unknown',
      async close() {
        await context.close();
        await fs.rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close();
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function runSourceProbe(page, options) {
  await page.waitForFunction(() => document.documentElement.dataset.dualReadG0 === 'ready', undefined, { timeout: 20_000 });
  return page.evaluate(opts => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
    const onMessage = event => {
      if (event.source !== window || event.origin !== location.origin
        || event.data?.type !== 'dual-read-g0:result' || event.data.id !== id) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve({ ...event.data.result, isolated: event.data.isolated });
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('G0 bridge timeout')); }, (opts.timeoutMs ?? 6_000) + 10_000);
    window.addEventListener('message', onMessage);
    window.postMessage({ type: 'dual-read-g0:probe', id, options: opts }, location.origin);
  }), options);
}

/** No source text, signed URLs, cookies, user identity or player response in reports. */
export function summarizeProbe(result) {
  const { events, ...metadata } = result;
  const timed = events.filter(e => e.segs?.some(s => s.utf8.trim()));
  return {
    ...metadata,
    eventCount: events.length,
    textEventCount: timed.length,
    firstStartMs: timed[0]?.tStartMs ?? null,
    lastStartMs: timed.at(-1)?.tStartMs ?? null,
    wordOffsetCount: events.reduce((n, e) => n + (e.segs?.filter(s => s.tOffsetMs !== undefined).length ?? 0), 0),
  };
}
