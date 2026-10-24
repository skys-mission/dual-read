// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectUnits, collectUnitsAsync, isVisibilityMutation, mutationIndexDelta } from '../lib/collector';
import { render, restoreDom, restoreUnit } from '../lib/renderer';
import { DONE, MODE } from '../lib/dom-const';

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 520, height: 24, top: 0, left: 0, right: 520, bottom: 24,
    toJSON() {},
  } as DOMRect);
});
afterEach(() => { restoreDom(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('independent flex text columns', () => {
  it.each(['rich', 'mixed'] as const)('preserves styled prose element parentage while translating a %s flex row', variant => {
    document.body.innerHTML = `<style>#row > #styled {color:rgb(200,0,0);font-size:24px}</style><ul><li id="row" style="display:flex">Read the <strong id="styled">important documentation</strong> carefully.${variant === 'mixed' ? '<button>Close</button>' : ''}</li></ul>`;
    const row = document.getElementById('row')!, styled = document.getElementById('styled')!;
    const children = Array.from(row.childNodes), text = styled.firstChild;
    for (const unit of collectUnits()) render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, 'bilingual');
    expect(styled.parentElement).toBe(row);
    expect(getComputedStyle(styled).color).toBe('rgb(200, 0, 0)'); expect(getComputedStyle(styled).fontSize).toBe('24px');
    styled.setAttribute('data-page-edit', 'retained'); restoreDom(); restoreDom();
    expect(Array.from(row.childNodes)).toEqual(children); expect(styled.firstChild).toBe(text); expect(styled.dataset.pageEdit).toBe('retained');
  });

  it.each(['bilingual', 'replace'] as const)('does not aggregate processed rich descendants during a %s ancestor rescan', mode => {
    document.body.innerHTML = '<main id="root"><div id="card"><p>Price information with <a href="/terms">pricing terms</a>.</p><p>Independent product description.</p></div></main>';
    const units = collectUnits();
    for (const unit of units) render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, mode);
    const observer = new MutationObserver(() => {});
    observer.observe(document.getElementById('root')!, {attributes:true, attributeOldValue:true});
    document.getElementById('root')!.style.setProperty('--carousel-progress', '1');
    const delta = mutationIndexDelta(observer.takeRecords(), units.map(unit => unit.el), () => false); observer.disconnect();
    expect(delta.added).toEqual([]);
    expect(collectUnits(document.getElementById('card')!)).toEqual([]);
    expect(document.getElementById('card')!.hasAttribute(DONE)).toBe(false);
  });

  it('collects only newly revealed prose around a processed rich descendant', () => {
    document.body.innerHTML = '<main id="root"><div id="card"><p>Price information with <a href="/terms">pricing terms</a>.</p><span id="late" hidden>Newly revealed description.</span></div></main>';
    const units = collectUnits();
    for (const unit of units) render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, 'bilingual');
    document.getElementById('late')!.hidden = false;
    const added = collectUnits(document.getElementById('card')!);
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('Newly revealed description.');
    expect(added[0].rich).toBeUndefined();
  });

  it.each(['rich', 'mixed'] as const)('keeps an independently styled action anchor outside a %s source flow', variant => {
    document.body.innerHTML = `<style>#row > a.action {display:inline-flex;flex:0 0 160px;background:blue;color:white;height:40px}</style><ul><li id="row" style="display:flex">Read the account documentation. <a id="action" class="action" href="/account">Account settings</a> for more information.${variant === 'mixed' ? '<button>Close</button>' : ''}</li></ul>`;
    const row = document.getElementById('row')!;
    const action = document.getElementById('action')!;
    const children = Array.from(row.childNodes);
    const label = action.firstChild;
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, 'bilingual');
    expect(action.parentElement).toBe(row);
    expect(getComputedStyle(action).backgroundColor).toBe('rgb(0, 0, 255)');
    expect(getComputedStyle(action).height).toBe('40px');
    expect(action.firstChild).toBe(label);
    action.setAttribute('href', '/updated');
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual(children);
    expect(action.getAttribute('href')).toBe('/updated');
  });

  it('keeps ordinary prose links direct while retaining one rich translation', () => {
    document.body.innerHTML = '<ul><li id="row" style="display:flex">Read <a id="link" href="/guide">the guide</a> carefully.</li></ul>';
    const row = document.getElementById('row')!;
    const link = document.getElementById('link')!;
    const children = Array.from(row.childNodes);
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, unit.rich!.slots.map(slot => `译:${slot}`), 'bilingual');
    expect(link.parentElement).toBe(row);
    expect(row.querySelectorAll(':scope > .dual-read-target')).toHaveLength(1);
    expect(row.querySelector('.dual-read-target a')!.textContent).toBe('译:the guide');
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual(children);
  });

  it.each(['bilingual', 'replace'] as const)('retains column parents, selectors and source nodes in %s', mode => {
    document.body.innerHTML = '<style>#row { display:flex;gap:24px } #row > #copy { color:red } #date { flex:0 0 140px } #copy { flex:1 }</style><ul><li id="row"><span id="date">Monday, October 6</span><span id="copy">Read <strong>the documentation</strong> for detailed instructions.</span></li></ul>';
    const row = document.getElementById('row')!;
    const date = document.getElementById('date')!;
    const copy = document.getElementById('copy')!;
    const children = Array.from(row.childNodes);
    const copyChildren = Array.from(copy.childNodes);
    const units = collectUnits();
    expect(units.map(unit => unit.el)).toEqual(expect.arrayContaining([date, copy]));
    expect(units).toHaveLength(2);
    for (const unit of units) render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, mode);
    expect(Array.from(row.childNodes)).toEqual(children);
    expect(date.parentElement).toBe(row);
    expect(copy.parentElement).toBe(row);
    expect(getComputedStyle(copy).color).toBe('rgb(255, 0, 0)');
    copy.style.flexGrow = '2';
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual(children);
    expect(Array.from(copy.childNodes)).toEqual(copyChildren);
    expect(copy.style.flexGrow).toBe('2');
  });

  it('uses the same independent columns in cooperative collection', async () => {
    document.body.innerHTML = '<div id="row" style="display:flex"><span id="left">First documentation column.</span><span id="right">Second documentation column.</span></div>';
    expect((await collectUnitsAsync()).units.map(unit => unit.el.id)).toEqual(['left', 'right']);
  });

  it('keeps a single existing text label in its original flex slot', () => {
    document.body.innerHTML = '<style>#row > #label { color:red;flex:1 }</style><ul><li id="row" style="display:flex"><svg></svg><span id="label">Read the documentation carefully.</span><svg></svg></li></ul>';
    const row = document.getElementById('row')!;
    const label = document.getElementById('label')!;
    const children = Array.from(row.childNodes);
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, '请仔细阅读文档。', 'bilingual');
    expect(Array.from(row.childNodes)).toEqual(children);
    expect(label.querySelector('.dual-read-target')).not.toBeNull();
    expect(getComputedStyle(label).color).toBe('rgb(255, 0, 0)');
  });
});

