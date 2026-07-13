// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RootRegistry,
  diagnoseFrames,
  getShadowRoot,
  summarizeDiagnostics,
  walkOpenShadowRoots,
} from '../lib/roots';
import { collectUnits } from '../lib/collector';

describe('shadow / frame root helpers', () => {
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 40,
        width: 400, height: 40, toJSON() {},
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('walkOpenShadowRoots finds nested open shadows', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `<p>Shadow paragraph for translation</p><div id="inner"></div>`;
    const inner = sr.getElementById('inner')!;
    const nested = inner.attachShadow({ mode: 'open' });
    nested.innerHTML = `<span>Nested shadow text ok</span>`;

    const roots = walkOpenShadowRoots(document.body);
    expect(roots).toHaveLength(2);
    expect(getShadowRoot(host)).toBe(sr);
  });

  it('collectUnits indexes open shadow content when scoped to the shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `<p>Shadow-only paragraph text here</p>`;

    expect(collectUnits(document.body).some((u) => u.text.includes('Shadow-only'))).toBe(false);
    const units = collectUnits(sr);
    expect(units.some((u) => u.text.includes('Shadow-only'))).toBe(true);
  });

  it('RootRegistry watches body and discovered shadow roots', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = `<p>Inside</p>`;

    const mutations: MutationRecord[][] = [];
    const registry = new RootRegistry((batch) => {
      mutations.push(batch);
    });
    const scopes = registry.bootstrap(document);
    expect(scopes.some((s) => s instanceof ShadowRoot)).toBe(true);
    expect(registry.size).toBeGreaterThanOrEqual(2);

    registry.dispose();
    expect(registry.size).toBe(0);
  });

  it('RootRegistry discovers shadow roots added after bootstrap', async () => {
    const added: unknown[] = [];
    const registry = new RootRegistry(
      () => {},
      (roots) => {
        added.push(...roots);
      },
    );
    registry.bootstrap(document);

    const host = document.createElement('div');
    document.body.appendChild(host);
    // Attach shadow after insert so mutation path must discover it.
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `<p>Late shadow</p>`;

    // Manually feed a synthetic-ish discovery: append a second host with shadow
    // already attached (mutation observer sees the host element).
    const host2 = document.createElement('div');
    host2.attachShadow({ mode: 'open' }).innerHTML = `<p>Ready</p>`;
    await new Promise<void>((resolve) => {
      const mo = new MutationObserver(() => {
        /* flush */
      });
      mo.observe(document.body, { childList: true });
      document.body.appendChild(host2);
      queueMicrotask(() => {
        mo.disconnect();
        resolve();
      });
    });

    // Registry's own observer should have picked up host2's shadow.
    expect(registry.roots.some((r) => r instanceof ShadowRoot)).toBe(true);
    registry.dispose();
  });

  it('diagnoseFrames marks cross-origin-like iframes without contentDocument', () => {
    document.body.innerHTML = `<iframe id="f" src="https://example.com/"></iframe>`;
    // jsdom usually yields null contentDocument for remote src.
    const barriers = diagnoseFrames(document);
    expect(barriers.length).toBe(1);
    expect(['cross-origin', 'opaque', 'same-origin']).toContain(barriers[0].kind);

    const summary = summarizeDiagnostics(2, barriers);
    expect(summary.shadowRoots).toBe(2);
    expect(
      summary.frames.sameOrigin + summary.frames.crossOrigin + summary.frames.opaque,
    ).toBe(1);
  });
});
