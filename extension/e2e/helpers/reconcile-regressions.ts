import { expect, type Page } from '@playwright/test';

type Change = 'wrap second' | 'wrap opaque' | 'move first' | 'move second' | 'remove first' | 'remove second'
  | 'reorder identical' | 'insert identical' | 'normalize moved' | 'normalize shadow' | 'edit moved'
  | 'same prefix' | 'same replacement'
  | 'link local' | 'link moved' | 'link shadow' | 'link remove' | 'link add';
interface Scenario { name: string; change: Change; watching: boolean }
export const reconcileRegressions: Scenario[] = [];
for (const watching of [false, true]) for (const change of [
  'wrap second', 'wrap opaque', 'move first', 'move second', 'remove first', 'remove second',
  'reorder identical', 'insert identical', 'normalize moved', 'normalize shadow', 'edit moved',
  'same prefix', 'same replacement',
  'link local', 'link moved', 'link shadow', 'link remove', 'link add',
] as const) reconcileRegressions.push({ name: `reconcile ${change} with watching ${watching}`, change, watching });

export function translateReconcileSource(text: string, scenario: Scenario): string {
  if (scenario.change.endsWith('identical') && ['First source', 'second source'].includes(text)) return '相同译文';
  if (scenario.change === 'wrap opaque' || scenario.change.startsWith('same ')) {
    if (text === 'First source') return '第一译文';
    if (text === 'second source') return '第二译文';
  }
  return `译:${text}`;
}

