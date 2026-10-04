// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { extractRichSlots } from '../lib/collector';
import { render, restoreDom, restoreUnit } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; });

function replaceRich(host: HTMLElement, translated?: string): void {
  const slots = extractRichSlots(host);
  render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(text => translated ?? `译:${text}`), 'replace');
}

it('preserves an incremental edit between adjacent slots after normalize', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  const original = host.querySelector('strong')!;
  const children = Array.from(original.childNodes);
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' with more source ');
  copy.normalize();
  restoreDom();
  expect(host.textContent).toBe('First source with more source second source for details.');
  expect(Array.from(original.childNodes)).toEqual(children);
});

it('preserves an inserted source Text between adjacent slots after normalize', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  copy.insertBefore(document.createTextNode(' New middle source '), copy.lastChild);
  copy.normalize();
  restoreDom();
  expect(host.textContent).toBe('First source New middle source second source for details.');
});

it('does not carry another slot translation into a replaced source after normalize', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  copy.firstChild!.nodeValue = 'New first source ';
  copy.normalize();
  restoreDom();
  expect(host.textContent).toBe('New first source second source for details.');
});

it('restores transferred Texts normalized with a different host translation', () => {
  document.body.innerHTML = '<p id="one"><strong>First source</strong> first tail.</p><p id="two"><strong>Second source</strong> second tail.</p>';
  const one = document.querySelector<HTMLElement>('#one')!;
  const two = document.querySelector<HTMLElement>('#two')!;
  const originalOne = one.querySelector('strong')!.firstChild!;
  const originalTwo = two.querySelector('strong')!.firstChild!;
  replaceRich(one);
  replaceRich(two);
  const left = one.querySelector(':scope > strong')!;
  const right = two.querySelector(':scope > strong')!;
  right.appendChild(left.firstChild!);
  right.normalize();
  restoreDom();
  expect(one.textContent).toBe(' first tail.');
  expect(two.textContent).toBe('Second sourceFirst source second tail.');
  expect(Array.from(two.querySelector('strong')!.childNodes)).toEqual([originalTwo, originalOne]);
});

it.each(['prepend second', 'replace second', 'both edits', 'page prefix', 'page suffix', 'split again'] as const)(
  'preserves source and original Text identities after %s and normalize', (change) => {
    document.body.innerHTML = '<p lang="en"><strong>First source<!-- marker -->second source</strong> for details.</p>';
    const host = document.querySelector('p')!;
    const title = host.querySelector('strong')!;
    const originals = Array.from(title.childNodes);
    replaceRich(host);
    const copy = host.querySelector(':scope > strong')!;
    const first = copy.firstChild as Text;
    const second = copy.lastChild as Text;
    if (change === 'prepend second') second.insertData(0, 'New ');
    else if (change === 'replace second') second.data = 'A new second source';
    else {
      first.appendData(' added ');
      if (change === 'both edits') second.insertData(0, 'New ');
      if (change === 'page prefix') copy.prepend(document.createTextNode('Page prefix '));
      if (change === 'page suffix') copy.append(' Page suffix');
    }
    copy.normalize();
    if (change === 'split again') {
      (copy.firstChild as Text).splitText(5);
      copy.normalize();
    }
    restoreDom();
    const prefix = change === 'page prefix' ? 'Page prefix ' : '';
    const middle = !['prepend second', 'replace second'].includes(change) ? ' added ' : '';
    const tail = change === 'replace second' ? 'A new second source'
      : `${['prepend second', 'both edits'].includes(change) ? 'New ' : ''}second source`;
    const suffix = change === 'page suffix' ? ' Page suffix' : '';
    expect(host.textContent).toBe(`${prefix}First source${middle}${tail}${suffix} for details.`);
    expect(originals.every(node => node.parentNode === title)).toBe(true);
    expect(host.getAttribute('lang')).toBe('en');
    restoreDom();
    expect(originals.every(node => node.parentNode === title)).toBe(true);
  },
);

