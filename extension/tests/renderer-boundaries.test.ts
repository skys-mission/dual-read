// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom, restoreMovedRichNodes } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

const sourceValues = ['First source', 'second source', 'third source'];
const keptSlots = [[0], [1], [2], [0, 1], [1, 2], [0, 2]];

for (const delivered of [false, true]) for (const identical of [false, true]) {
  for (const normalizeDestination of [false, true]) {
    it.each(keptSlots.map(kept => ({ kept })))(`restores retained slots $kept beside empty slots, delivered=${delivered}, identical=${identical}, normalizeDestination=${normalizeDestination}`, async ({ kept }) => {
      document.body.innerHTML = '<p id="one"><strong>First source<!--a-->second source<!--b-->third source</strong> tail.</p><p id="outside">Page prefix </p>';
      const one = document.querySelector<HTMLElement>('#one')!;
      const original = one.querySelector('strong')!;
      const originals = Array.from(original.childNodes).filter((node): node is Text => node instanceof Text);
      const slots = extractRichSlots(one);
      const translations = identical ? ['相同译文', '相同译文', '相同译文'] : ['第一译文', '第二译文', '第三译文'];
      render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, [...translations, '尾部译文'], 'replace');
      const copy = one.querySelector(':scope > strong')!;
      if (identical) {
        const texts = Array.from(copy.childNodes) as Text[];
        for (const [index, node] of texts.entries()) if (!kept.includes(index)) node.data = '';
      }
      copy.normalize();
      if (delivered) await Promise.resolve();
      const merged = copy.firstChild as Text;
      // Distinct values retain complete boundaries after a range edit.
      // Equal values need the per-Text identity before normalization.
      for (let index = 2; index >= 0; index--) if (!identical && !kept.includes(index)) {
        merged.deleteData(index * 4, 4);
        if (delivered) await Promise.resolve();
      }
      const target = document.querySelector('#outside')!;
      target.append(merged.splitText(0));
      if (normalizeDestination) target.normalize();
      if (delivered) await Promise.resolve();
      restoreDom();
      expect(one.textContent).toBe(' tail.');
      expect(target.textContent).toBe(`Page prefix ${kept.map(index => sourceValues[index]).join('')}`);
      for (const [index, node] of originals.entries()) {
        if (kept.includes(index)) {
          expect(node.parentNode).toBe(target);
          expect(node.data).toBe(sourceValues[index]);
        } else if (node.isConnected) expect(node.data).toBe('');
      }
      restoreDom();
      expect(target.textContent).toBe(`Page prefix ${kept.map(index => sourceValues[index]).join('')}`);
    });
  }
}

