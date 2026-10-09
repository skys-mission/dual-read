// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectMutationRoots, collectSlotTextNodes, collectUnits, collectUnitsAsync, extractRichSlots, isVisibilityMutation, mutationHasNewContent, mutationIndexDelta } from '../lib/collector';
import { buildSafeRichSkeleton, clearNode, render, restoreDom, restoreUnit } from '../lib/renderer';

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 24,
    width: 200, height: 24, toJSON() {},
  } as DOMRect);
});
afterEach(() => {
  restoreDom();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mockSourceLines(read: (node: Node) => DOMRect[]): void {
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = create();
    Object.defineProperty(range, 'getClientRects', {value: () => read(range.startContainer)});
    return range;
  });
}
const sourceLine = (left: number): DOMRect => new DOMRect(left, 0, 160, 18);

describe('generic page layout collection', () => {
  it.each(['absolute','fixed'])('retains a visible %s paragraph escaping a zero-sized clipping ancestor', position => {
    document.body.innerHTML = `<main style="position:relative"><section style="height:0;width:120px;overflow:hidden"><p id="visible" style="position:${position};left:300px">Visible zero-box documentation.</p><p id="clipped">Hidden zero-box documentation.</p></section></main>`;
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible zero-box documentation.']);
    expect(collectSlotTextNodes(document.body).map(node => node.data)).toEqual(['Visible zero-box documentation.']);
  });

  it.each(['position:relative','transform:translateX(0)','contain:paint'])('keeps genuinely clipped positioned text hidden under %s', containing => {
    document.body.innerHTML = `<section style="height:0;overflow:hidden;${containing}"><p style="position:absolute">Hidden containing-box documentation.</p></section>`;
    expect(collectUnits()).toEqual([]);
  });

  it.each(['display:none','visibility:hidden','opacity:0','height:0;overflow:hidden;transform:translateX(0)'])('does not let fixed positioning bypass %s', hiding => {
    document.body.innerHTML = `<section style="${hiding}"><p style="position:fixed">Hidden fixed documentation.</p></section>`;
    expect(collectUnits()).toEqual([]);
  });

  it('collects escaped inline markup at its own painted host in both collection paths while preserving rich slots', async () => {
    document.body.innerHTML = '<p id="wrapper" style="height:0;overflow:hidden"><strong id="floating" style="position:fixed">Visible <em>floating documentation.</em><code>safeFloating()</code></strong>Hidden wrapper documentation.</p>';
    const units = collectUnits();expect(units.map(unit => unit.el.id)).toEqual(['floating']);
    expect(units[0].rich?.slots).toEqual(['Visible','floating documentation.']);
    expect(collectSlotTextNodes(buildSafeRichSkeleton(units[0].el)).map(node => node.data)).toEqual(['Visible ','floating documentation.']);
    const asynchronous = await collectUnitsAsync(document.body,{budgetMs:0.01});
    expect(asynchronous.units.map(unit => unit.el.id)).toEqual(['floating']);
    expect(asynchronous.units[0].rich?.slots).toEqual(['Visible','floating documentation.']);
  });

  it('keeps escaped children independent of an otherwise paintable article ancestor', () => {
    document.body.innerHTML = '<article><div style="height:0;overflow:hidden"><span id="floating" style="position:absolute">Visible escaped label.</span></div></article>';
    expect(collectUnits().map(unit => unit.el.id)).toEqual(['floating']);
  });

  it.each(['absolute', 'fixed'])('retains visible %s text whose containing block lies outside a clipped ancestor', position => {
    document.body.innerHTML = `<main style="position:relative"><section style="overflow:hidden;text-indent:-9999px"><p id="visible" style="position:${position};text-indent:0">Visible positioned documentation.</p><p id="clipped">Clipped source documentation.</p></section></main>`;
    mockSourceLines(node => [sourceLine(node.parentElement?.id === 'visible' ? 400 : -9999)]);
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible positioned documentation.']);
    expect(collectSlotTextNodes(document.body).map(node => node.data)).toEqual(['Visible positioned documentation.']);
  });

  it.each(['absolute', 'fixed'])('keeps %s descendants clipped by a real transform containing block', position => {
    document.body.innerHTML = `<section style="overflow:hidden;text-indent:-9999px;transform:translateX(0)"><p style="position:${position};text-indent:0">Clipped positioned documentation.</p></section>`;
    mockSourceLines(() => [sourceLine(400)]);
    expect(collectUnits()).toEqual([]);
    expect(collectSlotTextNodes(document.body)).toEqual([]);
  });

  // JSDOM drops backdrop-filter; the native matrix covers that containing block.
  it.each(['perspective:1000px', 'translate:0px', 'rotate:0deg', 'scale:1', 'filter:blur(0px)', 'will-change:transform', 'contain:layout', 'contain:paint', 'content-visibility:auto'])('retains the real clipping relationship established by %s', declaration => {
    document.body.innerHTML = `<section style="overflow:hidden;text-indent:-9999px;${declaration}"><p style="position:fixed;text-indent:0">Clipped containing-block documentation.</p></section>`;
    mockSourceLines(() => [sourceLine(400)]);
    expect(collectUnits()).toEqual([]);
  });

  it('distinguishes an absolute containing block from a relative ancestor of viewport-fixed text', () => {
    document.body.innerHTML = '<section style="position:relative;overflow:hidden;text-indent:-9999px"><p id="absolute" style="position:absolute;text-indent:0">Clipped absolute documentation.</p><p id="fixed" style="position:fixed;text-indent:0">Visible fixed documentation.</p></section>';
    mockSourceLines(() => [sourceLine(400)]);
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible fixed documentation.']);
  });

  it('keeps the clipping ancestor above an absolute containing block while discarding only intervening clips', () => {
    document.body.innerHTML = '<section style="overflow:hidden;text-indent:-9999px"><div style="position:relative"><div style="overflow:hidden"><p style="position:absolute;text-indent:0">Clipped outer documentation.</p></div></div></section>';
    mockSourceLines(() => [sourceLine(400)]);
    expect(collectUnits()).toEqual([]);
  });

  it('follows a positioned source through shadow and assigned-slot ancestry', () => {
    document.body.innerHTML = '<x-copy id="component"><p id="visible" style="position:fixed;text-indent:0">Visible slotted documentation.</p></x-copy>';
    const root = document.getElementById('component')!.attachShadow({mode:'open'});
    root.innerHTML = '<section style="overflow:hidden;text-indent:-9999px"><slot></slot></section>';
    mockSourceLines(() => [sourceLine(400)]);
    expect(collectUnits(document.getElementById('component')!).map(unit => unit.text)).toEqual(['Visible slotted documentation.']);
  });

  it('retains a visible child that resets ancestor indent while pruning its clipped sibling', () => {
    document.body.innerHTML = '<section style="overflow-x:hidden;text-indent:-9999px"><p id="visible" style="text-indent:0">Visible child documentation.</p><p id="clipped">Clipped sibling documentation.</p></section>';
    mockSourceLines(node => [sourceLine(node.parentElement?.id === 'visible' ? 8 : -9999)]);
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible child documentation.']);
    expect(collectSlotTextNodes(document.body).map(node => node.data)).toEqual(['Visible child documentation.']);
  });

  it('keeps source and safe skeleton slots aligned when only one rich text run escapes the indent', () => {
    document.body.innerHTML = '<p id="prose" style="overflow-x:hidden;text-indent:-9999px">Clipped source <strong id="visible" style="display:block;text-indent:0">Visible rich documentation.</strong><code>createRoot()</code></p>';
    mockSourceLines(node => [sourceLine(node.parentElement?.id === 'visible' ? 8 : -9999)]);
    const host = document.getElementById('prose')!;
    expect(extractRichSlots(host)).toEqual(['Visible rich documentation.']);
    expect(collectSlotTextNodes(buildSafeRichSkeleton(host)).map(node => node.data)).toEqual(['Visible rich documentation.']);
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible rich documentation.']);
  });

  it('retains later visible lines even when the first source line is indented outside the clip', () => {
    document.body.innerHTML = '<p style="overflow-x:hidden;text-indent:-9999px">First and later documentation lines.</p>';
    mockSourceLines(() => [sourceLine(-9999), sourceLine(8)]);
    expect(collectUnits().map(unit => unit.text)).toEqual(['First and later documentation lines.']);
  });

  it('does not infer hidden text when line geometry is unavailable', () => {
    document.body.innerHTML = '<p style="overflow-x:hidden;text-indent:-9999px">Unmeasured documentation.</p>';
    expect(collectUnits().map(unit => unit.text)).toEqual(['Unmeasured documentation.']);
  });
  it.each(['block', 'inline-block', 'table-cell'])('keeps a visible padded zero-content-height %s in collection', display => {
    document.body.innerHTML = `<main><p id="padded" style="display:${display};box-sizing:content-box;height:0;padding:24px;overflow:hidden">Visible padded documentation.</p><p style="height:0;border-block:24px solid;overflow:hidden">Hidden border-only documentation.</p></main>`;
    expect(collectUnits().map(unit => unit.text)).toEqual(['Visible padded documentation.']);
    expect(collectSlotTextNodes(document.getElementById('padded')!).map(node => node.data)).toEqual(['Visible padded documentation.']);
  });

  it('recognizes padding-only reveals without changing the content height', () => {
    document.body.innerHTML = '<section id="box" style="height:0;padding:0;overflow:hidden"><p>Padding-revealed documentation.</p></section>';
    const box = document.getElementById('box')!;
    expect(collectUnits()).toEqual([]);
    const observer = new MutationObserver(() => {}); observer.observe(box, {attributes:true, attributeOldValue:true});
    box.style.padding = '24px';
    expect(observer.takeRecords().some(isVisibilityMutation)).toBe(true); observer.disconnect();
    expect(collectUnits().map(unit => unit.text)).toEqual(['Padding-revealed documentation.']);
    box.style.padding = '0px'; expect(collectUnits()).toEqual([]);
  });

  it.each(['inline', 'contents'])('collects visible text through a %s wrapper that does not create a clipping box', display => {
    for (const declaration of ['height:0;width:300px;overflow:hidden', 'width:0;height:40px;overflow:clip', 'overflow-x:hidden;text-indent:-9999px']) {
      const text = display === 'contents' ? '<span>the installation documentation</span>' : 'the installation documentation';
      document.body.innerHTML = `<p id="prose">Read <span style="display:${display};${declaration}">${text}</span> carefully.</p>`;
      const units = collectUnits();
      expect(units.map(unit => unit.text)).toEqual(['Read the installation documentation carefully.']);
      expect(collectSlotTextNodes(document.getElementById('prose')!).map(node => node.data)).toEqual(['Read ', 'the installation documentation', ' carefully.']);
    }
  });

  it('recognizes a variable declaration after a CSS comment without treating a quoted string as a variable', () => {
    document.body.innerHTML = '<section id="box" style="/* layout */ --panel-height:0px;height:var(--panel-height)"></section>';
    const box = document.getElementById('box')!;
    const observer = new MutationObserver(() => {}); observer.observe(box, {attributes:true, attributeOldValue:true});
    box.setAttribute('style', '/* layout */ --panel-height:100px;height:var(--panel-height)');
    expect(observer.takeRecords().some(isVisibilityMutation)).toBe(true);
    box.style.cssText = 'font-family:serif'; observer.takeRecords();
    box.style.fontFamily = '"--quoted-name"';
    expect(observer.takeRecords().some(isVisibilityMutation)).toBe(false); observer.disconnect();
  });

  it.each(['--panel-height', '--PanelHeight'] as const)('recognizes a changed %s input without changing the height declaration', variable => {
    document.body.innerHTML = `<section id="box" style="${variable}:0px;height:var(${variable});overflow:hidden"><p>Documentation revealed by a custom property.</p></section>`;
    const box = document.getElementById('box')!;
    const observer = new MutationObserver(() => {});
    observer.observe(box, {attributes: true, attributeOldValue: true});
    box.style.setProperty(variable, '100px');
    const records = observer.takeRecords(); observer.disconnect();
    expect(records.some(isVisibilityMutation)).toBe(true);
    expect(mutationHasNewContent(records)).toBe(true);
    expect(collectMutationRoots(records)).toEqual([box]);
    expect(box.style.height).toBe(`var(${variable})`);
  });

  it('retains CSS-variable name case in visibility references', () => {
    document.body.innerHTML = '<section id="box" style="--Height:0px;--height:100px;height:var(--Height)"></section>';
    const box = document.getElementById('box')!;
    const observer = new MutationObserver(() => {}); observer.observe(box, {attributes: true, attributeOldValue: true});
    box.style.height = 'var(--height)';
    expect(observer.takeRecords().some(isVisibilityMutation)).toBe(true); observer.disconnect();
  });

  it('continues filtering ordinary transform writes and custom properties on extension chrome', () => {
    document.body.innerHTML = '<section id="box"><span class="dual-read-target" id="target">译文</span></section>';
    const observer = new MutationObserver(() => {}); observer.observe(document.body, {attributes: true, attributeOldValue: true, subtree: true});
    document.getElementById('box')!.style.transform = 'translateX(10px)';
    document.getElementById('target')!.style.setProperty('--page-height', '100px');
    expect(observer.takeRecords().some(isVisibilityMutation)).toBe(false); observer.disconnect();
  });

  it.each([
    ['height:0px;width:300px;overflow:hidden', 'height:100px;width:300px;overflow:hidden'],
    ['width:0px;height:100px;overflow:hidden', 'width:300px;height:100px;overflow:hidden'],
    ['height:0px;width:300px;overflow:hidden', 'height:0px;width:300px;overflow:visible'],
    ['overflow-x:hidden;text-indent:-9999px', 'overflow-x:hidden;text-indent:0px'],
  ])('collects existing prose after a sizing or clipping reveal: %s', (initial, revealed) => {
    document.body.innerHTML = `<section id="box" style="${initial}"><p id="late">Previously clipped documentation.</p></section>`;
    const box = document.getElementById('box')!;
    const source = document.getElementById('late')!.firstChild;
    if (initial.includes('text-indent')) mockSourceLines(() => [sourceLine(-9999)]);
    expect(collectUnits()).toEqual([]);
    const observer = new MutationObserver(() => {});
    observer.observe(box, { attributes: true, attributeOldValue: true });
    box.setAttribute('style', revealed);
    const records = observer.takeRecords(); observer.disconnect();
    expect(mutationHasNewContent(records)).toBe(true);
    expect(mutationIndexDelta(records, []).added.map(unit => unit.text)).toEqual(['Previously clipped documentation.']);
    expect(document.getElementById('late')!.firstChild).toBe(source);
    expect(box.getAttribute('style')).toBe(revealed);
  });

  it.each(['style', 'class', 'hidden', 'aria-hidden'] as const)('discovers existing prose revealed by %s without changing its source', attribute => {
    document.body.innerHTML = '<style>.concealed { opacity:0 }</style><section id="box"><p id="late">Late visible paragraph.</p></section>';
    const box = document.getElementById('box')!;
    const late = document.getElementById('late')!;
    const text = late.firstChild;
    if (attribute === 'style') box.style.opacity = '0';
    if (attribute === 'class') box.className = 'concealed';
    if (attribute === 'hidden') box.hidden = true;
    if (attribute === 'aria-hidden') box.setAttribute('aria-hidden', 'true');
    expect(collectUnits()).toEqual([]);
    const observer = new MutationObserver(() => {});
    observer.observe(box, { attributes: true, attributeOldValue: true });
    if (attribute === 'style') box.style.opacity = '1';
    else box.removeAttribute(attribute);
    const records = observer.takeRecords();
    observer.disconnect();
    expect(mutationHasNewContent(records)).toBe(true);
    expect(collectMutationRoots(records)).toEqual([box]);
    const delta = mutationIndexDelta(records, []);
    expect(delta.added.map(unit => unit.text)).toEqual(['Late visible paragraph.']);
    render(delta.added[0], '稍后显示的正文。', 'bilingual');
    restoreDom();
    expect(late.firstChild).toBe(text);
    expect(late.childNodes).toHaveLength(1);
    expect(box.hasAttribute(attribute)).toBe(attribute === 'style');
  });

  it('drops a hidden source companion while preserving the page visibility change', () => {
    document.body.innerHTML = '<section><p id="source" style="-webkit-line-clamp:2;overflow:hidden">Original clipped paragraph.</p></section>';
    const host = document.getElementById('source')!;
    const text = host.firstChild;
    const unit = collectUnits().find(candidate => candidate.el === host)!;
    render(unit, '原始正文的译文。', 'bilingual');
    const observer = new MutationObserver(() => {});
    observer.observe(host, { attributes: true, attributeOldValue: true });
    host.style.opacity = '0';
    const delta = mutationIndexDelta(observer.takeRecords(), [host], () => false);
    observer.disconnect();
    expect(delta.invalidated).toEqual([host]);
    restoreUnit(host);
    expect(host.firstChild).toBe(text);
    expect(host.style.opacity).toBe('0');
    expect(document.querySelector('.dual-read-target')).toBeNull();
  });

  it('ignores transform animation and companion style writes when finding new content', () => {
    document.body.innerHTML = '<p id="source" style="opacity:1;transform:translateX(1px)">Original paragraph.</p>';
    const host = document.getElementById('source')!;
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { attributes: true, attributeOldValue: true, subtree: true });
    host.style.transform = 'translateX(2px)';
    expect(mutationHasNewContent(observer.takeRecords())).toBe(false);
    render(collectUnits()[0], '原始正文。', 'bilingual');
    observer.takeRecords();
    host.querySelector<HTMLElement>('.dual-read-target')!.style.opacity = '0.5';
    expect(mutationHasNewContent(observer.takeRecords())).toBe(false);
    observer.disconnect();
  });

  it.each(['a', 'span'])('gives ellipsized prose a wrapping row without treating it as a control: %s', tag => {
    document.body.innerHTML = `<div style="width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><${tag} id="excerpt" ${tag === 'a' ? 'href="/change"' : ''} style="white-space:nowrap">A useful description of the latest change</${tag}></div>`;
    const host = document.getElementById('excerpt')!;
    const original = host.firstChild;
    const unit = collectUnits().find(candidate => candidate.el === host || candidate.el.contains(host))!;
    expect(unit.kind).toBe('block');
    render(unit, '最新变更的说明应在独立的一行中完整显示。', 'bilingual');
    const target = unit.el.querySelector<HTMLElement>('.dual-read-target')!;
    expect(target.style.whiteSpace).toBe('normal');
    expect(target.style.overflowWrap).toBe('anywhere');
    expect(host.hasAttribute('data-dual-read-nowrap')).toBe(false);
    restoreDom();
    expect(host.firstChild).toBe(original);
    expect(host.childNodes).toHaveLength(1);
  });

  it('keeps ellipsized semantic actions on the control path', () => {
    document.body.innerHTML = '<button style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span id="label">Continue with your account</span></button>';
    expect(collectUnits().find(unit => unit.text === 'Continue with your account')?.kind).toBe('inner');
  });

  it('excludes unslotted light DOM while retaining assigned text and visible shadow prose', () => {
    const host = document.createElement('div');
    host.innerHTML = '<span>Fallback calendar date</span>';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Visible relative time</p>';
    expect(collectUnits().map(unit => unit.text)).not.toContain('Fallback calendar date');
    expect(collectUnits(shadow).map(unit => unit.text)).toContain('Visible relative time');
    shadow.innerHTML = '<slot><span>Hidden slot fallback</span></slot><p>Visible relative time</p>';
    expect(collectUnits().map(unit => unit.text)).toContain('Fallback calendar date');
    expect(collectUnits(shadow).map(unit => unit.text)).not.toContain('Hidden slot fallback');
    host.setAttribute('aria-hidden', 'true');
    expect(collectUnits(shadow)).toEqual([]);
  });

  it('keeps unslotted direct text out of source and safe skeleton slots', () => {
    document.body.innerHTML = '<p id="prose">Updated <span id="time">Fallback date</span> with <a href="/details">details</a>.</p>';
    document.getElementById('time')!.attachShadow({ mode: 'open' }).innerHTML = '<span>Relative time</span>';
    const host = document.getElementById('prose')!;
    expect(extractRichSlots(host)).toEqual(['Updated', 'with', 'details', '.']);
    expect(collectSlotTextNodes(buildSafeRichSkeleton(host)).map(node => node.nodeValue!.trim())).toEqual(['Updated', 'with', 'details', '.']);
  });

  it.each(['bilingual', 'replace'] as const)('keeps shadow prose visible beside independently translated light DOM: %s', mode => {
    document.body.innerHTML = '<main><div id="container"><read-widget></read-widget><div id="feedback">Share your feedback and <a href="/feedback">read more</a>.</div></div></main>';
    const container = document.getElementById('container')!;
    const component = container.querySelector('read-widget')!;
    const shadow = component.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<h1>Documentation</h1><p>Independent documentation paragraph.</p>';
    const paragraph = shadow.querySelector('p')!;
    const original = paragraph.firstChild;
    const children = Array.from(container.childNodes);
    const lightUnits = collectUnits();
    expect(lightUnits.some(unit => unit.el === container)).toBe(false);
    for (const unit of [...lightUnits, ...collectUnits(shadow)]) render(unit, '这段正文的译文。', mode);
    expect(component.parentElement).toBe(container);
    expect(component.closest('.dual-read-original-hidden')).toBeNull();
    expect(shadow.querySelector('.dual-read-target, .dual-read-replace-text')).not.toBeNull();
    expect(paragraph.closest('.dual-read-original-hidden')).toBeNull();
    restoreDom();
    expect(Array.from(container.childNodes)).toEqual(children);
    expect(paragraph.firstChild).toBe(original);
    expect(paragraph.textContent).toBe('Independent documentation paragraph.');
  });

  it.each(['bilingual', 'replace'] as const)('retains slot assignment when translating neighboring shadow text: %s', mode => {
    const component = document.createElement('read-widget');
    component.innerHTML = '<p slot="body">Assigned documentation paragraph.</p>';
    document.body.appendChild(component);
    const paragraph = component.querySelector('p')!;
    const original = paragraph.firstChild;
    const shadow = component.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div><span>Documentation heading</span><slot name="body"></slot></div>';
    const slot = shadow.querySelector('slot')!;
    for (const unit of [...collectUnits(), ...collectUnits(shadow)]) render(unit, '这段正文的译文。', mode);
    expect(slot.closest('.dual-read-original-hidden')).toBeNull();
    expect(slot.assignedElements()).toEqual([paragraph]);
    restoreDom();
    expect(slot.assignedElements()).toEqual([paragraph]);
    expect(paragraph.firstChild).toBe(original);
    expect(paragraph.textContent).toBe('Assigned documentation paragraph.');
  });

  it.each([
    'aria-hidden="true"',
    'hidden',
    'style="display:none"',
    'style="visibility:hidden"',
    'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)"',
    'style="position:fixed;width:1px;height:1px;overflow:clip;clip-path:inset(50%)"',
    'style="position:absolute;width:1px;height:1px;overflow:hidden;left:-1px;top:-1px"',
    'style="display:inline-block;width:1px;height:44px;overflow:hidden"',
    'style="display:block;width:80px;height:1px;overflow:hidden"',
    'style="display:block;overflow-x:hidden;text-indent:-9999px"',
  ])('keeps source/skeleton slots aligned around hidden text: %s', hidden => {
    document.body.innerHTML = `<p id="prose">Read <a href="/guide">the guide</a><span ${hidden}>Hidden helper</span> carefully.</p>`;
    const host = document.getElementById('prose')!;
    if (hidden.includes('text-indent')) mockSourceLines(() => [sourceLine(-9999)]);
    expect(extractRichSlots(host)).toEqual(['Read', 'the guide', 'carefully.']);
    const skeleton = buildSafeRichSkeleton(host);
    expect(collectSlotTextNodes(skeleton).map(node => node.nodeValue!.trim())).toEqual(['Read', 'the guide', 'carefully.']);
    expect(host.textContent).toContain('Hidden helper');
  });

  it('does not turn hidden tooltip labels into a visible rich companion', async () => {
    document.body.innerHTML = '<div id="tools"><a href="/issues"><svg aria-hidden="true"></svg></a><span aria-hidden="true" popover>All issues</span><a href="/reviews"><svg aria-hidden="true"></svg></a><span hidden>All reviews</span></div>';
    expect(collectUnits()).toEqual([]);
    expect((await collectUnitsAsync()).units).toEqual([]);
  });

  it.each(['button', 'div role="button"'])(
    'keeps nested labels owned by individual controls: %s', control => {
      const tag = control.split(' ')[0];
      document.body.innerHTML = `<div id="tools"><${control}><span id="save" style="display:block">Save changes</span></${tag}><${control}><span id="close" style="display:block">Close panel</span></${tag}></div>`;
      const units = collectUnits();
      expect(units.map(unit => unit.text)).toEqual(['Save changes', 'Close panel']);
      for (const unit of units) {
        expect(unit.kind).toBe('inner');
        render(unit, unit.text === 'Save changes' ? '保存更改' : '关闭面板', 'bilingual');
        expect(unit.el.closest('button, [role="button"]')!.querySelector('.dual-read-target')).toBeTruthy();
      }
      expect(document.querySelector('#tools > .dual-read-target')).toBeNull();
    },
  );

  it('places structured cell companions outside the source clipping box', () => {
    document.body.innerHTML = '<table><tbody><tr><td id="cell"><div style="overflow:hidden;white-space:nowrap"><a href="/change">A short change description</a></div></td><td>Ready</td></tr></tbody></table>';
    const cell = document.getElementById('cell')!;
    const unit = collectUnits().find(candidate => candidate.el === cell)!;
    expect(unit.kind).toBe('block');
    render(unit, ['这是一段较长的变更说明。'], 'bilingual');
    expect(cell.querySelector(':scope > .dual-read-target')).toBeTruthy();
    expect(cell.querySelector('div > a > .dual-read-target')).toBeNull();
    expect(collectUnits().find(candidate => candidate.text === 'Ready')?.kind).toBe('inline');
  });

  it.each(['<figure><figcaption id="caption">Photo credit</figcaption></figure>', '<table><caption id="caption">Results table</caption><tbody><tr><td>Ready</td></tr></tbody></table>'])(
    'gives short semantic captions a separate translation line', markup => {
      document.body.innerHTML = markup;
      expect(collectUnits().find(unit => unit.el.id === 'caption')?.kind).toBe('block');
    },
  );
});

