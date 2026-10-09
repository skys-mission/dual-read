// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectUnits, mutationIndexDelta } from '../lib/collector';
import { render, restoreDom, restoreUnit } from '../lib/renderer';
import { walkOpenShadowRoots } from '../lib/roots';

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, width: 520, height: 24, right: 520, bottom: 24, toJSON() {},
  } as DOMRect);
});
afterEach(() => { restoreDom(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

function actionFixture(): { action: HTMLElement; before: Text; after: Text; icon: SVGElement; children: Node[] } {
  document.body.innerHTML = '<style>#action { display:inline-flex } #action > svg { width:16px;height:16px }</style><aside><a id="action" href="/sign-in">Continue<svg id="icon"></svg> with your account</a></aside><section id="receiver"></section>';
  const action = document.getElementById('action')!;
  return { action, before: action.firstChild as Text, after: action.lastChild as Text,
    icon: document.getElementById('icon') as unknown as SVGElement, children: Array.from(action.childNodes) };
}

describe('flex flows with independent nodes between text runs', () => {
  it('keeps an intermediate SVG in its original slot and size across repeated bilingual renders', () => {
    const { action, icon, children } = actionFixture();
    const unit = collectUnits().find(candidate => candidate.el === action)!;
    render(unit, '使用您的账户继续', 'bilingual');
    render(unit, '继续使用您的账户', 'bilingual');
    expect(icon.parentElement).toBe(action);
    expect(getComputedStyle(icon).width).toBe('16px');
    expect(getComputedStyle(icon).height).toBe('16px');
    expect(action.querySelectorAll('.dual-read-target')).toHaveLength(1);
    expect(action.lastElementChild!.contains(action.querySelector('.dual-read-target'))).toBe(true);
    restoreDom();
    expect(Array.from(action.childNodes)).toEqual(children);
    restoreDom();
    expect(Array.from(action.childNodes)).toEqual(children);
  });

  it.each(['normal', 'wrap', 'permute-insert', 'split-normalize', 'transfer-delete'] as const)(
    'preserves current nodes, order and edits across %s of separated flows', operation => {
      const { action, icon, before, after, children } = actionFixture();
      const receiver = document.getElementById('receiver')!;
      render(collectUnits().find(unit => unit.el === action)!, '使用您的账户继续', 'bilingual');
      const first = before.parentElement!;
      const last = after.parentElement!;
      expect(first).not.toBe(last);
      expect(icon.parentElement).toBe(action);
      let expected = [...children];
      const wrappers: HTMLElement[] = [];
      if (operation === 'wrap') {
        for (const flow of [first, last]) {
          const wrapper = document.createElement('section');
          flow.replaceWith(wrapper); wrapper.appendChild(flow); wrappers.push(wrapper);
        }
        expected = [wrappers[0], icon, wrappers[1]];
      } else if (operation === 'permute-insert') {
        action.insertBefore(last, first);
        const addition = document.createElement('em'); addition.textContent = 'Page addition';
        action.insertBefore(addition, icon);
        action.setAttribute('href', '/updated');
        expected = [after, before, addition, icon];
      } else if (operation === 'split-normalize') {
        before.data = 'Updated introduction';
        const tail = before.splitText(8);
        first.normalize();
        expect(tail.isConnected).toBe(false);
        after.data = 'Updated conclusion';
      } else if (operation === 'transfer-delete') {
        receiver.append(first, last); action.remove(); expected = [before, after];
      }
      restoreDom();
      expect(Array.from(operation === 'transfer-delete' ? receiver.childNodes : action.childNodes)).toEqual(expected);
      if (operation === 'wrap') {
        expect(Array.from(wrappers[0].childNodes)).toEqual([before]);
        expect(Array.from(wrappers[1].childNodes)).toEqual([after]);
      }
      if (operation === 'permute-insert') expect(action.getAttribute('href')).toBe('/updated');
      if (operation === 'split-normalize') {
        expect(before.data).toBe('Updated introduction'); expect(after.data).toBe('Updated conclusion');
      }
      expect(document.querySelector('.dual-read-flow,.dual-read-target')).toBeNull();
      expect(icon.isConnected).toBe(operation !== 'transfer-delete');
      restoreDom();
      expect(Array.from(operation === 'transfer-delete' ? receiver.childNodes : action.childNodes)).toEqual(expected);
      if (operation !== 'transfer-delete') {
        render(collectUnits().find(unit => unit.el === action)!, '替换模式回归', 'replace'); restoreDom();
        expect(Array.from(action.childNodes)).toEqual(expected);
      }
    },
  );

  it.each(['pre', 'button', 'img'] as const)('keeps intermediate %s layout and code outside source flows', tag => {
    const middle = tag === 'img' ? '<img id="middle" alt="Diagram">'
      : tag === 'pre' ? '<pre id="middle"><span>function Example() {}</span></pre>' : '<button id="middle">Run example</button>';
    document.body.innerHTML = `<style>#row { display:flex } #row > #middle { width:80px }</style><ul><li id="row">Read the example.${middle} Continue reading.</li></ul>`;
    const row = document.getElementById('row')!;
    const node = document.getElementById('middle')!;
    const children = Array.from(row.childNodes);
    const middleChildren = Array.from(node.childNodes);
    const unit = collectUnits().find(candidate => candidate.el === row)!;
    render(unit, '阅读示例，然后继续。', 'bilingual');
    expect(node.parentElement).toBe(row);
    expect(getComputedStyle(node).width).toBe('80px');
    expect(Array.from(node.childNodes)).toEqual(middleChildren);
    restoreDom();
    expect(Array.from(row.childNodes)).toEqual(children);
  });
});

describe('dynamic code classification across composed ancestry', () => {
  it.each(['bilingual', 'replace'] as const)(
    'removes translated code after shadow-host hydration in %s while retaining independent prose', mode => {
      document.body.innerHTML = '<main><code-widget id="widget"></code-widget><p id="other">Independent page documentation.</p></main>';
      const widget = document.getElementById('widget')!;
      const outer = widget.attachShadow({ mode: 'open' });
      outer.innerHTML = '<nested-code></nested-code>';
      const inner = outer.querySelector('nested-code')!.attachShadow({ mode: 'open' });
      inner.innerHTML = '<p id="code">function Example() { return null; }</p>';
      const host = inner.querySelector<HTMLElement>('p')!;
      const original = host.firstChild!;
      const units = [collectUnits(), ...walkOpenShadowRoots(document).map(root => collectUnits(root))].flat();
      for (const unit of units) render(unit, `译:${unit.text}`, mode);
      const observer = new MutationObserver(() => {});
      observer.observe(widget, { attributes: true, attributeOldValue: true });
      widget.className = 'cm-editor';
      const delta = mutationIndexDelta(observer.takeRecords(), units.map(unit => unit.el), () => false);
      observer.disconnect();
      expect(delta.invalidated).toEqual([host]);
      for (const node of delta.invalidated) restoreUnit(node);
      expect(host.firstChild).toBe(original);
      expect(host.textContent).toBe('function Example() { return null; }');
      expect(host.querySelector('.dual-read-target,.dual-read-original-hidden')).toBeNull();
      expect(collectUnits(inner)).toEqual([]);
      expect(document.querySelector('#other .dual-read-target')).not.toBeNull();
      restoreDom(); restoreDom();
      expect(host.firstChild).toBe(original);
      expect(widget.className).toBe('cm-editor');
    },
  );

  it.each(['bilingual', 'replace'] as const)('invalidates slotted source only inside the hydrated editor in %s', mode => {
    document.body.innerHTML = '<read-widget id="widget"><p id="code" slot="code">function Slotted() {}</p><p id="prose" slot="prose">Neighboring slotted documentation.</p></read-widget>';
    const widget = document.getElementById('widget')!;
    const shadow = widget.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div id="editor"><slot name="code"></slot></div><slot name="prose"></slot>';
    const editor = shadow.querySelector<HTMLElement>('#editor')!;
    const code = document.getElementById('code')!;
    const original = code.firstChild!;
    const units = collectUnits();
    for (const unit of units) render(unit, `译:${unit.text}`, mode);
    const observer = new MutationObserver(() => {});
    observer.observe(editor, { attributes: true, attributeOldValue: true });
    editor.className = 'cm-editor';
    const delta = mutationIndexDelta(observer.takeRecords(), units.map(unit => unit.el), () => false);
    observer.disconnect();
    expect(delta.invalidated).toEqual([code]);
    restoreUnit(code);
    expect(code.firstChild).toBe(original);
    expect(code.closest('.dual-read-original-hidden')).toBeNull();
    expect(collectUnits(code)).toEqual([]);
    expect(document.querySelector('#prose .dual-read-target')).not.toBeNull();
    expect(shadow.querySelector<HTMLSlotElement>('slot[name="code"]')!.assignedElements()).toEqual([code]);
    restoreDom();
    expect(code.firstChild).toBe(original);
  });
});
