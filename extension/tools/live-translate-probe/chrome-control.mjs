import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let configBundle;

async function sessionConfig(sw, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('invalid tab id');
  configBundle ??= build({
    entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-config-entry.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'DualReadProbeConfig',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  // DevTools evaluates source in the worker. No eval/CSP changes or secrets
  // interpolated into source, and no settings bundle is written to output/.
  return sw.evaluate(`(async () => { ${await configBundle}; return DualReadProbeConfig.configForTab(${tabId}); })()`);
}

/** Use the same settings, site rules and provider identity as the extension. */
export async function chromeTranslate(sw, tabId) {
  const config = await sessionConfig(sw, tabId);
  return sw.evaluate(async ({ id, config }) => {
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
    const result = await new Promise((resolve) => {
      chrome.tabs.sendMessage(id, { action: 'translatePage', config }, (response) => {
        if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
        else resolve(response ?? { success: false, error: 'no response' });
      });
    });
    return { ok: Boolean(result?.success), result };
  }, { id: tabId, config });
}
