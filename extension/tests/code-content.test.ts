// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectUnits, collectUnitsAsync, collectVisibleTextNodes, extractRichSlots, mutationIndexDelta } from '../lib/collector';
import { render, restoreUnit } from '../lib/renderer';
import { DONE } from '../lib/dom-const';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function visiblePage(html: string): void {
  document.body.innerHTML = html;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: 600, height: 30, top: 0, right: 600, bottom: 30, left: 0,
    toJSON: () => ({}),
  });
}

const snippet = '<div class="cm-line"><span class="sp-syntax-keyword">function</span> <span>Video</span>({ video }) {<br></div><div class="cm-line">  <span>return</span> &lt;Video title="Hello world" /&gt;;</div>';

for (const [name, collect] of [
  ['sync', () => collectUnits()],
  ['cooperative', async () => (await collectUnitsAsync()).units],
] as const) {
  describe(`code boundaries during ${name} collection`, () => {
    it.each([
      ['nested pre/code', `<pre><code>${snippet}</code></pre>`],
      ['pre without code', `<pre>${snippet}</pre>`],
      ['block code without pre', `<code style="display:block">${snippet}</code>`],
      ['highlight.js', `<div class="hljs">${snippet}</div>`],
      ['Prism', `<div class="prism-code">${snippet}</div>`],
      ['Shiki', `<div class="shiki">${snippet}</div>`],
      ['CodeMirror 5', `<div class="CodeMirror"><div>${snippet}</div></div>`],
      ['CodeMirror 6', `<div class="cm-editor"><div class="cm-content">${snippet}</div></div>`],
      ['Monaco', `<div class="monaco-editor"><div class="view-lines">${snippet}</div></div>`],
      ['Ace', `<div class="ace_editor"><div class="ace_text-layer">${snippet}</div></div>`],
      ['Sandpack', `<div class="sp-code-editor"><div>${snippet}</div></div>`],
      ['terminal output', `<samp><span>Build completed successfully.</span><br><span>Output saved to dist.</span></samp>`],
    ])('excludes the complete %s subtree without losing adjacent prose', async (_label, code) => {
      visiblePage(`<main><div id="code-only">${code}</div><p id="copy">The example below explains how components work.</p></main>`);
      const units = await collect();
      expect(units.map(unit => unit.text)).toEqual(['The example below explains how components work.']);
      expect(collectVisibleTextNodes(document.querySelector('#code-only')!)).toEqual([]);
    });

    it('keeps an inline machine token out of rich translation slots', async () => {
      visiblePage('<p>Call <code><span>createRoot</span>(<var><span>container</span></var>)</code> to render <a href="/docs">the component</a>.</p>');
      const [unit] = await collect();
      expect(unit.rich?.slots).toEqual(['Call', 'to render', 'the component', '.']);
      expect(extractRichSlots(unit.el)).toEqual(unit.rich?.slots);
      expect(unit.text).not.toContain('createRoot');
    });

    it('continues collecting monospace prose, pre-wrapped paragraphs and ordinary highlights', async () => {
      visiblePage('<p style="font-family:monospace;white-space:pre-wrap">This function explains the role of the software.\nIt is ordinary documentation.</p><p><span class="highlight">An important explanation</span> follows here.</p>');
      const units = await collect();
      expect(units).toHaveLength(2);
      expect(units.map(unit => unit.text).join(' ')).toContain('This function explains');
      expect(units.map(unit => unit.text).join(' ')).toContain('An important explanation');
    });
  });
}

