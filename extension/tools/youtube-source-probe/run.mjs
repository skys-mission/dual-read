// Live G0 canary: no model calls, no user profile, no token/UA spoofing.
// npm run probe:youtube -- --browser=both [--headed]
// Exit 0: every required source case ready; 2: source gate failed; 1: harness error.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchProbeBrowser, runSourceProbe, summarizeProbe } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const name = args.find(a => a.startsWith('--browser='))?.slice('--browser='.length) ?? 'both';
if (!['chromium', 'firefox', 'both'].includes(name)) throw new Error('Use --browser=chromium|firefox|both');
const headless = !args.includes('--headed');
const reportPath = path.join(root, 'test-results/youtube-source', `${headless ? 'headless' : 'headed'}-${name}.json`);
const report = { timestamp: new Date().toISOString(), headless, authenticated: false,
  fixture: false, bridge: 'real MV3 addon; isolated/background/MAIN; diagnostic YouTube host grant',
  adapterSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'lib/subtitles/youtube-adapter.ts'))).digest('hex'),
  driverSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
  productionActiveTabVerified: false, modelRequests: 0, results: [] };
await fs.mkdir(path.dirname(reportPath), { recursive: true });
const save = async () => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
};

async function playerState(page) {
  return page.evaluate(() => {
    const p = document.querySelector('#movie_player');
    const response = p?.getPlayerResponse?.();
    const video = p?.querySelector('video');
    const selection = p?.getOption?.('captions', 'track');
    return {
      videoId: response?.videoDetails?.videoId ?? null,
      mediaTime: video?.currentTime ?? null,
      mediaReadyState: video?.readyState ?? null,
      paused: video?.paused ?? null,
      adShowing: p?.classList.contains('ad-showing') || p?.classList.contains('ad-interrupting') || false,
      cc: p?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') ?? null,
      selectedTrack: { id: selection?.vssId ?? selection?.vss_id ?? null,
        language: selection?.languageCode ?? null, kind: selection?.kind ?? null },
      nativeTextCharacters: [...p?.querySelectorAll('.ytp-caption-segment') ?? []]
        .reduce((n, e) => n + (e.textContent?.length ?? 0), 0),
    };
  });
}