describe('flow restoration after page operations', () => {
  it.each((['plain', 'structured'] as const).flatMap(variant =>
    (['wrap', 'split-insert', 'transfer', 'delete-host'] as const).map(operation => ({variant, operation})),
  ))('retains current $variant source nodes after $operation', ({variant, operation}) => {
    document.body.innerHTML = `<ul><li id="row" style="display:flex"><svg id="lead"></svg>${variant === 'structured' ? 'Read <a href="/guide">the guide</a>' : 'Read the guide carefully.'}<svg id="tail"></svg></li></ul><section id="receiver"></section>`;
    const row = document.getElementById('row')!;
    const text = row.childNodes[1] as Text;
    const link = row.querySelector('a');
    const lead = document.getElementById('lead')!;
    const tail = document.getElementById('tail')!;
    const receiver = document.getElementById('receiver')!;
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, 'bilingual');
    const wrapper = document.createElement('section');
    const flow = row.querySelector('.dual-read-flow');
    row.insertBefore(wrapper, flow || text);
    if (flow) wrapper.appendChild(flow);
    else wrapper.append(text, link!);
    let expected: Node[] = [text, ...link ? [link] : []];
    if (operation === 'split-insert') {
      text.data = 'Read updated ';
      const split = text.splitText(5);
      const addition = document.createElement('em');
      addition.textContent = 'page detail ';
      text.parentNode!.insertBefore(addition, link || text.nextSibling!.nextSibling);
      if (link) link.href = '/updated';
      expected = [text, split, addition, ...link ? [link] : []];
    }
    if (operation === 'transfer' || operation === 'delete-host') receiver.appendChild(wrapper);
    if (operation === 'delete-host') row.remove();
    restoreDom();
    expect(Array.from(wrapper.childNodes)).toEqual(expected);
    expect(wrapper.parentElement).toBe(operation === 'transfer' || operation === 'delete-host' ? receiver : row);
    expect(document.querySelector('.dual-read-flow,.dual-read-target')).toBeNull();
    expect(text.isConnected && (!link || link.isConnected)).toBe(true);
    expect(lead.isConnected && tail.isConnected).toBe(operation !== 'delete-host');
    if (operation === 'split-insert' && link) expect(link.getAttribute('href')).toBe('/updated');
    restoreDom();
    expect(Array.from(wrapper.childNodes)).toEqual(expected);
  });

  it('can restore a transferred flow through its original owner', () => {
    document.body.innerHTML = '<ul><li id="row" style="display:flex">Read the documentation.</li></ul><section id="receiver"></section>';
    const row = document.getElementById('row')!;
    const source = row.firstChild!;
    render(collectUnits().find(unit => unit.el === row)!, '请阅读文档。', 'bilingual');
    const receiver = document.getElementById('receiver')!;
    receiver.appendChild(row.querySelector('.dual-read-flow')!);
    restoreUnit(row);
    expect(Array.from(receiver.childNodes)).toEqual([source]);
    expect(row.childNodes).toHaveLength(0);
  });

  it('does not unwrap a different nested translation during single-owner restoration', () => {
    document.body.innerHTML = '<div id="outer"><ul><li id="row" style="display:flex">Read the documentation.</li></ul></div>';
    const outer = document.getElementById('outer')!;
    const row = document.getElementById('row')!;
    render(collectUnits().find(unit => unit.el === row)!, '请阅读文档。', 'bilingual');
    const flow = row.querySelector('.dual-read-flow')!;
    outer.setAttribute(DONE, 'true');
    outer.setAttribute(MODE, 'bilingual');
    restoreUnit(outer);
    expect(flow.parentElement).toBe(row);
    expect(row.querySelector('.dual-read-target')).not.toBeNull();
    restoreDom();
    expect(row.querySelector('.dual-read-flow')).toBeNull();
  });
});