const destinations = ['existing shadow', 'new shadow', 'detached element', 'known shadow', 'connected element'] as const;
for (const delivered of [false, true]) for (const place of destinations) {
  it(`preserves source without guessing an unobserved owner: ${place}, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source</strong> tail.</p><div id="shadow"></div>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const title = one.querySelector('strong')!;
    const source = title.firstChild!;
    const shadowHost = document.querySelector('#shadow')!;
    let root: ParentNode = document.body;
    if (place === 'known shadow') root = shadowHost.attachShadow({ mode: 'open' });
    const slots = extractRichSlots(one);
    render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '尾部译文'], 'replace');
    if (place === 'existing shadow') root = shadowHost.attachShadow({ mode: 'open' });
    if (place === 'new shadow') {
      const fresh = document.createElement('section'); document.body.append(fresh);
      root = fresh.attachShadow({ mode: 'open' });
    }
    if (delivered) await Promise.resolve();
    const target = document.createElement('p');
    const prefix = document.createTextNode('Fresh source '); target.append(prefix);
    if (place !== 'detached element') root.appendChild(target);
    target.append(one.querySelector(':scope > strong')!.firstChild!);
    target.normalize();
    if (place === 'detached element') document.body.append(target);
    if (delivered) await Promise.resolve();
    restoreDom();
    const known = place === 'known shadow' || place === 'connected element' || place === 'new shadow' && delivered;
    expect(one.textContent).toBe(known ? ' tail.' : 'First source tail.');
    expect(source.parentNode).toBe(known ? target : title);
    expect(source.nodeValue).toBe('First source');
    expect(target.textContent).toBe(known ? 'Fresh source First source' : 'Fresh source 第一译文');
    expect(target.firstChild).toBe(prefix);
    restoreDom();
    expect(source.parentNode).toBe(known ? target : title);
    expect(target.textContent).toBe(known ? 'Fresh source First source' : 'Fresh source 第一译文');
  });
}

for (const delivered of [false, true]) for (const deleted of [0, 1, 2]) {
  it(`does not choose an arbitrary source slot after an ambiguous merged deletion: slot=${deleted}, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source<!--a-->second source<!--b-->third source</strong> tail.</p><p id="outside">Page prefix </p>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const title = one.querySelector('strong')!;
    const originals = Array.from(title.childNodes);
    const slots = extractRichSlots(one);
    render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, ['相同译文', '相同译文', '相同译文', '尾部译文'], 'replace');
    const copy = one.querySelector(':scope > strong')!;
    copy.normalize();
    if (delivered) await Promise.resolve();
    const merged = copy.firstChild as Text;
    merged.deleteData(deleted * 4, 4);
    if (delivered) await Promise.resolve();
    const target = document.querySelector('#outside')!;
    const tail = merged.splitText(0); target.append(tail);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(one.textContent).toBe('First sourcesecond sourcethird source tail.');
    expect(originals.every(node => node.parentNode === title)).toBe(true);
    expect(target.textContent).toBe('Page prefix 相同译文相同译文');
    expect(tail.parentNode).toBe(target);
    restoreDom();
    expect(one.textContent).toBe('First sourcesecond sourcethird source tail.');
  });
}

