import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const partialVisibilityCases = ['hide-early', 'hide-late', 'reveal-late', 'cosmetic-late',
  'resize-hide', 'resize-reveal', 'cssom-hide', 'cssom-reveal', 'state-hide'] as const;
export const cssomCases = ['declaration', 'insert-rule', 'adopted-sheet', 'shadow-sheet'] as const;
export const translateCssomSource = (text: string): string => text.startsWith('CSSOM source')
  ? '这是用于验证网页修改布局后仍可正常收起容器的中文说明。'.repeat(10) : `译:${text}`;
interface Controls {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}
interface VisibilitySource { host: HTMLElement; part: HTMLElement; nodes: Node[]; text: Node | null }
interface CssomSource {
  root: Document | ShadowRoot; sheet: CSSStyleSheet; css: string;
  texts: { node: Text; value: string }[]; writes: number; observer?: MutationObserver;
}
declare global { interface Window {
  __partialSource: VisibilitySource;
  __cssomSource: CssomSource;
  __richResponse: { host: HTMLElement; originals: Node[]; texts: { node: Text; value: string }[]; gaps: number[]; frame: number };
} }

export async function verifyPartialVisibility(
  page: Page, scenario: typeof partialVisibilityCases[number], mode: TranslationMode,
  driver: Controls & { requests(): number; delay(ms: number): void; status(): Promise<Record<string, unknown>> },
): Promise<void> {
  await page.setViewportSize(scenario === 'resize-reveal' ? { width: 960, height: 540 } : { width: 1920, height: 1080 });
  await page.evaluate(scenario => {
    document.body.innerHTML = `<input id="toggle" type="checkbox" hidden><main><p id="copy">Always visible documentation. <span id="part" ${scenario === 'reveal-late' ? 'hidden' : ''}>Temporary supplemental information.</span></p></main>`;
    const style = document.createElement('style'); style.id = 'visibility-source';
    style.textContent = scenario.startsWith('resize') ? '@media(max-width:1000px){#part{display:none}}'
      : scenario === 'state-hide' ? '#toggle:checked + main #part{display:none}'
        : scenario.startsWith('cssom') ? `#part{display:${scenario === 'cssom-reveal' ? 'none' : 'inline'}}` : '';
    document.head.append(style);
    const host = document.getElementById('copy')!, part = document.getElementById('part')!;
    window.__partialSource = { host, part, nodes: [...host.childNodes], text: part.firstChild };
  }, scenario);
  driver.delay(scenario === 'hide-early' ? 200 : 1800);
  const before = driver.requests();
  const translating = driver.translate(mode);
  await expect.poll(driver.requests).toBeGreaterThan(before);
  driver.delay(0);
  if (scenario.startsWith('resize')) await page.setViewportSize(scenario === 'resize-hide'
    ? { width: 960, height: 540 } : { width: 1920, height: 1080 });
  else await page.evaluate(scenario => {
    const part = window.__partialSource.part;
    if (scenario === 'cosmetic-late') part.className = 'unrelated-paint';
    else if (scenario.startsWith('cssom')) {
      const sheet = (document.getElementById('visibility-source') as HTMLStyleElement).sheet!;
      (sheet.cssRules[0] as CSSStyleRule).style.display = scenario === 'cssom-hide' ? 'none' : 'inline';
    } else if (scenario === 'state-hide') (document.getElementById('toggle') as HTMLInputElement).checked = true;
    else part.hidden = scenario !== 'reveal-late';
  }, scenario);
  await translating;
  const target = page.locator('#copy .dual-read-target,#copy .dual-read-replace-text');
  await expect(target).toHaveCount(1);
  await expect(target).toContainText('译:Always visible documentation.');
  if (scenario.includes('hide')) await expect(target).not.toContainText('Temporary');
  else await expect(target).toContainText('Temporary');
  await expect.poll(async () => {
    const status = await driver.status();
    return { count: status.count, total: status.total, failed: status.failed };
  }).toEqual({ count: 1, total: 1, failed: 0 });
  expect(driver.requests() - before).toBe(scenario === 'cosmetic-late' ? 1 : 2);
  // Pause and switch modes after the obsolete response has arrived. The page's
  // visibility attributes, source identities and child order must survive.
  await driver.pause();
  await driver.translate(mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(target).toHaveCount(1);
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const { host, part, nodes, text } = window.__partialSource;
    return { identities: [...host.childNodes].every((node, i) => node === nodes[i]) && host.childNodes.length === nodes.length,
      part: part.firstChild === text, hidden: part.hidden,
      text: host.textContent, residual: document.querySelectorAll('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden').length };
  })).toEqual({ identities: true, part: true, hidden: scenario.startsWith('hide'),
    text: 'Always visible documentation. Temporary supplemental information.', residual: 0 });
}

/** A single rich paragraph can exceed the batch slot budget. Its cold response
 * must remain responsive, and both modes must retain every original node. */
