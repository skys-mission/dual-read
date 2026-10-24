// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom, restoreUnit } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

function translate(host: HTMLElement, identical = false): void {
  const slots = extractRichSlots(host);
  render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } },
    slots.map((_, i) => identical ? '相同译文' : ['第一译文', '第二译文', '第三译文', '尾部译文'][i]), 'replace');
}

const changes = ['wrap first', 'wrap second', 'move first', 'move second', 'shadow second',
  'remove first', 'remove second', 'reorder', 'insert middle', 'edit moved', 'replace moved',
  'new replacement', 'internal split'] as const;

for (const delivered of [false, true]) for (const identical of [false, true]) {
  it.each(changes)(`reconciles normalize/split/%s, delivered=${delivered}, identical=${identical}`, async (change) => {
    document.body.innerHTML = '<p id="one"><strong>First source<!-- marker -->second source</strong> tail.</p><p id="two">Other source.</p><div id="shadow"></div>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const two = document.querySelector<HTMLElement>('#two')!;
    const shadow = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const original = one.querySelector('strong')!;
    const [originalFirst, marker, originalSecond] = Array.from(original.childNodes);
    const wrapper = document.createElement('em');
    const fresh = document.createTextNode('New source');
    translate(one, identical);
    const strong = one.querySelector(':scope > strong')!;
    const firstValue = strong.firstChild!.nodeValue!;
    strong.normalize();
    if (delivered) await Promise.resolve();
    const first = strong.firstChild as Text;
    const second = first.splitText(firstValue.length);
    if (delivered) await Promise.resolve();
    if (change === 'wrap first') { strong.prepend(wrapper); wrapper.append(first); }
    else if (change === 'wrap second') { strong.append(wrapper); wrapper.append(second); }
    else if (change === 'move first') two.append(first);
    else if (['move second', 'edit moved', 'replace moved'].includes(change)) {
      two.append(second);
      if (delivered) await Promise.resolve();
      if (change === 'edit moved') second.appendData(' added source');
      if (change === 'replace moved') second.data = 'New source';
    } else if (change === 'shadow second') shadow.append(second);
    else if (change === 'remove first') first.remove();
    else if (change === 'remove second') second.remove();
    else if (change === 'reorder') strong.prepend(second);
    else if (change === 'insert middle') strong.insertBefore(fresh, second);
    else if (change === 'new replacement') second.replaceWith(fresh);
    else if (change === 'internal split') { first.splitText(1); two.append(second); }
    if (delivered) await Promise.resolve();
    restoreDom();
    const firstGone = ['move first', 'remove first'].includes(change);
    const secondGone = ['move second', 'shadow second', 'remove second', 'edit moved', 'replace moved', 'internal split'].includes(change);
    const expectedOne = change === 'reorder' ? 'second sourceFirst source tail.'
      : `${firstGone ? '' : 'First source'}${change === 'insert middle' ? 'New source' : ''}${secondGone ? '' : change === 'new replacement' ? 'New source' : 'second source'} tail.`;
    expect(one.textContent).toBe(expectedOne);
    expect(two.textContent).toBe(`Other source.${change === 'move first' ? 'First source'
      : ['move second', 'internal split'].includes(change) ? 'second source'
      : change === 'edit moved' ? 'second source added source' : change === 'replace moved' ? 'New source' : ''}`);
    expect(shadow.textContent).toBe(change === 'shadow second' ? 'second source' : '');
    expect(originalFirst.isConnected).toBe(change !== 'remove first');
    expect(originalSecond.isConnected).toBe(!['remove second', 'new replacement'].includes(change));
    expect(marker.parentNode).toBe(original);
    expect(one.querySelector('strong')).toBe(original);
    if (change.startsWith('wrap')) expect(original.querySelector('em')).toBe(wrapper);
    if (['insert middle', 'new replacement'].includes(change)) expect(fresh.parentNode).toBe(original);
    restoreDom();
    expect(one.textContent).toBe(expectedOne);
  });
}

