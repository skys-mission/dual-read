// @vitest-environment jsdom
/**
 * Collector timing smoke (jsdom). 5k/p95<100ms is enforced in Chromium
 * E2E (`perf.spec.ts`); jsdom is slower and only catches catastrophic O(n²).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { collectUnits } from '../lib/collector';

afterEach(() => {
  document.body.innerHTML = '';
});

function stubLayoutBoxes(): () => void {
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 640,
      bottom: 20,
      width: 640,
      height: 20,
      toJSON() {},
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = real;
  };
}

function buildParagraphForest(count: number): void {
  const root = document.createElement('main');
  root.id = 'root';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('p');
    p.id = `u${i}`;
    p.textContent = `Perf unit ${i}: The quick brown fox jumps over the lazy dog.`;
    root.appendChild(p);
  }
  document.body.appendChild(root);
}

describe('collector perf budget', () => {
  it('indexes 2,000 units without catastrophic slowdown (jsdom)', () => {
    const restore = stubLayoutBoxes();
    try {
      buildParagraphForest(2_000);
      const root = document.getElementById('root')!;
      const samples: number[] = [];
      let units: ReturnType<typeof collectUnits> = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        units = collectUnits(root);
        samples.push(performance.now() - t0);
      }
      expect(units.length).toBeGreaterThan(1_500);
      const ms = Math.min(...samples);
      // Generous: jsdom is ~10–20× slower than Chromium for this walk.
      expect(ms, `jsdom index ${ms.toFixed(1)}ms (best of 3)`).toBeLessThan(8_000);
    } finally {
      restore();
    }
  }, 30_000);
});