it.each(['remove first', 'remove second', 'replace all'] as const)('keeps an actual %s after edits and normalize', (change) => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  const title = host.querySelector('strong')!;
  const originals = Array.from(title.childNodes);
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' added ');
  copy.normalize();
  if (change === 'replace all') copy.textContent = 'Entirely new source';
  else {
    // Recover the first normalization before the next, independent page edit.
    restoreUnit(host);
    replaceRich(host);
    const next = host.querySelector(':scope > strong')!;
    (change === 'remove first' ? next.firstChild : next.lastChild)!.remove();
    next.normalize();
  }
  restoreDom();
  expect(host.textContent).toBe(`${change === 'replace all' ? 'Entirely new source'
    : change === 'remove first' ? 'second source' : 'First source added '} for details.`);
  if (change !== 'replace all') expect(originals[change === 'remove first' ? 0 : 2].isConnected).toBe(false);
});

it('distinguishes edits and removals when adjacent slots have identical translations', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  const title = host.querySelector('strong')!;
  const originals = Array.from(title.childNodes);
  replaceRich(host, '相同译文');
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' added ');
  copy.normalize();
  restoreDom();
  expect(host.textContent).toBe('First source added second source for details.');
  expect(Array.from(title.childNodes)).toEqual(originals);
  replaceRich(host, '相同译文');
  const next = host.querySelector(':scope > strong')!;
  next.lastChild!.remove();
  next.normalize();
  restoreDom();
  expect(host.textContent).toBe('First source added  for details.');
  expect(originals[2].isConnected).toBe(false);
});

it('does not infer a merge from an independent text edit followed by removal', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  const second = host.querySelector('strong')!.lastChild!;
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  copy.firstChild!.nodeValue = 'New first source';
  copy.lastChild!.remove();
  copy.normalize();
  restoreDom();
  expect(host.textContent).toBe('New first source for details.');
  expect(second.isConnected).toBe(false);
});

it('keeps a proven merge when page code later inserts and removes unrelated text', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' added ');
  copy.normalize();
  const temporary = document.createTextNode('Temporary page text');
  copy.appendChild(temporary);
  temporary.remove();
  restoreDom();
  expect(host.textContent).toBe('First source added second source for details.');
});

it('does not revive a normalized run replaced before records are delivered', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  const originals = Array.from(host.querySelector('strong')!.childNodes);
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' added ');
  copy.normalize();
  copy.replaceChildren(document.createTextNode('Fresh source'));
  restoreDom();
  expect(host.textContent).toBe('Fresh source for details.');
  expect(originals.filter(node => node.nodeType === Node.TEXT_NODE).every(node => !node.isConnected)).toBe(true);
});

it('replays delivered normalization records before later prefix and suffix edits', async () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong> for details.</p>';
  const host = document.querySelector('p')!;
  replaceRich(host);
  const copy = host.querySelector(':scope > strong')!;
  (copy.firstChild as Text).appendData(' added ');
  copy.normalize();
  await Promise.resolve();
  const merged = copy.firstChild as Text;
  merged.insertData(0, 'New prefix ');
  merged.appendData(' New suffix');
  await Promise.resolve();
  restoreDom();
  expect(host.textContent).toBe('New prefix First source added second source New suffix for details.');
});

it.each(['source removed', 'source restored first', 'survivor moved', 'raw survivor moved', 'shadow destination'] as const)(
  'preserves transferred originals after normalize with %s', (change) => {
    document.body.innerHTML = '<p id="one"><strong>First source</strong> first tail.</p><p id="two"><strong>Second source</strong> second tail.</p><div id="shadow"></div>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const two = document.querySelector<HTMLElement>('#two')!;
    if (change === 'shadow destination') {
      document.querySelector('#shadow')!.attachShadow({ mode: 'open' }).appendChild(two);
    }
    const first = one.querySelector('strong')!.firstChild!;
    const originalTarget = two.querySelector('strong')!;
    const second = originalTarget.firstChild!;
    replaceRich(one);
    replaceRich(two);
    const target = two.querySelector(':scope > strong')!;
    if (change === 'raw survivor moved') target.prepend(document.createTextNode('Page prefix '));
    target.appendChild(one.querySelector(':scope > strong')!.firstChild!);
    target.normalize();
    if (change === 'source removed') one.remove();
    if (change === 'source restored first') restoreUnit(one);
    let destination: Element = originalTarget;
    if (change === 'survivor moved' || change === 'raw survivor moved') {
      destination = document.createElement('em');
      two.appendChild(destination);
      destination.appendChild(target.firstChild!);
    }
    restoreDom();
    expect(destination.textContent).toBe(`${change === 'raw survivor moved' ? 'Page prefix ' : ''}Second sourceFirst source`);
    expect(first.parentNode).toBe(destination);
    expect(second.parentNode).toBe(destination);
    if (change !== 'source removed') expect(one.textContent).toBe(' first tail.');
    restoreDom();
    expect(first.parentNode).toBe(destination);
  },
);

