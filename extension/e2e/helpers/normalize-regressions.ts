import { expect, type Page } from '@playwright/test';

type Change = 'append' | 'insert' | 'replace' | 'temporary' | 'insert-after' | 'replace-after' | 'split-after'
  | 'transfer' | 'transfer-move' | 'transfer-new' | 'transfer-new-move';
interface Scenario {
  name: string;
  change: Change;
  watching: boolean;
  shadow: boolean;
}

export const normalizeRegressions: Scenario[] = [];
for (const watching of [false, true]) {
  for (const change of ['append', 'insert', 'replace', 'temporary'] as const) {
    normalizeRegressions.push({ name: `${change} before normalize with watching ${watching}`, change, watching, shadow: false });
  }
  for (const change of ['insert-after', 'replace-after', 'split-after'] as const) {
    normalizeRegressions.push({ name: `${change} normalize with watching ${watching}`, change, watching, shadow: false });
  }
  for (const shadow of [false, true]) {
    for (const change of ['transfer', 'transfer-move', 'transfer-new', 'transfer-new-move'] as const) {
      normalizeRegressions.push({ name: `${change} and normalize across ${shadow ? 'shadow roots' : 'hosts'} with watching ${watching}`, change, watching, shadow });
    }
  }
}

interface Driver {
  translate(mode: 'bilingual' | 'replace'): Promise<unknown>;
  restore(): Promise<unknown>;
  pause(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  sources: string[];
}
interface SavedNodes {
  normalizeNodes: {
    one: HTMLElement;
    title: HTMLElement;
    children: Node[];
    two: HTMLElement | null;
    other: HTMLElement | null;
    second: Node | null;
    moved: HTMLElement | null;
    prefix: Text | null;
    clicks: number;
  };
}

export async function setupNormalizeRegression(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(({ change, shadow }) => {
    const transfer = change.startsWith('transfer');
    const newHost = change.startsWith('transfer-new');
    document.body.innerHTML = transfer
      ? '<p id="one" lang="en"><strong id="title">First source</strong> first tail.</p>'
      : '<p id="one" lang="en"><strong id="title">First source<!-- marker -->second source</strong> for details.</p>';
    if (transfer) {
      const markup = '<p id="two" lang="en"><strong id="other">Second source</strong> second tail.</p>';
      if (shadow) {
        const host = document.createElement('div');
        host.id = 'shadow-host';
        document.body.appendChild(host);
        host.attachShadow({ mode: 'open' }).innerHTML = newHost ? '' : markup;
      } else if (!newHost) document.body.insertAdjacentHTML('beforeend', markup);
    }
    const title = document.querySelector<HTMLElement>('#title')!;
    const root = document.querySelector('#shadow-host')?.shadowRoot ?? document;
    const other = root.querySelector<HTMLElement>('#other');
    const g = globalThis as typeof globalThis & SavedNodes;
    g.normalizeNodes = {
      one: document.querySelector<HTMLElement>('#one')!, title, children: [...title.childNodes],
      two: root.querySelector<HTMLElement>('#two'), other, second: other?.firstChild ?? null,
      moved: null, prefix: null, clicks: 0,
    };
    title.addEventListener('click', () => { g.normalizeNodes.clicks++; });
    other?.addEventListener('click', () => { g.normalizeNodes.clicks++; });
  }, scenario);
}

/** Exercise the same restoration and request boundaries on both shipped builds. */
export async function verifyNormalizeRegression(page: Page, scenario: Scenario, driver: Driver): Promise<void> {
  const transfer = scenario.change.startsWith('transfer');
  const newHost = scenario.change.startsWith('transfer-new');
  const moved = scenario.change.endsWith('-move');
  await driver.translate('replace');
  await expect(page.locator('#one > strong')).toContainText('译:First source');
  if (transfer && !newHost) await expect(page.locator('#two > strong')).toHaveText('译:Second source');
  if (!scenario.watching) await driver.pause();
  const before = driver.sources.length;
  await page.evaluate(({ change }) => {
    const g = globalThis as typeof globalThis & SavedNodes;
    const left = document.querySelector('#one > strong')!;
    if (change.startsWith('transfer')) {
      const newHost = change.startsWith('transfer-new');
      let right: Element;
      if (newHost) {
        const target = document.createElement('p');
        target.id = 'two';
        target.lang = 'en';
        const prefix = document.createTextNode('Fresh source ');
        target.appendChild(prefix);
        (document.querySelector('#shadow-host')?.shadowRoot ?? document.body).appendChild(target);
        g.normalizeNodes.two = target;
        g.normalizeNodes.prefix = prefix;
        right = target;
      } else right = g.normalizeNodes.two!.querySelector(':scope > strong')!;
      // A page-owned survivor must also carry its history when moved again.
      if (change === 'transfer-move') right.prepend(document.createTextNode('Page prefix '));
      right.appendChild(left.firstChild!);
      right.normalize();
      if (change.endsWith('-move')) {
        const wrapper = document.createElement('em');
        wrapper.id = 'moved';
        g.normalizeNodes.moved = wrapper;
        g.normalizeNodes.two!.appendChild(wrapper);
        wrapper.appendChild(right.firstChild!);
      }
    } else if (change.endsWith('-after')) {
      left.normalize();
      const merged = left.firstChild as Text;
      if (change === 'replace-after') merged.replaceData(0, '译:First source'.length, 'New first source ');
      else if (change === 'split-after') {
        const tail = merged.splitText(5);
        tail.insertData('译:First source'.length - 5, ' New middle source ');
        left.normalize();
      } else merged.insertData('译:First source'.length, ' New middle source ');
    } else {
      if (change === 'insert') left.insertBefore(document.createTextNode(' New middle source '), left.lastChild);
      else if (change === 'replace') left.firstChild!.nodeValue = 'New first source ';
      else (left.firstChild as Text).appendData(' with more source ');
      left.normalize();
      if (change === 'temporary') {
        const temporary = document.createTextNode('Temporary page text');
        left.appendChild(temporary);
        temporary.remove();
      }
    }
  }, scenario);
  if (scenario.watching) {
    if (scenario.change === 'transfer') {
      // Unchanged slots can reuse cached responses; original node ownership
      // proves the watcher processed the transfer without requiring an API call.
      await expect.poll(() => page.evaluate(() => {
        const saved = (globalThis as typeof globalThis & SavedNodes).normalizeNodes;
        return saved.children[0].parentNode === saved.other;
      })).toBe(true);
    } else await expect.poll(() => driver.sources.length).toBeGreaterThan(before);
    await expect.poll(driver.status).toMatchObject({ count: transfer ? 2 : 1, total: transfer ? 2 : 1, failed: 0 });
    await page.waitForTimeout(800); // include the next observer debounce after repaint
  }
  expect(driver.sources.every(text => !text.includes('译:'))).toBe(true);
  const title = ['insert', 'insert-after', 'split-after'].includes(scenario.change) ? 'First source New middle source second source'
    : ['replace', 'replace-after'].includes(scenario.change) ? 'New first source second source'
    : 'First source with more source second source';
  const expectedOne = transfer ? ' first tail.' : `${title} for details.`;
  const expectedTwo = newHost ? 'Fresh source First source'
    : moved ? ' second tail.Page prefix Second sourceFirst source'
    : 'Second sourceFirst source second tail.';
  await driver.restore();
  await expect(page.locator('#one')).toHaveText(expectedOne);
  await expect(page.locator('#one')).toHaveAttribute('lang', 'en');
  if (transfer) {
    await expect(page.locator('#two')).toHaveText(expectedTwo);
    await expect(page.locator('#two')).toHaveAttribute('lang', 'en');
  }
  expect(await page.evaluate(({ transfer, moved, newHost }) => {
    const saved = (globalThis as typeof globalThis & SavedNodes).normalizeNodes;
    const destination = moved ? saved.moved! : newHost ? saved.two! : transfer ? saved.other! : saved.title;
    saved.title.click();
    if (transfer && !newHost) saved.other!.click();
    return {
      title: saved.one.querySelector('strong') === saved.title,
      other: !transfer || newHost || saved.two!.querySelector('strong') === saved.other,
      texts: saved.children.every(node => node.parentNode === destination)
        && (!transfer || newHost || saved.second!.parentNode === destination),
      wrapper: !moved || saved.two!.querySelector('#moved') === saved.moved,
      prefix: !newHost || saved.prefix!.parentNode === destination,
      clicks: saved.clicks,
    };
  }, { transfer, moved, newHost })).toEqual({ title: true, other: true, texts: true, wrapper: true, prefix: true, clicks: transfer && !newHost ? 2 : 1 });
  // Reuse the recovered source in another mode, including cache keys and slots.
  await driver.translate('bilingual');
  const bilingualText = newHost && !moved ? '译:Fresh source First source'
    : transfer ? '译:First source' : '译:second source';
  await expect(page.locator(`${transfer ? '#two' : '#one'} > .dual-read-target`)).toContainText(bilingualText);
  await driver.restore();
  await driver.restore();
  await expect(page.locator('#one')).toHaveText(expectedOne);
  if (transfer) await expect(page.locator('#two')).toHaveText(expectedTwo);
  expect(driver.sources.every(text => !text.includes('译:'))).toBe(true);
  await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-replace-text, .dual-read-original-hidden, style[data-dual-read-style]')).toHaveCount(0);
}
