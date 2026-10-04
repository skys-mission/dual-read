// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const layouts = ['form', 'fieldset', 'label', 'span', 'nested', 'multiple'] as const;
const changes = ['reorder', 'remove', 'replace', 'insert', 'wrap', 'move'] as const;
const values = ['First source', 'Second source', 'Third source'];

// Expected text and ownership are derived from the page operations, without
// consulting renderer maps, restoration helpers, or translated string offsets.
for (const layout of layouts) for (const delivered of [false, true]) {
  for (const order of permutations) for (const change of changes) {
    it(`${layout}: ${order.join('/')} then ${change}, delivered=${delivered}`, async () => {
      const elements = values.map((text, i) => `<strong data-source="${i}">${text}</strong>`);
      const markup = layout === 'multiple'
        ? `<form id="wrapper">${elements[0]}<!-- keep -->${elements[1]}</form><fieldset id="other">${elements[2]}</fieldset>`
        : layout === 'nested'
          ? `<form id="wrapper"><fieldset id="inner">${elements.join('<!-- keep -->')}</fieldset></form>`
          : `<${layout} id="wrapper">${elements.join('<!-- keep -->')}</${layout}>`;
      document.body.innerHTML = `<div id="source">Read ${markup} tail.</div><p id="target">Other source.</p>`;
      const host = document.querySelector<HTMLElement>('#source')!;
      const target = document.querySelector('#target')!;
      const originals = [...host.querySelectorAll('[data-source]')];
      const wrappers = [...host.querySelectorAll('[id]')];
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT);
      const comments: { node: Node; parent: Node | null }[] = [];
      while (walker.nextNode()) comments.push({ node: walker.currentNode, parent: walker.currentNode.parentNode });
      const before = host.innerHTML;
      let clicks = 0;
      originals.forEach(node => node.addEventListener('click', () => { clicks++; }));
      const slots = extractRichSlots(host);
      render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(() => '相同译文'), 'replace');
      const copyParent = layout === 'span' ? host.querySelector(':scope > span:not(.dual-read-original-hidden)')! : host;
      const copies = [...copyParent.querySelectorAll(':scope > strong')];
      const anchor = copies.at(-1)!.nextSibling;
      order.forEach(i => copyParent.insertBefore(copies[i], anchor));
      if (delivered) await Promise.resolve();
      const middle = copies[order[1]];
      const fresh = document.createTextNode('New source');
      const added = document.createElement('em');
      if (change === 'remove') middle.remove();
      if (change === 'replace') middle.replaceWith(fresh);
      if (change === 'insert') middle.before(fresh);
      if (change === 'wrap') { middle.before(added); added.append(fresh, middle); }
      if (change === 'move') target.append(middle);
      if (delivered) await Promise.resolve();

      const expected = order.flatMap((index, position) => {
        if (position !== 1 || change === 'reorder') return [values[index]];
        if (change === 'remove' || change === 'move') return [];
        if (change === 'replace') return ['New source'];
        return ['New source', values[index]];
      });
      const remaining = order.filter((_, position) => position !== 1 || !['remove', 'replace', 'move'].includes(change));
      restoreDom();
      expect(host.textContent).toBe(`Read ${expected.join('')} tail.`);
      const actual = [...host.querySelectorAll('[data-source]')];
      expect(actual).toHaveLength(remaining.length);
      remaining.forEach((index, position) => expect(actual[position]).toBe(originals[index]));
      wrappers.forEach(wrapper => expect(host.querySelector(`#${wrapper.id}`)).toBe(wrapper));
      comments.forEach(({ node, parent }) => expect(node.parentNode).toBe(parent));
      if (change === 'move') {
        expect(target.lastChild).toBe(originals[order[1]]);
        expect(target.textContent).toBe(`Other source.${values[order[1]]}`);
      }
      if (['replace', 'insert', 'wrap'].includes(change)) expect(host.contains(fresh)).toBe(true);
      if (change === 'wrap') expect(originals[order[1]].parentNode).toBe(added);
      if (change === 'reorder' && layout !== 'multiple') {
        const expectedParent = host.querySelector('#inner') ?? host.querySelector('#wrapper');
        originals.forEach(node => expect(node.parentNode).toBe(expectedParent));
      }
      if (change === 'reorder' && order.join() === '0,1,2') expect(host.innerHTML).toBe(before);
      actual.forEach(node => node.dispatchEvent(new MouseEvent('click')));
      expect(clicks).toBe(actual.length);
      const restored = host.innerHTML;
      restoreDom();
      expect(host.innerHTML).toBe(restored);
    });
  }
}

for (const nested of [false, true]) for (const normalized of [false, true]) {
  for (const delivered of [false, true]) for (const order of permutations) {
    it(`orders unwrapped Texts ${order.join('/')}, nested=${nested}, normalized=${normalized}, delivered=${delivered}`, async () => {
      const contents = values.join('<!-- keep -->');
      document.body.innerHTML = `<div>Read <form>${nested ? `<fieldset>${contents}</fieldset>` : contents}</form> tail.</div>`;
      const host = document.querySelector('div')!;
      const wrapper = host.querySelector(nested ? 'fieldset' : 'form')!;
      const originals = [...wrapper.childNodes].filter(node => node instanceof Text);
      const slots = extractRichSlots(host);
      render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(() => '译文'), 'replace');
      let texts = [...host.childNodes].filter(node => node instanceof Text);
      if (normalized) {
        const lengths = texts.map(node => node.length);
        host.normalize();
        if (delivered) await Promise.resolve();
        texts = [host.lastChild as Text];
        for (let i = 1; i < slots.length; i++) texts.push(texts.at(-1)!.splitText(lengths[i - 1]));
      }
      order.forEach(index => host.insertBefore(texts[index + 1], texts[4]));
      if (delivered) await Promise.resolve();
      restoreDom();
      expect(host.textContent).toBe(`Read ${order.map(index => values[index]).join('')} tail.`);
      const actual = [...wrapper.childNodes].filter(node => node instanceof Text);
      expect(actual).toHaveLength(3);
      order.forEach((index, position) => expect(actual[position]).toBe(originals[index]));
    });
  }
}

for (const delivered of [false, true]) for (let first = 0; first < 4; first++) {
  for (const tail of permutations) {
    const remaining = [0, 1, 2, 3].filter(index => index !== first);
    const order = [first, ...tail.map(index => remaining[index])];
    it(`orders mixed nested runs ${order.join('/')}, delivered=${delivered}`, async () => {
      document.body.innerHTML = '<div>Read <form id="outer"><strong>A source</strong><fieldset id="inner"><strong>B source</strong><strong>C source</strong></fieldset><strong>D source</strong></form> tail.</div>';
      const host = document.querySelector('div')!;
      const outer = host.querySelector('#outer')!;
      const inner = host.querySelector('#inner')!;
      const originals = [...host.querySelectorAll('strong')];
      const source = originals.map(node => node.textContent);
      const slots = extractRichSlots(host);
      render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(() => '译文'), 'replace');
      const copies = [...host.querySelectorAll(':scope > strong')];
      order.forEach(index => host.insertBefore(copies[index], host.lastChild));
      if (delivered) await Promise.resolve();
      restoreDom();
      expect(host.textContent).toBe(`Read ${order.map(index => source[index]).join('')} tail.`);
      expect(host.querySelector('#outer')).toBe(outer);
      expect(outer.querySelector('#inner')).toBe(inner);
      const actual = [...host.querySelectorAll('strong')];
      order.forEach((index, position) => expect(actual[position]).toBe(originals[index]));
    });
  }
}
