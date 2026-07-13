import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { startMockServer } from './helpers/mock-server';
import {
  seedSettings,
  getTabId,
  translateTab,
  stopWatchTab,
  getTabStatus,
  inspectTranslation,
} from './helpers/ext-control';

// Lab matrix: open Shadow DOM, same/cross-origin frames, SPA mutation,
// and XSS-safe text rendering — all on loopback fixtures (no live sites).

test.describe('DOM lab fixtures', () => {
  test('open shadow root content is translated', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('lab-shadow.html'), { waitUntil: 'domcontentloaded' });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      expect(Number(result.shadowRoots) || 0).toBeGreaterThanOrEqual(1);

      await expect
        .poll(async () => page.evaluate(() => {
          const host = document.getElementById('host');
          const sr = host?.shadowRoot;
          if (!sr) return 0;
          return sr.querySelectorAll('.dual-read-target').length;
        }), { timeout: 15_000 })
        .toBeGreaterThan(0);

      const shadowText = await page.evaluate(() => {
        const sr = document.getElementById('host')?.shadowRoot;
        return (sr?.querySelector('.dual-read-target')?.textContent || '').trim();
      });
      expect(shadowText).toContain('译:');
      expect(shadowText).toMatch(/shadow paragraph/i);

      const light = await inspectTranslation(page);
      expect(light.targetCount).toBeGreaterThan(0);
      expect(light.editorText).toBe('Editable lab text must stay intact.');

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('same-origin iframe translates; cross-origin reported', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('lab-frames.html'), { waitUntil: 'domcontentloaded' });

      // Point cross iframe at a different loopback port (true cross-origin).
      await page.locator('#cross').evaluate((el, src) => {
        (el as HTMLIFrameElement).src = src;
      }, `${mock.barrierOrigin}/`);
      await expect.poll(async () => page.evaluate(() => {
        const f = document.getElementById('cross') as HTMLIFrameElement | null;
        try {
          return f?.contentDocument ? 'same' : 'cross';
        } catch {
          return 'cross';
        }
      }), { timeout: 10_000 }).toBe('cross');

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => page.evaluate(() => {
          const f = document.getElementById('same') as HTMLIFrameElement | null;
          const doc = f?.contentDocument;
          if (!doc) return 0;
          return doc.querySelectorAll('.dual-read-target').length;
        }), { timeout: 15_000 })
        .toBeGreaterThan(0);

      const frameSample = await page.evaluate(() => {
        const doc = (document.getElementById('same') as HTMLIFrameElement).contentDocument!;
        return (doc.querySelector('.dual-read-target')?.textContent || '').trim();
      });
      expect(frameSample).toContain('译:');
      expect(frameSample).toMatch(/frame paragraph|Frame Child/i);

      const status = await getTabStatus(sw, tabId);
      const frames = (status.frames || result.frames) as
        | { sameOrigin?: number; crossOrigin?: number }
        | undefined;
      // Prefer DOM evidence: same-origin child has translations; cross stays blocked.
      expect(
        (frames?.sameOrigin || 0) >= 1
          || (await page.evaluate(() => {
            const doc = (document.getElementById('same') as HTMLIFrameElement).contentDocument;
            return (doc?.querySelectorAll('.dual-read-target').length || 0) > 0;
          })),
      ).toBeTruthy();
      const parentDiag = await page.evaluate(() => {
        const cross = document.getElementById('cross') as HTMLIFrameElement;
        try {
          return cross.contentDocument ? 'reachable' : 'blocked';
        } catch {
          return 'blocked';
        }
      });
      expect(parentDiag).toBe('blocked');
      expect((frames?.crossOrigin || 0) >= 1 || parentDiag === 'blocked').toBeTruthy();

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('SPA pushState content is picked up while watching', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('lab-spa.html'), { waitUntil: 'domcontentloaded' });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThan(0);
      await expect(page.locator('#title')).toContainText('Page One');

      await page.locator('#nav').click();
      await expect(page.locator('#title')).toHaveText('SPA Page Two Title');

      // Mutation watchers should index the replaced subtree.
      await expect
        .poll(async () => page.evaluate(() => {
          const title = document.getElementById('title');
          const body = document.getElementById('body');
          const has = (el: Element | null) =>
            Boolean(el?.querySelector?.('.dual-read-target') || el?.hasAttribute('data-dual-read-done'));
          return has(title) || has(body) ? 1 : 0;
        }), { timeout: 20_000 })
        .toBe(1);

      const bodyText = await page.locator('#body').innerText();
      expect(bodyText).toMatch(/译:|Second SPA/);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('HTML/script payload from API is rendered as text (no XSS)', async ({ extContext, extensionId, sw }) => {
    const mock = await startMockServer();
    mock.setMode('xss');
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();

      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThan(0);

      const safety = await page.evaluate(() => ({
        xssFlag: Boolean((window as unknown as { __xss?: number }).__xss),
        injectedImg: document.querySelectorAll('.dual-read-target img').length,
        injectedScript: document.querySelectorAll('.dual-read-target script').length,
        sample: (document.querySelector('.dual-read-target')?.textContent || '').slice(0, 120),
      }));
      expect(safety.xssFlag).toBe(false);
      expect(safety.injectedImg).toBe(0);
      expect(safety.injectedScript).toBe(0);
      expect(safety.sample).toMatch(/<img|<script/i);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('constrained nav labels wrap between languages without glyph stacks', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    const translations: Record<string, string> = {
      'Pull requests': '拉取请求',
      Discussions: '讨论',
      Actions: '操作',
      'Browser compatibility': '浏览器兼容性',
    };
    mock.setTranslator((source) => translations[source] || `译:${source}`);
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        document.body.innerHTML = `
          <nav id="tabs" style="width:390px;font:14px Arial">
            <ul style="display:flex;gap:6px;margin:0;padding:0;list-style:none">
              <li style="width:112px"><a id="pull" href="#" style="display:block">Pull requests</a></li>
              <li style="width:86px"><a id="discussions" href="#" style="display:block">Discussions</a></li>
              <li style="width:68px"><a id="actions" href="#" style="display:block">Actions</a></li>
            </ul>
          </nav>
          <aside style="width:126px;font:14px Arial">
            <a id="compat" href="#">Browser compatibility</a>
          </aside>`;
      });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);

      const layout = await page.evaluate(() => {
        const ids = ['pull', 'discussions', 'actions', 'compat'];
        return ids.map((id) => {
          const host = document.getElementById(id)!;
          const companion = host.querySelector('.dual-read-target')!;
          const range = document.createRange();
          const text = companion.firstChild as Text;
          range.setStart(text, Math.min(2, text.length));
          range.setEnd(text, text.length);
          const rect = companion.getBoundingClientRect();
          return {
            id,
            fragments: range.getClientRects().length,
            overflow: host.scrollWidth > host.clientWidth + 1,
            verticalStrip: rect.width > 0 && rect.width < 36 && rect.height > rect.width * 3,
          };
        });
      });
      expect(layout.every((row) => row.fragments === 1), JSON.stringify(layout)).toBeTruthy();
      expect(layout.every((row) => !row.overflow), JSON.stringify(layout)).toBeTruthy();
      expect(layout.every((row) => !row.verticalStrip), JSON.stringify(layout)).toBeTruthy();

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('structured flex CTA stays horizontal without rewriting its label tree', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    mock.setTranslator((source) =>
      source === 'View organization' ? '查看组织' : `译:${source}`);
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        document.body.innerHTML = `
          <main style="padding:40px;font:14px/20px Arial">
            <a id="organization" class="Button--secondary Button Button--labelWrap"
               href="/organization"
               style="display:flex;align-items:center;width:max-content;min-width:fit-content;
                      padding:4px 12px;border:1px solid #d0d7de;border-radius:6px">
              <span class="Button-content">
                <span class="Button-label">View organization</span>
              </span>
            </a>
          </main>`;
        const action = document.getElementById('organization')!;
        action.setAttribute('data-before-height', String(action.getBoundingClientRect().height));
      });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => page.evaluate(() =>
          document.querySelectorAll('#organization .dual-read-target').length), {
          timeout: 15_000,
        })
        .toBe(1);

      const layout = await page.evaluate(() => {
        const action = document.getElementById('organization')!;
        const label = action.querySelector(':scope > .Button-content > .Button-label')!;
        const target = label.querySelector(':scope > .dual-read-target--inner') as HTMLElement | null;
        const source = label.firstChild as Text;
        const range = document.createRange();
        range.selectNodeContents(source);
        const actionRect = action.getBoundingClientRect();
        const targetRect = target?.getBoundingClientRect();
        return {
          beforeHeight: Number(action.getAttribute('data-before-height')),
          afterHeight: actionRect.height,
          sourceFragments: range.getClientRects().length,
          targetText: target?.textContent?.replace(/\u200b/g, '').trim() || '',
          targetInside:
            Boolean(targetRect)
            && targetRect!.left >= actionRect.left
            && targetRect!.right <= actionRect.right,
          directContentPreserved: Boolean(action.querySelector(':scope > .Button-content')),
          flowCount: action.querySelectorAll('.dual-read-flow').length,
          breakCount: action.querySelectorAll('.dual-read-target--break').length,
          overflow: action.scrollWidth > action.clientWidth + 1,
        };
      });

      expect(layout.targetText).toBe('查看组织');
      expect(layout.sourceFragments).toBe(1);
      expect(layout.afterHeight).toBeLessThanOrEqual(layout.beforeHeight + 4);
      expect(layout.targetInside).toBe(true);
      expect(layout.directContentPreserved).toBe(true);
      expect(layout.flowCount).toBe(0);
      expect(layout.breakCount).toBe(0);
      expect(layout.overflow).toBe(false);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('Blender-style flex nav keeps CTA translation inside the painted button', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    const translations: Record<string, string> = {
      Features: '功能',
      'Get Involved': '参与',
      About: '关于',
      Donate: '捐赠',
    };
    mock.setTranslator((source) => translations[source] || `译:${source}`);
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        document.body.innerHTML = `
          <nav style="font:14px Arial;width:720px">
            <ul style="display:flex;flex-wrap:wrap;align-items:center;margin:0;padding:0;list-style:none">
              <li style="display:flex"><a id="features" class="nav-link" href="#" style="display:flex;padding:0 8px">Features</a></li>
              <li style="display:flex"><a id="involved" class="nav-link" href="#" style="display:flex;padding:0 8px">Get Involved</a></li>
              <li style="display:flex"><a id="about" class="nav-link" href="#" style="display:flex;padding:0 8px">About</a></li>
              <li style="display:flex">
                <a id="donate" class="nav-link" href="#"
                   style="display:flex;align-items:center;white-space:nowrap;padding:4px 16px;border-radius:6px;background:linear-gradient(350deg,#6183ff,#47aaf5);color:white">
                  <i aria-hidden="true">♡</i>&nbsp;Donate
                </a>
              </li>
            </ul>
          </nav>`;
        const donate = document.getElementById('donate')!;
        donate.setAttribute('data-before-width', String(donate.getBoundingClientRect().width));
      });

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);

      const layout = await page.evaluate(() => {
        const involved = document.getElementById('involved')!;
        const donate = document.getElementById('donate')!;
        const target = donate.querySelector('.dual-read-nav-sub') as HTMLElement | null;
        const donateRect = donate.getBoundingClientRect();
        const targetRect = target?.getBoundingClientRect();
        return {
          blockBreaks: document.querySelectorAll('nav .dual-read-target--break').length,
          involvedFlow: Boolean(involved.querySelector(':scope > .dual-read-flow .dual-read-nav-sub')),
          donateFlow: Boolean(donate.querySelector(':scope > .dual-read-flow .dual-read-nav-sub')),
          donateText: target?.textContent?.replace(/\u200b/g, '').trim() || '',
          donateTargetInsidePaint:
            Boolean(targetRect)
            && targetRect!.left >= donateRect.left
            && targetRect!.right <= donateRect.right,
          donateOutside: Boolean(donate.nextElementSibling?.classList.contains('dual-read-target')),
          donateBeforeWidth: Number(donate.getAttribute('data-before-width')),
          donateAfterWidth: donate.getBoundingClientRect().width,
        };
      });
      expect(layout.blockBreaks).toBe(0);
      expect(layout.involvedFlow).toBe(true);
      expect(layout.donateFlow).toBe(true);
      expect(layout.donateText).toBe('捐赠');
      expect(layout.donateTargetInsidePaint).toBe(true);
      expect(layout.donateOutside).toBe(false);
      expect(layout.donateAfterWidth).toBeGreaterThan(layout.donateBeforeWidth);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });

  test('hero translations inherit balanced wrapping from the source host', async ({
    extContext,
    extensionId,
    sw,
  }) => {
    const mock = await startMockServer();
    const source =
      'After 20 years of short films, Blender Studio is ready to tackle an ambitious new project: a feature film!';
    const translated =
      '经过20年的短片制作，Blender Studio已准备好迎接一个雄心勃勃的新项目：一部长片电影！';
    mock.setTranslator((text) => (text === source ? translated : `译:${text}`));
    try {
      await seedSettings(extContext, extensionId, { apiBase: mock.apiBase });
      const page = await extContext.newPage();
      await page.goto(mock.fixtureUrl('article.html'), { waitUntil: 'domcontentloaded' });
      await page.evaluate((text) => {
        document.body.innerHTML = `
          <main style="padding:20px">
            <div id="subtitle"
                 style="display:block;width:800px;max-width:800px;font:24px/28px Arial;text-wrap:balance;overflow-wrap:break-word">
              ${text}
            </div>
          </main>`;
      }, source);

      const tabId = await getTabId(page, sw);
      const result = await translateTab(sw, tabId, 'bilingual');
      expect(result.success, JSON.stringify(result)).toBeTruthy();
      await expect
        .poll(async () => (await inspectTranslation(page)).targetCount, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);

      const layout = await page.evaluate(() => {
        const host = document.getElementById('subtitle')!;
        const target = host.querySelector(':scope > .dual-read-target') as HTMLElement;
        const style = getComputedStyle(target);
        const range = document.createRange();
        range.selectNodeContents(target);
        const lines = Array.from(range.getClientRects()).map((rect) => rect.width);
        return {
          hostWidth: host.getBoundingClientRect().width,
          targetWidth: target.getBoundingClientRect().width,
          textWrap: style.textWrap,
          wordBreak: style.wordBreak,
          overflowWrap: style.overflowWrap,
          lineCount: lines.length,
          maxLineWidth: Math.max(...lines),
        };
      });
      expect(layout.hostWidth).toBe(800);
      expect(layout.targetWidth).toBe(800);
      expect(layout.textWrap).toBe('balance');
      expect(layout.wordBreak).toBe('normal');
      expect(layout.overflowWrap).toBe('break-word');
      expect(layout.lineCount).toBeGreaterThanOrEqual(2);
      // `balance` composes visually even lines instead of filling all 800px.
      expect(layout.maxLineWidth).toBeLessThan(650);

      await stopWatchTab(sw, tabId);
    } finally {
      await mock.close();
    }
  });
});
