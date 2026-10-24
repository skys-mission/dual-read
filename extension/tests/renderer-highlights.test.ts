// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

function fixture(structure: string) {
  const host = document.createElement('p');
  const strong = document.createElement('strong');
  strong.append('First source');
  if (structure === 'normalized') strong.append(document.createComment('slot'), 'second source');
  const originals = [...strong.childNodes];
  const wrapper = document.createElement(structure === 'omitted' ? 'form' : 'span');
  if (structure === 'ordinary' || structure === 'normalized') host.append(strong);
  else { wrapper.append(strong); host.append(wrapper); }
  host.append(' tail.'); document.body.append(host);
  const slots = extractRichSlots(host);
  render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } },
    structure === 'normalized' ? ['第一译文', '第二译文', '尾部译文'] : ['第一译文', '尾部译文'], 'replace');
  const copy = [...host.querySelectorAll('strong')].find(node => !node.closest('.dual-read-original-hidden'))!;
  if (structure === 'normalized') copy.normalize();
  return { host, strong, originals, wrapper, copy };
}

for (const delivered of [false, true]) {
  it(`retains a page-owned prefix normalized before highlighting, delivered=${delivered}`, async () => {
    const { host, copy, strong } = fixture('ordinary');
    const prefix = document.createTextNode('Page prefix '); copy.prepend(prefix); copy.normalize();
    const range = document.createRange(); range.setStart(copy.firstChild!, 13); range.setEnd(copy.firstChild!, 15);
    const mark = document.createElement('mark'); range.surroundContents(mark);
    if (delivered) await Promise.resolve();
    restoreDom(); restoreDom();
    expect(host.textContent).toBe('Page prefix First source tail.');
    expect(prefix.parentNode).toBe(strong); expect(prefix.data).toBe('Page prefix ');
  });

  it(`does not reclaim a discarded logical Text reinserted elsewhere, delivered=${delivered}`, async () => {
    const host = document.createElement('p');
    const strong = document.createElement('strong'); strong.append('First source', 'second source');
    host.append(strong, ' tail.'); document.body.append(host);
    const originals = [...strong.childNodes], slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '第二译文', '尾部译文'], 'replace');
    const copy = [...host.querySelectorAll('strong')].find(node => !node.closest('.dual-read-original-hidden'))!;
    const discarded = copy.lastChild!; copy.normalize();
    const range = document.createRange(); range.setStart(copy.firstChild!, 1); range.setEnd(copy.firstChild!, 3);
    range.surroundContents(document.createElement('mark'));
    const target = document.createElement('aside'); document.body.append(target); target.append(discarded);
    if (delivered) await Promise.resolve();
    restoreDom(); restoreDom();
    expect(originals[1].parentNode).toBe(target);
    expect(target.textContent).toBe('second source');
    expect(originals[0].nodeValue).toBe('First source');
  });

  it(`keeps unrelated equal text outside the proven wrapped slot, delivered=${delivered}`, async () => {
    const { host, strong, copy } = fixture('ordinary');
    const range = document.createRange(); range.setStart(copy.firstChild!, 1); range.setEnd(copy.firstChild!, 3);
    const mark = document.createElement('mark'); range.surroundContents(mark);
    const independent = document.createTextNode('一译'); copy.append(independent);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe('First source一译 tail.');
    expect(independent.parentNode).toBe(strong);
    expect(strong.contains(mark)).toBe(true);
  });

  it(`retains edits on both sides of a wrapped slot, delivered=${delivered}`, async () => {
    const { host, originals, copy } = fixture('ordinary');
    const range = document.createRange(); range.setStart(copy.firstChild!, 1); range.setEnd(copy.firstChild!, 3);
    const mark = document.createElement('mark'); range.surroundContents(mark);
    (copy.firstChild as Text).insertData(0, 'Prefix ');
    (copy.lastChild as Text).appendData(' suffix');
    if (delivered) await Promise.resolve();
    restoreDom(); restoreDom();
    expect(host.textContent).toBe('Prefix First source suffix tail.');
    expect(originals[0].nodeValue).toBe('Prefix First source suffix');
  });

  it(`does not revive a wrapped slot removed by the page, delivered=${delivered}`, async () => {
    const { host, strong, copy } = fixture('ordinary');
    const range = document.createRange(); range.setStart(copy.firstChild!, 1); range.setEnd(copy.firstChild!, 3);
    const mark = document.createElement('mark'); range.surroundContents(mark);
    copy.replaceChildren();
    if (delivered) await Promise.resolve();
    restoreDom(); restoreDom();
    expect(host.textContent).toBe(' tail.');
    expect(strong.childNodes).toHaveLength(0);
    expect(mark.isConnected).toBe(false);
  });

  it(`preserves source separately after an ambiguous partial transfer, delivered=${delivered}`, async () => {
    const { originals, copy } = fixture('ordinary');
    const range = document.createRange(); range.setStart(copy.firstChild!, 1); range.setEnd(copy.firstChild!, 3);
    const mark = document.createElement('mark'); range.surroundContents(mark);
    const target = document.createElement('aside'); document.body.append(target); target.append(mark);
    if (delivered) await Promise.resolve();
    restoreDom(); restoreDom();
    expect(originals[0].nodeValue).toBe('First source');
    expect(originals[0].isConnected).toBe(true);
    expect(mark.parentNode).toBe(target); expect(mark.textContent).toBe('一译');
  });
}

