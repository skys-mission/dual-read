// Opt-in real service canary using the production subtitle prompt and transport.
// Self-authored samples, at most two requests; never prints credentials or headers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { manualSamples } from './samples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = await build({
  write: false, bundle: true, format: 'esm', platform: 'node', target: 'node22',
  stdin: { resolveDir: root, loader: 'ts', contents: `
    export { translateSubtitleItems } from './lib/subtitles/translate';
    export { parseSettings } from './lib/settings/schema';
  ` },
});
const { translateSubtitleItems, parseSettings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const settings = parseSettings(JSON.parse(await fs.readFile(path.join(root, 'dev-settings.json'), 'utf8')));
if (!settings.apiKey || new URL(settings.apiBase).protocol !== 'https:') throw new Error('Configured HTTPS service and key required');
const samples = manualSamples;
const items = samples.map((text, index) => ({ id: `canary-${index + 1}`, revision: 1, text, context: samples[index - 1] ?? '' }));
const calls = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (calls.length >= 2) throw new Error('Canary request budget exhausted');
  const call = { index: calls.length + 1, status: 0, elapsedMs: 0, usage: null, finishReason: null };
  calls.push(call);
  const started = performance.now();
  try {
    const response = await nativeFetch(url, init);
    call.status = response.status;
    const body = await response.clone().json().catch(() => null);
    call.usage = body?.usage ?? null;
    call.finishReason = body?.choices?.[0]?.finish_reason ?? null;
    return response;
  } finally { call.elapsedMs = Math.round(performance.now() - started); }
};
const report = { at: new Date().toISOString(), sampleKind: 'self-authored controlled subtitles',
  apiOrigin: new URL(settings.apiBase).origin, model: settings.model, targetLang: settings.targetLang,
  productionTransport: true, productionPromptAndParser: true, calls };
try {
  const translated = await translateSubtitleItems(items, 'en', settings, AbortSignal.timeout(60000));
  report.passed = translated.length === items.length && translated.every((row, index) => row.id === items[index].id && row.revision === 1 && row.text.trim());
  report.items = items.map((row, index) => ({ id: row.id, source: row.text, translation: translated[index]?.text }));
} catch (error) {
  report.passed = false;
  report.error = error.code ?? error.name ?? 'unknown-error';
}
const destination = path.join(root, 'test-results/youtube-live/provider.json');
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
