// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { render, restoreDom } from '../lib/renderer';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; vi.restoreAllMocks(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
function setup() {
  document.body.innerHTML = '<main><section id="card"><div id="clip" style="display:-webkit-box;-webkit-line-clamp:4"><p id="a">First article excerpt.</p><p id="b">Second article excerpt.</p></div></section><section id="sink"></section></main>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 100, top: 0, bottom: 100, left: 0, right: 400, x: 0, y: 0, toJSON() {} } as DOMRect);
  const a = document.getElementById('a')!, b = document.getElementById('b')!, clip = document.getElementById('clip')!, sink = document.getElementById('sink')!;
  const originals = [a.firstChild, b.firstChild];
  render({ el: a, text: a.textContent!, kind: 'block' }, '第一段译文。', 'bilingual');
  render({ el: b, text: b.textContent!, kind: 'block' }, '第二段译文。', 'bilingual');
  const targets = [...document.querySelectorAll<HTMLElement>('.dual-read-target')];
  expect(targets.map(node => node.textContent)).toEqual(['第一段译文。', '第二段译文。']);
  return { a, b, clip, sink, originals, targets };
}

it.each(['move', 'reorder', 'unclamp', 'remove-card', 'shadow', 'interactive', 'grid'] as const)('keeps companions attached to their source after %s', async operation => {
  const { a, b, clip, sink, originals, targets } = setup();
  let destination: ParentNode = sink;
  if (operation === 'reorder') clip.prepend(b);
  else if (operation === 'unclamp') clip.style.removeProperty('-webkit-line-clamp');
  else if (operation === 'grid') clip.parentElement!.style.display = 'grid';
  else {
    if (operation === 'shadow') {
      destination = sink.attachShadow({ mode: 'open' });
      const wrapper = document.createElement('section'); destination.appendChild(wrapper);
      const box = document.createElement('div'); box.style.cssText = 'display:-webkit-box;-webkit-line-clamp:3';
      wrapper.appendChild(box); destination = box;
    } else if (operation === 'interactive') {
      const link = document.createElement('a'); link.href = '#'; sink.append(link); destination = link;
    }
    destination.appendChild(a);
    if (operation === 'remove-card') clip.parentElement!.remove();
  }
  await settle();
  if (operation === 'reorder') expect([...clip.parentElement!.querySelectorAll('.dual-read-target')]).toEqual([targets[1], targets[0]]);
  else if (operation === 'shadow') expect(targets[0].parentNode).toBe((destination as Element).parentNode);
  else expect(targets[0].parentNode).toBe(a);
  if (operation === 'unclamp' || operation === 'grid') expect(targets[1].parentNode).toBe(b);
  restoreDom(); restoreDom();
  expect(a.firstChild).toBe(originals[0]); expect(b.firstChild).toBe(originals[1]);
  expect(a.textContent).toBe('First article excerpt.'); expect(b.textContent).toBe('Second article excerpt.');
});

it.each(['display', 'visibility', 'opacity', 'aria', 'details'] as const)('hides and reveals the relocated companion with source %s', async property => {
  const { a, targets, originals } = setup();
  const styles = a.getAttribute('style');
  let details: HTMLDetailsElement | undefined;
  if (property === 'details') { details = document.createElement('details'); a.before(details); details.append(a); }
  else if (property === 'aria') a.setAttribute('aria-hidden', 'true');
  else a.style.setProperty(property, property === 'display' ? 'none' : property === 'visibility' ? 'hidden' : '0');
  await settle();
  expect(targets[0].style.display).toBe('none');
  expect(targets[1].style.display).not.toBe('none');
  if (details) details.open = true;
  else if (property === 'aria') a.removeAttribute('aria-hidden');
  else a.style.removeProperty(property);
  await settle();
  expect(targets[0].style.display).not.toBe('none');
  restoreDom();
  expect(a.firstChild).toBe(originals[0]);
  expect(a.getAttribute('style') || null).toBe(styles);
});

it('retains source typography when a detached card is reused while paused', async () => {
  const { a, clip, sink, targets } = setup();
  const card = clip.parentElement!;
  card.remove(); await settle();
  sink.append(card); a.style.fontSize = '28px'; await settle();
  expect(targets[0].parentElement).toBe(card);
  expect(targets[0].style.fontSize).toBe('28px');
  restoreDom();
  expect(a.textContent).toBe('First article excerpt.');
});

it('does not resurrect a removed companion after immediate full restore', async () => {
  const { a, targets } = setup();
  targets[0].remove();
  restoreDom(); restoreDom(); await settle();
  expect(document.querySelector('.dual-read-target')).toBeNull();
  expect(a.textContent).toBe('First article excerpt.');
});

it('releases a removed companion when its host registers a replacement', async () => {
  const { a, targets } = setup();
  targets[0].remove();
  render({ el: a, text: 'First article excerpt.', kind: 'block' }, '新的第一段译文。', 'bilingual');
  await settle();
  expect([...document.querySelectorAll('.dual-read-target')].map(node => node.textContent)).toEqual(['新的第一段译文。', '第二段译文。']);
  expect(targets[0].isConnected).toBe(false);
});
