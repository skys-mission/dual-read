import { expect, type Page } from '@playwright/test';

export const sourceRegressions = [
  { name: 'mixed parent append in bilingual mode', kind: 'mixed', mode: 'bilingual', watching: true, shadow: false },
  { name: 'mixed parent append in replace mode', kind: 'mixed', mode: 'replace', watching: true, shadow: false },
  { name: 'rich text edits with watching stopped', kind: 'text', mode: 'replace', watching: false, shadow: false },
  { name: 'rich text edits with watching active', kind: 'text', mode: 'replace', watching: true, shadow: false },
  { name: 'cross-host transfer with watching stopped', kind: 'transfer', mode: 'replace', watching: false, shadow: false },
  { name: 'cross-host transfer with watching active', kind: 'transfer', mode: 'replace', watching: true, shadow: false },
  { name: 'cross-shadow transfer with watching stopped', kind: 'transfer', mode: 'replace', watching: false, shadow: true },
  { name: 'cross-shadow transfer with watching active', kind: 'transfer', mode: 'replace', watching: true, shadow: true },
  { name: 'split Text with watching stopped', kind: 'split', mode: 'replace', watching: false, shadow: false },
  { name: 'split Text with watching active', kind: 'split', mode: 'replace', watching: true, shadow: false },
  { name: 'normalize Text with watching stopped', kind: 'normalize', mode: 'replace', watching: false, shadow: false },
  { name: 'normalize Text with watching active', kind: 'normalize', mode: 'replace', watching: true, shadow: false },
  { name: 'transfer to a new shadow host with watching stopped', kind: 'new-shadow', mode: 'replace', watching: false, shadow: true },
  { name: 'transfer to a new shadow host with watching active', kind: 'new-shadow', mode: 'replace', watching: true, shadow: true },
  { name: 'transfer to a late shadow attachment with watching stopped', kind: 'late-shadow', mode: 'replace', watching: false, shadow: true },
  { name: 'transfer to a late shadow attachment with watching active', kind: 'late-shadow', mode: 'replace', watching: true, shadow: true },
] as const;

