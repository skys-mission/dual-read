import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { startMockServer } from './helpers/mock-server';
import { seedSettings, getTabId, translateTab, restoreTab, stopWatchTab, getTabStatus } from './helpers/ext-control';
import { sourceRegressions, setupSourceRegression, verifySourceRegression } from './helpers/source-regressions';
import { normalizeRegressions, setupNormalizeRegression, verifyNormalizeRegression } from './helpers/normalize-regressions';
import { chromeTranslate } from '../tools/live-translate-probe/chrome-control.mjs';
import { reconcileRegressions, setupReconcileRegression, verifyReconcileRegression, translateReconcileSource } from './helpers/reconcile-regressions';
import { boundaryRegressions, setupBoundaryRegression, verifyBoundaryRegression, translateBoundarySource } from './helpers/boundary-regressions';

import { unwrappedRegressions, setupUnwrappedRegression, verifyUnwrappedRegression } from './helpers/unwrapped-regressions';

for (const scenario of unwrappedRegressions) {
  test(scenario.name, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator(text => { sources.push(text); return `译:${text}`; });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await setupUnwrappedRegression(page, scenario);
      const tabId = await getTabId(page, sw);
      await verifyUnwrappedRegression(page, scenario, {
        translate: mode => translateTab(sw, tabId, mode),
        restore: () => restoreTab(sw, tabId), pause: () => stopWatchTab(sw, tabId),
        status: () => getTabStatus(sw, tabId), sources,
      });
    } finally { await mock.close(); }
  });
}

for (const scenario of boundaryRegressions) {
  test(scenario.name, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator(text => { sources.push(text); return translateBoundarySource(text, scenario); });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await setupBoundaryRegression(page, scenario);
      const tabId = await getTabId(page, sw);
      await verifyBoundaryRegression(page, scenario, {
        translate: mode => translateTab(sw, tabId, mode),
        restore: () => restoreTab(sw, tabId), pause: () => stopWatchTab(sw, tabId),
        status: () => getTabStatus(sw, tabId), sources,
      });
    } finally { await mock.close(); }
  });
}

for (const scenario of reconcileRegressions) {
  test(scenario.name, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator((text) => { sources.push(text); return translateReconcileSource(text, scenario); });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await setupReconcileRegression(page, scenario);
      const tabId = await getTabId(page, sw);
      await verifyReconcileRegression(page, scenario, {
        translate: (mode) => translateTab(sw, tabId, mode),
        restore: () => restoreTab(sw, tabId), pause: () => stopWatchTab(sw, tabId),
        status: () => getTabStatus(sw, tabId), sources,
      });
    } finally { await mock.close(); }
  });
}

for (const scenario of normalizeRegressions) {
  test(scenario.name, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator((text) => { sources.push(text); return `译:${text}`; });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await setupNormalizeRegression(page, scenario);
      const tabId = await getTabId(page, sw);
      await verifyNormalizeRegression(page, scenario, {
        translate: (mode) => translateTab(sw, tabId, mode),
        restore: () => restoreTab(sw, tabId),
        pause: () => stopWatchTab(sw, tabId),
        status: () => getTabStatus(sw, tabId),
        sources,
      });
    } finally { await mock.close(); }
  });
}

for (const scenario of sourceRegressions) {
  test(scenario.name, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator((text) => { sources.push(text); return `译:${text}`; });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await setupSourceRegression(page, scenario);
      const tabId = await getTabId(page, sw);
      await verifySourceRegression(page, scenario, {
        translate: (mode) => translateTab(sw, tabId, mode),
        restore: () => restoreTab(sw, tabId),
        pause: () => stopWatchTab(sw, tabId),
        status: () => getTabStatus(sw, tabId),
        sources,
      });
    } finally { await mock.close(); }
  });
}

