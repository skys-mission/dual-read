import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const reviewLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].map(delivered => ({
    mode, paused, delivered,
    name: `review layout regression: ${mode}, paused=${paused}, delivered=${delivered}`,
  }))),
);
type ReviewCase = typeof reviewLayoutCases[number];

export function translateReviewLayoutText(text: string): string {
  if (/^Shared (bounded|media)/.test(text)) return '这是用于回归检查的较长中文说明，包含完整的使用方式和详细内容。'.repeat(4);
  return `译:${text}`;
}

interface ReviewSource {
  columns: HTMLElement;
  columnChildren: Node[];
  copy: HTMLElement;
  copyColor: string;
  firstTexts: Text[];
  image: HTMLImageElement;
  imageWidth: number;
  code: HTMLElement[];
  codeText: Text[];
  rows: HTMLElement[];
  texts: Text[];
  links: HTMLAnchorElement[];
  wrapper?: HTMLElement;
  split?: Text;
  addition?: HTMLElement;
}
declare global { interface Window { __reviewLayoutSource: ReviewSource } }

export async function verifyReviewLayoutRegression(
  page: Page,
  scenario: ReviewCase,
  controls: { translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown> },
  sources: string[],
): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(async () => {
    const image = document.getElementById('image') as HTMLImageElement;
    await image.decode();
    const columns = document.getElementById('columns')!;
    const copy = document.getElementById('copy')!;
    const rows = [document.getElementById('flow-one')!, document.getElementById('flow-two')!];
    const code = [document.getElementById('editor-plain')!, document.getElementById('editor-rich')!];
    window.__reviewLayoutSource = {
      columns, columnChildren: Array.from(columns.childNodes), copy, copyColor: getComputedStyle(copy).color,
      firstTexts: ['bounded-first', 'media-first'].map(id => document.getElementById(id)!.firstChild as Text),
      image, imageWidth: image.getBoundingClientRect().width, code, codeText: code.map(node => node.firstChild as Text),
      rows, texts: rows.map(row => row.childNodes[1] as Text), links: rows.map(row => row.querySelector('a')!),
    };
  });
  await controls.translate(scenario.mode);
  const target = (id: string) => page.locator(`#${id} .dual-read-target,#${id} .dual-read-replace-text`);
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#copy')).toContainText('译:');
  expect(await page.evaluate(() => {
    const source = window.__reviewLayoutSource;
    return Array.from(source.columns.childNodes).every((node, i) => node === source.columnChildren[i])
      && source.columns.childNodes.length === source.columnChildren.length
      && source.copy.parentElement === source.columns && getComputedStyle(source.copy).color === source.copyColor;
  })).toBe(true);
  await expect.poll(() => target('bounded-first').count()).toBeGreaterThan(0);
  await expect.poll(() => target('media-first').count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator('#image').getAttribute('data-dual-read-media-bound')).not.toBeNull();

  // Separate mutation/translation waves establish ownership after the first
  // correction is already active; reading both owners before applying would miss it.
  await page.evaluate(() => {
    document.getElementById('bounded-second')!.hidden = false;
    document.getElementById('media-second')!.hidden = false;
  });
  await expect.poll(() => target('bounded-second').count()).toBeGreaterThan(0);
  await expect.poll(() => target('media-second').count()).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    document.getElementById('bounded-first')!.classList.add('cm-content');
    document.getElementById('media-first')!.classList.add('cm-content');
  });
  await expect.poll(() => target('bounded-first').count()).toBe(0);
  await expect.poll(() => target('media-first').count()).toBe(0);
  if (scenario.mode === 'bilingual') await expect.poll(() => target('bounded-second').evaluate(node =>
    node.getBoundingClientRect().bottom <= document.getElementById('bounded')!.getBoundingClientRect().bottom + 1,
  )).toBe(true);
  await expect.poll(() => page.locator('#image').evaluate(node =>
    node.hasAttribute('data-dual-read-media-bound')
    && node.getBoundingClientRect().width <= window.__reviewLayoutSource.imageWidth + 2,
  )).toBe(true);

  const existingRequests = sources.filter(text => text.includes('Read the existing editor documentation.')).length;
  await page.evaluate(() => {
    for (const editor of window.__reviewLayoutSource.code) {
      editor.classList.add('cm-content');
      editor.setAttribute('contenteditable', 'true');
    }
    document.getElementById('existing-code')!.classList.add('active-line');
  });
  await expect.poll(() => page.evaluate(() => window.__reviewLayoutSource.code.every((node, i) =>
    !node.closest('.dual-read-original-hidden') && node.firstChild === window.__reviewLayoutSource.codeText[i]
    && !node.querySelector('.dual-read-target,.dual-read-replace-text'),
  ))).toBe(true);
  await page.waitForTimeout(650);
  expect(sources.filter(text => text.includes('Read the existing editor documentation.')).length).toBe(existingRequests);
  expect(sources.some(text => text.includes('ExistingExample'))).toBe(false);
  if (scenario.paused) await controls.pause();

  await page.evaluate(async delivered => {
    const source = window.__reviewLayoutSource;
    const second = source.rows[1];
    const wrapper = document.createElement('section');
    wrapper.id = 'page-wrapper';
    source.wrapper = wrapper;
    // Structured bilingual prose now keeps original children direct; replace
    // still stashes originals. Apply the same page operations to both sources.
    source.texts[0].parentNode!.insertBefore(wrapper, source.texts[0]);
    wrapper.append(source.texts[0], source.links[0]);
    document.getElementById('receiver')!.append(source.texts[1], source.links[1]);
    source.texts[0].data = 'Read updated ';
    source.split = source.texts[0].splitText(5);
    source.addition = document.createElement('em');
    source.addition.textContent = 'page detail ';
    source.links[0].parentNode!.insertBefore(source.addition, source.links[0]);
    source.links[0].setAttribute('href', '/updated');
    document.getElementById('tail-one')!.remove();
    second.remove();
    source.image.style.objectFit = 'cover';
    if (delivered) await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.dispatchEvent(new Event('review-layout-test:restore'));
  }, scenario.delivered);
  await expect(page.locator('.dual-read-flow,.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden')).toHaveCount(0);
  const verifySources = () => page.evaluate(() => {
    const source = window.__reviewLayoutSource;
    const expected = [source.texts[0], source.split!, source.addition!, source.links[0]];
    const children = Array.from(source.wrapper!.childNodes);
    const receiver = document.getElementById('receiver')!;
    return children.length === expected.length && children.every((node, i) => node === expected[i])
      && source.wrapper!.parentElement === source.rows[0]
      && source.links[0].getAttribute('href') === '/updated' && !source.rows[1].isConnected
      && receiver.childNodes.length === 2 && receiver.childNodes[0] === source.texts[1] && receiver.childNodes[1] === source.links[1]
      && source.code.every((node, i) => node.firstChild === source.codeText[i] && node.classList.contains('cm-content'))
      && source.firstTexts.every(node => node.isConnected)
      && source.image.style.objectFit === 'cover';
  });
  expect(await verifySources()).toBe(true);
  await expect(page.locator('[data-dual-read-layout-height],[data-dual-read-media-bound],style[data-dual-read-layout-style],style[data-dual-read-media-style]')).toHaveCount(0);
  await controls.restore();
  expect(await verifySources()).toBe(true);
  const requestsBeforeSwitch = sources.length;
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#copy')).toContainText('译:');
  await controls.restore();
  expect(await verifySources()).toBe(true);
  expect(sources.slice(requestsBeforeSwitch).some(text => /PlainExample|RichExample|ExistingExample|Shared (bounded|media) first/.test(text))).toBe(false);
  await expect(page.locator('.dual-read-flow,.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden')).toHaveCount(0);
}
