// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchLayoutUpdates } from '../lib/renderer/layout-updates';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const subscriptions: ReturnType<typeof watchLayoutUpdates>[] = [];
beforeEach(() => {
  frames = new Map(); sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  document.body.innerHTML = '<p id="source">Current page source.</p>';
});
afterEach(() => { for (const subscription of subscriptions.splice(0)) subscription.dispose(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function subscribe(read: Parameters<typeof watchLayoutUpdates>[0]) {
  const subscription = watchLayoutUpdates(read); subscriptions.push(subscription); return subscription;
}
function flushFrame(): void {
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(16); }
}

it('preserves undelivered page records when another reader disposes', async () => {
  const retired = vi.fn(), surviving = vi.fn();
  const first = subscribe(retired); subscribe(surviving);
  const source = document.getElementById('source')!;
  source.setAttribute('data-theme', 'changed'); first.dispose();
  await Promise.resolve(); flushFrame();
  expect(retired).not.toHaveBeenCalled();
  expect(surviving).toHaveBeenCalledOnce();
  expect(surviving.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ target:source, attributeName:'data-theme' })]));
});

it('preserves undelivered shadow records while unsubscribing a different shadow', async () => {
  const firstHost = document.createElement('first-widget'), secondHost = document.createElement('second-widget');
  document.body.append(firstHost, secondHost);
  const firstRoot = firstHost.attachShadow({mode:'open'}), secondRoot = secondHost.attachShadow({mode:'open'});
  secondRoot.innerHTML = '<p>Shadow source.</p>';
  const first = subscribe(vi.fn()), surviving = vi.fn();
  first.addRoot(firstRoot); subscribe(surviving).addRoot(secondRoot);
  const source = secondRoot.querySelector('p')!;
  source.className = 'changed'; first.dispose();
  await Promise.resolve(); flushFrame();
  expect(surviving).toHaveBeenCalledOnce();
  expect(surviving.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({target:source,attributeName:'class'})]));
});

it.each(['input', 'change'])('refreshes pseudo-class paint after a native %s event in a shadow root', async event => {
  const host = document.createElement('state-widget'); document.body.appendChild(host);
  const root = host.attachShadow({mode:'open'}); root.innerHTML = '<input type="checkbox">';
  const read = vi.fn(); subscribe(read).addRoot(root);
  const input = root.querySelector('input')!; input.checked = true;
  input.dispatchEvent(new Event(event, {bubbles:true}));
  await Promise.resolve(); flushFrame();
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0][0]).toBeNull();
});

it('cancels queued writes and form listeners when the last reader disposes', async () => {
  const read = vi.fn(() => vi.fn()); const subscription = subscribe(read);
  document.getElementById('source')!.className = 'changed';
  await Promise.resolve(); expect(frames.size).toBe(1);
  subscription.dispose();
  document.dispatchEvent(new Event('change')); window.dispatchEvent(new Event('resize'));
  await Promise.resolve(); flushFrame();
  expect(frames.size).toBe(0); expect(read).not.toHaveBeenCalled();
});

it.each(['transitionend', 'transitioncancel', 'animationend', 'animationcancel'].flatMap(event =>
  [false, true].map(shadow => ({ event, shadow })),
))('refreshes final CSS motion state for $event, shadow=$shadow', async ({ event, shadow }) => {
  const read = vi.fn(); const subscription = subscribe(read);
  let source = document.getElementById('source')!;
  if (shadow) {
    const host = document.createElement('motion-widget'); document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<p>Current shadow source.</p>';
    subscription.addRoot(root); source = root.querySelector('p')!;
    await Promise.resolve(); flushFrame(); read.mockClear();
  }
  source.dispatchEvent(new Event(event, { bubbles: true }));
  await Promise.resolve(); flushFrame();
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0][0]).toBeNull();
  subscription.dispose();
  source.dispatchEvent(new Event(event, { bubbles: true })); flushFrame();
  expect(read).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
});

it('ignores owned companion motion but retains motion on stashed page sources', async () => {
  document.body.innerHTML = '<span class="dual-read-target"><span id="target">Translation.</span></span><span class="dual-read-original-hidden"><span id="original">Current source.</span></span>';
  const read = vi.fn(); subscribe(read);
  document.getElementById('target')!.dispatchEvent(new Event('transitionend', { bubbles: true }));
  await Promise.resolve(); flushFrame(); expect(read).not.toHaveBeenCalled();
  document.getElementById('original')!.dispatchEvent(new Event('transitioncancel', { bubbles: true }));
  await Promise.resolve(); flushFrame(); expect(read).toHaveBeenCalledOnce();
});

it('can schedule an owned follow-up read without repeating global invalidation', () => {
  const read = vi.fn(); const subscription = subscribe(read);
  subscription.refresh(false); flushFrame(); expect(read.mock.calls[0][0]).toEqual([]);
  subscription.refresh(); flushFrame(); expect(read.mock.calls[1][0]).toBeNull();
});