// Expected source placement comes from page operations, independently of the
// renderer's translation boundaries and restoration implementation.
const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
for (const delivered of [false, true]) for (const identical of [false, true]) {
  for (const placement of ['reordered', 'distributed', 'removed'] as const) {
    it.each(permutations)(`matches the source model for %s/%s/%s, ${placement}, delivered=${delivered}, identical=${identical}`, async (...order) => {
      const source = ['Alpha source', 'Beta source', 'Gamma source'];
      document.body.innerHTML = '<p><strong>Alpha source<!-- a -->Beta source<!-- b -->Gamma source</strong> tail.</p><div id="outside"></div><div id="shadow"></div>';
      const host = document.querySelector('p')!;
      const original = host.querySelector('strong')!;
      const originals = Array.from(original.childNodes).filter((node) => node instanceof Text);
      const outside = document.querySelector('#outside')!;
      const shadow = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
      translate(host, identical);
      const copy = host.querySelector(':scope > strong')!;
      const lengths = Array.from(copy.childNodes, (node) => node.nodeValue!.length);
      copy.normalize();
      if (delivered) await Promise.resolve();
      const fragments = [copy.firstChild as Text];
      fragments.push(fragments[0].splitText(lengths[0]));
      fragments.push(fragments[1].splitText(lengths[1]));
      if (delivered) await Promise.resolve();
      const destinations: Node[] = [copy, outside, shadow];
      const expected: number[][] = [[], [], []];
      for (const [i, index] of order.entries()) {
        const target = placement === 'reordered' ? 0 : i;
        if (placement === 'removed' && index === 1) fragments[index].remove();
        else { destinations[target].appendChild(fragments[index]); expected[target].push(index); }
      }
      if (delivered) await Promise.resolve();
      restoreDom();
      for (const [i, target] of [original, outside, shadow].entries()) {
        expect(target.textContent).toBe(expected[i].map((index) => source[index]).join(''));
        const actual = Array.from(target.childNodes).filter((node) => node instanceof Text);
        expect(actual).toHaveLength(expected[i].length);
        for (const [position, index] of expected[i].entries()) expect(actual[position]).toBe(originals[index]);
      }
      expect(originals[1].isConnected).toBe(placement !== 'removed');
      expect(host.textContent).toBe(expected[0].map((index) => source[index]).join('') + ' tail.');
    });
  }
}

for (const delivered of [false, true]) for (const destination of ['translated', 'page prefix'] as const) {
  it(`restores a moved raw fragment normalized again with ${destination}, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source<!-- m -->second source</strong> tail.</p><p id="two"><strong>Third source</strong> other tail.</p><p id="raw">Page prefix </p>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const two = document.querySelector<HTMLElement>('#two')!;
    const originalSecond = one.querySelector('strong')!.lastChild!;
    const originalThird = two.querySelector('strong')!.firstChild!;
    translate(one);
    translate(two);
    const strong = one.querySelector(':scope > strong')!;
    strong.normalize();
    if (delivered) await Promise.resolve();
    const second = (strong.firstChild as Text).splitText('第一译文'.length);
    if (delivered) await Promise.resolve();
    const target = destination === 'translated' ? two.querySelector(':scope > strong')! : document.querySelector('#raw')!;
    target.append(second);
    if (delivered) await Promise.resolve();
    target.normalize();
    if (delivered) await Promise.resolve();
    (target.firstChild as Text).appendData(' added source');
    restoreUnit(one); // The donor may restore before its destination.
    restoreDom();
    expect(one.textContent).toBe('First source tail.');
    expect(target === document.querySelector('#raw') ? target.textContent : two.textContent)
      .toBe(destination === 'translated' ? 'Third sourcesecond source added source other tail.' : 'Page prefix second source added source');
    expect(originalSecond.isConnected).toBe(true);
    expect(originalThird.isConnected).toBe(true);
    expect(originalSecond.parentNode).toBe(destination === 'translated' ? originalThird.parentNode : target);
  });
}

it.each([0, 'end'] as const)('preserves a full run moved after splitText(%s)', (cut) => {
  document.body.innerHTML = '<p><strong>First source<!-- m -->second source</strong> tail.</p><p id="outside">Page prefix </p>';
  const host = document.querySelector('p')!;
  translate(host);
  const copy = host.querySelector(':scope > strong')!;
  copy.normalize();
  const first = copy.firstChild as Text;
  const second = first.splitText(cut === 0 ? 0 : first.length);
  const moved = cut === 0 ? second : first;
  document.querySelector('#outside')!.append(moved);
  restoreDom();
  expect(host.textContent).toBe(' tail.');
  expect(document.querySelector('#outside')!.textContent).toBe('Page prefix First sourcesecond source');
});

for (const delivered of [false, true]) {
  it(`does not reclaim equal-valued page text preceding split copies, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!-- m -->second source</strong> tail.</p>';
    const host = document.querySelector('p')!;
    const original = host.querySelector('strong')!;
    const first = original.firstChild!;
    const second = original.lastChild!;
    translate(host);
    const copy = host.querySelector(':scope > strong')!;
    const fresh = document.createTextNode(copy.textContent!);
    (copy.firstChild as Text).splitText(1);
    copy.prepend(fresh);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(original.textContent).toBe('第一译文第二译文First sourcesecond source');
    expect(original.firstChild).toBe(fresh);
    expect(first.parentNode).toBe(original);
    expect(second.parentNode).toBe(original);
  });

  it(`does not revive a deleted slot replaced with equal-valued page text, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!-- m -->second source</strong> tail.</p>';
    const host = document.querySelector('p')!;
    const original = host.querySelector('strong')!;
    const second = original.lastChild!;
    translate(host);
    const copy = host.querySelector(':scope > strong')!;
    const fresh = document.createTextNode(copy.lastChild!.nodeValue!);
    copy.lastChild!.replaceWith(fresh);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(original.textContent).toBe('First source第二译文');
    expect(fresh.parentNode).toBe(original);
    expect(second.isConnected).toBe(false);
  });

  it(`keeps new Text identity even when its value equals the removed translation, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!-- m -->second source</strong> tail.</p>';
    const host = document.querySelector('p')!;
    const original = host.querySelector('strong')!;
    const sources = Array.from(original.childNodes).filter((node) => node instanceof Text);
    translate(host);
    const copy = host.querySelector(':scope > strong')!;
    copy.normalize();
    if (delivered) await Promise.resolve();
    const fresh = document.createTextNode(copy.textContent!);
    copy.replaceChildren(fresh);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(original.textContent).toBe('第一译文第二译文'); // A new page node is new source, even with identical text.
    expect(original.childNodes).toContain(fresh);
    expect(sources.every((node) => !node.isConnected)).toBe(true);
  });
}