it('recovers multiple normalization steps across three translated containers', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong></p><p><strong>Third source</strong></p>';
  const [one, two] = Array.from(document.querySelectorAll('p'));
  const first = one.querySelector('strong')!.firstChild!;
  const second = one.querySelector('strong')!.lastChild!;
  const third = two.querySelector('strong')!.firstChild!;
  replaceRich(one);
  replaceRich(two);
  const left = one.querySelector(':scope > strong')!;
  (left.firstChild as Text).appendData(' added ');
  left.normalize();
  const right = two.querySelector(':scope > strong')!;
  right.appendChild(left.firstChild!);
  right.normalize();
  restoreDom();
  expect(two.textContent).toBe('Third sourceFirst source added second source');
  expect(Array.from(two.querySelector('strong')!.childNodes)).toEqual([third, first, second]);
});

for (const delivered of [false, true]) {
  it.each(['insert', 'replace first', 'replace second', 'delete first', 'split edit', 'edit twice', 'replace all', 'remove all'] as const)(
    `replays %s after normalize with records delivered=${delivered}`, async (change) => {
      document.body.innerHTML = '<p lang="en"><strong>First source<!-- marker -->second source</strong> for details.</p>';
      const host = document.querySelector('p')!;
      const title = host.querySelector('strong')!;
      const originals = Array.from(title.childNodes);
      replaceRich(host);
      const copy = host.querySelector(':scope > strong')!;
      const first = '译:First source';
      const second = '译:second source';
      copy.normalize();
      if (delivered) await Promise.resolve();
      const merged = copy.firstChild as Text;
      if (change === 'insert' || change === 'edit twice') {
        merged.insertData(first.length, ' New middle source ');
        if (change === 'edit twice') {
          if (delivered) await Promise.resolve();
          merged.replaceData(first.length, ' New middle source '.length, ' Updated middle ');
        }
      } else if (change === 'replace first') merged.replaceData(0, first.length, 'New first source ');
      else if (change === 'replace second') merged.replaceData(first.length, second.length, ' new second source');
      else if (change === 'delete first') merged.deleteData(0, first.length);
      else if (change === 'split edit') {
        const tail = merged.splitText(5);
        if (delivered) await Promise.resolve();
        tail.insertData(first.length - 5, ' New middle source ');
        copy.normalize();
      } else if (change === 'replace all') merged.data = 'Entirely fresh content';
      else copy.replaceChildren(document.createTextNode('Entirely fresh content'));
      if (delivered) await Promise.resolve();
      restoreDom();
      const text = change === 'replace first' ? 'New first source second source'
        : change === 'replace second' ? 'First source new second source'
        : change === 'delete first' ? 'second source'
        : change === 'edit twice' ? 'First source Updated middle second source'
        : ['replace all', 'remove all'].includes(change) ? 'Entirely fresh content'
        : 'First source New middle source second source';
      expect(host.textContent).toBe(`${text} for details.`);
      if (!['replace all', 'remove all'].includes(change)) {
        expect(Array.from(title.childNodes)).toEqual(originals);
        if (change === 'replace second') expect(originals[2].nodeValue).toBe(' new second source');
      } else {
        expect(originals[2].isConnected).toBe(false);
        expect(originals[0].isConnected).toBe(change === 'replace all');
      }
      expect(host.getAttribute('lang')).toBe('en');
      restoreDom();
      expect(host.textContent).toBe(`${text} for details.`);
    },
  );
}