export async function verifyRichResponse(page: Page, mode: TranslationMode, driver: Controls & { requests(): number }): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    document.body.innerHTML = `<main><p id="copy">${'<strong>Word </strong>'.repeat(250)}</p></main>`;
    const host = document.getElementById('copy')!;
    window.__richResponse = { host, originals: [...host.childNodes],
      texts: [...host.querySelectorAll('strong')].map(element => ({ node: element.firstChild as Text, value: 'Word ' })), gaps: [], frame: 0 };
    let previous = performance.now();
    const tick = (): void => {
      const now = performance.now(); window.__richResponse.gaps.push(now - previous); previous = now;
      window.__richResponse.frame = requestAnimationFrame(tick);
    };
    window.__richResponse.frame = requestAnimationFrame(tick);
  });
  const before = driver.requests();
  await driver.translate(mode);
  await expect(page.locator(mode === 'bilingual' ? '#copy .dual-read-target strong' : '#copy > strong')).toHaveCount(250);
  // Replacement writes are processed by the 320ms mutation batch after paint.
  // Include that work in the responsiveness budget, not just the API response.
  await page.waitForTimeout(1000);
  const maxGap = await page.evaluate(() => {
    cancelAnimationFrame(window.__richResponse.frame);
    return Math.max(0, ...window.__richResponse.gaps);
  });
  expect(maxGap, 'rich rendering and its mutation batch must remain responsive').toBeLessThan(250);
  expect(driver.requests() - before).toBe(1);
  await driver.pause();
  await driver.translate(mode === 'bilingual' ? 'replace' : 'bilingual');
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const { host, originals, texts } = window.__richResponse;
    return { order: host.childNodes.length === originals.length && [...host.childNodes].every((node, index) => node === originals[index]),
      texts: texts.every(({ node, value }) => node.isConnected && node.data === value),
      residual: document.querySelectorAll('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text').length };
  })).toEqual({ order: true, texts: true, residual: 0 });
}

export async function verifyCssomChange(
  page: Page, scenario: typeof cssomCases[number], mode: TranslationMode, driver: Controls,
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(scenario => {
    document.body.innerHTML = '<cssom-widget></cssom-widget>';
    const root = scenario === 'shadow-sheet' ? document.querySelector('cssom-widget')!.attachShadow({ mode: 'open' }) : document;
    const container = root instanceof Document ? root.body : root;
    const css = 'main{display:flex;align-items:flex-start;gap:30px;font:16px/20px sans-serif}section{width:280px}p{margin:0}#bounds{height:80px;overflow:hidden}#media{display:grid;grid-template-columns:180px 100px}.image{width:180px}.image img{display:block;height:100%;width:auto;max-width:none}#anchors{position:relative;min-height:100px}.anchor{position:absolute;left:0;width:100%}';
    container.innerHTML = '<main><section id="bounds"><p>CSSOM source for a collapsible panel.</p></section><section id="media"><div class="image"><img width="180" height="90" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%2790%27/%3E"></div><p>CSSOM source next to an image.</p></section><section id="anchors"><p>CSSOM source before an anchored footer.</p><div class="anchor" style="top:60px;height:calc(100% - 60px)"><button>Continue</button></div></section></main>';
    const style = document.createElement('style'); style.textContent = css;
    (root instanceof Document ? root.head : root).append(style);
    const sheet = scenario.endsWith('sheet') ? new CSSStyleSheet() : style.sheet!;
    if (scenario.endsWith('sheet')) { sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; style.remove(); }
    const texts: CssomSource['texts'] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('style')) texts.push({ node, value: node.data });
    }
    window.__cssomSource = { root, sheet, css, texts, writes: 0 };
  }, scenario);
  await driver.translate(mode);
  await expect(page.locator('#bounds')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#media img')).toHaveAttribute('data-dual-read-media-bound', /.+/);
  if (mode === 'bilingual') await expect(page.locator('.anchor')).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await driver.pause();
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const source = window.__cssomSource;
    source.observer = new MutationObserver(records => {
      source.writes += records.filter(record => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        return element?.closest('style[data-dual-read-layout-style],style[data-dual-read-media-style],style[data-dual-read-anchor-style]');
      }).length;
    });
    source.observer.observe(source.root, { subtree: true, childList: true, characterData: true });
  });
  // Several fallback checks must leave a stable translation untouched.
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => window.__cssomSource.writes)).toBe(0);
  await page.evaluate(scenario => {
    const { sheet, css } = window.__cssomSource;
    const overrides = '#bounds{height:0px}#media img{height:40px}#anchors .anchor{top:0px!important;height:0px!important}';
    if (scenario === 'declaration') {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (rule.selectorText === '#bounds') rule.style.height = '0px';
        if (rule.selectorText === '.image img') rule.style.height = '40px';
        if (rule.selectorText === '.anchor') { rule.style.setProperty('top', '0px', 'important'); rule.style.setProperty('height', '0px', 'important'); }
      }
    } else if (scenario === 'insert-rule') {
      for (const rule of overrides.split('}').filter(Boolean)) sheet.insertRule(`${rule}}`, sheet.cssRules.length);
    } else sheet.replaceSync(css + overrides);
  }, scenario);
  await expect(page.locator('#bounds')).toHaveCSS('height', '0px');
  await expect(page.locator('#bounds')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#media img')).not.toHaveAttribute('data-dual-read-media-bound', /.+/);
  await expect(page.locator('.anchor')).not.toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await expect(page.locator('#media img')).toHaveCSS('height', '40px');
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const source = window.__cssomSource; source.observer?.disconnect();
    return source.texts.every(({ node, value }) => node.isConnected && node.data === value);
  })).toBe(true);
  await expect(page.locator('#bounds')).toHaveCSS('height', '0px');
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-layout-anchor]')).toHaveCount(0);
}
