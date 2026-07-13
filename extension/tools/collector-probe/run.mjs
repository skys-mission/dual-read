// Real-world collector regression probe.
//
// Builds the pure-DOM collector into an IIFE, opens a set of structurally
// diverse real websites in headless Chromium, runs collectUnits() on each, and
// reports any text node covered by more than one unit (= duplicate-translation
// risk) plus other collection anomalies. No API key / LLM needed.
//
// Usage: node tools/collector-probe/run.mjs [url ...]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium, firefox } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_URLS = [
  // Docs (Sphinx/RTD, mdBook, MDN, framework sites)
  'https://docs.godotengine.org/en/stable/',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a',
  'https://doc.rust-lang.org/book/ch01-00-getting-started.html',
  'https://docs.python.org/3/tutorial/introduction.html',
  'https://go.dev/doc/tutorial/getting-started',
  'https://vuejs.org/guide/introduction.html',
  'https://kubernetes.io/docs/concepts/overview/',
  'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
  'https://react.dev/learn',
  'https://tailwindcss.com/docs/installation',
  // Long-form articles / blogs (plain HTML)
  'https://www.gnu.org/philosophy/free-sw.en.html',
  'https://overreacted.io/a-complete-guide-to-useeffect/',
  'https://danluu.com/input-lag/',
  // News / list-heavy
  'https://news.ycombinator.com/',
  'https://lobste.rs/',
  // App shells / marketing / SPA
  'https://github.com/golang/go',
  'https://stripe.com/',
  'https://vercel.com/',
  // Q&A with mixed inline code
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
];

async function buildBundle() {
  const result = await esbuild.build({
    entryPoints: [path.join(dirname, 'entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// Runs in the page. Returns plain JSON (never DOM nodes).
function probe() {
  const DR = window.__DR_PROBE;
  const units = DR.collectUnits();

  const nodeToUnits = new Map();
  const nodeText = new Map();
  units.forEach((u, i) => {
    const nodes = u.nodes && u.nodes.length ? u.nodes : DR.collectVisibleTextNodes(u.el, true);
    for (const n of nodes) {
      const arr = nodeToUnits.get(n) || [];
      arr.push(i);
      nodeToUnits.set(n, arr);
      nodeText.set(n, (n.nodeValue || '').replace(/\s+/g, ' ').trim());
    }
  });

  const desc = (el) => {
    if (!el || !el.tagName) return '?';
    const cls = (el.className && typeof el.className === 'string') ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${cls}`.slice(0, 70);
  };
  const chain = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 6; n = n.parentElement) parts.push(desc(n));
    return parts.join(' > ');
  };

  const dupSamples = [];
  let duplicateNodeCount = 0;
  for (const [n, idxs] of nodeToUnits) {
    if (idxs.length > 1) {
      duplicateNodeCount++;
      if (dupSamples.length < 20) {
        dupSamples.push({
          text: nodeText.get(n).slice(0, 60),
          covering: idxs.map((i) => `${units[i].kind}<${desc(units[i].el)}>:${units[i].text.slice(0, 40)}`),
          chains: idxs.map((i) => chain(units[i].el)),
          html: duplicateNodeCount <= 1 ? idxs.map((i) => units[i].el.outerHTML.slice(0, 260)) : undefined,
        });
      }
    }
  }

  // Units whose translated text is fully contained by another unit's text and
  // whose element is an ancestor/descendant — a softer overlap signal.
  const emptyText = units.filter((u) => !u.text || u.text.trim().length < 2).length;

  const bodyTextLen = (document.body.innerText || '').replace(/\s+/g, ' ').trim().length;
  const coveredLen = units.reduce((a, u) => a + (u.text ? u.text.length : 0), 0);
  const sampleTexts = units.slice(0, 8).map((u) => `${u.kind}:${u.text.slice(0, 45)}`);

  return {
    url: location.href,
    total: units.length,
    duplicateNodeCount,
    emptyText,
    bodyTextLen,
    coveredLen,
    coverage: bodyTextLen ? +(coveredLen / bodyTextLen).toFixed(2) : 0,
    sampleTexts,
    dupSamples,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const engineArg = (process.env.PROBE_BROWSER || 'chromium').toLowerCase();
  const engine = engineArg === 'firefox' ? firefox : chromium;
  const engineName = engineArg === 'firefox' ? 'firefox' : 'chromium';
  const urls = args.length ? args : DEFAULT_URLS;
  const code = await buildBundle();
  console.log(`engine: ${engineName}   sites: ${urls.length}\n`);
  const browser = await engine.launch();

  const reports = [];
  for (const url of urls) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // Only spoof a desktop Chrome UA on Chromium; let Firefox send its own.
      ...(engineName === 'chromium'
        ? {
            userAgent:
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          }
        : {}),
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2_000);
      // page.evaluate runs via CDP, bypassing page CSP (addScriptTag would be
      // blocked on strict-CSP sites like MDN).
      await page.evaluate(code);
      const report = await page.evaluate(probe);
      reports.push(report);
      const status = report.duplicateNodeCount === 0 ? 'OK ' : 'DUP';
      console.log(
        `[${status}] ${report.total.toString().padStart(4)} units  ` +
          `${report.duplicateNodeCount.toString().padStart(3)} dup-nodes  ` +
          `cov ${String(report.coverage).padStart(4)}  ${url}`,
      );
      if (process.env.VERBOSE) report.sampleTexts?.forEach((t) => console.log(`        ~ ${t}`));
      for (const s of report.dupSamples.slice(0, 6)) {
        console.log(`        · "${s.text}"  ← ${s.covering.join('  ||  ')}`);
        if (s.chains) s.chains.forEach((c, i) => console.log(`            [${i}] ${c}`));
        if (s.html) s.html.forEach((h, i) => console.log(`            html[${i}] ${h.replace(/\s+/g, ' ')}`));
      }
    } catch (err) {
      reports.push({ url, error: String(err?.message || err) });
      console.log(`[ERR] ${url}\n        ${err?.message || err}`);
    } finally {
      await context.close();
    }
  }

  await browser.close();

  const totalDup = reports.reduce((a, r) => a + (r.duplicateNodeCount || 0), 0);
  const errors = reports.filter((r) => r.error).length;
  console.log('\n──────── summary ────────');
  console.log(`sites: ${reports.length}   errors: ${errors}   total duplicate nodes: ${totalDup}`);
  process.exit(totalDup > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
