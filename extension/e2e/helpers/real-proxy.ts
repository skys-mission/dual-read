import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(dirname, '../../../server');

export interface RealProxy {
  apiBase: string;
  origin: string;
  close(): Promise<void>;
}

export interface RealProxyOptions {
  apiKey?: string;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve proxy port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitUntilReady(origin: string, child: ChildProcessWithoutNullStreams, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`dual-read-server exited with ${child.exitCode}\n${logs()}`);
    }
    try {
      const response = await fetch(`${origin}/livez`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The Go build and first server start can take a few seconds in CI.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`dual-read-server did not become ready\n${logs()}`);
}

export async function startRealProxy(
  upstreamOrigin: string,
  options: RealProxyOptions = {},
): Promise<RealProxy> {
  const port = await reserveLoopbackPort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-read-e2e-'));
  const origin = `http://127.0.0.1:${port}`;
  let output = '';

  const child = spawn('go', ['run', './cmd/dual-read-server', '-data-dir', dataDir], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      OPENAI_API_KEY: options.apiKey ?? 'e2e-upstream-key',
      OPENAI_BASE_URL: upstreamOrigin,
      DUAL_READ_HOST: '127.0.0.1',
      DUAL_READ_PORT: String(port),
      DUAL_READ_ADMIN_TOKEN: 'e2e-admin-token',
      DUAL_READ_ALLOW_PRIVATE_UPSTREAM: 'true',
      DUAL_READ_METRICS_ENABLED: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-16_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  try {
    await waitUntilReady(origin, child, () => output);
  } catch (error) {
    child.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    apiBase: `${origin}/v1`,
    origin,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}