for (const delivered of [false, true]) for (const change of ['remove', 'replace', 'replace merged'] as const) {
  it(`respects a proven ${change} beside equal-valued new page text, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source<!--a-->second source</strong> tail.</p><div id="shadow"></div>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const source = one.querySelector('strong')!.firstChild!;
    const second = one.querySelector('strong')!.lastChild!;
    const slots = extractRichSlots(one);
    render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '第二译文', '尾部译文'], 'replace');
    const copy = one.querySelector(':scope > strong')!;
    if (change === 'replace merged') copy.normalize();
    if (delivered) await Promise.resolve();
    const fresh = document.createTextNode(copy.firstChild!.nodeValue!);
    if (change === 'remove') copy.firstChild!.remove();
    else copy.firstChild!.replaceWith(fresh);
    // This equal-valued page text was inserted in an observed parent. It does
    // not provide evidence for a missed normalization or a source transfer.
    const target = document.querySelector('#shadow')!;
    const literal = document.createTextNode('第一译文'); target.append(literal);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(source.isConnected).toBe(false);
    expect(second.isConnected).toBe(change !== 'replace merged');
    expect(target.firstChild).toBe(literal);
    expect(target.textContent).toBe('第一译文');
    expect(one.textContent).toBe(change === 'remove' ? 'second source tail.'
      : change === 'replace' ? '第一译文second source tail.' : '第一译文第二译文 tail.');
    if (change !== 'remove') expect(fresh.parentNode).toBe(one.querySelector('strong'));
  });
}

for (const delivered of [false, true]) {
  it(`does not revive a deleted slot from a later observed insertion into a new wrapper, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!--marker-->second source</strong> tail.</p>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const removed = title.lastChild!;
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['相同译文', '相同译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    copy.lastChild!.remove();
    const fresh = document.createTextNode('相同译文'); copy.append(fresh);
    const wrapper = document.createElement('em'); copy.append(wrapper);
    if (delivered) await Promise.resolve();
    wrapper.append(fresh); fresh.appendData(' added source ');
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe('First source相同译文 added source  tail.');
    expect(removed.isConnected).toBe(false);
    expect(fresh.parentNode).toBe(wrapper);
    expect(wrapper.parentNode).toBe(title);
  });

  it(`retains each last known source edit after an unobserved multi-slot transfer, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!--marker-->second source</strong> tail.</p><div id="shadow"></div>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const originals = [...title.childNodes];
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '第二译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    (copy.lastChild as Text).appendData(' added source'); copy.normalize();
    if (delivered) await Promise.resolve();
    const root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const target = document.createElement('p'); target.append('Fresh source '); root.append(target);
    target.append(copy.firstChild!); target.normalize();
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe('First sourcesecond source added source tail.');
    expect(originals.every(node => node.parentNode === title)).toBe(true);
    expect(target.textContent).toBe('Fresh source 第一译文第二译文 added source');
    restoreDom();
    expect(host.textContent).toBe('First sourcesecond source added source tail.');
  });
}

for (const delivered of [false, true]) for (const merged of [false, true]) {
  it(`keeps the last source when a discarded copy is edited: merged=${merged}, delivered=${delivered}`, async () => {
    document.body.innerHTML = `<p><strong>First source${merged ? '<!--marker-->second source' : ''}</strong> tail.</p><div id="shadow"></div>`;
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const originals = [...title.childNodes];
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } },
      merged ? ['第一译文', '第二译文', '尾部译文'] : ['第一译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    const discarded = copy.lastChild as Text;
    if (merged) {
      copy.normalize();
      // jsdom lacks native transient observers on removed subtrees. Deliver
      // the merge first here; both browsers also test the same-turn sequence.
      await Promise.resolve();
      discarded.data = '';
    }
    const root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const target = document.createElement('p'); target.append('Fresh source '); root.append(target);
    target.append(copy.firstChild!); target.normalize();
    if (delivered) await Promise.resolve();
    if (!merged) discarded.data = '';
    restoreDom();
    expect(host.textContent).toBe(merged ? 'First sourcesecond source tail.' : 'First source tail.');
    expect(originals.every(node => node.parentNode === title)).toBe(true);
    expect(target.textContent).toBe(merged ? 'Fresh source 第一译文第二译文' : 'Fresh source 第一译文');
  });
}

for (const delivered of [false, true]) {
  it(`retains a complete source replacement and subsequent edits before an unobserved transfer, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!--marker-->second source</strong> tail.</p><div id="shadow"></div>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const original = title.firstChild!;
    const removed = title.lastChild!;
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '第二译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!; copy.normalize();
    if (delivered) await Promise.resolve();
    const merged = copy.firstChild as Text; merged.data = 'Entirely new source';
    if (delivered) await Promise.resolve();
    merged.appendData(' added');
    if (delivered) await Promise.resolve();
    const root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const target = document.createElement('p'); target.append('Fresh source '); root.append(target);
    target.append(merged); target.normalize();
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe('Entirely new source added tail.');
    expect(original.parentNode).toBe(title);
    expect(original.nodeValue).toBe('Entirely new source added');
    expect(removed.isConnected).toBe(false);
    expect(target.textContent).toBe('Fresh source Entirely new source added');
    restoreDom();
    expect(host.textContent).toBe('Entirely new source added tail.');
  });
}

