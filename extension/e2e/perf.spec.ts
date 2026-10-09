import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { startMockServer } from './helpers/mock-server';
import {
  seedSettings,
  getTabId,
  translateTab,
  stopWatchTab,
  getTabStatus,
  restoreTab,
} from './helpers/ext-control';
import { PERF_BUDGETS, PERF_FULL, PERF_STRICT, PERF_TIMING_SLACK_MS } from './helpers/perf-budgets';
import {
  installPerfObservers,
  readPerfObservers,
  resetLongTasks,
  waitFirstPaintMs,
  readHeapUsed,
  countTranslationTargets,
  sleep,
} from './helpers/perf-observe';

/**
 * Performance budget lab.
 * Chromium-only; uses loopback mock API + synthetic fixtures.
 *
 *   npm run e2e -- --project=chromium-ext e2e/perf.spec.ts
 *   PERF_STRICT=1 npm run e2e:perf
 *   PERF_FULL=1 npm run e2e:perf:full
 */

test.describe('perf budget lab', () => {
  test(`mock first paint ≤ ${PERF_BUDGETS.firstPaintMockMs}ms`, async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await installPerfObservers(page);
      await page.goto(mock.fixtureUrl('article.html'), {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      const tabId = await getTabId(page, sw);
      const translatePromise = translateTab(sw, tabId, 'bilingual');
      const firstPaint = await waitFirstPaintMs(page, PERF_BUDGETS.firstPaintMockMs + 5_000);
      const result = await translatePromise;

      expect(result.success, JSON.stringify(result)).toBeTruthy();
      expect(firstPaint, 'no translation target appeared').not.toBeNull();
      expect(
        firstPaint!,
        `first paint ${firstPaint}ms exceeds budget ${PERF_BUDGETS.firstPaintMockMs}ms (PERF_STRICT=${PERF_STRICT})`,
      ).toBeLessThanOrEqual(PERF_BUDGETS.firstPaintMockMs + PERF_TIMING_SLACK_MS);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test(`CLS during bilingual translate ≤ ${PERF_BUDGETS.cls}`, async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await installPerfObservers(page);
      await page.goto(mock.fixtureUrl('article.html'), {
        waitUntil: 'domcontentloaded',
      });

      const tabId = await getTabId(page, sw);
      await translateTab(sw, tabId, 'bilingual');
      await expect
        .poll(async () => countTranslationTargets(page), { timeout: 15_000 })
        .toBeGreaterThan(0);

      // Let layout-shift entries settle after buffered renders.
      await sleep(400);
      const snap = await readPerfObservers(page);
      expect(
        snap.cls,
        `CLS ${snap.cls.toFixed(4)} exceeds budget ${PERF_BUDGETS.cls} (PERF_STRICT=${PERF_STRICT})`,
      ).toBeLessThanOrEqual(PERF_BUDGETS.cls);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test(`dense page CLS ≤ ${PERF_BUDGETS.cls}`, async ({
    extContext,
    extensionId,
    sw,
  }) => {
    test.setTimeout(90_000);
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await installPerfObservers(page);
      await page.goto(mock.fixtureUrl('lab-cls-dense.html'), {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });

      const tabId = await getTabId(page, sw);
      await translateTab(sw, tabId, 'bilingual', { timeoutMs: 60_000 });
      await expect
        .poll(async () => countTranslationTargets(page), { timeout: 30_000 })
        .toBeGreaterThan(10);

      await sleep(600);
      const snap = await readPerfObservers(page);
      expect(
        snap.cls,
        `dense CLS ${snap.cls.toFixed(4)} exceeds budget ${PERF_BUDGETS.cls} (PERF_STRICT=${PERF_STRICT})`,
      ).toBeLessThanOrEqual(PERF_BUDGETS.cls);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test(`5k initial index ≤ ${PERF_BUDGETS.index5kMs}ms`, async ({
    extContext,
    extensionId,
    sw,
  }) => {
    test.setTimeout(120_000);
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('lab-perf-5k.html'), {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      const tabId = await getTabId(page, sw);
      // Fire translate but do not wait for full viewport drain — index timing is
      // available on status as soon as indexFullDocument finishes.
      const translatePromise = translateTab(sw, tabId, 'bilingual', { timeoutMs: 90_000 });

      await expect
        .poll(
          async () => {
            const st = await getTabStatus(sw, tabId);
            return Number((st.perf as { lastIndexMs?: number } | undefined)?.lastIndexMs) || 0;
          },
          { timeout: 45_000 },
        )
        .toBeGreaterThan(0);

      const st = await getTabStatus(sw, tabId);
      const indexMs = Number((st.perf as { lastIndexMs?: number } | undefined)?.lastIndexMs) || 0;
      expect(Number(st.total) || 0).toBeGreaterThan(1_000);
      expect(
        indexMs,
        `5k index ${indexMs.toFixed(1)}ms exceeds budget ${PERF_BUDGETS.index5kMs}ms (PERF_STRICT=${PERF_STRICT})`,
      ).toBeLessThanOrEqual(PERF_BUDGETS.index5kMs + PERF_TIMING_SLACK_MS);

      await stopWatchTab(sw, tabId);
      await translatePromise.catch(() => undefined);
    } finally {
      await mock.close();
    }
  });

  test(`SPA mutation index ≤ ${PERF_BUDGETS.mutationMs}ms`, async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('lab-spa.html'), {
        waitUntil: 'domcontentloaded',
      });

      const tabId = await getTabId(page, sw);
      const first = await translateTab(sw, tabId, 'bilingual');
      expect(first.success, JSON.stringify(first)).toBeTruthy();
      await expect
        .poll(async () => countTranslationTargets(page), { timeout: 15_000 })
        .toBeGreaterThan(0);

      await page.locator('#nav').click();
      await expect(page.locator('#title')).toHaveText('SPA Page Two Title');

      // Mutation debounce is ~320ms; poll status until mutation timing updates.
      await expect
        .poll(
          async () => {
            const st = await getTabStatus(sw, tabId);
            const perf = st.perf as { lastMutationIndexMs?: number } | undefined;
            return Number(perf?.lastMutationIndexMs) || 0;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);

      const st = await getTabStatus(sw, tabId);
      const mutationMs = Number((st.perf as { lastMutationIndexMs?: number } | undefined)?.lastMutationIndexMs) || 0;
      expect(
        mutationMs,
        `mutation index ${mutationMs.toFixed(1)}ms exceeds budget ${PERF_BUDGETS.mutationMs}ms (PERF_STRICT=${PERF_STRICT})`,
      ).toBeLessThanOrEqual(PERF_BUDGETS.mutationMs + PERF_TIMING_SLACK_MS);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test.describe('full suite (PERF_FULL=1)', () => {
    test.skip(!PERF_FULL, 'set PERF_FULL=1 for 20k long-task + SPA heap suites');

    test('20k: no long task over budget', async ({ extContext, extensionId, sw }) => {
      test.setTimeout(180_000);

      const mock = await startMockServer();
      try {
        await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
        const page = await extContext.newPage();
        await installPerfObservers(page);
        await page.goto(mock.fixtureUrl('lab-perf-20k.html'), {
          waitUntil: 'domcontentloaded',
          timeout: 90_000,
        });

        const tabId = await getTabId(page, sw);
        // Exclude page parse / first layout long tasks (captured via buffered
        // observer) — the budget covers extension work during index+translate.
        await resetLongTasks(page);
        await translateTab(sw, tabId, 'bilingual');
        await sleep(500);
        const snap = await readPerfObservers(page);
        expect(
          snap.longTaskMaxMs,
          `long task ${snap.longTaskMaxMs.toFixed(1)}ms > ${PERF_BUDGETS.longTask20kMs}ms (${snap.longTaskCount} tasks)`,
        ).toBeLessThanOrEqual(PERF_BUDGETS.longTask20kMs + PERF_TIMING_SLACK_MS);

        await stopWatchTab(sw, tabId);
      } finally {
        await mock.close();
      }
    });

    test('30× SPA nav: heap growth within budget', async ({ extContext, extensionId, sw }) => {
      test.setTimeout(180_000);

      const mock = await startMockServer();
      try {
        await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
        const page = await extContext.newPage();
        await page.goto(mock.fixtureUrl('lab-spa.html'), {
          waitUntil: 'domcontentloaded',
        });

        const tabId = await getTabId(page, sw);
        await translateTab(sw, tabId, 'bilingual');
        await expect
          .poll(async () => countTranslationTargets(page), { timeout: 15_000 })
          .toBeGreaterThan(0);

        const navigate = async (n: number) => {
          await page.evaluate((iteration) => {
            const app = document.getElementById('app');
            if (!app) return;
            history.pushState({ n: iteration }, '', `${location.pathname}?n=${iteration}`);
            app.innerHTML =
              `<h1 id="title">SPA Iter ${iteration}</h1>` +
              `<p id="body">SPA heap probe paragraph number ${iteration} with unique text.</p>` +
              `<button type="button" id="nav">Navigate</button>`;
          }, n);
          await sleep(400);
          return getTabStatus(sw, tabId);
        };
        // Exercise mutation indexing, cache events and request teardown before
        // taking the baseline; first-use compilation is not retained DOM growth.
        for (let i = -5; i < 0; i++) await navigate(i);
        const baseline = await readHeapUsed(page);
        expect(baseline).not.toBeNull();

        let lastTotal = Number((await getTabStatus(sw, tabId)).total) || 0;
        for (let i = 0; i < PERF_BUDGETS.spaNavCount; i++) {
          const st = await navigate(i);
          const total = Number(st.total) || 0;
          expect(total).toBeGreaterThanOrEqual(lastTotal);
          lastTotal = total;
        }

        const after = await readHeapUsed(page);
        expect(after).not.toBeNull();
        const growth = (after! - baseline!) / baseline!;
        expect(
          growth,
          `retained heap ${baseline} → ${after}; growth ${(growth * 100).toFixed(1)}% exceeds ${(PERF_BUDGETS.spaHeapGrowth * 100).toFixed(0)}%`,
        ).toBeLessThanOrEqual(PERF_BUDGETS.spaHeapGrowth);

        await stopWatchTab(sw, tabId);
      } finally {
        await mock.close();
      }
    });

    test('30× rich replace SPA nav, split/normalize and attributes: heap growth within budget', async ({ extContext, extensionId, sw }) => {
      test.setTimeout(180_000);
      const mock = await startMockServer();
      try {
        await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
        const page = await extContext.newPage();
        await page.goto(mock.fixtureUrl('lab-spa.html'));
        const tabId = await getTabId(page, sw);
        const replacePage = (n: number) => page.evaluate((iteration) => {
          document.querySelector('#app')!.innerHTML =
            `<p id="rich"><strong>First source ${iteration}<!-- marker -->second source</strong> for <a href="/before">details</a>.</p>`;
        }, n);
        await replacePage(-6);
        await translateTab(sw, tabId, 'replace');
        const navigate = async (n: number) => {
          await replacePage(n);
          await expect(page.locator('#rich > strong')).toHaveText(`译:First source ${n}译:second source`);
          await page.evaluate((iteration) => {
            const copy = document.querySelector('#rich > strong')!;
            copy.normalize();
            (copy.firstChild as Text).insertData(`译:First source ${iteration}`.length, ' appended ');
          }, n);
          await expect(page.locator('#rich > strong')).toContainText(`译:First source ${n} appended`);
          // The edited merged Text already contains that prefix. Wait for
          // retranslation to rebuild separate slots before moving just one.
          await expect.poll(() => page.evaluate(() => document.querySelector('#rich > strong')!.childNodes.length)).toBe(2);
          await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 1, total: 1, failed: 0 });
          // Move a retained slot into a page-owned survivor before the next
          // navigation, exercising the shared history outside rich hosts.
          await page.evaluate((iteration) => {
            const fresh = document.createElement('p');
            fresh.id = 'fresh';
            fresh.append('Fresh source ');
            document.querySelector('#app')!.appendChild(fresh);
            const strong = document.querySelector('#rich > strong')!;
            const length = strong.firstChild!.nodeValue!.length;
            strong.normalize();
            (strong.firstChild as Text).splitText(length);
            document.querySelector('#rich > a')!.setAttribute('href', `/updated-${iteration}`);
            fresh.appendChild(strong.firstChild!);
            fresh.normalize();
          }, n);
          await expect(page.locator('#fresh')).toContainText(`译:Fresh source First source ${n} appended`);
          await expect(page.locator('#rich > a')).toHaveAttribute('href', `/updated-${n}`);
          await expect.poll(() => getTabStatus(sw, tabId)).toMatchObject({ count: 2, total: 2, failed: 0 });
        };
        // Warm shared document history and cross-host transfers before measuring
        // detached replacement trees across subsequent SPA navigations.
        for (let i = -5; i < 0; i++) await navigate(i);
        const baseline = await readHeapUsed(page);
        expect(baseline).not.toBeNull();
        for (let i = 0; i < PERF_BUDGETS.spaNavCount; i++) await navigate(i);
        const after = await readHeapUsed(page);
        expect(after).not.toBeNull();
        const growth = (after! - baseline!) / baseline!;
        expect(growth,
          `rich replace retained heap ${baseline} → ${after}; growth ${(growth * 100).toFixed(1)}% exceeds ${(PERF_BUDGETS.spaHeapGrowth * 100).toFixed(0)}%`,
        ).toBeLessThanOrEqual(PERF_BUDGETS.spaHeapGrowth);
        await restoreTab(sw, tabId);
        await expect(page.locator('#rich')).toHaveText('second source for details.');
        await expect(page.locator('#rich > a')).toHaveAttribute('href', `/updated-${PERF_BUDGETS.spaNavCount - 1}`);
        await expect(page.locator('#fresh')).toHaveText(`Fresh source First source ${PERF_BUDGETS.spaNavCount - 1} appended`);
      } finally { await mock.close(); }
    });
  });
});
