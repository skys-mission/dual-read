// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ContentSession, configChanged } from '../lib/scheduler/session';
import { translateBatchViaPort } from '../lib/messaging';
import { DualReadError } from '../lib/errors';
import type { PublicSessionConfig } from '../lib/types';

vi.mock('../lib/messaging', async () => {
  const errors = await vi.importActual<typeof import('../lib/errors')>('../lib/errors');
  return {
    translateBatchViaPort: vi.fn(),
    isAbortError: errors.isAbortError,
  };
});

vi.mock('../lib/cache', () => ({
  lookup: vi.fn((texts: string[]) => Promise.resolve(texts.map(() => null))),
  store: vi.fn(() => Promise.resolve()),
}));

// Keep cooperative scheduling synchronous under fake timers: the real
// MessageChannel fallback depends on event-loop pumping that fake timers
// do not drive deterministically.
vi.mock('../lib/runtime/yield', () => ({
  yieldToMain: vi.fn(() => Promise.resolve()),
  sliceExceeded: (startedAt: number, budgetMs: number) => performance.now() - startedAt >= budgetMs,
}));

function config(partial: Partial<PublicSessionConfig> = {}): PublicSessionConfig {
  return {
    sessionId: 'sess-1',
    revision: 1,
    targetLang: 'zh-CN',
    uiLocale: 'en',
    mode: 'bilingual',
    maxConcurrent: 2,
    batchSize: 4,
    providerFingerprint: 'fp-aaa',
    disabled: false,
    ...partial,
  };
}

function stubObservers(): void {
  if (typeof IntersectionObserver === 'undefined') {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  if (typeof MutationObserver === 'undefined') {
    vi.stubGlobal(
      'MutationObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
}

describe('configChanged', () => {
  it('detects revision / fingerprint / mode / lang changes', () => {
    const a = config();
    expect(configChanged(a, config())).toBe(false);
    expect(configChanged(a, config({ revision: 2 }))).toBe(true);
    expect(configChanged(a, config({ providerFingerprint: 'fp-bbb' }))).toBe(true);
    expect(configChanged(a, config({ mode: 'replace' }))).toBe(true);
    expect(configChanged(a, config({ targetLang: 'en' }))).toBe(true);
  });
});

describe('ContentSession lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><p>Hello world</p></main>';
    stubObservers();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('marks disposed sessions as not alive and stops watching', () => {
    const session = new ContentSession(config());
    session.resumeWatch();
    expect(session.alive).toBe(true);
    expect(session.status().watching).toBe(true);
    session.dispose('stop');
    expect(session.alive).toBe(false);
    expect(session.status().watching).toBe(false);
    expect(session.status().translating).toBe(false);
  });

  it('start on disabled config disposes immediately', async () => {
    const session = new ContentSession(config({ disabled: true }));
    const result = await session.start();
    expect(result.success).toBe(false);
    expect(session.alive).toBe(false);
  });

  it('dispose ignores subsequent resumeWatch', () => {
    const session = new ContentSession(config());
    session.dispose('replace');
    session.resumeWatch();
    expect(session.status().watching).toBe(false);
  });

  it('pause then resumeWatch restores watching', () => {
    const session = new ContentSession(config());
    session.resumeWatch();
    expect(session.status().watching).toBe(true);
    session.pause();
    expect(session.status().watching).toBe(false);
    session.resumeWatch();
    expect(session.alive).toBe(true);
    expect(session.status().watching).toBe(true);
    session.dispose('stop');
  });

  it('exposes session id and revision in status', () => {
    const session = new ContentSession(config({ sessionId: 'abc', revision: 9 }));
    expect(session.status().sessionId).toBe('abc');
    expect(session.status().revision).toBe(9);
  });
});

describe('ContentSession scheduling state machine', () => {
  const realRect = Element.prototype.getBoundingClientRect;

  /** Fires `isIntersecting` synchronously on observe so entries enqueue immediately. */
  class AutoIO {
    private readonly cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element): void {
      this.cb(
        [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  function paragraphs(n: number): void {
    const main = document.createElement('main');
    for (let i = 0; i < n; i++) {
      const p = document.createElement('p');
      p.textContent = `Sentence number ${i}: the quick brown fox jumps over the lazy dog.`;
      main.appendChild(p);
    }
    document.body.appendChild(main);
  }

  function hangingPort(): void {
    vi.mocked(translateBatchViaPort).mockImplementation(
      (_texts, opts) =>
        new Promise<string[]>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
  }

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', AutoIO);
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 40,
        width: 400, height: 40, toJSON() {},
      } as DOMRect;
    };
    vi.mocked(translateBatchViaPort).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.getBoundingClientRect = realRect;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('sends non-retryable failures straight to terminal (no auto retry)', async () => {
    vi.useFakeTimers();
    paragraphs(1);
    vi.mocked(translateBatchViaPort).mockRejectedValue(
      new DualReadError('AUTH_INVALID', { detail: 'bad key' }),
    );
    const session = new ContentSession(config());
    const startP = session.start();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await startP;
    expect(result.success).toBe(true);
    expect(result.failed).toBe(1);
    expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(1);
    expect(session.status().translating).toBe(false);
    session.dispose('stop');
  });

  it('pause clears pending retries so status stops translating', async () => {
    vi.useFakeTimers();
    paragraphs(1);
    vi.mocked(translateBatchViaPort).mockRejectedValue(
      new DualReadError('UPSTREAM_UNAVAILABLE', { detail: 'HTTP 500' }),
    );
    const session = new ContentSession(config());
    const startP = session.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(session.status().translating).toBe(true); // retry pending
    session.pause();
    expect(session.status().translating).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await startP;
    session.dispose('stop');
  });

  it('pause strands no in-flight entry: resumeWatch re-dispatches it', async () => {
    vi.useFakeTimers();
    paragraphs(1);
    hangingPort();
    const session = new ContentSession(config());
    const startP = session.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(1);
    session.pause();
    await vi.advanceTimersByTimeAsync(50);
    expect(session.status().translating).toBe(false);

    vi.mocked(translateBatchViaPort).mockResolvedValue(['译文句子一。']);
    session.resumeWatch();
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await startP;
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    session.dispose('stop');
  });

  it('pause does not dispatch the queued remainder of a full pipeline', async () => {
    vi.useFakeTimers();
    paragraphs(9); // batchSize 4 × concurrency 2 → 8 in flight, 1 queued
    hangingPort();
    const session = new ContentSession(config());
    const startP = session.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(2);
    session.pause();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(2);
    expect(session.status().translating).toBe(false);
    session.dispose('stop');
    await vi.advanceTimersByTimeAsync(10_000);
    await startP;
  });
});
