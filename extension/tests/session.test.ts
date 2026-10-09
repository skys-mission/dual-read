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

  it('preserves appended plain source in replace mode', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>Original plain paragraph.</p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const p = document.querySelector('p')!;
      p.appendChild(document.createTextNode(' Additional source content.'));
      await vi.advanceTimersByTimeAsync(1600);
      expect(p.textContent).toContain('译:Original plain paragraph. Additional source content.');
      expect(session.status()).toMatchObject({ count: 1, total: 1, failed: 0 });
      session.restore();
      expect(p.textContent).toBe('Original plain paragraph. Additional source content.');
    } finally { session.dispose(); }
  });

  it('preserves rich descendant replacement in replace mode', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p><strong>Old title</strong> original paragraph.</p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const p = document.querySelector('p')!;
      const original = p.querySelector('.dual-read-original-hidden strong')!;
      p.querySelector(':scope > strong')!.textContent = 'New title';
      await vi.advanceTimersByTimeAsync(1600);
      expect(p.querySelector(':scope > strong')!.textContent).toBe('译:New title');
      expect(session.status()).toMatchObject({ count: 1, total: 1, failed: 0 });
      session.restore();
      expect(p.textContent).toBe('New title original paragraph.');
      expect(p.querySelector('strong')).toBe(original);
    } finally { session.dispose(); }
  });

  it.each([false, true])('keeps mixed segments tracked when the link finishes first: %s', async (linkFirst) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>Read this paragraph with <a href="/test">the linked documentation</a> and useful content.<img src="x"></p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => {
      if (texts[0].includes('linked') !== linkFirst) await new Promise((resolve) => setTimeout(resolve, 1000));
      return texts.map((text) => `译:${text}`);
    });
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(4000);
      await start;
      expect(session.status()).toMatchObject({ count: 2, total: 2 });
      expect(document.querySelector('a')!.textContent).toContain('译:the linked documentation');
      expect(translateBatchViaPort).toHaveBeenCalledTimes(2);
      session.restore();
      expect(document.querySelector('p')!.textContent).toBe('Read this paragraph with the linked documentation and useful content.');
    } finally { session.dispose(); }
  });

  it.each(['bilingual', 'replace'] as const)('keeps independent links and parent source tracked after an append in %s mode', async (mode) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>Read this paragraph with <a href="/docs">the linked documentation</a> and useful content.<img src="x"></p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const p = document.querySelector('p')!;
      const link = document.querySelector('a')!;
      const selector = mode === 'replace' ? '.dual-read-replace-text' : '.dual-read-target';
      const linkTranslation = link.querySelector(selector)!;
      expect(linkTranslation.textContent).toContain('译:the linked documentation');
      expect(p.querySelector(`:scope > ${selector}`)!.textContent).toContain('Read this paragraph with and useful content.');
      p.appendChild(document.createTextNode(' Additional source.'));
      await vi.advanceTimersByTimeAsync(1600);
      expect(link.querySelector(selector)).toBe(linkTranslation);
      expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
      expect(translateBatchViaPort).toHaveBeenCalledTimes(3);
      expect(p.querySelector(`:scope > ${selector}`)!.textContent).toContain('Read this paragraph with and useful content. Additional source.');
      session.restore();
      expect(p.textContent).toBe('Read this paragraph with the linked documentation and useful content. Additional source.');
    } finally { session.dispose(); }
  });

  it.each([false, true])('preserves rich source across hosts with watching: %s', async (watching) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="one">Read <strong>the original title</strong> for details.</p><p id="two">Another paragraph <em>with a note</em> here.</p>';
    const title = document.querySelector('#one strong')!;
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      if (!watching) session.pause();
      const two = document.querySelector('#two')!;
      const copy = document.querySelector('#one > strong')!;
      (copy.firstChild as Text).appendData(' with more source');
      two.appendChild(copy);
      await vi.advanceTimersByTimeAsync(1600);
      const sources = vi.mocked(translateBatchViaPort).mock.calls.flatMap(([texts]) => texts);
      expect(sources.every((text) => !text.includes('译:'))).toBe(true);
      if (watching) expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
      session.restore();
      expect(document.querySelector('#one')!.textContent).toBe('Read  for details.');
      expect(two.textContent).toBe('Another paragraph with a note here.the original title with more source');
      expect(two.querySelector('strong')).toBe(title);
    } finally { session.dispose(); }
  });

  it.each(['new host', 'late attachment'] as const)('collects transferred source before indexing a shadow root: %s', async (discovery) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="one">Read <strong>The original title</strong> for details.</p><div id="shadow-host"></div>';
    const title = document.querySelector('#one strong')!;
    const originalText = title.firstChild!;
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const host = discovery === 'new host' ? document.createElement('div') : document.querySelector('#shadow-host')!;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<p id="two" lang="en">A new paragraph </p>';
      const copy = document.querySelector('#one > strong')!;
      (copy.firstChild as Text).splitText(5);
      root.querySelector('p')!.appendChild(copy);
      if (discovery === 'new host') document.body.appendChild(host);
      await vi.advanceTimersByTimeAsync(2400);
      const sources = vi.mocked(translateBatchViaPort).mock.calls.flatMap(([texts]) => texts);
      expect(sources.some((text) => text.includes('The original title'))).toBe(true);
      expect(sources.every((text) => !text.includes('译:'))).toBe(true);
      expect(root.querySelector('#two > strong')!.textContent).toBe('译:The original title');
      expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
      session.restore();
      expect(root.querySelector('p')!.textContent).toBe('A new paragraph The original title');
      expect(root.querySelector('strong')).toBe(title);
      expect(title.firstChild).toBe(originalText);
      expect(root.querySelector('p')!.getAttribute('lang')).toBe('en');
    } finally { session.dispose(); }
  });

  it('retranslates a completely replaced link source after its text stashes are removed', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>Read this paragraph with <a href="/docs">the linked documentation</a> and useful content.<img src="x"></p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const link = document.querySelector('a')!;
      link.textContent = 'The updated linked guide';
      await vi.advanceTimersByTimeAsync(1600);
      expect(link.querySelector('.dual-read-replace-text')!.textContent).toBe('译:The updated linked guide');
      expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
      session.restore();
      expect(link.textContent).toBe('The updated linked guide');
    } finally { session.dispose(); }
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

  it('ignores an old response after a source update replaces its entry', async () => {
    vi.useFakeTimers();
    paragraphs(1);
    const pending: ((translations: string[]) => void)[] = [];
    vi.mocked(translateBatchViaPort).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const session = new ContentSession(config({ batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(400);
      const p = document.querySelector('p')!;
      p.firstChild!.nodeValue = 'A completely different newer paragraph.';
      await vi.advanceTimersByTimeAsync(400);
      expect(pending).toHaveLength(2);
      pending[1]!(['新译文']);
      await vi.advanceTimersByTimeAsync(400);
      pending[0]!(['旧译文']);
      await vi.advanceTimersByTimeAsync(8000);
      await start;
      expect(p.querySelector('.dual-read-target')?.textContent).toBe('新译文');
      expect(session.status()).toMatchObject({ count: 1, total: 1, failed: 0 });
    } finally { session.dispose(); }
  });

  it.each(['bilingual', 'replace'] as const)('retranslates textContent changes in %s mode without a render feedback loop', async (mode) => {
    vi.useFakeTimers();
    paragraphs(1);
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      expect(translateBatchViaPort).toHaveBeenCalledTimes(1);
      const p = document.querySelector('p')!;
      p.textContent = 'A completely different newer paragraph.';
      await vi.advanceTimersByTimeAsync(1600);
      expect(translateBatchViaPort).toHaveBeenCalledTimes(2);
      expect(p.textContent).toContain('译:A completely different newer paragraph.');
      expect(session.status()).toMatchObject({ count: 1, total: 1 });
      session.restore();
      expect(p.textContent).toBe('A completely different newer paragraph.');
    } finally { session.dispose(); }
  });

  it('preserves appended source text when invalidating rich replace markup', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p><strong>Read the</strong> original paragraph.</p>';
    vi.mocked(translateBatchViaPort).mockImplementation(async (texts) => texts.map((text) => `译:${text}`));
    const session = new ContentSession(config({ mode: 'replace', batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600);
      await start;
      const p = document.querySelector('p')!;
      p.appendChild(document.createTextNode(' Additional source content.'));
      await vi.advanceTimersByTimeAsync(1600);
      expect(p.textContent).toContain('译:Additional source content.');
      session.restore();
      expect(p.textContent).toBe('Read the original paragraph. Additional source content.');
      expect(p.querySelector('strong')?.textContent).toBe('Read the');
    } finally { session.dispose(); }
  });

  it('drops a response arriving before the mutation debounce and handles empty source', async () => {
    vi.useFakeTimers();
    paragraphs(1);
    let resolve!: (translations: string[]) => void;
    vi.mocked(translateBatchViaPort).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const session = new ContentSession(config({ batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      const p = document.querySelector('p')!;
      p.firstChild!.nodeValue = '';
      resolve(['过时译文']);
      await vi.advanceTimersByTimeAsync(100);
      expect(p.textContent).toBe('');
      await vi.advanceTimersByTimeAsync(1400);
      await start;
      expect(session.status()).toMatchObject({ count: 0, total: 0, failed: 0 });
    } finally { session.dispose(); }
  });

  it.each(['bilingual', 'replace'] as const)('translates new prose during continuous unrelated class animation in %s', async mode => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><svg id="spinner" class="first" aria-hidden="true"></svg></main>';
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    await session.start();
    const late = document.createElement('p'); late.textContent = 'Newly appended document paragraph.';
    const original = late.firstChild;
    document.querySelector('main')!.appendChild(late);
    const animation = setInterval(() => {
      const spinner = document.getElementById('spinner')!;
      spinner.setAttribute('class', spinner.getAttribute('class') === 'first' ? 'second' : 'first');
    }, 100);
    try {
      await vi.advanceTimersByTimeAsync(1600);
      expect(late.textContent).toContain('译:Newly appended document paragraph.');
      expect(translateBatchViaPort).toHaveBeenCalledTimes(1);
      expect(session.status()).toMatchObject({ count: 1, total: 1, watching: true });
      session.restore();
      await vi.advanceTimersByTimeAsync(800);
      expect(late.firstChild).toBe(original);
      expect(late.textContent).toBe('Newly appended document paragraph.');
      expect(document.querySelector('.dual-read-target,.dual-read-original-hidden')).toBeNull();
    } finally { clearInterval(animation); session.dispose(); }
  });

  it.each(['bilingual', 'replace'] as const)('reindexes nested shadow and slotted prose after ancestor reveals in %s', async mode => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><read-widget id="widget"><p id="slotted" slot="copy">Assigned slot documentation.</p></read-widget><other-widget></other-widget></main>';
    const widget = document.getElementById('widget')!;
    const root = widget.attachShadow({mode:'open'});
    root.innerHTML = '<div id="inner"><slot name="copy"></slot><nested-widget></nested-widget></div>';
    const inner = root.querySelector<HTMLElement>('#inner')!;
    // jsdom caches a shadow element's UA [hidden] display after its removal.
    // Native Chromium/Firefox fixtures also exercise the actual CSS behavior.
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computedStyle(element);
      if (element === inner) style.display = inner.hidden ? 'none' : 'block';
      return style;
    });
    const nested = root.querySelector('nested-widget')!.attachShadow({mode:'open'});
    nested.innerHTML = '<p style="color:black;background:black"><span style="color:white">Nested component documentation.</span></p>';
    const other = document.querySelector('other-widget')!.attachShadow({mode:'open'});
    other.innerHTML = '<p>Unrelated component documentation.</p>';
    const original = nested.querySelector('p')!.firstChild;
    const slotted = document.getElementById('slotted')!; const slotOriginal = slotted.firstChild;
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({mode}));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600); await start;
      expect(nested.textContent).toContain('译:Nested component documentation.');
      const unrelated = other.querySelector('.dual-read-target');
      // Reveal while source moves emitted by restoration still await their
      // own mutation batch. The narrower span must not become a second unit.
      widget.setAttribute('style','opacity:0'); await vi.advanceTimersByTimeAsync(400);
      widget.setAttribute('style','opacity:1'); await vi.advanceTimersByTimeAsync(1600);
      expect(nested.textContent).toContain('译:Nested component documentation.');
      expect(nested.querySelectorAll('.dual-read-target,.dual-read-replace-text')).toHaveLength(1);
      expect(slotted.textContent).toContain('译:Assigned slot documentation.');
      root.querySelector<HTMLElement>('#inner')!.hidden = true; await vi.advanceTimersByTimeAsync(800);
      root.querySelector<HTMLElement>('#inner')!.hidden = false; await vi.advanceTimersByTimeAsync(1600);
      expect(slotted.textContent).toContain('译:Assigned slot documentation.');
      expect(nested.textContent).toContain('译:Nested component documentation.');
      expect(nested.querySelectorAll('.dual-read-target,.dual-read-replace-text')).toHaveLength(1);
      expect(other.querySelector('.dual-read-target')).toBe(unrelated);
      session.restore(); session.restore();
      expect(nested.querySelector('p')!.firstChild).toBe(original); expect(slotted.firstChild).toBe(slotOriginal);
      expect(slotted.textContent).toBe('Assigned slot documentation.');
      expect(root.querySelector<HTMLSlotElement>('slot')!.assignedElements()).toEqual([slotted]);
    } finally {session.restore();}
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
