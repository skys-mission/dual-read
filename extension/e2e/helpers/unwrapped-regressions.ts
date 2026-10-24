import { expect, type Page } from '@playwright/test';

type Change = 'remove' | 'replace' | 'replace middle' | 'move'
  | 'reorder' | 'reorder nested' | 'reorder insert' | 'reorder transfer' | 'reorder interleaved';
interface Scenario { name: string; tag: 'form' | 'fieldset' | 'span'; change: Change; watching: boolean }
export const unwrappedRegressions: Scenario[] = [];
for (const tag of ['form', 'fieldset'] as const) for (const watching of [false, true]) {
  for (const change of ['remove', 'replace', 'replace middle', 'move',
    'reorder', 'reorder nested', 'reorder insert', 'reorder transfer', 'reorder interleaved'] as const) {
    unwrappedRegressions.push({ name: `unwrapped ${tag}: ${change}, watching ${watching}`, tag, change, watching });
  }
}
for (const watching of [false, true]) {
  unwrappedRegressions.push({ name: `unwrapped span control: reorder, watching ${watching}`, tag: 'span', change: 'reorder', watching });
}

interface Driver {
  translate(mode: 'bilingual' | 'replace'): Promise<unknown>;
  restore(): Promise<unknown>;
  pause(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  sources: string[];
}
interface Saved {
  unwrapped: { wrapper: Element; inner: Element | null; original: Element; fresh: Text;
    stash: Element | null; clicks: number; originals: Element[]; other: Element | null };
}

export async function setupUnwrappedRegression(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(({ tag, change }) => {
    const contents = change === 'replace middle' || change === 'reorder nested'
      ? '<fieldset id="inner"><strong>first source</strong><em id="original">second source</em><b>third source</b></fieldset>'
      : change.startsWith('reorder')
        ? `<strong>first source</strong><em id="original">second source</em>${change === 'reorder interleaved' ? '' : '<b>third source</b>'}`
      : '<strong id="original">first source</strong>';
    const other = change === 'reorder interleaved' ? '<fieldset id="other"><b>third source</b></fieldset>' : '';
    document.body.innerHTML = `<div id="one">Read <${tag} id="wrapper" class="page-wrapper">${contents}<!-- keep --></${tag}>${other} tail.</div><p id="two">Other source.</p>`;
    const g = globalThis as typeof globalThis & Saved;
    g.unwrapped = { wrapper: document.querySelector('#wrapper')!, inner: document.querySelector('#inner'),
      original: document.querySelector('#original')!, fresh: document.createTextNode('Fresh source'), stash: null, clicks: 0,
      originals: [...document.querySelectorAll('#one strong, #one em, #one b')], other: document.querySelector('#other') };
    g.unwrapped.wrapper.addEventListener('click', () => { g.unwrapped.clicks++; });
  }, scenario);
}

export async function verifyUnwrappedRegression(page: Page, scenario: Scenario, driver: Driver): Promise<void> {
  await driver.translate('replace');
  const scope = scenario.tag === 'span' ? '#one > span:not(.dual-read-original-hidden)' : '#one';
  await expect(page.locator(`${scope} > strong`)).toHaveText('译:first source');
  await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  if (!scenario.watching) await driver.pause();
  await page.evaluate(({ change, scope }) => {
    const g = globalThis as typeof globalThis & Saved;
    g.unwrapped.stash = document.querySelector('#one > .dual-read-original-hidden');
    const copy = document.querySelector(change === 'replace middle' ? '#one > em' : `${scope} > strong`)!;
    if (change.startsWith('reorder')) {
      const copies = [...document.querySelectorAll(`${scope} > strong, ${scope} > em, ${scope} > b`)];
      const anchor = copies.at(-1)!.nextSibling;
      const order = change === 'reorder interleaved' ? [0, 2, 1]
        : change === 'reorder insert' ? [2, 0, 1]
        : change === 'reorder nested' || change === 'reorder transfer' ? [2, 1, 0] : [1, 0, 2];
      order.forEach(i => document.querySelector(scope)!.insertBefore(copies[i], anchor));
      if (change === 'reorder insert') copies[1].before(g.unwrapped.fresh);
      if (change === 'reorder transfer') document.querySelector('#two')!.append(copies[0]);
    } else if (change === 'remove') copy.remove();
    else if (change === 'move') document.querySelector('#two')!.append(copy);
    else copy.replaceWith(g.unwrapped.fresh);
  }, { change: scenario.change, scope });
  if (scenario.watching) {
    // A removal may retranslate entirely from cache. Wait for a new paint,
    // rather than a new provider request or the already-mutated visible text.
    await expect.poll(() => page.evaluate(() => {
      const saved = (globalThis as typeof globalThis & Saved).unwrapped;
      const current = document.querySelector('#one > .dual-read-original-hidden');
      return current !== null && current !== saved.stash;
    })).toBe(true);
    await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  }
  await driver.restore();
  const expectedByChange: Record<Change, string> = {
    remove: 'Read  tail.', replace: 'Read Fresh source tail.', move: 'Read  tail.',
    'replace middle': 'Read first sourceFresh sourcethird source tail.',
    reorder: 'Read second sourcefirst sourcethird source tail.',
    'reorder nested': 'Read third sourcesecond sourcefirst source tail.',
    'reorder insert': 'Read third sourcefirst sourceFresh sourcesecond source tail.',
    'reorder transfer': 'Read third sourcesecond source tail.',
    'reorder interleaved': 'Read first sourcethird sourcesecond source tail.',
  };
  const expected = expectedByChange[scenario.change];
  await expect(page.locator('#one')).toHaveText(expected);
  await expect(page.locator('#two')).toHaveText(['move', 'reorder transfer'].includes(scenario.change) ? 'Other source.first source' : 'Other source.');
  expect(await page.evaluate(({ change }) => {
    const saved = (globalThis as typeof globalThis & Saved).unwrapped;
    saved.wrapper.dispatchEvent(new MouseEvent('click'));
    return {
      wrapper: document.querySelector('#wrapper') === saved.wrapper,
      inner: !saved.inner || document.querySelector('#inner') === saved.inner,
      className: saved.wrapper.getAttribute('class'), clicks: saved.clicks,
      original: change.startsWith('reorder') ? saved.originals.every(node => node.isConnected)
        : change === 'move' ? document.querySelector('#two')!.contains(saved.original) : !saved.original.isConnected,
      fresh: !(change.startsWith('replace') || change === 'reorder insert') || document.querySelector('#one')!.contains(saved.fresh),
      other: !saved.other || document.querySelector('#other') === saved.other,
      order: !change.startsWith('reorder') ? null : [...document.querySelectorAll('#one strong, #one em, #one b')].map(node => saved.originals.indexOf(node)),
    };
  }, scenario)).toEqual({ wrapper: true, inner: true, className: 'page-wrapper', clicks: 1, original: true, fresh: true, other: true,
    order: !scenario.change.startsWith('reorder') ? null
      : scenario.change === 'reorder interleaved' ? [0, 2, 1] : scenario.change === 'reorder insert' ? [2, 0, 1]
      : scenario.change === 'reorder transfer' ? [2, 1] : scenario.change === 'reorder nested' ? [2, 1, 0] : [1, 0, 2] });
  await driver.restore();
  await expect(page.locator('#one')).toHaveText(expected);
  await driver.translate('bilingual');
  await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
  expect(driver.sources.filter(text => text.includes('译:'))).toEqual([]);
  await driver.restore();
  await expect(page.locator('#one')).toHaveText(expected);
}