interface Driver {
  translate(mode: 'bilingual' | 'replace'): Promise<unknown>;
  restore(): Promise<unknown>;
  pause(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  sources: string[];
}
interface Saved {
  reconcileNodes: {
    title: Element | null;
    first: Node | null;
    second: Node | null;
    marker: Node | null;
    link: Element | null;
    wrapper: Element | null;
    fresh: Text | null;
    clicks: number;
  };
}

function verifySourceRequests(scenario: Scenario, sources: string[]): void {
  // Equal-valued Texts explicitly inserted by the page are legitimate source.
  const fresh = scenario.change === 'same prefix' ? '第一译文第二译文'
    : scenario.change === 'same replacement' ? '第二译文' : null;
  expect(sources.filter((text) => /译:|相同译文/.test(text)
    || /第一译文|第二译文/.test(text) && text !== fresh)).toEqual([]);
}

export async function setupReconcileRegression(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(({ change }) => {
    const link = change.startsWith('link');
    const shadow = change.endsWith('shadow');
    document.body.innerHTML = link
      ? '<p id="one" lang="en">Read <a id="original-link" class="page-link" href=" /original " title="old" target="_blank" rel="author">the documentation</a> for details.</p>'
      : '<p id="one" lang="en"><strong id="original-title">First source<!-- marker -->second source</strong> tail.</p>';
    const markup = link ? '<p id="two" lang="en">New place.</p>'
      : '<p id="two" lang="en"><strong id="other-title">Third source</strong> other tail.</p>';
    if (shadow) {
      const host = document.createElement('div'); host.id = 'shadow-host'; document.body.append(host);
      host.attachShadow({ mode: 'open' }).innerHTML = markup;
    } else document.body.insertAdjacentHTML('beforeend', markup);
    const title = document.querySelector('#original-title');
    const originalLink = document.querySelector('#original-link');
    const g = globalThis as typeof globalThis & Saved;
    g.reconcileNodes = { title, first: title?.firstChild ?? null, second: title?.lastChild ?? null,
      marker: title?.childNodes[1] ?? null, link: originalLink, wrapper: null, fresh: null, clicks: 0 };
    (originalLink ?? title)!.addEventListener('click', (event) => { event.preventDefault(); g.reconcileNodes.clicks++; });
  }, scenario);
}

export async function verifyReconcileRegression(page: Page, scenario: Scenario, driver: Driver): Promise<void> {
  const linkCase = scenario.change.startsWith('link');
  const identical = scenario.change.endsWith('identical');
  const opaque = scenario.change === 'wrap opaque' || scenario.change.startsWith('same ');
  await driver.translate('replace');
  await expect(page.locator(linkCase ? '#one > a' : '#one > strong'))
    .toHaveText(linkCase ? '译:the documentation' : identical ? '相同译文相同译文'
      : opaque ? '第一译文第二译文' : '译:First source译:second source');
  await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  if (!scenario.watching) await driver.pause();
  await page.evaluate(({ change }) => {
    const g = globalThis as typeof globalThis & Saved;
    const root = document.querySelector('#shadow-host')?.shadowRoot ?? document;
    const two = root.querySelector('#two')!;
    if (change.startsWith('link')) {
      const link = document.querySelector('#one > a')!;
      if (change === 'link remove') { link.removeAttribute('href'); link.removeAttribute('title'); }
      else {
        link.setAttribute('href', '/updated');
        if (change === 'link add') { link.setAttribute('data-page', 'new'); link.setAttribute('class', 'new-class'); }
      }
      if (change === 'link local') link.append(' added source'); // Force automatic source reconciliation.
      else two.append(link);
      return;
    }
    const strong = document.querySelector('#one > strong')!;
    if (change === 'same prefix') {
      const fresh = document.createTextNode(strong.textContent!); g.reconcileNodes.fresh = fresh;
      (strong.firstChild as Text).splitText(1);
      strong.prepend(fresh);
      return;
    }
    if (change === 'same replacement') {
      const fresh = document.createTextNode(strong.lastChild!.nodeValue!); g.reconcileNodes.fresh = fresh;
      strong.lastChild!.replaceWith(fresh);
      return;
    }
    const firstLength = strong.firstChild!.nodeValue!.length;
    strong.normalize();
    const first = strong.firstChild as Text;
    const second = first.splitText(firstLength);
    if (change.startsWith('wrap')) {
      const wrapper = document.createElement('em'); g.reconcileNodes.wrapper = wrapper;
      strong.append(wrapper); wrapper.append(second);
    } else if (change === 'move first') two.append(first);
    else if (change === 'move second') two.append(second);
    else if (change === 'remove first') first.remove();
    else if (change === 'remove second') second.remove();
    else if (change === 'reorder identical') strong.prepend(second);
    else if (change === 'insert identical') {
      const fresh = document.createTextNode(' New source '); g.reconcileNodes.fresh = fresh;
      strong.insertBefore(fresh, second);
    } else {
      const target = two.querySelector(':scope > strong')!;
      target.append(second);
      if (change.startsWith('normalize')) target.normalize();
      (target.lastChild as Text).appendData(' added source');
    }
  }, scenario);
  if (scenario.watching) {
    if (scenario.change.startsWith('normalize') || scenario.change === 'edit moved') {
      await expect.poll(() => driver.sources.includes('second source added source')).toBe(true);
      await expect(page.locator('#two > strong')).toHaveText('译:Third source译:second source added source');
    } else if (scenario.change === 'link local') {
      await expect.poll(() => driver.sources.includes('added source')).toBe(true);
      await expect(page.locator('#one > a')).toContainText('译:added source');
    }
    else if (scenario.change === 'insert identical') await expect(page.locator('#one > strong')).toContainText('译:New source');
    // Retained slots can come from cache with unchanged visible text. Give the
    // watcher a turn as well as checking its final session state below.
    else await page.waitForTimeout(750);
    await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  }
  if (linkCase) {
    if (scenario.watching) {
      // Removing href changes collection/rendering from rich to plain text.
      // Check the actual source node, even when no visible link is rendered.
      await expect.poll(() => page.evaluate(() =>
        (globalThis as typeof globalThis & Saved).reconcileNodes.link!.getAttribute('href')))
        .toBe(scenario.change === 'link remove' ? null : '/updated');
    } else {
      const link = page.locator(scenario.change === 'link local' ? '#one > a' : '#two > a');
      if (scenario.change === 'link remove') await expect(link).not.toHaveAttribute('href');
      else await expect(link).toHaveAttribute('href', '/updated');
    }
  }
  await driver.pause();
  await driver.restore();
  const expectedOne = linkCase ? scenario.change === 'link local'
    ? 'Read the documentation added source for details.' : 'Read  for details.'
    : scenario.change === 'same prefix' ? '第一译文第二译文First sourcesecond source tail.'
    : scenario.change === 'same replacement' ? 'First source第二译文 tail.'
    : scenario.change === 'remove first' || scenario.change === 'move first' ? 'second source tail.'
    : ['move second', 'remove second', 'normalize moved', 'normalize shadow', 'edit moved'].includes(scenario.change)
      ? 'First source tail.' : scenario.change === 'reorder identical' ? 'second sourceFirst source tail.'
      : scenario.change === 'insert identical' ? 'First source New source second source tail.' : 'First sourcesecond source tail.';
  const expectedTwo = linkCase ? scenario.change === 'link local' ? 'New place.' : 'New place.the documentation'
    : scenario.change === 'move first' ? 'Third source other tail.First source'
    : scenario.change === 'move second' ? 'Third source other tail.second source'
    : ['normalize moved', 'normalize shadow', 'edit moved'].includes(scenario.change)
      ? 'Third sourcesecond source added source other tail.' : 'Third source other tail.';
  await expect(page.locator('#one')).toHaveText(expectedOne);
  await expect(page.locator('#two')).toHaveText(expectedTwo);
  verifySourceRequests(scenario, driver.sources);
  const identities = await page.evaluate(({ change }) => {
    const g = globalThis as typeof globalThis & Saved;
    const n = g.reconcileNodes;
    const root = document.querySelector('#shadow-host')?.shadowRoot ?? document;
    const one = document.querySelector('#one')!;
    const two = root.querySelector('#two')!;
    (n.link ?? n.title)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (change.startsWith('link')) {
      return { identity: (change === 'link local' ? one : two).querySelector('a') === n.link,
        href: n.link!.getAttribute('href'), title: n.link!.getAttribute('title'),
        id: n.link!.id, className: n.link!.getAttribute('class'), rel: n.link!.getAttribute('rel'),
        page: n.link!.getAttribute('data-page'), clicks: n.clicks };
    }
    return { identity: one.querySelector('strong') === n.title,
      first: n.first!.isConnected, second: n.second!.isConnected, marker: n.marker!.parentNode === n.title,
      wrapper: !change.startsWith('wrap') || n.title!.querySelector('em') === n.wrapper,
      fresh: !['insert identical', 'same prefix', 'same replacement'].includes(change)
        || n.fresh!.parentNode === n.title && (change !== 'same prefix' || n.title!.firstChild === n.fresh), clicks: n.clicks };
  }, scenario);
  expect(identities).toMatchObject(linkCase ? {
    identity: true, href: scenario.change === 'link remove' ? null : '/updated',
    title: scenario.change === 'link remove' ? null : 'old', id: 'original-link',
    className: scenario.change === 'link add' ? 'new-class' : 'page-link', rel: 'author',
    page: scenario.change === 'link add' ? 'new' : null, clicks: 1,
  } : { identity: true, first: scenario.change !== 'remove first', second: !['remove second', 'same replacement'].includes(scenario.change),
    marker: true, wrapper: true, fresh: true, clicks: 1 });
  await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden, style[data-dual-read-style]')).toHaveCount(0);
  // Mode switches must use the newly reconciled source and preserve its edits.
  await driver.translate('bilingual');
  await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  await driver.restore();
  await driver.restore();
  await expect(page.locator('#one')).toHaveText(expectedOne);
  await expect(page.locator('#two')).toHaveText(expectedTwo);
  verifySourceRequests(scenario, driver.sources);
}
