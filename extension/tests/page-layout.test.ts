// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSlotTextNodes, collectUnits, collectUnitsAsync, extractRichSlots } from '../lib/collector';
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

describe('generic page layout collection', () => {
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

  it.each([
    'aria-hidden="true"',
    'hidden',
    'style="display:none"',
    'style="visibility:hidden"',
    'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)"',
    'style="position:fixed;width:1px;height:1px;overflow:clip;clip-path:inset(50%)"',
  ])('keeps source/skeleton slots aligned around hidden text: %s', hidden => {
    document.body.innerHTML = `<p id="prose">Read <a href="/guide">the guide</a><span ${hidden}>Hidden helper</span> carefully.</p>`;
    const host = document.getElementById('prose')!;
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

describe('nested captions next to media', () => {
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
