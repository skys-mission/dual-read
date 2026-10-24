// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applySourceTypography, readSourceTypography, releaseSourceTypography, restoreSourceTypography } from '../lib/renderer/source-typography';

afterEach(() => { restoreSourceTypography(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('bounds each typography refresh and drains all owners despite repeated input', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  document.body.innerHTML = '<main>' + '<p><span style="font-size:20px">Styled source.</span></p>'.repeat(120) + '</main>';
  const hosts = [...document.querySelectorAll('p')];
  const sources = hosts.map(host => host.querySelector('span')!);
  const units = hosts.map(el => ({ el, kind: 'block' as const, text: 'Styled source.' }));
  const typography = readSourceTypography(units);
  const targets = hosts.map(host => {
    const node = document.createElement('span'); node.className = 'dual-read-target'; host.append(node);
    applySourceTypography(node, typography.get(host), host); return node;
  });
  const flush = (): void => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id); callback(performance.now());
  };
  await Promise.resolve();
  while (frames.size) flush();
  const read = vi.spyOn(window, 'getComputedStyle');
  for (const source of sources) source.style.fontSize = '24px';
  await Promise.resolve();
  let maxReads = 0, turns = 0;
  while (targets.some(target => target.style.fontSize !== '24px') && turns < 20) {
    // Input while a prior refresh is unfinished must not starve the tail.
    document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
    read.mockClear(); flush();
    maxReads = Math.max(maxReads, read.mock.calls.length); turns++;
  }
  expect(turns).toBeGreaterThan(1);
  expect(turns).toBeLessThan(20);
  expect(maxReads).toBeLessThanOrEqual(64);
  expect(targets.every(target => target.style.fontSize === '24px')).toBe(true);
  // A released owner and a full restore must cancel unfinished writes.
  for (const source of sources) source.style.fontSize = '30px';
  await Promise.resolve();
  releaseSourceTypography(targets.at(-1)!);
  while (frames.size) flush();
  expect(targets.at(-1)!.style.fontSize).toBe('24px');
  document.body.dispatchEvent(new Event('pointerover', { bubbles: true }));
  restoreSourceTypography();
  expect(frames.size).toBe(0);
});