describe('code classification changes under translated hosts', () => {
  it.each(['bilingual', 'replace'] as const)('invalidates only the source owner after editor hydration in %s', mode => {
    document.body.innerHTML = '<p id="outer">An example follows: <strong id="editor">function Example() { return null; }</strong> Continue reading.</p><p id="unrelated">Independent documentation.</p>';
    const outer = document.getElementById('outer')!;
    const editor = document.getElementById('editor')!;
    const code = editor.firstChild as Text;
    const units = collectUnits();
    const unit = units.find(candidate => candidate.el === outer)!;
    render(unit, unit.rich!.slots.map(slot => `译:${slot}`), mode);
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { attributes: true, attributeOldValue: true, subtree: true });
    editor.classList.add('cm-content');
    editor.setAttribute('contenteditable', 'true');
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.some(isVisibilityMutation)).toBe(true);
    const delta = mutationIndexDelta(records, units.map(candidate => candidate.el), () => false, (host, box) => host === outer && box.contains(code));
    expect(delta.invalidated).toEqual([outer]);
    restoreUnit(outer);
    const current = collectUnits(outer);
    expect(current.map(candidate => candidate.text).join(' ')).not.toContain('function');
    for (const candidate of current) render(candidate, `译:${candidate.text}`, mode);
    expect(editor.closest('.dual-read-original-hidden')).toBeNull();
    expect(editor.firstChild).toBe(code);
    expect(editor.textContent).toBe('function Example() { return null; }');
    restoreDom();
    expect(outer.childNodes[1]).toBe(editor);
    expect(editor.classList.contains('cm-content')).toBe(true);
  });

  it('does not invalidate adjacent prose on an existing editor animation', () => {
    document.body.innerHTML = '<div id="outer">Read the example below.<div class="cm-editor"><span id="code">function Example() {}</span></div></div>';
    const host = document.getElementById('outer')!;
    const code = document.getElementById('code')!;
    const unit = collectUnits().find(candidate => candidate.el === host)!;
    const source = unit.nodes!;
    render(unit, '请阅读下方示例。', 'bilingual');
    const observer = new MutationObserver(() => {});
    observer.observe(code, { attributes: true, attributeOldValue: true });
    code.classList.add('active-line');
    const delta = mutationIndexDelta(observer.takeRecords(), [host], () => false, (_host, box) => source.some(node => box.contains(node)));
    observer.disconnect();
    expect(delta.invalidated).toEqual([]);
  });
});
