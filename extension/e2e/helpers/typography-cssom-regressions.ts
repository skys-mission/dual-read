import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const typographyCssomCases = ['declaration', 'insert-rule', 'adopted-sheet', 'shadow-sheet'] as const;
type TypographyCase = typeof typographyCssomCases[number];
interface TypographySource {
  root: Document | ShadowRoot;
  sheet: CSSStyleSheet;
  css: string;
  host: HTMLElement;
  run: HTMLElement;
  text: Node;
  code: HTMLElement;
  codeText: string;
  targetWrites: number;
  sourceWrites: number;
  targetObserver?: MutationObserver;
  sourceObserver?: MutationObserver;
}
declare global { interface Window { __typographySource: TypographySource } }

async function changeTypography(page: Page, scenario: TypographyCase, color: string, size: number): Promise<void> {
  await page.evaluate(({ scenario, color, size }) => {
    const { sheet, css } = window.__typographySource;
    const overrides = `#typo-panel{background:white}#typo-run{color:${color};font-size:${size}px;line-height:${size * 1.5}px}`;
    if (scenario === 'declaration') {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (rule.selectorText === '#typo-panel') rule.style.background = 'white';
        if (rule.selectorText === '#typo-run') {
          rule.style.color = color;
          rule.style.fontSize = `${size}px`;
          rule.style.lineHeight = `${size * 1.5}px`;
        }
      }
    } else if (scenario === 'insert-rule') {
      for (const rule of overrides.split('}').filter(Boolean)) sheet.insertRule(`${rule}}`, sheet.cssRules.length);
    } else sheet.replaceSync(css + overrides);
  }, { scenario, color, size });
}

/** Pure CSSOM changes must update copied paint in both modes, without another
 * translation or writes to page source. Pausing translation still follows CSS. */
export async function verifyTypographyCssom(
  page: Page, scenario: TypographyCase, mode: TranslationMode,
  driver: { translate(mode: TranslationMode): Promise<unknown>; pause(): Promise<unknown>; restore(): Promise<unknown>; requests(): number },
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(scenario => {
    document.body.innerHTML = '<typography-widget></typography-widget>';
    const root = scenario === 'shadow-sheet' ? document.querySelector('typography-widget')!.attachShadow({ mode: 'open' }) : document;
    const container = root instanceof Document ? root.body : root;
    container.innerHTML = '<main id="typo-panel"><p id="typo-copy"><span id="typo-run">Readable documentation with useful instructions.</span></p><pre><code>const keepSourceCode = true;</code></pre></main>';
    const css = '#typo-panel{background:black;color:black;padding:20px;font:16px/24px sans-serif}#typo-copy{margin:0;color:black;font-size:16px;line-height:24px}#typo-run{color:white;font-size:18px;line-height:27px}pre{color:orange}';
    const style = document.createElement('style'); style.textContent = css;
    (root instanceof Document ? root.head : root).append(style);
    const sheet = scenario.endsWith('sheet') ? new CSSStyleSheet() : style.sheet!;
    if (scenario.endsWith('sheet')) { sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; style.remove(); }
    const host = root.querySelector<HTMLElement>('#typo-copy')!, run = root.querySelector<HTMLElement>('#typo-run')!;
    const code = root.querySelector<HTMLElement>('code')!;
    window.__typographySource = { root, sheet, css, host, run, text: run.firstChild!, code, codeText: code.textContent!, targetWrites: 0, sourceWrites: 0 };
  }, scenario);
  await driver.translate(mode);
  const target = page.locator('#typo-copy .dual-read-target');
  await expect(target).toHaveCount(1);
  await expect(target).toHaveCSS('color', 'color(srgb 1 1 1 / 0.84)');
  await expect(target).toHaveCSS('font-size', '18px');
  const requests = driver.requests();
  await page.evaluate(() => {
    const source = window.__typographySource;
    source.targetObserver = new MutationObserver(records => { source.targetWrites += records.length; });
    source.targetObserver.observe(source.host.querySelector('.dual-read-target')!, { attributes: true, attributeFilter: ['style'] });
    source.sourceObserver = new MutationObserver(records => { source.sourceWrites += records.length; });
    source.sourceObserver.observe(source.run, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => window.__typographySource.targetWrites)).toBe(0);

  await changeTypography(page, scenario, 'black', 24);
  await expect(target).toHaveCSS('font-size', '24px');
  await expect(target).toHaveCSS('line-height', '36px');
  await expect(target).toHaveCSS('color', 'color(srgb 0 0 0 / 0.84)');
  expect(await target.evaluate(element => (element as HTMLElement).style.color)).toBe('');
  await driver.pause();
  await changeTypography(page, scenario, 'blue', 26);
  await expect(target).toHaveCSS('font-size', '26px');
  await expect(target).toHaveCSS('color', 'color(srgb 0 0 1 / 0.84)');

  // Page-owned overrides remain authoritative while other copied values update.
  await target.evaluate(element => (element as HTMLElement).style.setProperty('color', 'green', 'important'));
  await changeTypography(page, scenario, 'red', 28);
  await expect(target).toHaveCSS('font-size', '28px');
  await expect(target).toHaveCSS('color', 'rgb(0, 128, 0)');
  expect(await target.evaluate(element => (element as HTMLElement).style.getPropertyPriority('color'))).toBe('important');
  expect(driver.requests()).toBe(requests);
  expect(await page.evaluate(() => window.__typographySource.sourceWrites)).toBe(0);
  await page.evaluate(() => {
    window.__typographySource.targetObserver?.disconnect();
    window.__typographySource.sourceObserver?.disconnect();
  });
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const source = window.__typographySource;
    return { run: source.host.firstChild === source.run && source.host.childNodes.length === 1,
      text: source.run.firstChild === source.text && source.text.nodeValue === 'Readable documentation with useful instructions.',
      code: source.code.isConnected && source.code.textContent === source.codeText,
      color: getComputedStyle(source.run).color, font: getComputedStyle(source.run).fontSize,
      residual: source.root.querySelectorAll('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text').length };
  })).toEqual({ run: true, text: true, code: true, color: 'rgb(255, 0, 0)', font: '28px', residual: 0 });
}
