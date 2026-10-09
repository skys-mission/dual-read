// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyCompactLayouts, readCompactLayouts } from '../lib/renderer/compact-layout';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });
function fixture() {
  document.body.innerHTML = '<main><div id="column"><a href="/console" style="white-space:nowrap">Original label<span class="dual-read-target--inner">较长的译文说明。</span></a></div></main>';
  const column = document.getElementById('column')!;
  const link = document.querySelector('a')!;
  const target = document.querySelector<HTMLElement>('span')!;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
    const width = this === target ? 350 : 240;
    return { x: 0, y: 0, width, height: 20, top: 0, bottom: 20, left: 0, right: width, toJSON() {} } as DOMRect;
  });
  return { column, link, target };
}

it('wraps within the original hit target without rewriting source styles or repeatedly scheduling an unresolved overflow', () => {
  const { link, target } = fixture();
  const style = link.getAttribute('style');
  expect(readCompactLayouts([target])).toEqual([target]);
  applyCompactLayouts([target]);
  expect(link.getAttribute('style')).toBe(style);
  expect(target.parentElement).toBe(link);
  expect(target.style.whiteSpace).toBe('normal');
  expect(readCompactLayouts([target])).toEqual([]);
});

it('preserves a horizontally scrollable column policy', () => {
  const { column, target } = fixture(); column.style.overflowX = 'auto';
  expect(readCompactLayouts([target])).toEqual([]);
});
