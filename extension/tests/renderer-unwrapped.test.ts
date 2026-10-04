// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

function translate(host: HTMLElement): void {
  const slots = extractRichSlots(host);
  render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } },
    slots.map(text => `译:${text}`), 'replace');
}

for (const tag of ['form', 'fieldset', 'label', 'span']) {
  for (const delivered of [false, true]) for (const change of ['remove', 'replace', 'move', 'unchanged'] as const) {
    it(`${change} under ${tag}, delivered=${delivered}`, async () => {
      document.body.innerHTML = `<div id="source">Read <${tag} id="wrapper" class="page-wrapper"><strong id="original">first source</strong><!-- keep --></${tag}> and second source.</div><p id="target">Other source.</p>`;
      const host = document.querySelector<HTMLElement>('#source')!;
      const wrapper = document.querySelector('#wrapper')!;
      const original = document.querySelector('#original')!;
      const marker = wrapper.lastChild!;
      const target = document.querySelector('#target')!;
      let clicks = 0;
      wrapper.addEventListener('click', () => { clicks++; });
      translate(host);
      const copy = host.querySelector(tag === 'span' ? ':scope > span:not(.dual-read-original-hidden) > strong' : ':scope > strong')!;
      const fresh = document.createTextNode('Fresh source');
      if (change === 'remove') copy.remove();
      if (change === 'replace') copy.replaceWith(fresh);
      if (change === 'move') target.append(copy);
      if (delivered) await Promise.resolve();
      restoreDom();
      const expected = `Read ${change === 'unchanged' ? 'first source' : change === 'replace' ? 'Fresh source' : ''} and second source.`;
      expect(host.textContent).toBe(expected);
      expect(host.querySelector('#wrapper')).toBe(wrapper);
      expect(wrapper.getAttribute('class')).toBe('page-wrapper');
      expect(marker.parentNode).toBe(wrapper);
      expect(original.isConnected).toBe(change === 'unchanged' || change === 'move');
      if (change === 'move') {
        expect(original.parentNode).toBe(target);
        expect(target.textContent).toBe('Other source.first source');
      }
      if (change === 'replace') expect(host.contains(fresh)).toBe(true);
      wrapper.dispatchEvent(new MouseEvent('click'));
      expect(clicks).toBe(1);
      restoreDom();
      expect(host.textContent).toBe(expected);
    });
  }
}

for (const removed of ['element', 'text', 'all'] as const) {
  it(`removes ${removed} through nested unwrapped containers`, () => {
    document.body.innerHTML = '<div id="source">Read <form id="form"><fieldset id="fieldset"><strong>first source</strong> second source</fieldset><!-- keep --></form> tail.</div>';
    const host = document.querySelector<HTMLElement>('#source')!;
    const form = host.querySelector('form')!;
    const fieldset = host.querySelector('fieldset')!;
    const original = fieldset.firstChild!;
    const text = fieldset.lastChild!;
    translate(host);
    const copy = host.querySelector(':scope > strong')!;
    if (removed !== 'element') copy.nextSibling!.remove();
    if (removed !== 'text') copy.remove();
    restoreDom();
    expect(host.textContent).toBe(`Read ${removed === 'element' ? ' second source' : removed === 'text' ? 'first source' : ''} tail.`);
    expect(host.querySelector('form')).toBe(form);
    expect(form.querySelector('fieldset')).toBe(fieldset);
    expect(original.isConnected).toBe(removed === 'text');
    expect(text.isConnected).toBe(removed === 'element');
  });
}

it('keeps an original independently reparented by the page after its copy is deleted', () => {
  document.body.innerHTML = '<div id="source">Read <form><strong>first source</strong></form> tail.</div>';
  const host = document.querySelector<HTMLElement>('#source')!;
  const original = host.querySelector('strong')!;
  translate(host);
  const stash = host.querySelector('.dual-read-original-hidden')!;
  const wrapper = document.createElement('aside');
  stash.append(wrapper); wrapper.append(original);
  host.querySelector(':scope > strong')!.remove();
  restoreDom();
  expect(original.parentNode).toBe(wrapper);
  expect(wrapper.parentNode).toBe(host);
  expect(original.textContent).toBe('first source');
});

for (const replaced of [0, 1, 2]) {
  it(`keeps replacement ${replaced} between retained unwrapped siblings`, () => {
    document.body.innerHTML = '<div id="source">Read <form><fieldset><strong>first source</strong><em>second source</em><b>third source</b></fieldset></form> tail.</div>';
    const host = document.querySelector<HTMLElement>('#source')!;
    const form = host.querySelector('form')!;
    const fieldset = host.querySelector('fieldset')!;
    const originals = [...fieldset.childNodes];
    translate(host);
    const current = host.querySelectorAll(':scope > strong, :scope > em, :scope > b');
    const fresh = document.createTextNode('Fresh source');
    current[replaced].replaceWith(fresh);
    restoreDom();
    expect(host.textContent).toBe(`Read ${['first source', 'second source', 'third source'].map((text, i) => i === replaced ? 'Fresh source' : text).join('')} tail.`);
    expect(host.querySelector('form')).toBe(form);
    expect(form.querySelector('fieldset')).toBe(fieldset);
    for (const [i, original] of originals.entries()) expect(original.isConnected).toBe(i !== replaced);
    expect(host.contains(fresh)).toBe(true);
  });
}
