// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render, restoreDom } from '../lib/renderer';
import { extractRichSlots } from '../lib/collector';

// Fixed seed covers different original/current nesting, transfers, wrappers,
// removals and text appends. Snapshot page positions before restoring source.
it('preserves original nodes and text after 100 combinations of page tree edits', () => {
  let seed = 47391;
  const pick = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let iteration = 0; iteration < 100; iteration++) {
    document.body.innerHTML = [0, 1, 2].map(n => `<p><strong>Head ${n} <em>Nested ${n}</em></strong><span>Tail ${n} <b>Detail ${n}</b></span></p>`).join('');
    const hosts = Array.from(document.querySelectorAll('p'));
    const originals = new Map<Node, Node>();
    const source = new Map<Node, string | null>();
    const pair = (copy: Node, original: Node) => {
      originals.set(copy, original);
      source.set(copy, original.nodeValue);
      Array.from(copy.childNodes).forEach((child, i) => pair(child, original.childNodes[i]));
    };
    for (const host of hosts) {
      const children = Array.from(host.childNodes);
      const slots = extractRichSlots(host);
      render({ el: host, kind: 'block', text: slots.join(' '), rich: { slots } }, slots.map(s => `译:${s}`), 'replace');
      Array.from(host.childNodes).slice(1).forEach((copy, i) => pair(copy, children[i]));
    }
    const movable = Array.from(originals.keys()).filter(n => n instanceof Element);
    for (let move = 0; move < 12; move++) {
      const node = movable[pick(movable.length)];
      const parents = [...hosts, ...movable].filter(p => p !== node && !node.contains(p));
      const parent = parents[pick(parents.length)];
      const children = Array.from(parent.childNodes).filter(n => !(n instanceof Element && n.classList.contains('dual-read-original-hidden')));
      parent.insertBefore(node, children[pick(children.length + 1)] ?? null);
    }
    if (iteration % 3 === 0) {
      const copy = movable[pick(movable.length)];
      const wrapper = document.createElement('span');
      copy.before(wrapper);
      wrapper.append('Page addition ', copy);
    }
    if (iteration % 4 === 0) movable[pick(movable.length)].remove();
    const textCopies = Array.from(originals.keys()).filter((node) => node instanceof Text && node.isConnected);
    if (textCopies.length) {
      const text = textCopies[pick(textCopies.length)] as Text;
      text.appendData(' more source');
      source.set(text, source.get(text)! + ' more source');
    }
    interface Expected { node: Node; value: string | null; children: Expected[] }
    const snapshot = (node: Node): Expected => ({ node: originals.get(node) ?? node, value: source.has(node) ? source.get(node)! : node.nodeValue, children: Array.from(node.childNodes).map(snapshot) });
    const expected = hosts.map(host => Array.from(host.childNodes).filter(n => !(n instanceof Element && n.classList.contains('dual-read-original-hidden'))).map(snapshot));
    const check = (parent: Node, tree: Expected[]) => {
      expect(parent.childNodes.length, `iteration ${iteration}`).toBe(tree.length);
      tree.forEach((item, i) => {
        expect(parent.childNodes[i], `iteration ${iteration}`).toBe(item.node);
        expect(item.node.nodeValue).toBe(item.value);
        check(item.node, item.children);
      });
    };
    restoreDom();
    hosts.forEach((host, i) => check(host, expected[i]));
  }
  document.body.innerHTML = '';
});
