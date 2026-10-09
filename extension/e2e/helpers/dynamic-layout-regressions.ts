import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const dynamicLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  (['wrap-permute', 'transfer-delete'] as const).flatMap(operation =>
    [false, true].flatMap(paused => [false, true].map(delivered => ({
      mode, operation, paused, delivered,
      name: `dynamic layout regression: ${mode}, ${operation}, paused=${paused}, delivered=${delivered}`,
    }))),
  ),
);
type DynamicCase = typeof dynamicLayoutCases[number];

export function translateDynamicLayoutText(text: string): string {
  if (/^First long footer/.test(text)) return '这是一段用于测试较长正文所产生的高度增长及页面布局变化的翻译内容。'.repeat(6);
  if (/^Second short footer/.test(text)) return '第二段正文。';
  return `译:${text}`;
}

interface DynamicSource {
  action: HTMLElement;
  first: Text;
  last: Text;
  icon: Element;
  code: HTMLElement[];
  codeText: Text[];
  footer: HTMLElement;
  footerStyle: string | null;
  animation?: number;
  firstWrapper?: HTMLElement;
  lastWrapper?: HTMLElement;
  split?: Text;
  addition?: HTMLElement;
}
declare global { interface Window { __dynamicLayoutSource: DynamicSource } }

export async function verifyDynamicLayoutRegression(
  page: Page,
  scenario: DynamicCase,
  controls: { translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown> },
  sources: string[],
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    const action = document.getElementById('action')!;
    const nested = document.getElementById('shadow-editor')!.shadowRoot!.querySelector('nested-code')!;
    const code = [nested.shadowRoot!.querySelector<HTMLElement>('p')!, document.getElementById('slot-code')!];
    const footer = document.getElementById('footer')!;
    window.__dynamicLayoutSource = { action, first: action.firstChild as Text, last: action.lastChild as Text,
      icon: document.getElementById('middle-icon')!, code, codeText: code.map(node => node.firstChild as Text),
      footer, footerStyle: footer.getAttribute('style') };
  });
  await controls.translate(scenario.mode);
  await expect(page.locator('#action')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#second')).toContainText('第二段正文。');
  if (scenario.mode === 'bilingual') {
    expect(await page.evaluate(() => {
      const source = window.__dynamicLayoutSource;
      return source.icon.parentElement === source.action && source.icon.getBoundingClientRect().width === 16
        && source.icon.getBoundingClientRect().height === 16 && source.first.parentElement !== source.last.parentElement;
    })).toBe(true);
    await expect(page.locator('#footer')).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  }
  expect(await page.evaluate(() => window.__dynamicLayoutSource.code.every(node => !!node.querySelector('.dual-read-target')))).toBe(true);

  // The class stream remains active until the newly inserted paragraph paints.
  await page.evaluate(() => {
    const source = window.__dynamicLayoutSource;
    source.animation = window.setInterval(() => {
      const spinner = document.getElementById('spinner')!;
      spinner.setAttribute('class', spinner.getAttribute('class') === 'spin-a' ? 'spin-b' : 'spin-a');
    }, 100);
    const late = document.createElement('p'); late.id = 'late'; late.textContent = 'New prose during continuous class animation.';
    document.getElementById('main')!.appendChild(late);
  });
  await expect(page.locator('#late')).toContainText('译:New prose during continuous class animation.', { timeout: 6000 });
  await page.evaluate(() => clearInterval(window.__dynamicLayoutSource.animation));

  // Two shadow boundaries and a named slot must use the same code ancestry as
  // initial collection; an existing editor animation must leave adjacent prose.
  const requestsBeforeHydration = sources.length;
  await page.evaluate(() => {
    document.getElementById('first')!.classList.add('cm-content');
    document.getElementById('shadow-editor')!.classList.add('cm-editor');
    document.getElementById('slot-widget')!.shadowRoot!.querySelector('#slot-editor')!.classList.add('cm-editor');
    document.getElementById('existing-code')!.classList.add('active-line');
  });
  await expect(page.locator('#first .dual-read-target')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__dynamicLayoutSource.code.every((node, index) =>
    node.firstChild === window.__dynamicLayoutSource.codeText[index]
    && !node.querySelector('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden'),
  ))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const frame = document.getElementById('frame')!.getBoundingClientRect();
    const button = document.getElementById('next')!.getBoundingClientRect();
    return button.top >= frame.top && button.bottom <= frame.bottom + 1;
  })).toBe(true);
  expect(await page.evaluate(() => window.__dynamicLayoutSource.footer.getAttribute('style') === window.__dynamicLayoutSource.footerStyle)).toBe(true);
  await expect(page.locator('#slot-prose')).toContainText('译:Independent slotted documentation.');
  await expect(page.locator('#adjacent')).toContainText('译:Read the existing editor documentation.');
  expect(sources.slice(requestsBeforeHydration).some(text => /ShadowReviewExample|SlottedReviewExample|ExistingReviewExample|existing editor documentation/.test(text))).toBe(false);

  if (scenario.paused) await controls.pause();
  await page.evaluate(async ({ mode, operation, delivered }) => {
    const source = window.__dynamicLayoutSource;
    const containers = mode === 'bilingual'
      ? [source.first.parentElement!, source.last.parentElement!] : [source.first, source.last];
    const wrappers = containers.map(container => {
      const wrapper = document.createElement('span'); wrapper.setAttribute('data-page-wrapper', 'true');
      container.parentNode!.insertBefore(wrapper, container); wrapper.appendChild(container); return wrapper;
    });
    [source.firstWrapper, source.lastWrapper] = wrappers;
    source.first.data = 'Updated introduction ';
    source.split = source.first.splitText(8);
    source.addition = document.createElement('em'); source.addition.textContent = 'page detail ';
    source.split.parentNode!.insertBefore(source.addition, source.split.nextSibling);
    source.last.data = 'Updated conclusion';
    source.action.setAttribute('href', '/updated');
    if (operation === 'wrap-permute') wrappers[0].parentNode!.insertBefore(wrappers[1], wrappers[0]);
    else { document.getElementById('receiver')!.append(...wrappers); source.action.remove(); }
    if (delivered) await new Promise<void>(resolve => setTimeout(resolve, 450));
    document.dispatchEvent(new Event('dynamic-layout-test:restore'));
  }, scenario);
  await expect(page.locator('.dual-read-flow,.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden')).toHaveCount(0);
  const verify = () => page.evaluate(operation => {
    const source = window.__dynamicLayoutSource;
    const firstExpected = [source.first, source.split!, source.addition!];
    const parent = operation === 'wrap-permute' ? source.action : document.getElementById('receiver')!;
    const expected = operation === 'wrap-permute'
      ? [source.lastWrapper!, source.firstWrapper!, source.icon] : [source.firstWrapper!, source.lastWrapper!];
    return source.firstWrapper!.childNodes.length === firstExpected.length
      && firstExpected.every((node, index) => source.firstWrapper!.childNodes[index] === node)
      && source.lastWrapper!.childNodes.length === 1 && source.lastWrapper!.firstChild === source.last
      && parent.childNodes.length === expected.length && expected.every((node, index) => parent.childNodes[index] === node)
      && source.action.getAttribute('href') === '/updated' && source.first.data === 'Updated '
      && source.split!.data === 'introduction ' && source.last.data === 'Updated conclusion'
      && source.icon.isConnected === (operation === 'wrap-permute')
      && source.code.every((node, index) => node.firstChild === source.codeText[index])
      && source.footer.getAttribute('style') === source.footerStyle;
  }, scenario.operation);
  expect(await verify()).toBe(true);
  await expect(page.locator('[data-dual-read-layout-anchor],style[data-dual-read-anchor-style]')).toHaveCount(0);
  await controls.restore();
  expect(await verify()).toBe(true);
  const requestsBeforeSwitch = sources.length;
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#second')).toContainText('第二段正文。');
  await controls.restore();
  expect(await verify()).toBe(true);
  expect(sources.slice(requestsBeforeSwitch).some(text => /ShadowReviewExample|SlottedReviewExample|ExistingReviewExample|First long footer/.test(text))).toBe(false);
  await expect(page.locator('.dual-read-flow,.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden')).toHaveCount(0);
}
