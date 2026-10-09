import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const layoutPolicyCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].flatMap(delivered =>
    (['finish', 'cancel'] as const).map(motion => ({mode, paused, delivered, motion,
      name: `layout policy regression: ${mode}, ${motion}, paused=${paused}, delivered=${delivered}`})),
  )),
);
type PolicyCase = typeof layoutPolicyCases[number];
export function translateLayoutPolicyText(text: string): string {
  return text.startsWith('Expansion')
    ? '这是一段用于检查译文容器响应网页尺寸和样式变化的正文。'.repeat(10) : `译:${text}`;
}
interface SavedSource {text: {node: Text; value: string}[]; removed: Text[]; code: Element; codeText: string; link: Element; order: Element[]}
declare global {interface Window {__layoutPolicySource: SavedSource}}

export async function verifyResumedFooter(
  page: Page,
  delivered: boolean,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(() => {
    const box = document.getElementById('policy')!;
    box.style.position = 'relative'; box.style.paddingBottom = '40px'; box.style.boxSizing = 'border-box';
    const footer = document.createElement('div'); footer.id = 'resumed-footer';
    footer.setAttribute('style', 'position:absolute;top:48px;height:calc(100% - 48px)');
    const button = document.createElement('button'); button.id = 'resumed-button'; button.textContent = 'Next';
    button.addEventListener('click', () => {button.dataset.clicked = 'yes';}); footer.appendChild(button); box.appendChild(footer);
  });
  await controls.translate('bilingual');
  await expect(page.locator('#resumed-footer')).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await controls.pause();
  const owner = await page.locator('#policy .dual-read-target').elementHandle(); const before = requests.length;
  await page.evaluate(() => {const box = document.getElementById('policy')!; box.style.height = '0px'; box.style.paddingBottom = '0px';});
  await expect(page.locator('#policy')).toHaveCSS('height', '0px');
  await page.evaluate(() => {const box = document.getElementById('policy')!; box.style.height = '80px'; box.style.paddingBottom = '40px';});
  await expect(page.locator('#policy')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#resumed-footer')).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await expect.poll(() => page.locator('#policy').evaluate(box => box.querySelector('p')!.getBoundingClientRect().bottom
    - document.getElementById('resumed-footer')!.getBoundingClientRect().top)).toBeLessThan(1);
  expect(await owner!.evaluate(node => node.isConnected)).toBe(true);
  await page.locator('#resumed-button').click(); await expect(page.locator('#resumed-button')).toHaveAttribute('data-clicked', 'yes');
  expect(requests.length).toBe(before);
  await page.evaluate(async delivered => {
    document.getElementById('policy')!.style.height = '0px'; document.getElementById('policy')!.style.paddingBottom = '0px';
    if (delivered) await new Promise(resolve => setTimeout(resolve, 80));
    document.dispatchEvent(new Event('layout-policy-test:restore'));
  }, delivered);
  await expect(page.locator('[data-dual-read-layout-height],[data-dual-read-layout-anchor],style[data-dual-read-layout-style],style[data-dual-read-anchor-style],.dual-read-target')).toHaveCount(0);
  await controls.restore(); await page.waitForTimeout(400);
  await expect(page.locator('#policy')).toHaveCSS('height', '0px');
  await expect(page.locator('#resumed-footer')).toHaveCSS('top', '48px');
  await expect(page.locator('#resumed-button')).toHaveAttribute('data-clicked', 'yes');
}

