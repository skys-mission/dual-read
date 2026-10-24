import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const boundedScaleCases = (['self', 'ancestor', 'individual', 'zoom', 'nested', 'fractional', 'translated3d'] as const)
  .flatMap(transform => (['bilingual', 'replace'] as const).map(mode => ({ transform, mode })));
export const boundedPercentageCases = (['inline', 'cssom', 'viewport'] as const)
  .flatMap(change => (['bilingual', 'replace'] as const)
    .flatMap(mode => [false, true].map(paused => ({ change, mode, paused }))));

interface Driver {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}
interface BoundedSource { host: HTMLElement; text: Node; value: string; parent: Node | null }
declare global { interface Window { __boundedSizingSources: BoundedSource[] } }

export function translateBoundedSizingText(): string {
  return '用于检查容器布局和动态页面更新的翻译文本。'.repeat(4);
}

async function rememberSources(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__boundedSizingSources = [...document.querySelectorAll<HTMLElement>('p')].map(host => ({
      host, text: host.firstChild!, value: host.textContent!, parent: host.parentNode,
    }));
  });
}

async function expectRestored(page: Page, driver: Driver): Promise<void> {
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => window.__boundedSizingSources.every(({ host, text, value, parent }) =>
    host.parentNode === parent && host.childNodes.length === 1 && host.firstChild === text && host.textContent === value,
  ))).toBe(true);
  await expect(page.locator('[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toHaveCount(0);
}

/** The unscaled peer is an independent browser-layout oracle: both containers
 * have the same text, width and CSS height, regardless of their painted scale. */
export async function verifyBoundedScale(page: Page, scenario: typeof boundedScaleCases[number], driver: Driver): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(transform => {
    const transforms = {
      self: '#scaled{transform:scale(2)}',
      ancestor: '#wrapper{transform:scale(1.5,2)}',
      individual: '#wrapper{scale:2}',
      zoom: '#wrapper{zoom:1.5}',
      nested: '#wrapper{transform:scale(1.5)}#scaled{transform:scale(1.25)}',
      fractional: '#wrapper{transform:scale(.5)}.box{height:80.25px;padding:7.5px;border:1.25px solid;box-sizing:content-box}',
      translated3d: '#wrapper{transform:translate3d(20px,10px,0) scale(1.5,2)}',
    };
    document.body.innerHTML = `<style>body{margin:8px;font:16px/20px sans-serif}p{margin:0}.box{width:260px;height:80px;overflow:hidden;transform-origin:top left}#wrapper{position:absolute;left:400px;top:8px;transform-origin:top left}${transforms[transform]}</style><main><section id="reference" class="box"><p>Original paragraph with useful details for readers.</p></section><div id="wrapper"><section id="scaled" class="box"><p>Original paragraph with useful details for readers.</p></section></div></main>`;
  }, scenario.transform);
  await rememberSources(page);
  const height = (id: string) => page.locator(`#${id}`).evaluate(node => parseFloat(getComputedStyle(node).height));
  const before = await height('scaled');
  try {
    await driver.translate(scenario.mode);
    await expect(page.locator('#scaled .dual-read-target')).toHaveCount(1);
    await expect(page.locator('#reference .dual-read-target')).toHaveCount(1);
    await expect(page.locator('#scaled')).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await expect.poll(async () => Math.abs(await height('scaled') - await height('reference'))).toBeLessThan(2);
    // A wider container must release its historical floor after text reflows.
    const expanded = await height('reference');
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.box').forEach(box => { box.style.width = '520px'; }));
    await expect.poll(() => height('reference')).toBeLessThan(expanded - 20);
    await expect.poll(async () => Math.abs(await height('scaled') - await height('reference'))).toBeLessThan(2);
    await expectRestored(page, driver);
    expect(await height('scaled')).toBeCloseTo(before, 1);
  } finally { await driver.restore(); }
}

export async function verifyBoundedPercentage(page: Page, scenario: typeof boundedPercentageCases[number], driver: Driver): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(change => {
    document.body.innerHTML = `<style>body{margin:8px;font:16px/20px sans-serif}p{margin:0}#parent{width:300px;height:80px;overflow:auto}#percent{width:260px;height:100%;overflow:hidden}</style><style id="parent-sizing">${change === 'viewport' ? '@media(min-width:1800px){#parent{height:400px}}' : '#parent{height:80px}'}</style><main id="parent"><section id="percent"><p>Original paragraph with useful details for readers.</p></section></main>`;
  }, scenario.change);
  await rememberSources(page);
  const setExpanded = async (expanded: boolean) => {
    if (scenario.change === 'viewport') await page.setViewportSize({ width: expanded ? 1920 : 1600, height: 900 });
    else await page.evaluate(({ change, expanded }) => {
      const height = expanded ? '400px' : '80px';
      if (change === 'inline') document.getElementById('parent')!.style.height = height;
      else ((document.getElementById('parent-sizing') as HTMLStyleElement).sheet!.cssRules[0] as CSSStyleRule).style.height = height;
    }, { change: scenario.change, expanded });
  };
  const height = () => page.locator('#percent').evaluate(node => parseFloat(getComputedStyle(node).height));
  try {
    await driver.translate(scenario.mode);
    await expect(page.locator('#percent')).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await expect.poll(height).toBeGreaterThan(80);
    if (scenario.paused) await driver.pause();
    const target = await page.locator('#percent .dual-read-target').elementHandle();
    await setExpanded(true);
    await expect.poll(height).toBeCloseTo(400, 1);
    await setExpanded(false);
    await expect.poll(height).toBeLessThan(300);
    await expect.poll(height).toBeGreaterThan(80);
    expect(await target!.evaluate(node => node.isConnected)).toBe(true);
    await expectRestored(page, driver);
    expect(await height()).toBe(80);
  } finally { await driver.restore(); }
}