for (const operation of ['range', 'split']) for (const delivered of [false, true]) for (const structure of ['ordinary', 'nested', 'omitted', 'normalized']) {
  for (const range of [[0, 2], [1, 3], [2, 4]]) {
    it(`restores a highlighted partial slot: ${operation}, ${structure}, ${range}, delivered=${delivered}`, async () => {
      const { host, strong, originals, wrapper, copy } = fixture(structure);
      if (delivered) await Promise.resolve();
      const mark = document.createElement('mark'); mark.setAttribute('data-page-note', 'retained');
      let clicks = 0; mark.addEventListener('click', () => clicks++);
      if (operation === 'range') {
        const selection = document.createRange();
        selection.setStart(copy.firstChild!, range[0]); selection.setEnd(copy.firstChild!, range[1]);
        selection.surroundContents(mark);
      } else {
        const selected = (copy.firstChild as Text).splitText(range[0]); selected.splitText(range[1] - range[0]);
        selected.before(mark); mark.append(selected);
      }
      const prefix = document.createTextNode('Page prefix '); copy.prepend(prefix);
      const suffix = document.createTextNode(' page suffix'); copy.append(suffix);
      if (delivered) await Promise.resolve();
      restoreDom(); restoreDom();
      expect(host.textContent).toBe(`Page prefix First source${structure === 'normalized' ? 'second source' : ''} page suffix tail.`);
      expect(originals.every(node => node.parentNode === strong)).toBe(true);
      expect(originals[0].nodeValue).toBe('First source');
      expect(prefix.parentNode).toBe(strong); expect(suffix.parentNode).toBe(strong);
      expect(strong.contains(mark)).toBe(true);
      expect(mark.getAttribute('data-page-note')).toBe('retained');
      mark.click(); expect(clicks).toBe(1);
      if (structure === 'nested' || structure === 'omitted') expect(strong.parentNode).toBe(wrapper);
      // The source has no equivalent character offset for a partial translated
      // highlight. Preserve the page wrapper, without guessing that offset.
      expect(mark.textContent).toBe('');
      const slots = extractRichSlots(host);
      expect(slots.join(' ')).not.toMatch(/译文/);
      render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(text => `译:${text}`), 'bilingual');
      restoreDom();
      expect(originals[0].nodeValue).toBe('First source');
    });
  }
}
