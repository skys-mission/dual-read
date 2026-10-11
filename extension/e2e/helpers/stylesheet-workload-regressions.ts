import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

declare global { interface Window { __layoutSourceWrites: number } }

export const stylesheetWorkloadModes = ['bilingual', 'replace'] as const;
export const layoutWorkloadCases = ['bounds', 'media', 'media-grid', 'anchors', 'clamps'] as const;
type LayoutWorkload = typeof layoutWorkloadCases[number];
export const translateStylesheetWorkloadText = (text: string): string => text.startsWith('Bounded workload')
  || text.startsWith('Layout workload')
  || text.startsWith('Synchronous workload')
  ? '这段译文用于验证固定高度容器可以完整展示内容。'.repeat(10) : `译:${text}`;

interface WorkloadSource {
  texts: { node: Text; value: string }[];
  paragraph: HTMLElement;
  children: Node[];
  link: HTMLAnchorElement;
  gaps: number[];
  frame: number;
}

/** Author callbacks can change another contract during our write pass. The
 * later owner must be checked again before installing its important rule. */
export async function verifySynchronousLayoutChange(
  page: Page,
  controls: { translate: () => Promise<unknown>; restore: () => Promise<unknown> },
): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(() => {
    let secondWrites = 0;
    customElements.define('dr-layout-source-box', class extends HTMLElement {
      static get observedAttributes(): string[] { return ['data-dual-read-layout-height']; }
      attributeChangedCallback(_name: string, _old: string | null, value: string | null): void {
        if (!value) return;
        if (this.id === 'first-box') document.getElementById('second-box')!.style.height = '0px';
        else secondWrites++;
      }
    });
    document.body.innerHTML = '<style>body{margin:8px;font:16px/20px sans-serif}main{width:300px}.box{display:block;height:80px;overflow:hidden}p{margin:0}</style><main><dr-layout-source-box id="first-box" class="box"><p>Synchronous workload first source paragraph.</p></dr-layout-source-box><dr-layout-source-box id="second-box" class="box"><p>Synchronous workload second source paragraph.</p></dr-layout-source-box></main>';
    const texts = Array.from(document.querySelectorAll('p')).map(p => ({node: p.firstChild as Text, value: p.textContent!}));
    const paragraph = document.querySelector('p')!;
    window.__stylesheetWorkload = {texts, paragraph, children: Array.from(paragraph.childNodes),
      link: document.createElement('a'), gaps: [], frame: 0};
    Object.defineProperty(window, '__layoutSourceWrites', {get: () => secondWrites});
  });
  await controls.translate();
  await expect(page.locator('#first-box')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#second-box')).toHaveCSS('height', '0px');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__layoutSourceWrites)).toBe(0);
  await controls.restore();
  expect(await page.evaluate(() => window.__stylesheetWorkload.texts.every(({node, value}) => node.isConnected && node.data === value))).toBe(true);
  await expect(page.locator('#second-box')).toHaveCSS('height', '0px');
}
declare global { interface Window { __stylesheetWorkload: WorkloadSource } }

/** Large readable stylesheets used to make ordinary, already-fitting prose
 * block the main thread during the post-render ancestor checks. */