test('live Chrome probe uses formal provider identity, local headers and site overrides', async ({ extContext, extensionId, sw }) => {
  const mock = await startMockServer();
  try {
    await seedSettings(extContext, extensionId, { apiBase: mock.apiBase, targetLang: 'zh-CN' });
    await sw.evaluate(async () => {
      await chrome.storage.local.set({ customHeaders: { 'X-Probe-Profile': 'first' }, dualReadSettingsMeta: { revision: 42 } });
      await chrome.storage.sync.set({ siteRules: [{ host: '127.0.0.1', targetLang: 'fr', mode: 'replace' }] });
    });
    const page = await extContext.newPage();
    await page.goto(mock.fixtureUrl('article.html'));
    await page.evaluate(() => { document.body.innerHTML = '<p id="source">A paragraph for the live probe.</p>'; });
    const tabId = await getTabId(page, sw);
    expect(await chromeTranslate(sw, tabId)).toMatchObject({ ok: true, result: { success: true } });
    await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
    expect(mock.getRequestCount()).toBe(1);
    expect(mock.getSystemPrompts()[0]).toContain('French');
    await expect(page.locator('#source > .dual-read-target')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('#source')).toContainText('译:A paragraph for the live probe.');
    const configs = await sw.evaluate(async (id) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => (globalThis as typeof globalThis & { __DUAL_READ_SESSION__: { active: { config: Record<string, unknown> } } }).__DUAL_READ_SESSION__.active.config,
      });
      return results[0].result;
    }, tabId);
    expect(configs).toMatchObject({ revision: 42, targetLang: 'fr', mode: 'replace', disabled: false });
    expect(configs).not.toHaveProperty('apiKey');
    expect(configs).not.toHaveProperty('customHeaders');
    expect(configs!.providerFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await restoreTab(sw, tabId);
    expect(await chromeTranslate(sw, tabId)).toMatchObject({ ok: true });
    expect(mock.getRequestCount()).toBe(1);
    await restoreTab(sw, tabId);
    await sw.evaluate(() => chrome.storage.local.set({ customHeaders: { 'X-Probe-Profile': 'second' } }));
    expect(await chromeTranslate(sw, tabId)).toMatchObject({ ok: true });
    expect(mock.getRequestCount()).toBe(2);
    await restoreTab(sw, tabId);
  } finally { await mock.close(); }
});

test('site and selection targets reach the provider while globals stay unchanged', async ({ extContext, extensionId, sw }) => {
  const mock = await startMockServer();
  try {
    await seedSettings(extContext, extensionId, { apiBase: mock.apiBase, targetLang: 'zh-CN' });
    const page = await extContext.newPage();
    await page.goto(mock.fixtureUrl('article.html'));
    await page.evaluate(() => { document.body.innerHTML = '<p>Source paragraph for a site language override.</p>'; });
    await sw.evaluate(() => chrome.storage.sync.set({ siteRules: [{ host: '127.0.0.1', targetLang: 'fr' }] }));
    const tabId = await getTabId(page, sw);
    await translateTab(sw, tabId);
    await expect(page.locator('.dual-read-target')).toHaveAttribute('lang', 'fr');
    expect(mock.getSystemPrompts()[0]).toContain('French');
    const globals = await sw.evaluate(() => chrome.storage.sync.get('targetLang'));
    expect(globals.targetLang).toBe('zh-CN');

    // Use the current live session identity through the actual content port.
    await sw.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: async () => {
          const g = globalThis as typeof globalThis & { __DUAL_READ_SESSION__: { active: { config: unknown } }; __DUAL_READ__: { handleMessage: (req: unknown, sender: unknown, reply: (value: unknown) => void) => void } };
          await new Promise((resolve) => g.__DUAL_READ__.handleMessage({ action: 'translateSelection', config: g.__DUAL_READ_SESSION__.active.config, text: 'Another selection for the same French site.' }, null, resolve));
        },
      });
    }, tabId);
    expect(mock.getSystemPrompts()).toHaveLength(2);
    expect(mock.getSystemPrompts()[1]).toContain('French');
    await expect(page.locator('#dual-read-overlay-host').locator('.dr-body')).toContainText('译:');
    await restoreTab(sw, tabId);
    await translateTab(sw, tabId);
    expect(mock.getRequestCount()).toBe(2); // page translation is cached under French
  } finally { await mock.close(); }
});