const attrChanges = ['update', 'remove', 'add', 'namespace', 'unchanged', 'original edit'] as const;
for (const location of ['local', 'moved', 'shadow'] as const) {
  it.each(attrChanges)(`reconciles element attribute deltas for %s at ${location}`, (change) => {
    document.body.innerHTML = '<p id="one">Read <a id="original" class="page-link" style="color: red" href=" /original " title="old" lang="en" target="_blank" rel="author">the documentation</a> for details.</p><p id="two"></p><div id="shadow"></div>';
    const host = document.querySelector<HTMLElement>('#one')!;
    const original = host.querySelector('a')!;
    let clicks = 0;
    original.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    const shadow = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    translate(host);
    const link = host.querySelector(':scope > a')!;
    expect(link.getAttribute('id')).toBeNull();
    if (change === 'update') {
      link.setAttribute('href', '/updated'); link.setAttribute('title', 'new'); link.setAttribute('lang', 'fr');
    } else if (change === 'remove') { link.removeAttribute('href'); link.removeAttribute('title'); }
    else if (change === 'add') { link.setAttribute('data-page', 'new'); link.setAttribute('class', 'new-class'); link.setAttribute('dir', 'rtl'); }
    else if (change === 'namespace') link.setAttributeNS('urn:page', 'page:state', 'updated');
    else if (change === 'original edit') original.setAttribute('href', '/hidden-edit');
    const target = location === 'moved' ? document.querySelector('#two')! : location === 'shadow' ? shadow : host;
    if (location !== 'local') target.append(link);
    restoreDom();
    expect(target.querySelector('a')).toBe(original);
    expect(original.getAttribute('href')).toBe(change === 'update' ? '/updated' : change === 'remove' ? null
      : change === 'original edit' ? '/hidden-edit' : ' /original ');
    expect(original.getAttribute('title')).toBe(change === 'update' ? 'new' : change === 'remove' ? null : 'old');
    expect(original.getAttribute('lang')).toBe(change === 'update' ? 'fr' : 'en');
    expect(original.getAttribute('id')).toBe('original');
    expect(original.getAttribute('class')).toBe(change === 'add' ? 'new-class' : 'page-link');
    expect(original.getAttribute('style')).toBe('color: red');
    expect(original.getAttribute('rel')).toBe('author'); // Unchanged safe-skeleton rel must not overwrite the source.
    expect(original.getAttribute('data-page')).toBe(change === 'add' ? 'new' : null);
    expect(original.getAttributeNS('urn:page', 'state')).toBe(change === 'namespace' ? 'updated' : null);
    original.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    restoreDom();
    expect(target.querySelector('a')).toBe(original);
  });
}
