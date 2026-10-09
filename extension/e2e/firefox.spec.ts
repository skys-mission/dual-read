import { test, expect, firefox } from '@playwright/test';
import { withExtension } from 'playwright-webextext';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './helpers/mock-server';
import { pageLayoutCases, setupPageLayoutRegression, verifyPageLayoutRegression } from './helpers/page-layout-regressions';
import { feedLayoutCases, setupFeedLayoutRegression, translateFeedText, verifyFeedLayoutRegression } from './helpers/feed-layout-regressions';
import { codeContentCases, verifyCodeContentRegression } from './helpers/code-content-regressions';
import { reviewLayoutCases, translateReviewLayoutText, verifyReviewLayoutRegression } from './helpers/review-layout-regressions';
import { dynamicLayoutCases, translateDynamicLayoutText, verifyDynamicLayoutRegression } from './helpers/dynamic-layout-regressions';
import { presentationLayoutCases, translatePresentationText, verifyPresentationLayoutRegression } from './helpers/presentation-layout-regressions';
import { layoutLifecycleCases, translateLayoutLifecycleText, verifyLayoutLifecycleRegression } from './helpers/layout-lifecycle-regressions';
import { layoutPolicyCases, translateLayoutPolicyText, verifyLayoutPolicyRegression, verifyResumedFooter } from './helpers/layout-policy-regressions';
import {flowStyleCases, translateFlowStyleText, verifyFlowStyleRegression} from './helpers/flow-style-regressions';
import {stylesheetLayoutCases, translateStylesheetText, verifyStylesheetLayoutRegression} from './helpers/stylesheet-layout-regressions';
import {mediaPolicyCases, translateMediaPolicyText, verifyMediaPolicyRegression} from './helpers/media-policy-regressions';
import {inlineVisibilityCases, verifyInlineVisibilityRegression} from './helpers/inline-visibility-regressions';
import {layoutNeighborCases, translateNeighborText, verifyLayoutNeighborRegression} from './helpers/layout-neighbor-regressions';
import {cascadeLayoutCases, translateCascadeText, verifyCascadeLayoutRegression} from './helpers/cascade-layout-regressions';
import {positionedLayoutCases, translatePositionedText, verifyPositionedLayoutRegression} from './helpers/positioned-layout-regressions';
import {specificityVisibilityCases, translateSpecificityText, verifySpecificityVisibilityRegression} from './helpers/specificity-visibility-regressions';
import {motionPolicyGroups, translateMotionPolicyText, verifyMotionPolicyRegression} from './helpers/motion-policy-regressions';
import {sharedPolicyGroups, translateSharedPolicyText, verifySharedPolicyRegression} from './helpers/shared-policy-regressions';
import {nestingPaddingCases, translateNestingPaddingText, verifyNestingPaddingRegression} from './helpers/nesting-padding-regressions';
import {logicalNestingCases, translateLogicalText, verifyLogicalNestingRegression} from './helpers/logical-nesting-regressions';
import { startRealProxy } from './helpers/real-proxy';
import { sourceRegressions, setupSourceRegression, verifySourceRegression } from './helpers/source-regressions';
import { normalizeRegressions, setupNormalizeRegression, verifyNormalizeRegression } from './helpers/normalize-regressions';
import { reconcileRegressions, setupReconcileRegression, verifyReconcileRegression, translateReconcileSource } from './helpers/reconcile-regressions';
import { boundaryRegressions, setupBoundaryRegression, verifyBoundaryRegression, translateBoundarySource } from './helpers/boundary-regressions';
import { unwrappedRegressions, setupUnwrappedRegression, verifyUnwrappedRegression } from './helpers/unwrapped-regressions';
import {
  FIREFOX_EXT_PATH,
  launchFirefoxGeckoContext,
  installFirefoxDualRead,
  firefoxTranslatePage,
  firefoxRestore,
  firefoxStopWatch,
  firefoxStatus,
  inspectTranslation,
} from './helpers/firefox-gecko';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const FIREFOX_EXT = path.resolve(dirname, '../output/firefox-mv3');