for (const mode of ['bilingual', 'replace'] as const) {
  test(`source child replacement retranslates in ${mode} mode and restores the new source`, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage(); await page.goto(mock.fixtureUrl('article.html'));
      await page.evaluate(() => { document.body.innerHTML = '<p id="source">Original paragraph before a client update.</p>'; });
      const tabId = await getTabId(page, sw); await translateTab(sw, tabId, mode);
      expect(mock.getRequestCount()).toBe(1);
      await page.evaluate(() => { document.querySelector('#source')!.textContent = 'New paragraph after the client update.'; });
      await expect(page.locator('#source')).toContainText('译:New paragraph after the client update.');
      await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
      // Both rendering and restore emit mutations; neither should retranslate.
      await page.waitForTimeout(800);
      expect(mock.getRequestCount()).toBe(2);
      await restoreTab(sw, tabId);
      await expect(page.locator('#source')).toHaveText('New paragraph after the client update.');
      await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden')).toHaveCount(0);
    } finally { await mock.close(); }
  });

  test(`nested and late shadow roots have styles and restore in ${mode} mode`, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage(); await page.goto(mock.fixtureUrl('lab-shadow.html'));
      const tabId = await getTabId(page, sw); await translateTab(sw, tabId, mode);
      await page.evaluate(() => {
        const nested = document.createElement('div');
        document.querySelector('#host')!.shadowRoot!.appendChild(nested);
        nested.attachShadow({ mode: 'open' }).innerHTML = '<p id="nested" lang="en"><strong>Late shadow</strong> paragraph.</p>';
      });
      await expect(page.locator('#nested')).toContainText('译:Late shadow');
      const layout = await page.evaluate(() => {
        const root = document.querySelector('#host')!.shadowRoot!;
        const p = root.querySelector('#shadow-p')!;
        const target = p.querySelector('.dual-read-target');
        const hidden = p.querySelector('.dual-read-original-hidden');
        return { styles: root.querySelectorAll('style[data-dual-read-style]').length, display: target && getComputedStyle(target).display, hidden: hidden && getComputedStyle(hidden).display };
      });
      expect(layout.styles).toBe(1);
      if (mode === 'bilingual') expect(layout.display).toBe('block');
      else expect(layout.hidden).toBe('none');
      await restoreTab(sw, tabId);
      await expect(page.locator('#shadow-p')).toHaveText('Open shadow paragraph unique marker.');
      await expect(page.locator('#nested')).toHaveText('Late shadow paragraph.');
      await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden, style[data-dual-read-style]')).toHaveCount(0);
      await translateTab(sw, tabId, mode === 'bilingual' ? 'replace' : 'bilingual');
      await expect(page.locator('#nested')).toContainText('译:Late shadow');
      await restoreTab(sw, tabId);
      await expect(page.locator('#nested')).toHaveText('Late shadow paragraph.');
    } finally { await mock.close(); }
  });
}

for (const scenario of ['plain append', 'rich descendant update'] as const) {
  test(`replace mode preserves ${scenario} through retranslation and restore`, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await page.evaluate((selected) => {
        document.body.innerHTML = selected === 'plain append'
          ? '<p id="source" lang="en">Original plain paragraph.</p>'
          : '<p id="source" lang="en"><strong id="emphasis">Old title</strong> original paragraph.</p>';
      }, scenario);
      const tabId = await getTabId(page, sw);
      await translateTab(sw, tabId, 'replace');
      await page.evaluate((selected) => {
        const p = document.querySelector('#source')!;
        if (selected === 'plain append') p.appendChild(document.createTextNode(' Additional source content.'));
        else p.querySelector(':scope > strong')!.textContent = 'New title';
      }, scenario);
      const expected = scenario === 'plain append'
        ? 'Original plain paragraph. Additional source content.'
        : 'New title original paragraph.';
      await expect(page.locator('#source')).toContainText(scenario === 'plain append' ? `译:${expected}` : '译:New title');
      await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
      await restoreTab(sw, tabId);
      await expect(page.locator('#source')).toHaveText(expected);
      await expect(page.locator('#source')).toHaveAttribute('lang', 'en');
      if (scenario === 'rich descendant update') await expect(page.locator('#emphasis')).toHaveText('New title');
      await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden')).toHaveCount(0);
    } finally { await mock.close(); }
  });
}

for (const watching of [false, true]) {
  test(`rich reparenting preserves source with watching ${watching}`, async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    const sources: string[] = [];
    mock.setTranslator((text) => { sources.push(text); return `译:${text}`; });
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await page.evaluate(() => {
        document.body.innerHTML = '<p id="source" lang="en"><strong>First <em id="word">nested title</em></strong> tail text.</p>';
        (globalThis as unknown as { originalWord: Element | null }).originalWord = document.querySelector('#word');
      });
      const tabId = await getTabId(page, sw);
      await translateTab(sw, tabId, 'replace');
      await expect(page.locator('#source > strong em')).toHaveText('译:nested title');
      if (!watching) await stopWatchTab(sw, tabId);
      await page.evaluate(() => {
        const p = document.querySelector('#source')!;
        const word = p.querySelector(':scope > strong em')!;
        p.appendChild(word);
        word.appendChild(document.createTextNode(' New source.'));
      });
      if (watching) {
        await expect(page.locator('#source > em')).toContainText('译:New source.');
        await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
      }
      expect(sources.every((text) => !text.includes('译:'))).toBe(true);
      await restoreTab(sw, tabId);
      await expect(page.locator('#source')).toHaveText('First  tail text.nested title New source.');
      await expect(page.locator('#source')).toHaveAttribute('lang', 'en');
      expect(await page.evaluate(() => document.querySelector('#source > #word') ===
        (globalThis as unknown as { originalWord: Element }).originalWord)).toBe(true);
      await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden')).toHaveCount(0);
      await restoreTab(sw, tabId);
      await expect(page.locator('#source')).toHaveText('First  tail text.nested title New source.');
    } finally { await mock.close(); }
  });
}