describe('flat flex control ordering', () => {
  it.each(['bilingual', 'replace'] as const)('retains flat control text before a trailing icon after restore: %s', mode => {
    document.body.innerHTML = '<aside><a id="control" href="/console" style="display:inline-flex"><svg id="lead" aria-hidden="true"></svg>Developer Console<svg id="tail" aria-hidden="true"></svg></a></aside>';
    const control = document.getElementById('control')!;
    const children = Array.from(control.childNodes);
    const unit = collectUnits().find(candidate => candidate.el === control)!;
    render(unit, '开发者控制台', mode);
    restoreDom();
    expect(Array.from(control.childNodes)).toEqual(children);
    expect(control.textContent).toBe('Developer Console');
    expect(control.getAttribute('href')).toBe('/console');
    render(collectUnits().find(candidate => candidate.el === control)!, '开发者控制台', mode === 'bilingual' ? 'replace' : 'bilingual');
    restoreDom();
    expect(Array.from(control.childNodes)).toEqual(children);
  });
});

describe('nested text replacement restoration', () => {
  it.each(['parent-first', 'cloned-host', 'cloned-visible'] as const)(
    'preserves current source nodes and edits when restoring %s', scenario => {
      document.body.innerHTML = '<div id="card">Product details. <a id="action" href="/details">Learn more</a></div>';
      const card = document.getElementById('card')!;
      let action = document.getElementById('action')!;
      const original = action.firstChild as Text;
      render({ el: action, text: original.data, kind: 'inner', ...(scenario === 'cloned-visible' ? { segment: true, nodes: [original] } : {}) }, '了解更多', 'replace');
      if (scenario === 'parent-first') {
        render({ el: card, text: 'Product details.', kind: 'inner' }, '产品详情。', 'replace');
      } else {
        const clone = action.cloneNode(true) as HTMLElement;
        action.replaceWith(clone);
        action = clone;
      }
      const stash = action.querySelector('.dual-read-original-hidden')!;
      const source = stash.firstChild as Text;
      if (scenario === 'parent-first') expect(source).toBe(original);
      source.data = 'Updated details';
      const tail = source.splitText(7);
      const addition = document.createElement('em');
      addition.textContent = ' by the page';
      stash.appendChild(addition);
      action.setAttribute('href', '/updated');
      restoreDom();
      expect(Array.from(action.childNodes)).toEqual([source, tail, addition]);
      expect(action.textContent).toBe('Updated details by the page');
      expect(action.getAttribute('href')).toBe('/updated');
      expect(document.querySelector('.dual-read-original-hidden, .dual-read-replace-text')).toBeNull();
      restoreDom();
      expect(Array.from(action.childNodes)).toEqual([source, tail, addition]);
    },
  );
});

