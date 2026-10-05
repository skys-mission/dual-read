// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSlotTextNodes, collectUnits, collectUnitsAsync, extractRichSlots } from '../lib/collector';
import { buildSafeRichSkeleton, render, restoreDom } from '../lib/renderer';

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