test('late link replacement keeps its mixed parent tracked', async ({ extContext, extensionId, sw }) => {
  const mock = await startMockServer();
  // The first segment response makes subsequent link responses arrive after
  // its paint, exercising separate renderer flushes rather than one chunk.
  mock.setTranslator((text) => {
    if (!text.includes('linked')) mock.setResponseDelay(1000);
    return `译:${text}`;
  });
  try {
    await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
    await sw.evaluate(() => chrome.storage.sync.set({ batchSize: 1 }));
    const page = await extContext.newPage();
    await page.goto(mock.fixtureUrl('article.html'));
    await page.evaluate(() => {
      document.body.innerHTML = '<p id="source">Read this paragraph with <a href="/test">the linked documentation</a> and useful content.<img src="x"></p>';
    });
    const tabId = await getTabId(page, sw);
    await translateTab(sw, tabId, 'replace');
    await expect(page.locator('#source a .dual-read-replace-text')).toHaveText('译:the linked documentation');
    await page.waitForTimeout(800); // let the link's own mutations finish debouncing
    expect(await getTabStatus(sw, tabId)).toMatchObject({ count: 2, total: 2, failed: 0 });
    expect(mock.getRequestCount()).toBe(2);
    await restoreTab(sw, tabId);
    await expect(page.locator('#source')).toHaveText('Read this paragraph with the linked documentation and useful content.');
    await expect(page.locator('[data-dual-read-done], .dual-read-replace-text, .dual-read-original-hidden')).toHaveCount(0);
  } finally { await mock.close(); }
});

test('late responses and buffered paints cannot replace newer text', async ({ extContext, extensionId, sw }) => {
  const mock = await startMockServer(); mock.setResponseDelay(1800);
  try {
    await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
    const page = await extContext.newPage(); await page.goto(mock.fixtureUrl('article.html'));
    await page.evaluate(() => { document.body.innerHTML = '<p id="source">Old original paragraph before the request.</p>'; });
    const tabId = await getTabId(page, sw); const translating = translateTab(sw, tabId);
    await expect.poll(() => mock.getRequestCount()).toBe(1);
    mock.setResponseDelay(0);
    await page.evaluate(() => { document.querySelector('#source')!.firstChild!.nodeValue = 'New paragraph while the old request is in flight.'; });
    await expect(page.locator('#source .dual-read-target')).toContainText('译:New paragraph');
    await translating;
    await expect(page.locator('#source .dual-read-target')).toContainText('译:New paragraph');
    expect(await getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
  } finally { await mock.close(); }
});

test('Options cache clear reaches existing tabs and frames without changing their DOM', async ({ extContext, extensionId, sw }) => {
  const mock = await startMockServer(); mock.setTranslator((source) => `OLD:${source}`);
  try {
    await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
    const page = await extContext.newPage(); await page.goto(mock.fixtureUrl('lab-frames.html'));
    const tabId = await getTabId(page, sw); await translateTab(sw, tabId);
    const child = page.frameLocator('#same');
    await expect(child.locator('.dual-read-target').first()).toContainText('OLD:');
    const before = mock.getRequestCount();
    const options = await extContext.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
    options.on('dialog', (dialog) => dialog.accept()); await options.locator('#clearCacheBtn').click();
    await expect.poll(() => options.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('dr:c')).length)).toBe(0);
    await expect(child.locator('.dual-read-target').first()).toContainText('OLD:');
    mock.setTranslator((source) => `NEW:${source}`);
    await restoreTab(sw, tabId); await translateTab(sw, tabId);
    await expect(child.locator('.dual-read-target').first()).toContainText('NEW:');
    await expect(page.locator('.dual-read-target').first()).toContainText('NEW:');
    expect(mock.getRequestCount()).toBeGreaterThan(before);
  } finally { await mock.close(); }
});
