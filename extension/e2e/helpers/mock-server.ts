import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.resolve(dirname, '../fixtures/pages');

export type MockMode = 'ok' | 'auth_fail' | 'malformed' | 'xss';

export type TranslateFn = (source: string) => string;

/** Synthetic perf fixtures — generated on the fly (not checked into git). */
function buildSyntheticPerfPage(name: string): string | null {
  const match = /^lab-perf-(\d+)k\.html$/.exec(name);
  if (!match) return null;
  const thousands = Number(match[1]);
  if (!Number.isFinite(thousands) || thousands < 1 || thousands > 50) return null;
  const count = thousands * 1000;
  const parts: string[] = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    `<title>Dual Read Perf Lab — ${count} units</title>`,
    '<style>body{font-family:Georgia,serif;max-width:48rem;margin:1rem auto;line-height:1.4}',
    'p{margin:0.25rem 0}</style></head><body>',
    `<main id="root" data-perf-units="${count}">`,
    `<h1 id="title">Perf fixture ${count}</h1>`,
  ];
  for (let i = 0; i < count; i++) {
    parts.push(`<p id="u${i}">Perf unit ${i}: The quick brown fox jumps over the lazy dog.</p>`);
  }
  parts.push('</main></body></html>');
  return parts.join('\n');
}

export interface MockServer {
  /** OpenAI-compatible base ending with /v1 (no trailing slash beyond that). */
  apiBase: string;
  /** Origin for fixture pages, e.g. http://127.0.0.1:3456 */
  origin: string;
  /**
   * Separate loopback origin (different port) used as a cross-origin iframe
   * barrier — no external network required.
   */
  barrierOrigin: string;
  fixtureUrl(name: string): string;
  setMode(mode: MockMode): void;
  setTranslator(fn: TranslateFn): void;
  setResponseDelay(ms: number): void;
  getRequestCount(): number;
  close(): Promise<void>;
}

/**
 * Local HTTP server for Chromium E2E:
 * - GET /pages/* → static fixture HTML
 * - POST /v1/chat/completions → deterministic mock translations
 *
 * Fetches come from the extension service worker, so Playwright page.route
 * cannot intercept them — a real loopback listener is required.
 */
export async function startMockServer(): Promise<MockServer> {
  let mode: MockMode = 'ok';
  let translate: TranslateFn = (source) => `译:${source}`;
  let responseDelayMs = 0;
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname.startsWith('/pages/')) {
      const name = path.basename(url.pathname);
      if (!/^[\w.-]+\.html$/.test(name)) {
        res.writeHead(400);
        res.end('bad path');
        return;
      }
      const synthetic = buildSyntheticPerfPage(name);
      if (synthetic) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(synthetic);
        return;
      }
      const file = path.join(PAGES_DIR, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end('missing fixture');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      requestCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const respond = () => {
          if (mode === 'auth_fail') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
            return;
          }

          let indexed: Record<string, string> = {};
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              messages?: { role?: string; content?: string }[];
            };
            const user = body.messages?.find((m) => m.role === 'user')?.content ?? '{}';
            indexed = JSON.parse(user) as Record<string, string>;
          } catch {
            indexed = {};
          }

          if (mode === 'malformed') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{ message: { content: 'not-json-and-not-aligned' } }],
            }));
            return;
          }

          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(indexed)) {
            const source = String(v);
            out[k] = mode === 'xss'
              ? `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>${source}`
              : translate(source);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(out) } }],
          }));
        };

        if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
        else respond();
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  const barrier = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>barrier</title><p>Cross-origin barrier frame</p>');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    barrier.once('error', reject);
    barrier.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const barrierPort = (barrier.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const barrierOrigin = `http://127.0.0.1:${barrierPort}`;

  const forceClose = (s: http.Server): Promise<void> =>
    new Promise((resolve) => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close(() => resolve());
      setTimeout(resolve, 1_000);
    });

  return {
    apiBase: `${origin}/v1`,
    origin,
    barrierOrigin,
    fixtureUrl(name: string) {
      return `${origin}/pages/${name}`;
    },
    setMode(next: MockMode) {
      mode = next;
    },
    setTranslator(fn: TranslateFn) {
      translate = fn;
    },
    setResponseDelay(ms: number) {
      responseDelayMs = Math.max(0, Math.floor(ms));
    },
    getRequestCount() {
      return requestCount;
    },
    async close() {
      await Promise.all([forceClose(server), forceClose(barrier)]);
    },
  };
}
