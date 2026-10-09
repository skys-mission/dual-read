// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyBoundedLayouts, readBoundedLayouts, renderBatch, restoreDom, restoreUnit } from '../lib/renderer';
import type { TranslationUnit } from '../lib/types';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

it.each(['rich', 'segment', 'visible'] as const)('releases bounded replacement ownership through %s restoration', kind => {
  document.body.innerHTML = '<main><section id="box" style="height:80px;overflow:hidden"><p id="copy">Read <strong>the documentation</strong>.</p></section></main>';
  const box = document.getElementById('box')!;
  const host = document.getElementById('copy')!;
  const originals = Array.from(host.childNodes);
  const unit: TranslationUnit = { el: host, text: 'Read the documentation.', kind: 'block' };
  if (kind === 'rich') unit.rich = { slots: ['Read', 'the documentation', '.'] };
  else { unit.segment = true; unit.nodes = [host.firstChild as Text, host.querySelector('strong')!.firstChild as Text, host.lastChild as Text]; }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
    const height = this === box ? 80 : this === document.querySelector('main') ? 600 : 300;
    return { x:0,y:0,width:260,height,top:0,left:0,right:260,bottom:height,toJSON() {} } as DOMRect;
  });
  Object.defineProperty(box, 'scrollHeight', { configurable:true, value:300 });
  const pending = renderBatch([{ unit, payload: unit.rich ? ['阅读', '详细文档', '。'] : '阅读详细文档。' }], 'replace');
  applyBoundedLayouts(readBoundedLayouts(pending.map(({ node }) => node)));
  expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
  box.style.height = '100px'; host.classList.add('cm-editor');
  restoreUnit(kind === 'visible' ? host.querySelector<HTMLElement>('.dual-read-replace-text')! : host);
  expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
  expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  expect(Array.from(host.childNodes)).toEqual(originals);
  expect(box.style.height).toBe('100px'); expect(host.classList.contains('cm-editor')).toBe(true);
  restoreDom(); restoreDom(); expect(Array.from(host.childNodes)).toEqual(originals);
});

it('keeps a shared expansion until its remaining replacement owner is restored', () => {
  document.body.innerHTML = '<main><section id="box" style="height:80px;overflow:hidden"><p id="first">First documentation.</p><p id="second">Second documentation.</p></section></main>';
  const box = document.getElementById('box')!;
  const hosts = [document.getElementById('first')!, document.getElementById('second')!];
  const originals = hosts.map(host => host.firstChild);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
    const height = this === box ? 80 : this === document.querySelector('main') ? 600 : 300;
    return {x:0,y:0,width:260,height,top:0,left:0,right:260,bottom:height,toJSON() {}} as DOMRect;
  });
  Object.defineProperty(box, 'scrollHeight', {configurable:true,value:300});
  const pending = renderBatch(hosts.map(el => ({unit:{el,text:el.textContent!,kind:'block' as const,rich:{slots:[el.textContent!]}},payload:['详细文档。']})), 'replace');
  applyBoundedLayouts(readBoundedLayouts(pending.map(({node}) => node)));
  restoreUnit(hosts[0]); expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
  restoreUnit(hosts[1]); expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
  expect(hosts.map(host => host.firstChild)).toEqual(originals);
});
