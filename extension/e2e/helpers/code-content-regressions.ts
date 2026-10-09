import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const codeContentCases = (['bilingual', 'replace'] as const).map(mode => ({
  mode, name: `code content boundaries: ${mode}`,
}));

export async function verifyCodeContentRegression(
  page: Page,
  mode: TranslationMode,
  controls: { translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown> },
  sources: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-code-test]'));
    const snapshot = blocks.map(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      return {element, markup:element.innerHTML, nodes, values:nodes.map(node => node.nodeValue)};
    });
    Object.assign(window, {__codeContentSnapshot:snapshot});
  });
  await controls.translate(mode);
  await expect.poll(() => page.locator('#preview .dual-read-target,#preview .dual-read-replace-text').count(), {timeout:15000}).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#ordinary .dual-read-target,#ordinary .dual-read-replace-text').count(), {timeout:15000}).toBeGreaterThan(0);

  const intact = () => page.evaluate(() => {
    const state = window as unknown as {__codeContentSnapshot: {element:HTMLElement;markup:string;nodes:Text[];values:(string|null)[]}[]};
    return state.__codeContentSnapshot.filter(({element,nodes,values,markup}) =>
      !element.isConnected || element.innerHTML !== markup
      || nodes.some((node,index) => !node.isConnected || node.nodeValue !== values[index])
      || Boolean(element.closest('.dual-read-original-hidden') && !element.closest('#inline-copy'))
      || Boolean(element.querySelector('.dual-read-target,.dual-read-replace-text')),
    ).map(({element}) => element.outerHTML.slice(0,200));
  });
  expect(await intact()).toEqual([]);
  expect(sources.some(text => /CODE_\w+_SENTINEL|function Video|createRoot/.test(text))).toBe(false);

  await page.evaluate(() => {
    const late = document.getElementById('late')!;
    late.innerHTML = '<div class="cm-content" id="late-code"><div><span>CODE_LATE_SENTINEL</span></div></div><p id="late-copy">Newly added documentation should still translate.</p>';
  });
  await expect.poll(() => page.locator('#late-copy .dual-read-target,#late-copy .dual-read-replace-text').count(), {timeout:15000}).toBeGreaterThan(0);
  expect(await page.locator('#late-code').textContent()).toBe('CODE_LATE_SENTINEL');
  expect(await page.locator('#late-code .dual-read-target,#late-code .dual-read-replace-text').count()).toBe(0);
  expect(sources.some(text => text.includes('CODE_LATE_SENTINEL'))).toBe(false);

  await page.evaluate(() => {
    const code = document.querySelector<HTMLElement>('#semantic-panel [data-code-test]')!;
    code.querySelector('.sp-syntax-keyword')!.firstChild!.nodeValue = 'page-edited-function';
    const comment = document.createElement('span');
    comment.id = 'page-code-comment';
    comment.textContent = ' // page-added-code-comment';
    code.append(comment);
  });
  await controls.restore();
  expect(await page.locator('#semantic-panel .sp-syntax-keyword').textContent()).toBe('page-edited-function');
  expect(await page.locator('#page-code-comment').textContent()).toBe(' // page-added-code-comment');
  const restoration = await page.evaluate(() => {
    const state = window as unknown as {__codeContentSnapshot: {element:HTMLElement;nodes:Text[]}[]};
    return state.__codeContentSnapshot.every(({element,nodes}) =>
      element.isConnected && nodes.every(node => node.isConnected && element.contains(node)),
    );
  });
  expect(restoration).toBe(true);
  expect(await page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden').count()).toBe(0);
}