type Scenario = typeof sourceRegressions[number];
interface Driver {
  translate(mode: 'bilingual' | 'replace'): Promise<unknown>;
  restore(): Promise<unknown>;
  pause(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  sources: string[];
}
interface SavedNodes {
  originalTitle: HTMLElement;
  originalText: Node;
  originalChildren: Node[];
  linkTranslation: Element | null;
  titleClicks: number;
}

export async function setupSourceRegression(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(({ kind, shadow }) => {
    const g = globalThis as typeof globalThis & SavedNodes;
    if (kind === 'mixed') {
      document.body.innerHTML = '<p id="source">Read this paragraph with <a href="/docs">the linked documentation</a> and useful content.<img src="x"></p>';
      return;
    }
    document.body.innerHTML = '<p id="one" lang="en">Read <strong id="title">the original title</strong> for details.</p>';
    g.originalTitle = document.querySelector<HTMLElement>('#title')!;
    if (kind === 'normalize') g.originalTitle.innerHTML = 'First source<!-- marker -->second source';
    g.originalText = g.originalTitle.firstChild!;
    g.originalChildren = Array.from(g.originalTitle.childNodes);
    g.titleClicks = 0;
    g.originalTitle.addEventListener('click', () => { g.titleClicks++; });
    if (kind === 'late-shadow') document.body.insertAdjacentHTML('beforeend', '<div id="shadow-host"></div>');
    if (kind === 'transfer') {
      const target = '<p id="two" lang="en">Another paragraph <em>with a note</em> here.</p>';
      if (shadow) {
        const host = document.createElement('div');
        host.id = 'shadow-host';
        document.body.appendChild(host);
        host.attachShadow({ mode: 'open' }).innerHTML = target;
      } else document.body.insertAdjacentHTML('beforeend', target);
    }
  }, scenario);
}

/** Identical behavior assertions against Chromium's real port and Gecko's shim. */
export async function verifySourceRegression(page: Page, scenario: Scenario, driver: Driver): Promise<void> {
  await driver.translate(scenario.mode);
  if (!scenario.watching) await driver.pause();
  if (scenario.kind === 'mixed') {
    const selector = scenario.mode === 'replace' ? '.dual-read-replace-text' : '.dual-read-target';
    await expect(page.locator(`a ${selector}`)).toContainText('译:the linked documentation');
    await expect(page.locator(`#source > ${selector}`)).toContainText('译:Read this paragraph with and useful content.');
    await page.evaluate((sel) => {
      (globalThis as typeof globalThis & SavedNodes).linkTranslation = document.querySelector(`a ${sel}`);
      document.querySelector('#source')!.appendChild(document.createTextNode(' Additional source.'));
    }, selector);
    await expect(page.locator(`#source > ${selector}`)).toContainText('Read this paragraph with and useful content. Additional source.');
    await expect(page.locator(`a ${selector}`)).toContainText('译:the linked documentation');
    expect(await page.evaluate((sel) => document.querySelector(`a ${sel}`) ===
      (globalThis as typeof globalThis & SavedNodes).linkTranslation, selector)).toBe(true);
    await expect.poll(driver.status).toMatchObject({ count: 2, total: 2, failed: 0 });
    expect(driver.sources).toHaveLength(3);
    await driver.restore();
    await expect(page.locator('#source')).toHaveText('Read this paragraph with the linked documentation and useful content. Additional source.');
  } else if (['split', 'normalize', 'new-shadow', 'late-shadow'].includes(scenario.kind)) {
    const transferred = scenario.shadow;
    const selector = transferred ? '#two' : '#one';
    const title = scenario.kind === 'normalize' ? 'First sourcesecond source' : 'the original title';
    const translated = scenario.kind === 'normalize' ? '译:First source译:second source' : `译:${title}`;
    await page.evaluate(({ kind }) => {
      const copy = document.querySelector('#one > strong')!;
      if (kind === 'normalize') copy.normalize();
      else (copy.firstChild as Text).splitText(5);
      if (kind === 'new-shadow' || kind === 'late-shadow') {
        const host = kind === 'new-shadow' ? document.createElement('div') : document.querySelector('#shadow-host')!;
        host.id = 'shadow-host';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<p id="two" lang="en">A new paragraph </p>';
        root.querySelector('p')!.appendChild(copy);
        if (kind === 'new-shadow') document.body.appendChild(host);
      }
    }, scenario);
    if (scenario.watching) {
      await expect(page.locator(`${selector} > strong`)).toHaveText(translated);
      await expect.poll(driver.status).toMatchObject({ count: transferred ? 2 : 1, total: transferred ? 2 : 1, failed: 0 });
      // Check after the mutation debounce too: the initial translated shape
      // can already satisfy the assertion before watching processes a split.
      await page.waitForTimeout(800);
      await expect(page.locator(`${selector} > strong`)).toHaveText(translated);
    }
    expect(driver.sources.every((text) => !text.includes('译:'))).toBe(true);
    await driver.restore();
    await expect(page.locator(selector)).toHaveText(transferred ? `A new paragraph ${title}` : `Read ${title} for details.`);
    if (transferred) await expect(page.locator('#one')).toHaveText('Read  for details.');
    await expect(page.locator(selector)).toHaveAttribute('lang', 'en');
    expect(await page.evaluate((sel) => {
      const g = globalThis as typeof globalThis & SavedNodes;
      const root = document.querySelector('#shadow-host')?.shadowRoot ?? document;
      const node = root.querySelector<HTMLElement>(`${sel} > strong`)!;
      node.click();
      return node === g.originalTitle && node.firstChild === g.originalText
        && g.originalChildren.every((child) => child.parentNode === node) && g.titleClicks === 1;
    }, selector)).toBe(true);
    await driver.translate('bilingual');
    await expect(page.locator(`${selector} > .dual-read-target`)).toContainText(translated);
    await driver.restore();
    expect(driver.sources.every((text) => !text.includes('译:'))).toBe(true);
  } else {
    await page.evaluate(({ kind, shadow }) => {
      const copy = document.querySelector('#one > strong')!;
      const text = copy.firstChild as Text;
      if (kind === 'text') text.insertData(0, 'New prefix ');
      text.appendData(' with more source');
      if (kind === 'transfer') {
        const target = shadow
          ? document.querySelector('#shadow-host')!.shadowRoot!.querySelector('#two')!
          : document.querySelector('#two')!;
        target.appendChild(copy);
      }
    }, scenario);
    const title = `${scenario.kind === 'text' ? 'New prefix ' : ''}the original title with more source`;
    if (scenario.watching) {
      await expect(page.locator(`${scenario.kind === 'text' ? '#one' : '#two'} > strong`)).toHaveText(`译:${title}`);
      await expect.poll(driver.status).toMatchObject({ count: scenario.kind === 'text' ? 1 : 2, total: scenario.kind === 'text' ? 1 : 2, failed: 0 });
    }
    expect(driver.sources.every((text) => !text.includes('译:'))).toBe(true);
    await driver.restore();
    if (scenario.kind === 'text') await expect(page.locator('#one')).toHaveText(`Read ${title} for details.`);
    else {
      await expect(page.locator('#one')).toHaveText('Read  for details.');
      await expect(page.locator('#two')).toHaveText(`Another paragraph with a note here.${title}`);
      await expect(page.locator('#two')).toHaveAttribute('lang', 'en');
    }
    await expect(page.locator('#one')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(({ kind, shadow }) => {
      const g = globalThis as typeof globalThis & SavedNodes;
      const root = shadow ? document.querySelector('#shadow-host')!.shadowRoot! : document;
      const titleNode = root.querySelector(`${kind === 'text' ? '#one' : '#two'} > strong`)!;
      (titleNode as HTMLElement).click();
      return titleNode === g.originalTitle && titleNode.firstChild === g.originalText && g.titleClicks === 1;
    }, scenario)).toBe(true);
    // A mode switch exercises reuse of source identities and cached responses.
    await driver.translate('bilingual');
    await expect(page.locator(`${scenario.kind === 'text' ? '#one' : '#two'} > .dual-read-target`)).toContainText(`译:${title}`);
    await driver.restore();
    expect(driver.sources.every((text) => !text.includes('译:'))).toBe(true);
  }
  const restored = await page.locator('body').innerText();
  await driver.restore();
  expect(await page.locator('body').innerText()).toBe(restored);
  await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-replace-text, .dual-read-original-hidden, style[data-dual-read-style]')).toHaveCount(0);
}