export async function verifyStylesheetWorkload(
  page: Page,
  mode: TranslationMode,
  controls: { translate: () => Promise<unknown>; pause: () => Promise<unknown>; restore: () => Promise<unknown> },
  requests: string[],
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    const utilities = Array.from({ length: 6000 }, (_, index) =>
      `.utility-${index}{height:${index % 200 + 10}px;min-height:0;padding-block:2px;color:rgb(10,20,30)}`).join('');
    document.body.innerHTML = `<style>@layer utilities{${utilities}}body{margin:8px;font:16px/20px sans-serif}main{width:640px}p{margin:0 0 8px}#bounded{height:80px;overflow:hidden}#flow{padding-top:12px}</style><main><section id="bounded"><p>Bounded workload first paragraph.</p><p>Bounded workload second paragraph.</p></section><section id="flow">${Array.from({ length: 120 }, (_, index) => `<p id="flow-${index}">Workload documentation paragraph ${index}. <a href="#guide">Read the guide</a>.</p>`).join('')}</section><pre><code>function ProtectedWorkloadCode() { return "Keep source code"; }</code></pre></main>`;
    const texts: WorkloadSource['texts'] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('style,script')) texts.push({ node, value: node.data });
    }
    const paragraph = document.getElementById('flow-0')!;
    window.__stylesheetWorkload = { texts, paragraph, children: Array.from(paragraph.childNodes),
      link: paragraph.querySelector('a')!, gaps: [], frame: 0 };
  });
  // Exclude initial stylesheet parsing/first layout from the extension budget.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const source = window.__stylesheetWorkload;
    let previous = performance.now();
    const tick = (): void => {
      const time = performance.now();
      source.gaps.push(time - previous); previous = time;
      source.frame = requestAnimationFrame(tick);
    };
    source.frame = requestAnimationFrame(tick);
  });
  await controls.translate();
  await expect(page.locator('#flow-0')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#bounded')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await page.waitForFunction(() => window.__stylesheetWorkload.gaps.length >= 12);
  await page.waitForTimeout(500);
  const maxFrameGap = await page.evaluate(() => Math.max(...window.__stylesheetWorkload.gaps));
  // A crash guard, with ample shared-CI margin, rather than a frame-rate target.
  expect(maxFrameGap, `6000 stylesheet rules blocked rendering for ${maxFrameGap.toFixed(1)}ms (${mode})`).toBeLessThan(1200);
  await controls.pause();
  await page.evaluate(() => {
    const source = window.__stylesheetWorkload;
    cancelAnimationFrame(source.frame);
    const first = source.texts.find(({ node }) => source.paragraph.contains(node))!;
    first.node.data = 'Page edited workload documentation. '; first.value = first.node.data;
    source.link.setAttribute('href', '#current-guide');
    document.getElementById('bounded')!.style.height = '50px';
  });
  await expect(page.locator('#bounded')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  await controls.restore();
  expect(await page.evaluate(() => {
    const source = window.__stylesheetWorkload;
    return { texts: source.texts.every(({ node, value }) => node.isConnected && node.data === value),
      order: source.paragraph.childNodes.length === source.children.length
        && Array.from(source.paragraph.childNodes).every((node, index) => node === source.children[index]),
      link: source.link.getAttribute('href') === '#current-guide',
      height: document.getElementById('bounded')!.style.height === '50px' };
  })).toEqual({ texts: true, order: true, link: true, height: true });
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height]')).toHaveCount(0);
  expect(requests.some(text => /ProtectedWorkloadCode|Keep source code/.test(text))).toBe(false);
}

/** Real candidates exercise capture and validation, not only fitting flow.
 * Also keep paused CSS updates and sibling-selector dependencies responsive. */