for (const scenario of motionPolicyGroups) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-motion-policy.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateMotionPolicyText);}});
      await page.evaluate(() => document.addEventListener('motion-policy-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifyMotionPolicyRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of sharedPolicyGroups) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-shared-policy.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateSharedPolicyText);}});
      await page.evaluate(() => document.addEventListener('shared-policy-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifySharedPolicyRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of nestingPaddingCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-nesting-padding.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateNestingPaddingText);}});
      await page.evaluate(() => document.addEventListener('nesting-padding-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifyNestingPaddingRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of logicalNestingCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-logical-nesting.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateLogicalText);}});
      await page.evaluate(() => document.addEventListener('logical-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifyLogicalNestingRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of specificityVisibilityCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-specificity-visibility.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateSpecificityText);}});
      await page.evaluate(() => document.addEventListener('specificity-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifySpecificityVisibilityRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of positionedLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-positioned-layout.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translatePositionedText);}});
      await page.evaluate(() => document.addEventListener('positioned-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifyPositionedLayoutRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of cascadeLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-cascade-layout.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts);return texts.map(translateCascadeText);}});
      await page.evaluate(() => document.addEventListener('cascade-test:restore',() => globalThis.__DUAL_READ__?.restore()));
      await verifyCascadeLayoutRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of layoutNeighborCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-layout-neighbors.html'));
      await installFirefoxDualRead(page,{translate:async texts => {requests.push(...texts); return texts.map(translateNeighborText);}});
      await page.evaluate(() => {document.addEventListener('layout-neighbor-test:restore',() => globalThis.__DUAL_READ__?.restore());});
      await verifyLayoutNeighborRegression(page,scenario,{translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page)},requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const scenario of inlineVisibilityCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(), requests: string[] = [];
    try {
      const page = await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-inline-visibility.html'));
      await installFirefoxDualRead(page, {translate: async texts => {requests.push(...texts); return texts.map(text => `译:${text}`);}});
      await page.evaluate(() => {document.addEventListener('inline-visibility-test:restore', () => globalThis.__DUAL_READ__?.restore());});
      await verifyInlineVisibilityRegression(page, scenario, {translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page)}, requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const scenario of mediaPolicyCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(), fx = await launchFirefoxGeckoContext(); const requests: string[] = [];
    try {
      const page = await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-media-policy.html'));
      await installFirefoxDualRead(page, {translate: async texts => {requests.push(...texts); return texts.map(translateMediaPolicyText);}});
      await page.evaluate(() => {document.addEventListener('media-policy-test:restore', () => globalThis.__DUAL_READ__?.restore());});
      await verifyMediaPolicyRegression(page, scenario, {translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page)}, requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const scenario of stylesheetLayoutCases) {
  test(scenario.name, async () => {
    const mock=await startMockServer(),fx=await launchFirefoxGeckoContext();const requests:string[]=[];
    try {
      const page=await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-stylesheet-layout.html'));
      await installFirefoxDualRead(page,{translate:async texts=>{requests.push(...texts);return texts.map(translateStylesheetText);}});
      await page.evaluate(()=>{document.addEventListener('stylesheet-layout-test:restore',()=>globalThis.__DUAL_READ__?.restore());});
      await verifyStylesheetLayoutRegression(page,scenario,{translate:mode=>firefoxTranslatePage(page,mode),restore:()=>firefoxRestore(page),pause:()=>firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of flowStyleCases) {
  test(scenario.name, async () => {
    const mock=await startMockServer(), fx=await launchFirefoxGeckoContext(); const requests:string[]=[];
    try {
      const page=await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-flow-style.html'));
      await installFirefoxDualRead(page,{translate:async texts=>{requests.push(...texts);return texts.map(translateFlowStyleText);}});
      await page.evaluate(()=>{document.addEventListener('flow-style-test:restore',()=>globalThis.__DUAL_READ__?.restore());});
      await verifyFlowStyleRegression(page,scenario,{translate:mode=>firefoxTranslatePage(page,mode),restore:()=>firefoxRestore(page),pause:()=>firefoxStopWatch(page)},requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const delivered of [false, true]) {
  test(`layout policy resumed footer: delivered=${delivered}`, async () => {
    const mock = await startMockServer(); const fx = await launchFirefoxGeckoContext(); const requests: string[] = [];
    try {
      const page = await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-layout-policy.html'));
      await installFirefoxDualRead(page, {translate: async texts => {requests.push(...texts); return texts.map(translateLayoutPolicyText);}});
      await page.evaluate(() => {document.addEventListener('layout-policy-test:restore', () => globalThis.__DUAL_READ__?.restore());});
      await verifyResumedFooter(page, delivered, {
        translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      }, requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const scenario of layoutPolicyCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer(); const fx = await launchFirefoxGeckoContext(); const requests: string[] = [];
    try {
      const page = await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-layout-policy.html'));
      await installFirefoxDualRead(page, {translate: async texts => {requests.push(...texts); return texts.map(translateLayoutPolicyText);}});
      await page.evaluate(() => {document.addEventListener('layout-policy-test:restore', () => globalThis.__DUAL_READ__?.restore());});
      await verifyLayoutPolicyRegression(page, scenario, {
        translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      }, requests);
    } finally {await fx.close(); await mock.close();}
  });
}

for (const scenario of layoutLifecycleCases) {
  test(scenario.name, async () => {
    const mock=await startMockServer();const fx=await launchFirefoxGeckoContext();const requests:string[]=[];
    try {
      const page=await fx.context.newPage();await page.goto(mock.fixtureUrl('lab-layout-lifecycle.html'));
      await installFirefoxDualRead(page,{translate:async texts=>{requests.push(...texts);return texts.map(translateLayoutLifecycleText);}});
      await page.evaluate(()=>{document.addEventListener('layout-lifecycle-test:restore',()=>globalThis.__DUAL_READ__?.restore());});
      await verifyLayoutLifecycleRegression(page,scenario,{translate:mode=>firefoxTranslatePage(page,mode),restore:()=>firefoxRestore(page),pause:()=>firefoxStopWatch(page)},requests);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of presentationLayoutCases) {
  test(scenario.name, async () => {
    const mock=await startMockServer(); const fx=await launchFirefoxGeckoContext(); const sources:string[]=[];
    try {
      const page=await fx.context.newPage(); await page.goto(mock.fixtureUrl('lab-presentation-layout.html'));
      await installFirefoxDualRead(page,{translate:async texts => {sources.push(...texts);return texts.map(translatePresentationText);}});
      await page.evaluate(() => {document.addEventListener('presentation-layout-test:restore',() => globalThis.__DUAL_READ__?.restore());});
      await verifyPresentationLayoutRegression(page,scenario,{
        translate:mode => firefoxTranslatePage(page,mode),restore:() => firefoxRestore(page),pause:() => firefoxStopWatch(page),
      },sources);
    } finally {await fx.close();await mock.close();}
  });
}

for (const scenario of dynamicLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    const sources: string[] = [];
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('lab-dynamic-layout.html'));
      await installFirefoxDualRead(page, { translate: async texts => {
        sources.push(...texts); return texts.map(translateDynamicLayoutText);
      } });
      await page.evaluate(() => {
        document.addEventListener('dynamic-layout-test:restore', () => globalThis.__DUAL_READ__?.restore());
      });
      await verifyDynamicLayoutRegression(page, scenario, {
        translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      }, sources);
    } finally { await fx.close(); await mock.close(); }
  });
}

for (const scenario of reviewLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    const sources: string[] = [];
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('lab-review-layout.html'));
      await installFirefoxDualRead(page, { translate: async texts => {
        sources.push(...texts); return texts.map(translateReviewLayoutText);
      } });
      await page.evaluate(() => {
        document.addEventListener('review-layout-test:restore', () => globalThis.__DUAL_READ__?.restore());
      });
      await verifyReviewLayoutRegression(page, scenario, {
        translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      }, sources);
    } finally { await fx.close(); await mock.close(); }
  });
}

for (const scenario of codeContentCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    const sources: string[] = [];
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('lab-code-content.html'));
      await installFirefoxDualRead(page, {translate:async texts => {
        sources.push(...texts); return texts.map(text => `译:${text}`);
      }});
      await verifyCodeContentRegression(page, scenario.mode, {
        translate: mode => firefoxTranslatePage(page, mode), restore: () => firefoxRestore(page),
      }, sources);
    } finally { await fx.close(); await mock.close(); }
  });
}

for (const scenario of pageLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('lab-page-layout.html'));
      await setupPageLayoutRegression(page);
      await installFirefoxDualRead(page);
      await page.evaluate(() => {
        document.addEventListener('page-layout-test:restore', () => globalThis.__DUAL_READ__?.restore());
      });
      await verifyPageLayoutRegression(page, scenario, {
        translate: mode => firefoxTranslatePage(page, mode),
        restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      });
    } finally { await fx.close(); await mock.close(); }
  });
}

for (const scenario of feedLayoutCases) {
  test(scenario.name, async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('lab-feed-layout.html'));
      await setupFeedLayoutRegression(page);
      await installFirefoxDualRead(page, { translate: async texts => texts.map(translateFeedText) });
      await page.evaluate(() => {
        document.addEventListener('feed-layout-test:restore', () => globalThis.__DUAL_READ__?.restore());
      });
      await verifyFeedLayoutRegression(page, scenario, {
        translate: mode => firefoxTranslatePage(page, mode),
        restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
      });
    } finally { await fx.close(); await mock.close(); }
  });
}

/**
 * Firefox E2E:
 * 1) Temporary-addon load smoke via playwright-webextext (real gecko.id).
 * 2) Translate main path on Gecko via content harness — Playwright cannot drive
 *    moz-extension:// / Firefox MV3 service workers like Chromium.
 *    Harness loads built firefox-mv3 dual-read.js (same artifact users ship).
 */

test.describe('firefox extension load', () => {
  test('builds output exists', () => {
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'manifest.json'))).toBeTruthy();
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'popup.html'))).toBeTruthy();
    expect(fs.existsSync(path.join(FIREFOX_EXT, 'dual-read.js'))).toBeTruthy();
    const manifest = JSON.parse(fs.readFileSync(path.join(FIREFOX_EXT, 'manifest.json'), 'utf8'));
    expect(manifest.browser_specific_settings?.gecko?.id).toBe('dual-read@skysmission.github.io');
    expect(FIREFOX_EXT_PATH).toBe(FIREFOX_EXT);
  });

  test('loads temporary addon and browses without crash', async () => {
    // launch() (not persistent) avoids a playwright-webextext bug when the MV3
    // manifest has neither content_scripts nor optional_permissions arrays.
    const browserType = withExtension(firefox, FIREFOX_EXT);
    const mock = await startMockServer();
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await expect(page.locator('#title')).toHaveText('Hello World');
    } finally {
      await browser.close();
      await mock.close();
    }
  });
});

test.describe('firefox translate main path (Gecko content harness)', () => {
  for (const scenario of unwrappedRegressions) {
    test(scenario.name, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const sources: string[] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await setupUnwrappedRegression(page, scenario);
        await installFirefoxDualRead(page, { translate: async texts => {
          sources.push(...texts); return texts.map(text => `译:${text}`);
        } });
        await verifyUnwrappedRegression(page, scenario, {
          translate: mode => firefoxTranslatePage(page, mode),
          restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
          status: () => firefoxStatus(page), sources,
        });
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const scenario of boundaryRegressions) {
    test(scenario.name, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const sources: string[] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await setupBoundaryRegression(page, scenario);
        await installFirefoxDualRead(page, { translate: async texts => {
          sources.push(...texts); return texts.map(text => translateBoundarySource(text, scenario));
        } });
        await verifyBoundaryRegression(page, scenario, {
          translate: mode => firefoxTranslatePage(page, mode),
          restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
          status: () => firefoxStatus(page), sources,
        });
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const scenario of reconcileRegressions) {
    test(scenario.name, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const sources: string[] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await setupReconcileRegression(page, scenario);
        await installFirefoxDualRead(page, { translate: async (texts) => {
          sources.push(...texts);
          return texts.map((text) => translateReconcileSource(text, scenario));
        } });
        await verifyReconcileRegression(page, scenario, {
          translate: (mode) => firefoxTranslatePage(page, mode),
          restore: () => firefoxRestore(page), pause: () => firefoxStopWatch(page),
          status: () => firefoxStatus(page), sources,
        });
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const scenario of normalizeRegressions) {
    test(scenario.name, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const sources: string[] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await setupNormalizeRegression(page, scenario);
        await installFirefoxDualRead(page, { translate: async (texts) => {
          sources.push(...texts);
          return texts.map((text) => `译:${text}`);
        } });
        await verifyNormalizeRegression(page, scenario, {
          translate: (mode) => firefoxTranslatePage(page, mode),
          restore: () => firefoxRestore(page),
          pause: () => firefoxStopWatch(page),
          status: () => firefoxStatus(page),
          sources,
        });
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const scenario of sourceRegressions) {
    test(scenario.name, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const sources: string[] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await setupSourceRegression(page, scenario);
        await installFirefoxDualRead(page, { translate: async (texts) => {
          sources.push(...texts);
          return texts.map((text) => `译:${text}`);
        } });
        await verifySourceRegression(page, scenario, {
          translate: (mode) => firefoxTranslatePage(page, mode),
          restore: () => firefoxRestore(page),
          pause: () => firefoxStopWatch(page),
          status: () => firefoxStatus(page),
          sources,
        });
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const watching of [false, true]) {
    test(`rich reparenting preserves source with watching ${watching}`, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      const requests: string[][] = [];
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('article.html'));
        await page.evaluate(() => {
          document.body.innerHTML = '<p id="source" lang="en"><strong>First <em id="word">nested title</em></strong> tail text.</p>';
          (globalThis as unknown as { originalWord: Element | null }).originalWord = document.querySelector('#word');
        });
        await installFirefoxDualRead(page, { translate: async (texts) => {
          requests.push([...texts]);
          return texts.map((text) => `译:${text}`);
        } });
        expect((await firefoxTranslatePage(page, 'replace')).success).toBeTruthy();
        await expect(page.locator('#source > strong em')).toHaveText('译:nested title');
        if (!watching) await firefoxStopWatch(page);
        await page.evaluate(() => {
          const p = document.querySelector('#source')!;
          const word = p.querySelector(':scope > strong em')!;
          p.appendChild(word);
          word.appendChild(document.createTextNode(' New source.'));
        });
        if (watching) await expect(page.locator('#source > em')).toContainText('译:New source.');
        expect(requests.flat().every((text) => !text.includes('译:'))).toBe(true);
        await firefoxRestore(page);
        await expect(page.locator('#source')).toHaveText('First  tail text.nested title New source.');
        await expect(page.locator('#source')).toHaveAttribute('lang', 'en');
        expect(await page.evaluate(() => document.querySelector('#source > #word') ===
          (globalThis as unknown as { originalWord: Element }).originalWord)).toBe(true);
        await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden')).toHaveCount(0);
        await firefoxRestore(page);
        await expect(page.locator('#source')).toHaveText('First  tail text.nested title New source.');
      } finally { await fx.close(); await mock.close(); }
    });
  }

  for (const mode of ['bilingual', 'replace'] as const) {
    test(`dynamic source and nested shadows restore cleanly in ${mode} mode`, async () => {
      const mock = await startMockServer();
      const fx = await launchFirefoxGeckoContext();
      try {
        const page = await fx.context.newPage();
        await page.goto(mock.fixtureUrl('lab-shadow.html'));
        await installFirefoxDualRead(page);
        expect((await firefoxTranslatePage(page, mode)).success).toBeTruthy();
        await expect(page.locator('#shadow-p')).toContainText('译:Open shadow');
        await page.evaluate(() => {
          const root = document.querySelector('#host')!.shadowRoot!;
          root.querySelector('#shadow-p')!.textContent = 'Updated shadow paragraph after a client render.';
          const host = document.createElement('div'); root.appendChild(host);
          host.attachShadow({ mode: 'open' }).innerHTML = '<p id="nested" lang="en"><strong>Late shadow</strong> paragraph.</p>';
        });
        await expect(page.locator('#shadow-p')).toContainText('译:Updated shadow');
        await expect(page.locator('#nested')).toContainText('译:Late shadow');
        expect(await page.evaluate((selectedMode) => {
          const root = document.querySelector('#host')!.shadowRoot!;
          const p = root.querySelector('#shadow-p')!;
          const node = p.querySelector(selectedMode === 'bilingual' ? '.dual-read-target' : '.dual-read-original-hidden')!;
          return { styles: root.querySelectorAll('style[data-dual-read-style]').length, display: getComputedStyle(node).display };
        }, mode)).toEqual({ styles: 1, display: mode === 'bilingual' ? 'block' : 'none' });
        await firefoxRestore(page);
        await expect(page.locator('#shadow-p')).toHaveText('Updated shadow paragraph after a client render.');
        await expect(page.locator('#nested')).toHaveText('Late shadow paragraph.');
        await expect(page.locator('[data-dual-read-done], .dual-read-target, .dual-read-original-hidden, style[data-dual-read-style]')).toHaveCount(0);
        expect((await firefoxTranslatePage(page, mode === 'bilingual' ? 'replace' : 'bilingual')).success).toBeTruthy();
        await expect(page.locator('#nested')).toContainText('译:Late shadow');
        await firefoxRestore(page);
        await expect(page.locator('#nested')).toHaveText('Late shadow paragraph.');
      } finally { await fx.close(); await mock.close(); }
    });
  }

  test('late Gecko responses cannot overwrite a changed source', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    let calls = 0;
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'));
      await page.evaluate(() => { document.body.innerHTML = '<p id="source">Old source before the translation request.</p>'; });
      await installFirefoxDualRead(page, { translate: async (texts) => {
        if (++calls === 1) await new Promise((resolve) => setTimeout(resolve, 1800));
        return texts.map((text) => `译:${text}`);
      } });
      const translating = firefoxTranslatePage(page);
      await expect.poll(() => calls).toBe(1);
      await page.evaluate(() => { document.querySelector('#source')!.firstChild!.nodeValue = 'New source while the old response is pending.'; });
      await expect(page.locator('#source .dual-read-target')).toContainText('译:New source');
      await translating;
      await expect(page.locator('#source .dual-read-target')).toContainText('译:New source');
      await firefoxRestore(page);
      await expect(page.locator('#source')).toHaveText('New source while the old response is pending.');
    } finally { await fx.close(); await mock.close(); }
  });

  test('Gecko reaches the real proxy contract', async () => {
    const upstream = await startMockServer();
    const proxy = await startRealProxy(upstream.origin);
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(`${proxy.origin}/livez`);
      const result = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'e2e-mock',
            messages: [{ role: 'user', content: JSON.stringify({ 0: 'firefox proxy smoke' }) }],
          }),
        });
        return {
          status: response.status,
          cache: response.headers.get('x-cache'),
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      }, `${proxy.apiBase}/chat/completions`);
      expect(result.status).toBe(200);
      expect(result.cache).toBe('MISS');
      expect(result.contentType).toContain('application/json');
      expect(result.body).toContain('firefox proxy smoke');
      expect(upstream.getRequestCount()).toBe(1);
    } finally {
      await fx.close();
      await proxy.close();
      await upstream.close();
    }
  });

  test('bilingual → restore leaves original DOM', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      await expect(page.locator('#title')).toHaveText('Hello World');

      await installFirefoxDualRead(page);
      const result = await firefoxTranslatePage(page, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      expect(Number(result.total) || Number(result.count) || 0).toBeGreaterThan(0);

      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.targetSamples.some((t) => t.includes('译:'))).toBeTruthy();
      expect(after.editorText).toBe('Do not translate this editable text.');

      await firefoxRestore(page);
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 10_000 })
        .toBe(0);

      const restored = await inspectTranslation(page);
      expect(restored.doneCount).toBe(0);
      expect(restored.titleText).toBe('Hello World');
      expect(restored.p1Text).toContain('first paragraph');
      expect(restored.editorText).toBe('Do not translate this editable text.');
    } finally {
      await fx.close();
      await mock.close();
    }
  });

  test('replace mode hides original and shows translation', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await installFirefoxDualRead(page);

      const result = await firefoxTranslatePage(page, 'replace');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => {
          const i = await inspectTranslation(page);
          return i.replaceCount + i.hideCount + i.targetCount;
        }, { timeout: 20_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.doneCount).toBeGreaterThan(0);
      expect(after.hideCount + after.replaceCount + after.targetCount).toBeGreaterThan(0);
      expect(after.editorText).toBe('Do not translate this editable text.');
      await firefoxStopWatch(page);
    } finally {
      await fx.close();
      await mock.close();
    }
  });

  test('API auth failure surfaces errors without mutating editable', async () => {
    const mock = await startMockServer();
    const fx = await launchFirefoxGeckoContext();
    try {
      const page = await fx.context.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await installFirefoxDualRead(page, { batchMode: 'auth_fail' });

      const result = await firefoxTranslatePage(page, 'bilingual');
      // start() may still succeed (indexed); failures appear as error chrome.
      expect(String(result.error || ''), JSON.stringify(result)).not.toMatch(/timed out/i);

      await expect
        .poll(async () => (await inspectTranslation(page)).errorCount, { timeout: 45_000 })
        .toBeGreaterThan(0);

      const after = await inspectTranslation(page);
      expect(after.editorText).toBe('Do not translate this editable text.');
      expect(after.targetSamples.every((t) => !t.includes('译:'))).toBeTruthy();
      await firefoxStopWatch(page);
    } finally {
      await fx.close();
      await mock.close();
    }
  });
});