it.each(['document', 'existing shadow', 'late shadow', 'source removed', 'source restored first', 'survivor moved'] as const)(
  'restores a transfer normalized into an untranslated destination: %s', async (location) => {
    document.body.innerHTML = '<p id="one"><strong>First source</strong> first tail.</p><div id="shadow"></div>';
    const one = document.querySelector<HTMLElement>('#one')!;
    const original = one.querySelector('strong')!.firstChild!;
    const shadowHost = document.querySelector('#shadow')!;
    let scope: ParentNode = document.body;
    if (location === 'existing shadow') scope = shadowHost.attachShadow({ mode: 'open' });
    replaceRich(one);
    if (location === 'late shadow') {
      const component = document.createElement('div');
      shadowHost.appendChild(component);
      scope = component.attachShadow({ mode: 'open' });
      await Promise.resolve();
    }
    const target = document.createElement('p');
    const prefix = document.createTextNode('Fresh source ');
    target.appendChild(prefix);
    scope.appendChild(target);
    target.appendChild(one.querySelector(':scope > strong')!.firstChild!);
    target.normalize();
    if (location === 'source removed') one.remove();
    if (location === 'source restored first') restoreUnit(one);
    let destination: Element = target;
    if (location === 'survivor moved') {
      destination = document.createElement('em');
      target.appendChild(destination);
      destination.appendChild(prefix);
    }
    restoreDom();
    expect(target.textContent).toBe('Fresh source First source');
    expect(original.parentNode).toBe(destination);
    expect(prefix.parentNode).toBe(destination);
    if (location !== 'source removed') expect(one.textContent).toBe(' first tail.');
    restoreDom();
    expect(target.textContent).toBe('Fresh source First source');
  },
);

it('restores opaque translations in a new host while preserving the page-owned prefix', () => {
  document.body.innerHTML = '<p><strong>First source</strong> first tail.</p>';
  const one = document.querySelector('p')!;
  const original = one.querySelector('strong')!.firstChild!;
  replaceRich(one, '第一段译文');
  const target = document.createElement('p');
  const prefix = document.createTextNode('Fresh source ');
  target.appendChild(prefix);
  document.body.appendChild(target);
  target.appendChild(one.querySelector(':scope > strong')!.firstChild!);
  target.normalize();
  restoreDom();
  expect(target.textContent).toBe('Fresh source First source');
  expect(target.firstChild).toBe(prefix);
  expect(original.parentNode).toBe(target);
});

it('keeps explicit deletion in a new destination after an unrelated text edit', () => {
  document.body.innerHTML = '<p><strong>First source</strong> first tail.</p>';
  const one = document.querySelector('p')!;
  const original = one.querySelector('strong')!.firstChild!;
  replaceRich(one);
  const target = document.createElement('p');
  const prefix = document.createTextNode('Fresh source ');
  target.appendChild(prefix);
  document.body.appendChild(target);
  const translated = one.querySelector(':scope > strong')!.firstChild!;
  target.appendChild(translated);
  prefix.appendData('updated ');
  translated.remove();
  restoreDom();
  expect(target.textContent).toBe('Fresh source updated ');
  expect(one.textContent).toBe(' first tail.');
  expect(original.isConnected).toBe(false);
});

it('flattens repeated transfers before an edit in the inner merged slots', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong></p><p><strong>Third source</strong></p>';
  const [one, two] = Array.from(document.querySelectorAll('p'));
  const title = one.querySelector('strong')!;
  const first = title.firstChild!;
  const second = title.lastChild!;
  const other = two.querySelector('strong')!;
  const third = other.firstChild!;
  replaceRich(one);
  replaceRich(two);
  const left = one.querySelector(':scope > strong')!;
  left.normalize();
  const right = two.querySelector(':scope > strong')!;
  right.appendChild(left.firstChild!);
  right.normalize();
  (right.firstChild as Text).insertData('译:Third source译:First source'.length, ' New middle source ');
  restoreDom();
  expect(two.textContent).toBe('Third sourceFirst source New middle source second source');
  expect(Array.from(other.childNodes)).toEqual([third, first, second]);
});

it('keeps unchanged slots intact when an inserted source shares their translation prefix', () => {
  document.body.innerHTML = '<p><strong>First source<!-- marker -->second source</strong></p>';
  const host = document.querySelector('p')!;
  const title = host.querySelector('strong')!;
  const originals = Array.from(title.childNodes);
  replaceRich(host, '同一译文');
  const copy = host.querySelector(':scope > strong')!;
  copy.normalize();
  (copy.firstChild as Text).insertData('同一译文'.length, '同一新增内容');
  restoreDom();
  expect(host.textContent).toBe('First source同一新增内容second source');
  expect(Array.from(title.childNodes)).toEqual(originals);
});