export async function verifyLayoutWorkload(
  page: Page,
  scenario: LayoutWorkload,
  mode: TranslationMode,
  controls: { translate: () => Promise<unknown>; pause: () => Promise<unknown>; restore: () => Promise<unknown> },
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(scenario => {
    const utilities = Array.from({ length: 6000 }, (_, index) =>
      `.utility-${index}{height:${index % 200 + 10}px;min-height:0;padding-block:2px;color:rgb(10,20,30)}`).join('');
    const media = '<div class="image"><img width="180" height="90" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27180%27 height=%2790%27/%3E"></div>';
    const anchor = '<div class="anchor" style="top:60px;height:calc(100% - 60px)"><button>Continue</button></div>';
    document.body.innerHTML = `<style>@layer utilities{${utilities}}body{margin:8px;font:16px/20px sans-serif}main{display:grid;grid-template-columns:repeat(4,280px);gap:12px}p{margin:0 0 8px}.card{position:relative;min-height:100px}.bounds{height:100px;overflow:hidden}.media{display:flex;align-items:stretch}.media-grid{display:grid;grid-template-columns:180px 100px}.image{width:180px;flex:none}.image img{display:block;height:100%;width:auto;max-width:none}.prose{flex:1;min-width:0}.anchor{position:absolute;left:0;width:100%}body[data-author-change] .card{max-height:40px;overflow:hidden}</style><main>${Array.from({ length: 24 }, (_, index) => `<section id="card-${index}" class="card ${scenario}">${scenario.startsWith('media') ? media : ''}<div class="prose"><p id="source-${index}-0">Layout workload card ${index}, first explanation.</p><p id="source-${index}-1">Layout workload card ${index}, second explanation.</p></div>${scenario === 'anchors' ? anchor : ''}</section>`).join('')}</main><pre id="outside">Outside the translated cards.</pre>`;
    if (scenario === 'clamps') {
      const style = document.createElement('style');
      style.textContent = '.clamps .prose{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}';
      document.head.append(style);
    }
    const texts: WorkloadSource['texts'] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('style,script')) texts.push({ node, value: node.data });
    }
    const paragraph = document.getElementById('source-0-0')!;
    window.__stylesheetWorkload = { texts, paragraph, children: Array.from(paragraph.childNodes),
      link: document.createElement('a'), gaps: [], frame: 0 };
  }, scenario);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const startClock = async (): Promise<void> => {
    await page.evaluate(() => {
      const source = window.__stylesheetWorkload;
      source.gaps = [];
      let previous = performance.now();
      const tick = (): void => {
        const time = performance.now(); source.gaps.push(time - previous); previous = time;
        source.frame = requestAnimationFrame(tick);
      };
      source.frame = requestAnimationFrame(tick);
    });
  };
  const checkClock = async (phase: string): Promise<void> => {
    // Pump fresh frames after browser automation returns, so a blocked callback
    // cannot be absent from the sample just because its rAF has not run yet.
    await page.waitForFunction(() => window.__stylesheetWorkload.gaps.length >= 20);
    await page.waitForTimeout(500);
    const gap = await page.evaluate(() => {
      cancelAnimationFrame(window.__stylesheetWorkload.frame);
      return Math.max(...window.__stylesheetWorkload.gaps);
    });
    expect(gap, `${scenario}/${mode}/${phase} blocked for ${gap.toFixed(1)}ms`).toBeLessThan(1200);
  };
  await startClock();
  await controls.translate();
  await expect(page.locator('p[data-dual-read-done]')).toHaveCount(48);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text').filter({ hasText: '这段译文' })).toHaveCount(48);
  if (scenario === 'bounds') await expect(page.locator('.card[data-dual-read-layout-height]')).toHaveCount(24);
  if (scenario === 'media-grid') await expect(page.locator('[data-dual-read-media-bound]')).toHaveCount(24);
  if (scenario === 'anchors' && mode === 'bilingual') await expect(page.locator('[data-dual-read-layout-anchor]')).toHaveCount(24);
  if (scenario === 'clamps' && mode === 'bilingual') await expect(page.locator('.card > .dual-read-target')).toHaveCount(48);
  await checkClock('translation');
  await controls.pause();
  await startClock();
  await page.waitForTimeout(2200);
  await checkClock('idle source policy checks');
  await startClock();
  await page.evaluate(() => document.getElementById('outside')!.setAttribute('data-unused-workload', '1'));
  await checkClock('paused sibling attribute');
  await startClock();
  await page.evaluate(() => document.body.setAttribute('data-author-change', 'true'));
  await expect(page.locator('[data-dual-read-layout-height],[data-dual-read-media-bound]')).toHaveCount(0);
  await checkClock('paused author sizing');
  await controls.restore();
  expect(await page.evaluate(() => window.__stylesheetWorkload.texts.every(({ node, value }) => node.isConnected && node.data === value))).toBe(true);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-layout-anchor]')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-author-change', 'true');
}