describe('nested captions next to media', () => {
  it.each([
    '<figure><a href="/photo"><img alt="Landscape"></a><div id="caption" style="display:block">Photo of the mountain range</div></figure>',
    '<p><img alt="Landscape"><span id="caption" style="display:block">Photo of the mountain range</span></p>',
    '<p id="caption"><img alt="Landscape">Photo of the mountain range</p>',
  ])('gives a plain block caption its own translation row: %s', markup => {
    document.body.innerHTML = markup;
    const caption = document.getElementById('caption')!;
    const originalChildren = Array.from(caption.childNodes);
    const unit = collectUnits().find(candidate => candidate.el === caption)!;
    expect(unit.kind).toBe('block');
    render(unit, '山脉景观照片与相关说明', 'bilingual');
    expect(caption.querySelector(':scope > .dual-read-target--inner')).toBeNull();
    expect(caption.querySelector(':scope > .dual-read-target')).toBeTruthy();
    restoreDom();
    expect(Array.from(caption.childNodes)).toEqual(originalChildren);
  });

  it('keeps inline credit labels and nested controls compact next to media', () => {
    document.body.innerHTML = '<p><img alt="Landscape"><span id="credit">Photo credit</span><button><span id="download">Download photo</span></button></p>';
    const units = collectUnits();
    expect(['inline', 'inner']).toContain(units.find(unit => unit.el.id === 'credit')?.kind);
    expect(units.find(unit => unit.text === 'Download photo')?.kind).toBe('inner');
    expect(units.some(unit => unit.text.includes('Photo credit Download'))).toBe(false);
  });

  it.each(['bilingual', 'replace'] as const)('keeps links, code and page edits in order through %s restoration', mode => {
    document.body.innerHTML = '<p id="media"><img alt="Artwork"><br><em id="caption">Image by <a href="/author">Ada</a>, shared under <a href="/license">a license</a>, using <code>SVG</code>.</em></p>';
    const caption = document.getElementById('caption')!;
    const originalChildren = Array.from(caption.childNodes);
    const author = caption.querySelector('a')!;
    const license = caption.querySelectorAll('a')[1];
    const leadingText = caption.firstChild as Text;
    const units = collectUnits();
    const unit = units.find(candidate => candidate.el === caption)!;
    expect(unit.kind).toBe('block');
    expect(unit.rich?.slots).toEqual(['Image by', 'Ada', ', shared under', 'a license', ', using', '.']);
    expect(units.filter(candidate => caption.contains(candidate.el))).toHaveLength(1);
    render(unit, ['图片由', 'Ada', '提供，采用', '许可协议', '，使用', '。'], mode);

    const companion = mode === 'bilingual' ? caption.querySelector('.dual-read-target')! : caption;
    const translatedLinks = Array.from(companion.querySelectorAll('a')).filter(link => !link.closest('.dual-read-original-hidden'));
    expect(translatedLinks.map(link => link.getAttribute('href'))).toEqual(['/author', '/license']);
    expect(companion.textContent).toContain('Ada');
    expect(companion.querySelector('code')?.textContent).toBe('SVG');
    restoreDom();
    expect(Array.from(caption.childNodes)).toEqual(originalChildren);
    expect(caption.firstChild).toBe(leadingText);
    expect(caption.querySelectorAll('a')[0]).toBe(author);
    expect(caption.querySelectorAll('a')[1]).toBe(license);
    expect(caption.textContent).toBe('Image by Ada, shared under a license, using SVG.');

    // Expectations come from page operations after restoration, independent of
    // matching helpers. Re-collection must keep those edits on the same nodes.
    author.textContent = 'Grace';
    author.setAttribute('href', '/grace');
    caption.insertBefore(license, author);
    const editedChildren = Array.from(caption.childNodes);
    const editedText = caption.textContent;
    const next = collectUnits().find(candidate => candidate.el === caption)!;
    render(next, next.rich!.slots.map(text => `译:${text}`), mode);
    restoreDom();
    restoreDom();
    expect(Array.from(caption.childNodes)).toEqual(editedChildren);
    expect(caption.textContent).toBe(editedText);
    expect(author.getAttribute('href')).toBe('/grace');
  });
});

