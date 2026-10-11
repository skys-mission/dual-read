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
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  document.body.innerHTML = '';
  document.head.querySelectorAll('[data-layout-update-test]').forEach(style => style.remove());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function subscribe(read: Parameters<typeof watchLayoutUpdates>[0], checkSourcePolicies = false) {
  const subscription = watchLayoutUpdates(read, { checkSourcePolicies }); subscriptions.push(subscription); return subscription;
}
function flushFrame(): void {
  for (const [id, callback] of [...frames]) { frames.delete(id); callback(16); }
}
function drainFrames(): void {
  for (let count = 0; frames.size && count < 100; count++) flushFrame();
  expect(frames.size).toBe(0);
}
function authorSheet(css: string): CSSStyleSheet {
  const style = document.createElement('style');
  style.setAttribute('data-layout-update-test', ''); style.textContent = css;
  document.head.append(style);
  // jsdom omits CSSStyleSheet.ownerNode; native browsers provide it.
  Object.defineProperty(style.sheet!, 'ownerNode', { value: style });
  return style.sheet!;
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

it('yields between expensive readers, retaining page records and global refreshes', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const first = vi.fn(() => { time += 30; return vi.fn(); }), second = vi.fn();
  subscribe(first); subscribe(second);
  document.getElementById('source')!.className = 'changed';
  await Promise.resolve(); flushFrame();
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  flushFrame();
  expect(second).toHaveBeenCalledOnce();
  expect(second.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({attributeName:'class'})]));
  window.dispatchEvent(new Event('resize')); flushFrame(); flushFrame();
  expect(second.mock.calls[1][0]).toBeNull();
});

it('an owned continuation wakes only its reader and disposal cancels deferred work', () => {
  const first = vi.fn(), second = vi.fn();
  const subscription = subscribe(first); subscribe(second);
  subscription.refresh(false); flushFrame();
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  subscription.refresh(false); subscription.dispose(); flushFrame();
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
});

it('checks opted-in source policies without a global reflow and cancels on disposal', async () => {
  vi.useFakeTimers();
  const ordinary = vi.fn(), policy = vi.fn();
  subscribe(ordinary);
  await vi.advanceTimersByTimeAsync(3000); flushFrame();
  expect(ordinary).not.toHaveBeenCalled();
  const subscription = subscribe(policy, true);
  await vi.advanceTimersByTimeAsync(1000); flushFrame(); flushFrame();
  expect(policy).toHaveBeenCalledWith([], true);
  expect(ordinary).not.toHaveBeenCalled();
  subscription.dispose();
  await vi.advanceTimersByTimeAsync(3000); flushFrame();
  expect(policy).toHaveBeenCalledOnce(); expect(ordinary).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('retains a policy check across read-budget deferral and merges page changes', async () => {
  vi.useFakeTimers();
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const first = vi.fn(() => { time += 30; return undefined; }), second = vi.fn();
  subscribe(first, true); subscribe(second, true);
  await vi.advanceTimersByTimeAsync(1000); flushFrame(); flushFrame();
  expect(first).toHaveBeenCalledWith([], true); expect(second).not.toHaveBeenCalled();
  document.getElementById('source')!.className = 'changed';
  await Promise.resolve(); flushFrame();
  expect(second).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ attributeName: 'class' })]), true);
});

it('suspends policy checks in the background and checks on visibility return', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const read = vi.fn(); const subscription = subscribe(read, true);
  await vi.advanceTimersByTimeAsync(3000); flushFrame();
  expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); flushFrame(); flushFrame();
  expect(read).toHaveBeenCalledWith([], true);
  subscription.dispose();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(3000); flushFrame();
  expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('skips unchanged stylesheets and detects CSSOM declaration and grouping-rule edits', async () => {
  vi.useFakeTimers();
  const sheet = authorSheet('#source{height:80px}@media screen{#source{max-height:100px}}');
  const read = vi.fn(); subscribe(read, true);
  await vi.advanceTimersByTimeAsync(1000); drainFrames();
  expect(read).toHaveBeenCalledWith([], true); read.mockClear();
  await vi.advanceTimersByTimeAsync(1000); drainFrames();
  expect(read).not.toHaveBeenCalled();
  (sheet.cssRules[0] as CSSStyleRule).style.height = '0px';
  await vi.advanceTimersByTimeAsync(1000); drainFrames();
  expect(read).toHaveBeenCalledWith([], true); read.mockClear();
  ((sheet.cssRules[1] as CSSMediaRule).cssRules[0] as CSSStyleRule).style.setProperty('max-height', '50px');
  await vi.advanceTimersByTimeAsync(1000); drainFrames();
  expect(read).toHaveBeenCalledWith([], true);
});

it('ignores owned stylesheet changes but detects author sheet disablement and insertion', async () => {
  vi.useFakeTimers();
  const sheet = authorSheet('#source{height:80px}'), owned = authorSheet('#source{min-height:90px}');
  (owned.ownerNode as Element).setAttribute('data-dual-read-layout-style', 'true');
  const read = vi.fn(); subscribe(read, true);
  await vi.advanceTimersByTimeAsync(1000); drainFrames(); read.mockClear();
  (owned.cssRules[0] as CSSStyleRule).style.minHeight = '100px';
  await vi.advanceTimersByTimeAsync(1000); drainFrames(); expect(read).not.toHaveBeenCalled();
  sheet.disabled = true;
  await vi.advanceTimersByTimeAsync(1000); drainFrames(); expect(read).toHaveBeenCalledWith([], true); read.mockClear();
  sheet.insertRule('#source{height:0px}', 1);
  await vi.advanceTimersByTimeAsync(1000); drainFrames(); expect(read).toHaveBeenCalledWith([], true);
});

it('yields during large stylesheet scans and cancels the unfinished scan on disposal', async () => {
  vi.useFakeTimers();
  authorSheet(Array.from({ length: 1000 }, (_, i) => `.rule-${i}{height:80px}`).join(''));
  const read = vi.fn(); const subscription = subscribe(read, true);
  await vi.advanceTimersByTimeAsync(1000); flushFrame();
  expect(frames.size).toBe(1); expect(read).not.toHaveBeenCalled();
  drainFrames(); expect(read).toHaveBeenCalledWith([], true); read.mockClear();
  await vi.advanceTimersByTimeAsync(1000); flushFrame();
  expect(frames.size).toBe(1); subscription.dispose();
  drainFrames(); expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('merges a CSSOM signal into an already queued local continuation', async () => {
  vi.useFakeTimers();
  const read = vi.fn(); const subscription = subscribe(read, true);
  await vi.advanceTimersByTimeAsync(1000);
  subscription.refresh(false);
  flushFrame(); drainFrames();
  expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith([], true);
});
