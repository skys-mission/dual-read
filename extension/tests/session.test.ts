// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ContentSession, configChanged } from '../lib/scheduler/session';
import { translateBatchViaPort } from '../lib/messaging';
import { lookup } from '../lib/cache';
import { yieldToMain } from '../lib/runtime/yield';
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

  it.each((['bilingual', 'replace'] as const).flatMap(mode =>
    (['text', 'replacement', 'rich', 'segment', 'hidden', 'code'] as const).map(change => ({ mode, change }))),
  )('keeps collected text and source identity consistent across an index yield: $mode / $change', async ({ mode, change }) => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><p id="source">${change === 'rich' ? '<strong>Original source before hydration.</strong>'
      : change === 'segment' ? 'Original source before hydration.<button>Action</button>' : 'Original source before hydration.'}</p><p>Unaffected source paragraph.</p></main>`;
    const host = document.getElementById('source')!;
    const original = (change === 'rich' ? host.firstChild!.firstChild : host.firstChild) as Text;
    let retained: Text = original;
    let yielded = false, ticks = 0;
    vi.mocked(yieldToMain).mockImplementationOnce(async () => {
      yielded = true;
      if (change === 'hidden') host.style.display = 'none';
      else if (change === 'code') host.className = 'shiki';
      else if (change === 'replacement') {
        retained = document.createTextNode('Updated source after hydration.'); original.replaceWith(retained);
      } else original.data = 'Updated source after hydration.';
    });
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => ticks += 13);
    const session = new ContentSession(config({ mode }));
    try {
      const start = session.start();
      await vi.advanceTimersByTimeAsync(2600); await start;
      expect(yielded).toBe(true);
      const targets = host.querySelectorAll('.dual-read-target,.dual-read-replace-text');
      if (change === 'hidden' || change === 'code') expect(targets).toHaveLength(0);
      else {
        const translated = mode === 'replace' && change === 'rich'
          ? [...host.childNodes].filter(node => !(node instanceof Element && node.matches('.dual-read-original-hidden')))
          : [...targets];
        expect(translated.map(node => node.textContent).join(' ')).toContain('译:Updated source after hydration.');
        expect(translated.map(node => node.textContent).join(' ')).not.toContain('Original source');
      }
      session.restore(); session.restore();
      expect(host.contains(retained)).toBe(true);
      expect(retained.data).toBe(change === 'hidden' || change === 'code' ? 'Original source before hydration.' : 'Updated source after hydration.');
      expect(host.querySelector('button')?.textContent).toBe(change === 'segment' ? 'Action' : undefined);
    } finally {
      session.restore(); clock.mockRestore();
      vi.mocked(yieldToMain).mockReset().mockResolvedValue();
    }
  });

  it.each(['delivered', 'undelivered'] as const)('can translate a detached owner reused after full restore and a new session: %s', async delivery => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><div id="clip" style="display:-webkit-box;-webkit-line-clamp:3"><p id="source">Reusable article excerpt.</p><p>Retained article excerpt.</p></div></main>';
    const host = document.getElementById('source')!, text = host.firstChild!, clip = host.parentElement!;
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const first = new ContentSession(config());
    let next: ContentSession | undefined;
    try {
      const start = first.start(); await vi.advanceTimersByTimeAsync(1600); await start;
      first.pause(); host.remove();
      if (delivery === 'delivered') await vi.advanceTimersByTimeAsync(100);
      first.restore(); first.restore();
      expect(host.hasAttribute('data-dual-read-done')).toBe(false);
      expect(host.hasAttribute('data-dual-read-mode')).toBe(false);
      next = new ContentSession(config({ sessionId: 'next' }));
      const restart = next.start(); await vi.advanceTimersByTimeAsync(1600); await restart;
      clip.prepend(host); await vi.advanceTimersByTimeAsync(1600);
      expect([...document.querySelectorAll('.dual-read-target')].some(node => node.textContent === '译:Reusable article excerpt.')).toBe(true);
      next.restore(); expect(host.firstChild).toBe(text);
      expect(host.textContent).toBe('Reusable article excerpt.');
    } finally { first.restore(); next?.restore(); }
  });

  it('releases relocated layout subscriptions after an unclamped source is dropped', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p style="display:-webkit-box;-webkit-line-clamp:2">Original article excerpt.</p></main>';
    const host = document.querySelector('p')!;
    let clamped = true;
    const computed = window.getComputedStyle.bind(window);
    // A media/CSSOM change produces no source attribute mutation (and thus
    // must not rely on the session replacing the entry to release its layout).
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const value = computed(element);
      if (element === host) value.setProperty('-webkit-line-clamp', clamped ? '2' : 'none');
      return value;
    });
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config());
    try {
      const start = session.start(); await vi.advanceTimersByTimeAsync(1600); await start;
      clamped = false; window.dispatchEvent(new Event('resize')); await vi.advanceTimersByTimeAsync(400);
      const target = host.querySelector<HTMLElement>('.dual-read-target')!;
      expect(target).not.toBeNull();
      host.remove(); await vi.advanceTimersByTimeAsync(1600);
      expect(session.status()).toMatchObject({ count: 0, total: 0 });
      const frames = vi.spyOn(window, 'requestAnimationFrame');
      try {
        window.dispatchEvent(new Event('resize')); await vi.advanceTimersByTimeAsync(50);
        expect(frames).not.toHaveBeenCalled();
      } finally { frames.mockRestore(); }
      document.querySelector('main')!.append(host); await vi.advanceTimersByTimeAsync(400);
      expect(target.isConnected).toBe(true);
      expect(target.style.display).not.toBe('none');
      session.restore(); expect(host.textContent).toBe('Original article excerpt.');
    } finally { session.restore(); styles.mockRestore(); }
  });

  it.each(
    (['watching', 'paused'] as const).flatMap(state =>
      (['remove', 'replace', 'transfer', 'container'] as const).map(operation => ({ state, operation }))),
  )('cleans owned relocated companions after $operation while $state', async ({ state, operation }) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><div id="clip" style="display:-webkit-box;-webkit-line-clamp:2;overflow:hidden"><p id="copy">Original article excerpt with useful details.</p><p id="retained">Retained article excerpt with other details.</p></div><div id="sink"></div><pre><code>const unchanged = true;</code></pre></main>';
    const clip = document.getElementById('clip')!;
    const copy = document.getElementById('copy')!;
    const retained = document.getElementById('retained')!;
    const source = copy.firstChild!;
    const retainedText = retained.firstChild;
    const code = document.querySelector('code')!;
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config());
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1600); await start;
      expect(document.querySelectorAll('main > .dual-read-target')).toHaveLength(2);
      if (state === 'paused') session.pause();
      let replacement: HTMLElement | undefined;
      if (operation === 'container') clip.remove();
      else if (operation === 'replace') {
        replacement = document.createElement('p');
        replacement.textContent = 'Updated article excerpt with new details.';
        copy.replaceWith(replacement);
      } else {
        copy.remove();
        if (operation === 'transfer') {
          replacement = document.createElement('p');
          replacement.append(source);
          document.getElementById('sink')!.append(replacement);
        }
      }
      if (state === 'paused') session.resumeWatch();
      await vi.advanceTimersByTimeAsync(1600);
      const expected = operation === 'container' ? 0 : operation === 'remove' ? 1 : 2;
      expect(document.querySelectorAll('.dual-read-target')).toHaveLength(expected);
      expect(session.status()).toMatchObject({ count: expected, total: expected });
      expect(Array.from(document.querySelectorAll('main > .dual-read-target')).map(node => node.textContent).join(' ')).not.toContain('译:Original article excerpt');
      expect(copy.isConnected).toBe(false);
      expect(source.parentNode).toBe(operation === 'transfer' ? replacement : copy);
      if (operation === 'remove') {
        // Reusing the same detached source must not retain a stale DONE marker.
        clip.prepend(copy);
        await vi.advanceTimersByTimeAsync(1600);
        expect(document.querySelectorAll('main > .dual-read-target')).toHaveLength(2);
        expect(session.status()).toMatchObject({ count: 2, total: 2 });
      }
      session.restore(); session.restore();
      expect(document.querySelector('.dual-read-target')).toBeNull();
      expect(source.nodeValue).toBe('Original article excerpt with useful details.');
      expect(source.parentNode).toBe(operation === 'transfer' ? replacement : copy);
      expect(retained.firstChild).toBe(retainedText);
      expect(document.querySelector('code')).toBe(code);
      expect(code.textContent).toBe('const unchanged = true;');
      if (replacement) expect(replacement.isConnected).toBe(true);
      expect(copy.isConnected).toBe(operation === 'remove');
    } finally { session.restore(); }
  });

  it.each(['remove', 'replace'] as const)('restores relocated companions before %s mutation records are delivered', async operation => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p style="-webkit-line-clamp:2">Original article excerpt with useful details.</p><code>unchanged</code></main>';
    const host = document.querySelector('p')!;
    const text = host.firstChild;
    const code = document.querySelector('code');
    const replacement = document.createElement('p');
    replacement.textContent = 'Replacement article excerpt with updated details.';
    const replacementText = replacement.firstChild;
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config());
    try {
      const start = session.start();
      await vi.advanceTimersByTimeAsync(1600); await start;
      expect(document.querySelector('main > .dual-read-target')).not.toBeNull();
      if (operation === 'remove') host.remove();
      else host.replaceWith(replacement);
      session.restore(); session.restore();
      await vi.advanceTimersByTimeAsync(1600);
      expect(document.querySelector('.dual-read-target')).toBeNull();
      expect(host.isConnected).toBe(false);
      expect(host.firstChild).toBe(text);
      expect(replacement.firstChild).toBe(replacementText);
      expect(Array.from(document.querySelector('main')!.childNodes)).toEqual(operation === 'remove' ? [code] : [replacement, code]);
    } finally { session.restore(); }
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

  it.each(['bilingual', 'replace'] as const)('recollects source edited while paused before resuming %s', async (mode) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="stable">A stable translated paragraph.</p><p id="changing">The old pending paragraph.</p></main>';
    const changing = document.getElementById('changing')!;
    const original = changing.firstChild!;
    const pending: ((translations: string[]) => void)[] = [];
    vi.mocked(translateBatchViaPort).mockImplementation((texts) => texts.includes('The old pending paragraph.')
      ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(texts.map(text => `译:${text}`)));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(800);
      expect(pending).toHaveLength(1);
      expect(document.getElementById('stable')!.textContent).toContain('译:A stable translated paragraph.');
      session.pause();
      original.nodeValue = 'The current paragraph edited while paused.';
      session.resumeWatch();
      await vi.advanceTimersByTimeAsync(1600);
      pending[0]!(['An obsolete response.']);
      await vi.advanceTimersByTimeAsync(8000);
      await start;
      expect(vi.mocked(translateBatchViaPort).mock.calls.map(([texts]) => texts)).toContainEqual(['The current paragraph edited while paused.']);
      expect(changing.textContent).toContain('译:The current paragraph edited while paused.');
      expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0, translating: false });
      session.restore();
      expect(changing.firstChild).toBe(original);
      expect(changing.textContent).toBe('The current paragraph edited while paused.');
    } finally { session.dispose(); }
  });

  it.each((['bilingual', 'replace'] as const).flatMap(mode => ['edit', 'replace', 'remove'].map(change => ({mode, change}))))(
    'reconciles delivered source $change after a pause in $mode', async ({mode, change}) => {
      vi.useFakeTimers();
      document.body.innerHTML = '<main><p id="stable">A stable paragraph.</p><p id="changing"><strong>Original title</strong> with an explanation.</p></main>';
      const host = document.getElementById('changing')!, title = host.querySelector('strong')!;
      const original = title.firstChild!;
      const fresh = document.createTextNode('Current page title');
      vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
      const session = new ContentSession(config({mode, batchSize: 1}));
      const start = session.start();
      try {
        await vi.advanceTimersByTimeAsync(1600); await start;
        session.pause();
        if (change === 'remove') host.remove();
        else if (change === 'replace') original.replaceWith(fresh);
        else original.nodeValue = 'Current page title';
        session.resumeWatch();
        await vi.advanceTimersByTimeAsync(1600);
        expect(session.status()).toMatchObject({count: change === 'remove' ? 1 : 2, total: change === 'remove' ? 1 : 2, failed: 0, translating: false});
        if (change !== 'remove') expect(host.textContent).toContain('译:Current page title');
        session.restore();
        if (change === 'remove') expect(host.isConnected).toBe(false);
        else {
          expect(host.querySelector('strong')).toBe(title);
          expect(title.firstChild).toBe(change === 'replace' ? fresh : original);
          expect(host.textContent).toBe('Current page title with an explanation.');
        }
      } finally { session.dispose(); }
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

  it.each((['bilingual', 'replace'] as const).flatMap(mode =>
    (['hide', 'reveal', 'cosmetic'] as const).flatMap(change => [0, 500].map(delay => ({ mode, change, delay }))),
  ))('reconciles partial visibility during a request: $mode / $change / $delay', async ({ mode, change, delay }) => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><p id="copy">Always visible documentation. <span id="part" ${change === 'reveal' ? 'hidden' : ''}>Temporary supplemental information.</span></p></main>`;
    const host = document.getElementById('copy')!;
    const part = document.getElementById('part')!;
    const original = Array.from(host.childNodes), partText = part.firstChild;
    let resolveFirst!: (texts: string[]) => void;
    let firstTexts: string[] = [];
    vi.mocked(translateBatchViaPort).mockImplementationOnce(texts => {
      firstTexts = texts;
      return new Promise(resolve => { resolveFirst = resolve; });
    }).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(600);
      expect(resolveFirst).toBeTypeOf('function');
      if (change === 'cosmetic') part.className = 'unrelated-paint';
      else part.hidden = change === 'hide';
      await vi.advanceTimersByTimeAsync(delay);
      resolveFirst(firstTexts.map(text => `旧:${text}`));
      await vi.advanceTimersByTimeAsync(1800); await start;
      expect(session.status()).toMatchObject({ count: 1, total: 1, failed: 0, translating: false });
      const target = host.querySelector('.dual-read-target,.dual-read-replace-text');
      expect(target).not.toBeNull();
      expect(target!.textContent).toContain(change === 'cosmetic' ? '旧:' : '译:');
      if (change === 'hide') expect(target!.textContent).not.toContain('Temporary');
      else expect(target!.textContent).toContain('Temporary');
      expect(vi.mocked(translateBatchViaPort)).toHaveBeenCalledTimes(change === 'cosmetic' ? 1 : 2);
      session.restore(); session.restore();
      expect(Array.from(host.childNodes)).toEqual(original);
      expect(part.firstChild).toBe(partText);
      expect(part.hidden).toBe(change === 'hide');
      expect(host.textContent).toBe('Always visible documentation. Temporary supplemental information.');
    } finally { session.restore(); }
  });

  it('bounds source walks per rich unit when a many-slot response arrives', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<p>${'<strong>Word </strong>'.repeat(80)}</p>`;
    const host = document.querySelector('p')!, originals = [...host.childNodes];
    let resolve!: (texts: string[]) => void;
    vi.mocked(translateBatchViaPort).mockImplementation(() => new Promise(done => { resolve = done; }));
    const session = new ContentSession(config({ batchSize: 6 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(vi.mocked(translateBatchViaPort).mock.calls[0][0]).toHaveLength(80);
      const walks = vi.spyOn(document, 'createTreeWalker');
      try {
        resolve(Array.from({ length: 80 }, () => '词语'));
        await vi.advanceTimersByTimeAsync(0);
        // Response processing must not walk the entire source once per slot.
        // Exclude rendering, whose skeleton legitimately has its own walks.
        expect(walks.mock.calls.length).toBeLessThan(10);
      } finally { walks.mockRestore(); }
      await vi.advanceTimersByTimeAsync(1600); await start;
      expect(host.querySelectorAll('.dual-read-target strong')).toHaveLength(80);
      expect(session.status()).toMatchObject({ count: 1, total: 1, failed: 0 });
      session.restore();
      expect([...host.childNodes]).toEqual(originals);
      expect(host.textContent).toBe('Word '.repeat(80));
    } finally { session.restore(); }
  });

  it.each((['bilingual', 'replace'] as const).flatMap(mode =>
    (['response', 'cache', 'error', 'render'] as const).map(stage => ({ mode, stage })),
  ))('recovers source visibility without a mutation at $stage in $mode', async ({ mode, stage }) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><p id="copy">Always visible documentation. <span id="part">Temporary supplemental information.</span></p></main>';
    if (stage === 'render') document.querySelector('main')!.insertAdjacentHTML('beforeend', '<p>Independent pending paragraph.</p>');
    const host = document.getElementById('copy')!, part = document.getElementById('part')!;
    const original = [...host.childNodes], partText = part.firstChild;
    let hidden = false;
    const computed = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computed(element);
      if (element === part) style.display = hidden ? 'none' : 'inline';
      return style;
    });
    let resolve!: (texts: string[]) => void, reject!: (error: Error) => void, releaseOther!: (texts: string[]) => void;
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    if (stage === 'cache') vi.mocked(lookup).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    else vi.mocked(translateBatchViaPort).mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    if (stage === 'render') vi.mocked(translateBatchViaPort).mockImplementationOnce(() => new Promise(done => { releaseOther = done; }));
    const session = new ContentSession(config({ mode, batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      if (stage === 'render') { resolve(['旧译文']); await vi.advanceTimersByTimeAsync(0); }
      hidden = true; // A CSS/media change, with no attribute or text mutation.
      if (stage === 'render') releaseOther(['另一段译文']);
      if (stage === 'error') reject(new DualReadError('AUTH_INVALID'));
      else if (stage !== 'render') resolve(['旧译文']);
      await vi.advanceTimersByTimeAsync(2400); await start;
      const count = stage === 'render' ? 2 : 1;
      expect(session.status()).toMatchObject({ count, total: count, failed: 0, translating: false });
      const targets = host.querySelectorAll('.dual-read-target,.dual-read-replace-text');
      expect(targets).toHaveLength(1);
      expect(targets[0].textContent).toBe('译:Always visible documentation.');
      expect(translateBatchViaPort).toHaveBeenCalledTimes(stage === 'cache' ? 1 : stage === 'render' ? 3 : 2);
      session.restore(); session.restore();
      expect([...host.childNodes]).toEqual(original);
      expect(part.firstChild).toBe(partText);
      expect(host.textContent).toBe('Always visible documentation. Temporary supplemental information.');
    } finally { session.restore(); styles.mockRestore(); }
  });

  it.each(['pause', 'restore'] as const)('cancels pending source recovery on %s', async action => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>Stable original text. <span>Supplemental source text.</span></p>';
    const host = document.querySelector('p')!, part = host.querySelector('span')!;
    const original = [...host.childNodes];
    let hidden = false, resolve!: (texts: string[]) => void;
    const computed = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computed(element);
      if (element === part) style.display = hidden ? 'none' : 'inline';
      return style;
    });
    vi.mocked(translateBatchViaPort).mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({ batchSize: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      hidden = true; resolve(['旧译文']);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.status().translating).toBe(true);
      session[action]();
      await vi.advanceTimersByTimeAsync(action === 'restore' ? 9000 : 1600); await start;
      expect(translateBatchViaPort).toHaveBeenCalledTimes(1);
      expect(session.status().translating).toBe(false);
      expect(host.querySelector('.dual-read-target')).toBeNull();
      if (action === 'pause') {
        session.resumeWatch(); await vi.advanceTimersByTimeAsync(1600);
        expect(host.querySelector('.dual-read-target')?.textContent).toBe('译:Stable original text.');
        expect(session.status()).toMatchObject({ count: 1, total: 1 });
      }
      session.restore();
      expect([...host.childNodes]).toEqual(original);
    } finally { session.restore(); styles.mockRestore(); }
  });

  it.each(['change', 'pause'] as const)('revalidates after yielding between response units: %s', async action => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="one">First <strong>rich paragraph.</strong></p><p id="two">Second <strong>rich paragraph.</strong></p>';
    const part = document.querySelector('#two strong')!;
    let hidden = false, resolve!: (texts: string[]) => void, first: string[] = [];
    const computed = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computed(element);
      if (element === part) style.display = hidden ? 'none' : 'inline';
      return style;
    });
    vi.mocked(translateBatchViaPort).mockImplementationOnce(texts => {
      first = texts; return new Promise(done => { resolve = done; });
    }).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({ batchSize: 4, maxConcurrent: 1 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(first).toHaveLength(4);
      let yielded = false, ticks = 0;
      vi.mocked(yieldToMain).mockImplementationOnce(async () => {
        yielded = true;
        if (action === 'pause') session.pause();
        else hidden = true;
      });
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => ticks += 13);
      try { resolve(first.map(text => `译:${text}`)); await vi.advanceTimersByTimeAsync(0); }
      finally { clock.mockRestore(); }
      expect(yielded).toBe(true);
      await vi.advanceTimersByTimeAsync(2600); await start;
      if (action === 'pause') {
        expect(document.querySelector('.dual-read-target')).toBeNull();
        expect(session.status()).toMatchObject({ watching: false, translating: false, count: 0 });
        expect(translateBatchViaPort).toHaveBeenCalledTimes(1);
      } else {
        expect(document.querySelector('#two .dual-read-target')?.textContent).toBe('译:Second ');
        expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
      }
    } finally {
      session.restore(); styles.mockRestore();
      vi.mocked(yieldToMain).mockReset().mockResolvedValue();
    }
  });

  it('preserves rich slot order when a response contains only cache misses', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>First <strong>cached label</strong> ending.</p><p>Second <strong>uncached label</strong> conclusion.</p>';
    vi.mocked(lookup).mockImplementationOnce(async texts => texts.map(text => text === 'cached label' || text === 'Second' ? `缓存:${text}` : null));
    vi.mocked(translateBatchViaPort).mockImplementation(async texts => texts.map(text => `译:${text}`));
    const session = new ContentSession(config({ batchSize: 6 }));
    const start = session.start();
    try {
      await vi.advanceTimersByTimeAsync(1800); await start;
      expect([...document.querySelectorAll('.dual-read-target')].map(node => node.textContent))
        .toEqual(['译:First 缓存:cached label 译:ending.', '缓存:Second 译:uncached label 译:conclusion.']);
      expect(vi.mocked(translateBatchViaPort).mock.calls[0][0]).toEqual(['First', 'ending.', 'uncached label', 'conclusion.']);
      expect(session.status()).toMatchObject({ count: 2, total: 2, failed: 0 });
    } finally { session.restore(); }
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