it.each(['bilingual', 'replace'] as const)('preserves mixed-container code and current code edits in %s mode', mode => {
  visiblePage(`<div id="mixed">Read the example below.<pre id="code"><code>${snippet}</code></pre><em>Then continue with <a href="/guide">the guide</a>.</em></div>`);
  const code = document.querySelector('#code')!;
  const codeNodes = Array.from(code.querySelectorAll('*'));
  const codeText = Array.from(code.querySelectorAll('span')).map(node => node.firstChild!);
  const codeMarkup = code.innerHTML;
  const units = collectUnits();
  expect(units.every(unit => !/function|return|Hello world/.test(unit.text))).toBe(true);
  for (const unit of units) render(unit, unit.rich ? unit.rich.slots.map(slot => `译:${slot}`) : `译:${unit.text}`, mode);
  expect(code.isConnected).toBe(true);
  expect(code.innerHTML).toBe(codeMarkup);
  expect(code.closest('.dual-read-original-hidden')).toBeNull();
  expect(code.querySelector('.dual-read-target,.dual-read-replace-text')).toBeNull();
  (codeText[1] as Text).nodeValue = 'UpdatedVideo';
  const addition = document.createElement('span');
  addition.textContent = ' // page-owned comment';
  code.append(addition);
  for (const unit of units) restoreUnit(unit.el);
  expect(codeText.every(node => node.isConnected)).toBe(true);
  expect(Array.from(code.querySelectorAll('*')).slice(0, codeNodes.length)).toEqual(codeNodes);
  expect(code.textContent).toContain('UpdatedVideo');
  expect(code.lastChild).toBe(addition);
});

it('does not translate new highlighted code inserted during a watched session', () => {
  visiblePage('<main><p id="copy">Existing documentation remains visible.</p></main>');
  const units = collectUnits();
  const code = document.createElement('pre');
  code.innerHTML = `<code>${snippet}</code>`;
  document.querySelector('main')!.append(code);
  const delta = mutationIndexDelta([{type: 'childList', target: code.parentElement!, addedNodes: [code], removedNodes: []} as unknown as MutationRecord], units.map(unit => unit.el));
  expect(delta.added).toEqual([]);
});

it('invalidates a translated host when the page turns it into a code editor', () => {
  visiblePage('<div id="source">A description that will become an editor.</div>');
  const host = document.querySelector<HTMLElement>('#source')!;
  host.setAttribute(DONE, 'true');
  host.classList.add('cm-content');
  const delta = mutationIndexDelta([{type:'attributes', target:host, attributeName:'class', oldValue:'', addedNodes:[], removedNodes:[]} as unknown as MutationRecord], [host]);
  expect(delta.invalidated).toEqual([host]);
});

it.each(['bilingual', 'replace'] as const)('keeps nested inline code unchanged through rich %s rendering', mode => {
  visiblePage('<p>Use <code><span>createRoot</span>(container)</code> to render <a href="/guide">the component</a>.</p>');
  const [unit] = collectUnits();
  const code = unit.el.querySelector('code')!;
  const identifier = code.querySelector('span')!.firstChild!;
  render(unit, unit.rich!.slots.map(slot => `译:${slot}`), mode);
  const visibleCode = Array.from(unit.el.querySelectorAll('code')).find(node =>
    !node.closest('.dual-read-original-hidden') && (mode === 'replace' || node.closest('.dual-read-target')),
  )!;
  expect(visibleCode.textContent).toBe('createRoot(container)');
  restoreUnit(unit.el);
  expect(unit.el.querySelector('code')).toBe(code);
  expect(code.querySelector('span')!.firstChild).toBe(identifier);
});

it('respects code ancestry across an open shadow root while collecting neighboring shadow prose', () => {
  visiblePage('<pre><code-sample></code-sample></pre><prose-sample></prose-sample>');
  const codeRoot = document.querySelector('code-sample')!.attachShadow({mode:'open'});
  codeRoot.innerHTML = '<div><span>function Video() { return null; }</span></div>';
  const proseRoot = document.querySelector('prose-sample')!.attachShadow({mode:'open'});
  proseRoot.innerHTML = '<p>Independent shadow documentation remains translatable.</p>';
  expect(collectUnits(codeRoot)).toEqual([]);
  expect(collectUnits(proseRoot).map(unit => unit.text)).toEqual(['Independent shadow documentation remains translatable.']);
});