export async function verifyLayoutPolicyRegression(
  page: Page,
  scenario: PolicyCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(() => {
    const text: SavedSource['text'] = [];
    for (const root of [document.body, document.getElementById('motion-widget')!.shadowRoot!]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest('script,style')) text.push({node, value: node.data});
      }
    }
    const code = document.getElementById('code')!;
    window.__layoutPolicySource = {text, removed: [], code, codeText: code.textContent!, link: document.getElementById('link')!, order: []};
  });
  await controls.translate(scenario.mode);
  await expect(page.locator('#responsive')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#policy')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#scroll')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#reveal .dual-read-target')).toHaveCount(0);
  await page.evaluate(() => {document.getElementById('reveal')!.style.height = '100px';});
  await expect(page.locator('#reveal .dual-read-target')).toContainText('译:Previously collapsed');
  if (scenario.paused) await controls.pause();

  // Change the container without a viewport event, then resize the actual 16:9
  // viewport. Both retain the same source and translated owner identities.
  const owner = await page.locator('#responsive .dual-read-target').elementHandle();
  const initialHeight = await page.locator('#responsive').evaluate(node => node.getBoundingClientRect().height);
  await page.evaluate(() => {document.getElementById('responsive')!.style.width = '1000px';});
  await expect.poll(() => page.locator('#responsive').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(160);
  expect(initialHeight - await page.locator('#responsive').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(200);
  expect(await owner!.evaluate(node => node.isConnected)).toBe(true);
  await page.setViewportSize({width: 1600, height: 900});
  await expect.poll(() => page.locator('#responsive').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(160);
  await page.setViewportSize({width: 1920, height: 1080});
  const beforePolicies = requests.length;
  await page.evaluate(() => {
    const policy = document.getElementById('policy')!; policy.style.height = '0px'; policy.style.minHeight = '0px';
    const scroll = document.getElementById('scroll')!; scroll.style.height = '120px'; scroll.style.overflow = 'auto';
  });
  await expect(page.locator('#policy')).toHaveCSS('height', '0px');
  await expect(page.locator('#scroll')).toHaveCSS('height', '120px');
  await expect(page.locator('#scroll')).toHaveCSS('overflow', 'auto');
  await expect(page.locator('#policy')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#scroll')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  if (scenario.paused) {
    const policyOwner = await page.locator('#policy .dual-read-target').elementHandle();
    await page.evaluate(() => {
      const policy = document.getElementById('policy')!; policy.style.height = '80px'; policy.style.minHeight = '';
      const scroll = document.getElementById('scroll')!; scroll.style.height = '80px'; scroll.style.overflow = 'hidden';
    });
    await expect(page.locator('#policy')).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await expect(page.locator('#scroll')).toHaveAttribute('data-dual-read-layout-height', /.+/);
    expect(await policyOwner!.evaluate(node => node.isConnected)).toBe(true);
    await page.evaluate(() => {
      const policy = document.getElementById('policy')!; policy.style.height = '0px'; policy.style.minHeight = '0px';
      const scroll = document.getElementById('scroll')!; scroll.style.height = '120px'; scroll.style.overflow = 'auto';
    });
    await expect(page.locator('#policy')).toHaveCSS('height', '0px');
    await expect(page.locator('#scroll')).toHaveCSS('height', '120px');
  }

  await page.evaluate(() => {
    document.getElementById('theme')!.classList.add('light');
    document.getElementById('motion-widget')!.shadowRoot!.querySelector('section')!.classList.add('light');
  });
  if (scenario.motion === 'cancel') {
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      for (const source of [document.getElementById('theme-source')!, document.getElementById('motion-widget')!.shadowRoot!.querySelector('span')!]) {
        for (const animation of source.getAnimations()) animation.cancel();
      }
    });
  }
  await expect.poll(() => page.locator('#theme .dual-read-target').evaluate(node => (node as HTMLElement).style.color)).toBe('');
  await expect.poll(() => page.evaluate(() => document.getElementById('motion-widget')!.shadowRoot!.querySelector<HTMLElement>('.dual-read-target')!.style.color)).toBe('');
  await expect(page.locator('#theme-source')).toHaveCSS('color', 'rgb(0, 0, 0)');
  // Source motion must not override a current page edit on the companion.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#theme .dual-read-target')!.style.setProperty('color', 'green', 'important');
    document.getElementById('theme')!.classList.remove('light');
  });
  await expect(page.locator('#theme-source')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.locator('#theme .dual-read-target')).toHaveCSS('color', 'rgb(0, 128, 0)');
  await page.waitForTimeout(450); expect(requests.length).toBe(beforePolicies);
  expect(requests.some(text => text.includes('Do not translate source code'))).toBe(false);
  await expect(page.locator('#code .dual-read-target')).toHaveCount(0);

  await page.evaluate(async delivered => {
    const saved = window.__layoutPolicySource;
    const edited = document.getElementById('edited')!;
    const entry = saved.text.find(item => edited.contains(item.node))!;
    entry.node.data = 'Current page edit before restore.'; entry.value = entry.node.data;
    saved.link.setAttribute('href', '/current');
    const removed = document.getElementById('removed')!;
    saved.removed = saved.text.filter(item => removed.contains(item.node)).map(item => item.node); removed.remove();
    const neighbor = document.getElementById('neighbor')!; neighbor.insertBefore(saved.link, edited);
    saved.order = [...neighbor.children];
    document.getElementById('theme')!.classList.add('light');
    if (delivered) await new Promise(resolve => setTimeout(resolve, 80));
    document.dispatchEvent(new Event('layout-policy-test:restore'));
  }, scenario.delivered);
  await expect(page.locator('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text,[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toHaveCount(0);
  const intact = () => page.evaluate(() => {
    const saved = window.__layoutPolicySource;
    return saved.text.every(({node, value}) => saved.removed.includes(node) ? !node.isConnected : node.isConnected && node.data === value)
      && saved.code === document.getElementById('code') && saved.code.textContent === saved.codeText
      && saved.link === document.getElementById('link') && saved.link.getAttribute('href') === '/current'
      && document.getElementById('removed') === null
      && [...document.getElementById('neighbor')!.children].every((node, i) => node === saved.order[i])
      && document.getElementById('policy')!.style.height === '0px' && document.getElementById('scroll')!.style.height === '120px';
  });
  expect(await intact()).toBe(true); await controls.restore(); expect(await intact()).toBe(true);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#reveal .dual-read-target')).toContainText('译:Previously collapsed');
  await expect(page.locator('#policy')).toHaveCSS('height', '0px');
  await expect(page.locator('#scroll')).toHaveCSS('height', '120px');
  await controls.restore(); expect(await intact()).toBe(true);
  await page.waitForTimeout(500); expect(await intact()).toBe(true);
  await expect(page.locator('.dual-read-target,[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toHaveCount(0);
}