it.each(['transfer then normalize', 'remove then insert equal text'] as const)(
  'keeps source without rewriting the target when records cannot distinguish %s', (operation) => {
    document.body.innerHTML = '<p><strong>First source</strong> tail.</p><div id="shadow"></div>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const original = title.firstChild!;
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    const text = copy.firstChild!;
    const observer = new MutationObserver(() => {});
    observer.observe(document, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    const root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const target = document.createElement('p');
    const prefix = document.createTextNode('Fresh source '); target.append(prefix); root.append(target);
    if (operation === 'transfer then normalize') target.append(text);
    else { text.remove(); target.append(document.createTextNode('第一译文')); }
    target.normalize();
    const records = observer.takeRecords(); observer.disconnect();
    // Both operations expose precisely the same identity-bearing removal and
    // final DOM. Neither exposes a target normalization record to the renderer.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'childList', target: copy, oldValue: null });
    expect([...records[0].removedNodes]).toEqual([text]);
    expect([...records[0].addedNodes]).toEqual([]);
    expect(text.parentNode).toBeNull();
    expect(text.nodeValue).toBe('第一译文');
    restoreDom();
    expect(host.textContent).toBe('First source tail.');
    expect(original.parentNode).toBe(title);
    expect(target.firstChild).toBe(prefix);
    expect(target.textContent).toBe('Fresh source 第一译文');
  },
);

for (const delivered of [false, true]) for (const cleared of [0, 1]) {
  it(`uses split Text identity for an equal-valued slot cleared after normalization: slot=${cleared}, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source<!--marker-->second source</strong> tail.</p><p id="outside">Page prefix </p>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const title = one.querySelector('strong')!;
    const originals = [title.firstChild!, title.lastChild!];
    const slots = extractRichSlots(one);
    render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, ['相同译文', '相同译文', '尾部译文'], 'replace');
    const copy = one.querySelector(':scope > strong')!; copy.normalize();
    if (delivered) await Promise.resolve();
    const first = copy.firstChild as Text;
    const second = first.splitText(4);
    if (delivered) await Promise.resolve();
    [first, second][cleared].data = '';
    if (delivered) await Promise.resolve();
    const target = document.querySelector('#outside')!;
    target.append([first, second][1 - cleared]); target.normalize();
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(one.textContent).toBe(' tail.');
    expect(target.textContent).toBe(`Page prefix ${cleared === 0 ? 'second source' : 'First source'}`);
    expect(originals[1 - cleared].parentNode).toBe(target);
    if (originals[cleared].isConnected) expect(originals[cleared].nodeValue).toBe('');
  });
}

for (const delivered of [false, true]) {
  it(`limits ambiguous recovery to the edited physical fragment, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p id="one"><strong>First source<!--a-->second source<!--b-->third source</strong> tail.</p><p id="outside">Page prefix </p><p id="uncertain">Current text </p>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const title = one.querySelector('strong')!;
    const originals = [...title.childNodes].filter(node => node instanceof Text);
    const slots = extractRichSlots(one);
    render({ el: one, kind: 'block', text: slots.join(' '), rich: { slots } }, ['相同译文', '相同译文', '相同译文', '尾部译文'], 'replace');
    const copy = one.querySelector(':scope > strong')!; copy.normalize();
    if (delivered) await Promise.resolve();
    const first = copy.firstChild as Text;
    const remaining = first.splitText(4);
    if (delivered) await Promise.resolve();
    remaining.deleteData(0, 4);
    if (delivered) await Promise.resolve();
    const target = document.querySelector('#outside')!;
    const uncertain = document.querySelector('#uncertain')!;
    target.append(first); uncertain.append(remaining);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(one.textContent).toBe('second sourcethird source tail.');
    expect(target.textContent).toBe('Page prefix First source');
    expect(uncertain.textContent).toBe('Current text 相同译文');
    expect(originals[0].parentNode).toBe(target);
    expect(originals.slice(1).every(node => node.parentNode === title)).toBe(true);
    expect(remaining.parentNode).toBe(uncertain);
  });

  it(`uses reconnected copied Text identity after conservative retention, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source</strong> tail.</p><div id="shadow"></div>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const original = title.firstChild!;
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    const copiedText = copy.firstChild!;
    const root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const target = document.createElement('p'); target.append('Fresh source '); root.append(target);
    target.append(copiedText); target.normalize();
    if (delivered) await Promise.resolve();
    restoreMovedRichNodes([document, root]);
    copy.append(copiedText);
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe('First source tail.');
    expect(original.parentNode).toBe(title);
    expect(target.textContent).toBe('Fresh source 第一译文');
  });
}

for (const delivered of [false, true]) {
  it(`does not revive a completely emptied normalized run, delivered=${delivered}`, async () => {
    document.body.innerHTML = '<p><strong>First source<!--marker-->second source</strong> tail.</p>';
    const host = document.querySelector('p')!;
    const slots = extractRichSlots(host);
    render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, ['第一译文', '第二译文', '尾部译文'], 'replace');
    const copy = host.querySelector(':scope > strong')!;
    copy.normalize();
    if (delivered) await Promise.resolve();
    (copy.firstChild as Text).data = '';
    if (delivered) await Promise.resolve();
    restoreDom();
    expect(host.textContent).toBe(' tail.');
  });
}