async function selectTrack(page, kind, ccOn) {
  // Test preparation only. Use the real menu: passing raw caption metadata to
  // the private setOption API can silently leave the old track selected.
  const available = await page.evaluate(kind => {
    const p = document.querySelector('#movie_player');
    const tracks = p?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    return tracks.some(t => (t.kind === 'asr' ? 'asr' : 'manual') === kind && t.languageCode === 'en');
  }, kind);
  if (!available) return false;
  const settings = page.locator('#movie_player .ytp-settings-button');
  await settings.click({ force: true });
  await page.locator('#movie_player .ytp-settings-menu .ytp-menuitem')
    .filter({ visible: true, hasText: /Subtitles|字幕/ }).click();
  const label = kind === 'asr' ? /^\s*(English|英语).*?(auto-generated|自动生成).*$/ : /^\s*(English|英语)\s*$/;
  await page.locator('#movie_player .ytp-settings-menu .ytp-menuitem').filter({ visible: true, hasText: label }).click();
  if (await settings.getAttribute('aria-expanded') === 'true') await settings.click({ force: true });
  await page.waitForFunction(kind => {
    const t = document.querySelector('#movie_player')?.getOption?.('captions', 'track');
    return t?.languageCode === 'en' && (t?.kind === 'asr' ? 'asr' : 'manual') === kind;
  }, kind, { timeout: 8000 });
  await page.evaluate(ccOn => {
    const button = document.querySelector('.ytp-subtitles-button');
    if ((button?.getAttribute('aria-pressed') === 'true') !== ccOn) button?.click();
  }, ccOn);
  await page.waitForFunction(ccOn => (document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true') === ccOn,
    ccOn, { timeout: 8000 });
  return true;
}

let harnessError = false;
for (const browserName of name === 'both' ? ['chromium', 'firefox'] : [name]) {
  let fx;
  let stage = 'launch';
  try {
    fx = await launchProbeBrowser(browserName, { headless });
    const page = await fx.context.newPage();
    const initialVideo = 'M7lc1UVf-VE'; // YouTube Developers; manual English + ASR.
    stage = 'watch-navigation';
    await page.goto(`https://www.youtube.com/watch?v=${initialVideo}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    stage = 'player-ready';
    await page.waitForFunction(id => document.querySelector('#movie_player')?.getPlayerResponse?.()?.videoDetails?.videoId === id,
      initialVideo, { timeout: 30_000 });
    await page.locator('video').evaluate(v => { v.muted = true; return v.play().catch(() => {}); });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime >= 2 && !v.paused; }, undefined, { timeout: 20_000 });
    const record = async (stage, expectedVideoId, expectedKind, expectedCC) => {
      const before = await playerState(page);
      const raw = await runSourceProbe(page, { expectedVideoId, enableNativeCC: true, timeoutMs: 4000 });
      const result = summarizeProbe(raw);
      const after = await playerState(page);
      const actualKind = result.tracks.find(t => t.id === result.trackId)?.kind ?? null;
      if (result.status === 'ready' && actualKind) {
        // Preserve event boundaries, punctuation, repetition and time offsets;
        // replace words consistently and never persist the dictionary itself.
        const words = new Map();
        const redact = text => text.replace(/[\p{L}\p{M}\p{N}'’-]+/gu, word => {
          if (!words.has(word)) words.set(word, `word${words.size + 1}`);
          return words.get(word);
        });
        const sample = { redacted: true, synthetic: false, videoId: expectedVideoId, trackId: result.trackId,
          events: raw.events.slice(0, 60).map(e => ({ ...e, ...(e.segs ? { segs: e.segs.map(s => ({ ...s, utf8: redact(s.utf8) })) } : {}) })) };
        await fs.mkdir(path.dirname(reportPath), { recursive: true });
        await fs.writeFile(path.join(path.dirname(reportPath), `${browserName}-${actualKind}-sample.json`), `${JSON.stringify(sample, null, 2)}\n`);
      }
      const entry = { browser: browserName, version: fx.version, stage, before, after,
        expectedKind: expectedKind ?? null, actualKind, expectedCC: expectedCC ?? null,
        preconditionsMet: expectedCC == null || (before.cc === expectedCC && result.cc.initial === expectedCC), ...result };
      report.results.push(entry);
      await save();
      console.log(JSON.stringify({ browser: browserName, stage, status: result.status, reason: result.reason, actualKind,
        eventCount: result.eventCount, observations: result.observations, cc: result.cc, isolated: result.isolated }));
    };
    for (const [caseName, kind, ccOn] of [
      ['manual-cc-off', 'manual', false], ['manual-midplay-cc-on', 'manual', true],
      ['asr-cc-off', 'asr', false], ['asr-midplay-cc-on', 'asr', true],
    ]) {
      stage = caseName;
      await page.waitForFunction(() => {
        const p = document.querySelector('#movie_player');
        return p && !p.classList.contains('ad-showing') && !p.classList.contains('ad-interrupting');
      }, undefined, { timeout: 30_000 });
      if (!await selectTrack(page, kind, ccOn)) throw new Error(`Native ${kind} track unavailable`);
      await record(stage, initialVideo, kind, String(ccOn));
    }
    stage = 'spa-navigation';
    // Navigate through an actual YouTube watch-link when available, so the
    // player and URL change via YouTube's SPA. Do not fake a successful SPA.
    const documentToken = await page.evaluate(() => { window.__g0DocumentToken = crypto.randomUUID(); return window.__g0DocumentToken; });
    const candidate = await page.locator('a[href*="/watch?v="]').filter({ visible: true }).evaluateAll((links, current) => links
      .map(a => ({ href: a.getAttribute('href'), id: new URL(a.href).searchParams.get('v') }))
      .find(a => a.id && a.id !== current && /^[\w-]{11}$/.test(a.id)), initialVideo);
    if (!candidate) throw new Error('No native watch link available; SPA case unverified');
    const nextVideo = candidate.id;
    await page.locator('a[href*="/watch?v="]').filter({ visible: true }).evaluateAll((links, href) => {
      const link = links.find(a => a.getAttribute('href') === href);
      if (!link) throw new Error('Native watch link not visible');
      link.click();
    }, candidate.href);
    await page.waitForFunction(id => new URL(location.href).searchParams.get('v') === id
      && document.querySelector('#movie_player')?.getPlayerResponse?.()?.videoDetails?.videoId === id,
    nextVideo, { timeout: 20_000 });
    const sameDocument = await page.evaluate(token => window.__g0DocumentToken === token, documentToken);
    if (!sameDocument) throw new Error('Navigation replaced the document; SPA case unverified');
    await page.waitForFunction(() => {
      const p = document.querySelector('#movie_player');
      return p && !p.classList.contains('ad-showing') && !p.classList.contains('ad-interrupting');
    }, undefined, { timeout: 30_000 }).catch(() => {});
    await record('spa-selected-track', nextVideo);
  } catch (error) {
    harnessError = true;
    // Framework errors can contain page URLs. Use only a fixed diagnosis here;
    // do not accidentally store signed caption URLs or browser internals.
    const allowed = ['Native manual track unavailable', 'Native asr track unavailable', 'Navigation replaced the document; SPA case unverified',
      'G0 bridge timeout', 'MAIN execution failed', 'MAIN injection failed', 'background relay failed',
      'No native watch link available; SPA case unverified'];
    const errorCode = allowed.includes(error?.message) ? error.message
      : String(error?.message ?? 'browser-harness-error').split('\n')[0].replace(/https?:\/\/\S+/g, '[url]').slice(0, 180);
    report.results.push({ browser: browserName, stage, error: errorCode });
    console.error(JSON.stringify({ browser: browserName, stage, error: errorCode }));
    await save();
  } finally { await fx?.close(); }
}
const passed = !harnessError && report.results.length > 0 && report.results.every(r => r.status === 'ready'
  && r.textEventCount > 0 && r.isolated && r.preconditionsMet && (!r.expectedKind || r.expectedKind === r.actualKind)
  && (!r.cc.enabledByProbe || r.cc.restored));
report.gate = passed ? 'passed' : 'not-passed';
await save();
console.log(`G0 ${report.gate}; sanitized report: ${reportPath}`);
process.exitCode = harnessError ? 1 : passed ? 0 : 2;
