import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const inlineVisibilityCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].map(delivered => ({mode, paused, delivered,
    name: `inline visibility regression: ${mode}, paused=${paused}, delivered=${delivered}`}))),
);
type InlineVisibilityCase = typeof inlineVisibilityCases[number];
interface InlineVisibilitySource {
  texts: {node: Text; value: string}[];
  paragraphs: HTMLElement[];
  children: Node[][];
  transferred?: HTMLElement;
}
declare global {interface Window {__inlineVisibilitySource: InlineVisibilitySource}}

export async function verifyInlineVisibilityRegression(
  page: Page, scenario: InlineVisibilityCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(() => {
    const texts: InlineVisibilitySource['texts'] = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {const node = walk.currentNode as Text; if (!node.parentElement?.closest('script,style')) texts.push({node, value: node.data});}
    const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('#source > p[id]'));
    window.__inlineVisibilitySource = {texts, paragraphs, children: paragraphs.map(paragraph => Array.from(paragraph.childNodes))};
    for (const paragraph of paragraphs.slice(0, 6)) {
      const range = document.createRange(); range.selectNodeContents(paragraph.firstElementChild!);
      if (!(range.getBoundingClientRect().width > 100 && range.getBoundingClientRect().height > 10)) throw new Error('Source inline text must actually be visible');
    }
  });
  await controls.translate(scenario.mode);
  for (const id of ['inline-height', 'inline-width', 'inline-indent', 'contents-height', 'contents-width', 'contents-indent', 'rich']) {
    await expect(page.locator('#' + id)).toHaveAttribute('data-dual-read-done', 'true');
    await expect(page.locator('#' + id)).toContainText('译:');
  }
  expect(requests.some(text => text.includes('installation documentation'))).toBe(true);
  expect(requests.some(text => /Hidden |protectedSnippet|Do not translate code|createRoot/.test(text))).toBe(false);
  if (scenario.paused) await controls.pause();
  await page.setViewportSize({width: 1600, height: 900}); await page.waitForTimeout(100);
  for (const id of ['inline-height', 'contents-height']) await expect(page.locator('#' + id)).toContainText('译:');
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(async delivered => {
    const s = window.__inlineVisibilitySource;
    const changed = s.texts.find(({node}) => node.data === 'Visible inline height documentation.')!;
    changed.node.data = 'Updated visible inline documentation.'; changed.value = changed.node.data;
    const code = s.texts.find(({node}) => node.parentElement?.id === 'protected')!;
    code.node.data = 'const currentSnippet = "Page code edit";'; code.value = code.node.data;
    document.getElementById('guide')!.setAttribute('href', '/current-guide');
    s.transferred = document.getElementById('inline-width')!; document.getElementById('receiver')!.appendChild(s.transferred);
    if (delivered) await new Promise(resolve => setTimeout(resolve, 400));
    document.dispatchEvent(new Event('inline-visibility-test:restore'));
  }, scenario.delivered);
  const source = () => page.evaluate(() => {
    const s = window.__inlineVisibilitySource;
    return {texts: s.texts.every(({node, value}) => node.isConnected && node.data === value),
      order: s.paragraphs.every((paragraph, index) => paragraph.childNodes.length === s.children[index].length && Array.from(paragraph.childNodes).every((node, n) => node === s.children[index][n])),
      transfer: s.transferred!.parentElement === document.getElementById('receiver'),
      link: document.getElementById('guide')!.getAttribute('href') === '/current-guide'};
  });
  const expected = {texts: true, order: true, transfer: true, link: true};
  expect(await source()).toEqual(expected); await controls.restore(); expect(await source()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-done]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#inline-height')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#rich')).toContainText('译:');
  await controls.restore(); expect(await source()).toEqual(expected);
  expect(requests.some(text => /Hidden |protectedSnippet|currentSnippet|createRoot/.test(text))).toBe(false);
}