describe('generic feed and action layout', () => {
  it.each(['bilingual', 'replace'] as const)('preserves icon-row prose and page edits through %s restoration', mode => {
    document.body.innerHTML = '<ul><li id="row" style="display:flex;flex-wrap:nowrap"><svg id="icon" aria-hidden="true"></svg>Read <a id="reference" href="/guide">the guide</a><svg id="tail" aria-hidden="true"></svg></li></ul><section id="receiver"></section>';
    const row = document.getElementById('row')!;
    const icon = document.getElementById('icon')!;
    const tail = document.getElementById('tail')!;
    const reference = document.getElementById('reference')!;
    const sourceText = row.childNodes[1] as Text;
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, ['阅读', '指南'], mode);
    if (mode === 'bilingual') {
      expect(reference.parentElement).toBe(row);
      expect(row.querySelector(':scope > .dual-read-target--break')).toBeTruthy();
      expect(row.firstChild).toBe(icon);
      expect(tail.parentElement).toBe(row);
    }
    sourceText.nodeValue = 'Edited introduction ';
    reference.setAttribute('href', '/edited-guide');
    document.getElementById('receiver')!.appendChild(reference);
    tail.remove();
    const added = document.createElement('strong');
    added.textContent = 'Added detail.';
    sourceText.parentNode!.appendChild(added);
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual([icon, sourceText, added]);
    expect(row.textContent).toBe('Edited introduction Added detail.');
    expect(reference.parentElement?.id).toBe('receiver');
    expect(reference.getAttribute('href')).toBe('/edited-guide');
    expect(tail.isConnected).toBe(false);
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual([icon, sourceText, added]);
  });

  it('keeps centered flex actions and their nested labels compact without button classes', () => {
    document.body.innerHTML = '<a id="action" href="/continue" style="display:flex;align-items:center;justify-content:center"><span style="display:flex;width:100%"><svg aria-hidden="true"></svg><span id="label">Continue with phone</span></span></a>';
    const action = document.getElementById('action')!;
    const label = document.getElementById('label')!;
    const children = Array.from(action.childNodes);
    const units = collectUnits();
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe('inner');
    render(units[0], '使用手机号继续', 'bilingual');
    expect(label.querySelector('.dual-read-target--inner')).toBeTruthy();
    expect(action.querySelector('.dual-read-target--break')).toBeNull();
    expect(action.hasAttribute('data-dual-read-nowrap')).toBe(false);
    restoreDom();
    expect(Array.from(action.childNodes)).toEqual(children);
    expect(label.textContent).toBe('Continue with phone');
  });

  it('recognizes blockified flex metadata inside a nowrap row without treating prose cards as controls', () => {
    document.body.innerHTML = '<div style="display:flex"><span style="display:flex;white-space:nowrap"><a id="time" href="/post" style="display:flex;white-space:pre-wrap">3h</a></span></div><a id="card" href="/article" style="display:flex;flex-direction:column;align-items:center;justify-content:center">A useful article title</a>';
    const byId = new Map(collectUnits().map(unit => [unit.el.id, unit]));
    expect(byId.get('time')?.kind).toBe('inner');
    expect(byId.get('card')?.kind).toBe('block');
    render(byId.get('time')!, '3 小时', 'bilingual');
    expect(document.querySelector('#time .dual-read-flow .dual-read-target--inner')).toBeTruthy();
  });

  it.each(['pre-wrap', 'pre-line', 'break-spaces'])('preserves visible paragraph breaks for %s prose', whiteSpace => {
    document.body.innerHTML = `<p id="prose" style="white-space:${whiteSpace}">First paragraph.\n\nSecond paragraph.</p><p id="normal">Ordinary\nsource formatting.</p>`;
    const byId = new Map(collectUnits().map(unit => [unit.el.id, unit]));
    expect(byId.get('prose')?.text).toBe('First paragraph.\n\nSecond paragraph.');
    expect(byId.get('normal')?.text).toBe('Ordinary source formatting.');
  });

  it.each(['bilingual', 'replace'] as const)('preserves clipped source nodes and edits across %s restoration', mode => {
    document.body.innerHTML = '<section id="card"><div id="clip" style="display:-webkit-box;-webkit-line-clamp:3;overflow:hidden"><span id="prose">A quoted paragraph with enough text to require a block translation, including all the source details that remain clipped by the page.</span></div></section>';
    const card = document.getElementById('card')!;
    const clip = document.getElementById('clip')!;
    const prose = document.getElementById('prose')!;
    const source = prose.firstChild!;
    const style = clip.getAttribute('style');
    const unit = collectUnits().find(candidate => candidate.el === prose)!;
    render(unit, '引用正文的译文需要在截断区域外完整显示。', mode);
    if (mode === 'bilingual') {
      const target = card.querySelector(':scope > .dual-read-target')!;
      expect(target).toBeTruthy();
      expect(clip.nextElementSibling).toBe(target);
      expect(prose.querySelector('.dual-read-target')).toBeNull();
      clearNode(prose);
      expect(card.querySelector('.dual-read-target')).toBeNull();
      render(unit, '更新后的引用译文。', mode);
    }
    source.nodeValue = 'Edited quoted source.';
    const extra = document.createElement('em');
    extra.textContent = ' Added detail.';
    prose.appendChild(extra);
    restoreUnit(prose);
    expect(Array.from(prose.childNodes)).toEqual([source, extra]);
    expect(prose.textContent).toBe('Edited quoted source. Added detail.');
    expect(clip.getAttribute('style')).toBe(style);
    expect(card.querySelector('.dual-read-target')).toBeNull();
    restoreDom();
    expect(prose.firstChild).toBe(source);
  });

  it('removes detached-source companions while retaining neighboring card content', () => {
    document.body.innerHTML = '<section id="card"><p id="clip" style="-webkit-line-clamp:2;overflow:hidden">A sufficiently long source paragraph whose translation is outside the clipping box, with more details for the reader.</p><p id="neighbor">Neighboring content.</p></section>';
    const clip = document.getElementById('clip')!;
    const neighbor = document.getElementById('neighbor')!;
    render(collectUnits().find(unit => unit.el === clip)!, '完整的引用译文。', 'bilingual');
    expect(clip.nextElementSibling?.classList.contains('dual-read-target')).toBe(true);
    clip.remove();
    restoreDom();
    expect(Array.from(document.getElementById('card')!.children)).toEqual([neighbor]);
    expect(neighbor.textContent).toBe('Neighboring content.');
  });

  it('keeps multiple translations in source order outside nested line clamps', () => {
    document.body.innerHTML = '<section><div id="outer" style="-webkit-line-clamp:5;overflow:hidden"><div style="-webkit-line-clamp:3;overflow:hidden"><span id="first">First quoted paragraph.</span><span id="second">Second quoted paragraph.</span></div></div></section>';
    const outer = document.getElementById('outer')!;
    const first = document.getElementById('first')!;
    const second = document.getElementById('second')!;
    const firstNode = first.firstChild;
    const secondNode = second.firstChild;
    const units = [first, second].map(el => ({ el, text: el.textContent!, kind: 'block' as const }));
    // Reverse response order must not reverse the paragraph order on screen.
    render(units[1], '第二段引用译文。', 'bilingual');
    render(units[0], '第一段引用译文。', 'bilingual');
    expect(outer.nextElementSibling?.textContent).toBe('第一段引用译文。');
    expect(outer.nextElementSibling?.nextElementSibling?.textContent).toBe('第二段引用译文。');
    clearNode(first);
    render(units[0], '第一段的新译文。', 'bilingual');
    expect(outer.nextElementSibling?.textContent).toBe('第一段的新译文。');
    restoreDom();
    expect(first.firstChild).toBe(firstNode);
    expect(second.firstChild).toBe(secondNode);
    expect(outer.nextElementSibling).toBeNull();
  });

  it('retains a nested mount when an outside companion would become a sideways flex item', () => {
    document.body.innerHTML = '<section style="display:flex;flex-direction:row"><p id="clip" style="-webkit-line-clamp:2;overflow:hidden">A long clipped paragraph with useful details that should not force the neighboring horizontal layout to gain another column.</p><button>Next</button></section>';
    const clip = document.getElementById('clip')!;
    render(collectUnits().find(unit => unit.el === clip)!, '正文译文。', 'bilingual');
    expect(clip.querySelector(':scope > .dual-read-target')).toBeTruthy();
    expect(clip.nextElementSibling?.tagName).toBe('BUTTON');
  });
});
