import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const feedLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].map(delivered => ({
    mode, paused, delivered,
    name: `generic feed layout: ${mode}, paused=${paused}, delivered=${delivered}`,
  }))),
);
type FeedCase = typeof feedLayoutCases[number];

export function translateFeedText(source: string): string {
  if (source === 'Continue with phone') return '使用手机号继续';
  if (source === 'Log in with username or email') return '使用用户名或邮箱登录';
  if (source === '3h') return '3 小时';
  return `译:${source}`;
}

interface FeedSource {
  plain: HTMLElement;
  plainText: Text;
  clip: HTMLElement;
  clipStyle: string | null;
  rich: HTMLElement;
  richChildren: Node[];
  reference: HTMLAnchorElement;
  emphasis: HTMLElement;
  removed: HTMLElement;
  actionLabels: HTMLElement[];
  actionText: Node[];
  added?: HTMLElement;
  clicks: number;
}
declare global {
  interface Window { __feedLayoutSource: FeedSource }
}

export async function setupFeedLayoutRegression(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    const plain = document.getElementById('plain-source')!;
    const clip = document.getElementById('plain-clip')!;
    const rich = document.getElementById('rich-source')!;
    const actionLabels = Array.from(document.querySelectorAll<HTMLElement>('.action-label'));
    window.__feedLayoutSource = {
      plain, plainText: plain.firstChild as Text, clip, clipStyle: clip.getAttribute('style'),
      rich, richChildren: Array.from(rich.childNodes), reference: rich.querySelector('a')!,
      emphasis: rich.querySelector('strong')!, removed: document.getElementById('removed-source')!,
      actionLabels, actionText: actionLabels.map(label => label.firstChild!), clicks: 0,
    };
    document.getElementById('phone')!.addEventListener('click', event => {
      event.preventDefault();
      window.__feedLayoutSource.clicks++;
    });
  });
}

export async function verifyFeedLayoutRegression(
  page: Page,
  scenario: FeedCase,
  control: {
    translate: (mode: TranslationMode) => Promise<unknown>;
    restore: () => Promise<unknown>;
    pause: () => Promise<unknown>;
  },
): Promise<void> {
  await control.translate(scenario.mode);
  await expect.poll(() => page.locator('#elapsed').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#rich-source').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#phone .dual-read-target, #phone .dual-read-replace-text').count()).toBe(1);
  await expect.poll(() => page.locator('#login .dual-read-target, #login .dual-read-replace-text').count()).toBe(1);
  const actions = await page.locator('.action').evaluateAll(elements => elements.map(el => {
    const target = el.querySelector('.dual-read-target, .dual-read-replace-text')!;
    const range = document.createRange();
    range.selectNodeContents(el.querySelector('.action-label')!);
    const label = range.getBoundingClientRect();
    const bounds = el.getBoundingClientRect();
    return {
      targetInsideLabel: target.parentElement?.classList.contains('action-label'),
      height: bounds.height,
      fits: label.left >= bounds.left && label.right <= bounds.right + 1,
      sourceAndTranslation: el.textContent,
    };
  }));
  expect(actions.every(action => action.targetInsideLabel && action.height <= 50 && action.fits), JSON.stringify(actions)).toBe(true);
  await page.locator('#phone').click();
  expect(await page.evaluate(() => window.__feedLayoutSource.clicks)).toBe(1);
  const time = await page.locator('#elapsed').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    overflow: el.scrollWidth > el.clientWidth + 1,
  }));
  expect(time.height).toBeLessThanOrEqual(time.lineHeight + 1);
  expect(time.overflow).toBe(false);

  if (scenario.mode === 'bilingual') {
    await expect(page.locator('#plain-boundary + .dual-read-target')).toHaveCount(1);
    await expect(page.locator('#rich-source + .dual-read-target')).toHaveCount(1);
    const quote = await page.locator('#plain-boundary').evaluate(el => {
      const target = el.nextElementSibling!;
      const box = el.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      return {
        below: rect.top >= box.bottom,
        visible: rect.height > 0 && rect.bottom <= el.parentElement!.getBoundingClientRect().bottom,
        sourceStillClipped: getComputedStyle(el).overflow === 'hidden' && getComputedStyle(el).getPropertyValue('-webkit-line-clamp') === '5',
        translationHeight: rect.height,
      };
    });
    expect(quote.below && quote.visible && quote.sourceStillClipped, JSON.stringify(quote)).toBe(true);
    expect(quote.translationHeight).toBeGreaterThan(20);
    expect(await page.locator('#multiline > .dual-read-target').textContent()).toBe('译:First visible paragraph.\n\nSecond visible paragraph, with useful details.');
    expect(await page.locator('#ordinary-card .dual-read-target--inner').count()).toBe(0);
  }

  if (scenario.paused) await control.pause();
  await page.evaluate(async delivered => {
    const source = window.__feedLayoutSource;
    source.plainText.nodeValue = 'Edited quoted paragraph.';
    document.getElementById('receiver')!.appendChild(source.plain);
    source.clip.remove();
    source.removed.remove();
    source.reference.firstChild!.nodeValue = 'Edited reference';
    source.reference.setAttribute('href', '/edited-reference');
    source.reference.parentNode!.insertBefore(source.reference, source.emphasis);
    const added = document.createElement('em');
    added.textContent = ' Added page detail.';
    source.rich.appendChild(added);
    source.added = added;
    if (delivered) await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.dispatchEvent(new Event('feed-layout-test:restore'));
  }, scenario.delivered);

  const expectedRich = 'Edited referenceOriginal emphasis introduces a longer quoted paragraph with useful background and . Every original node must survive editing and restoration. Added page detail.';
  await expect(page.locator('#rich-source')).toHaveText(expectedRich);
  await expect(page.locator('#receiver')).toHaveText('Edited quoted paragraph.');
  await expect(page.locator('.dual-read-target, .dual-read-flow, .dual-read-original-hidden, .dual-read-replace-text')).toHaveCount(0);
  const restored = await page.evaluate(() => {
    const source = window.__feedLayoutSource;
    const expected = [source.reference, ...source.richChildren.filter(node => node !== source.reference), source.added];
    return {
      plainIdentity: document.getElementById('receiver')!.firstChild === source.plain && source.plain.firstChild === source.plainText,
      richNodes: Array.from(source.rich.childNodes).length === expected.length && Array.from(source.rich.childNodes).every((node, i) => node === expected[i]),
      href: source.reference.getAttribute('href'),
      clipStyle: source.clip.getAttribute('style') === source.clipStyle,
      clipRemoved: !source.clip.isConnected,
      sourceRemoved: !source.removed.isConnected,
      actionNodes: source.actionLabels.every((label, i) => label.firstChild === source.actionText[i] && label.childNodes.length === 1),
    };
  });
  expect(restored).toEqual({
    plainIdentity: true, richNodes: true, href: '/edited-reference', clipStyle: true,
    clipRemoved: true, sourceRemoved: true, actionNodes: true,
  });
  await control.restore();
  await control.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect.poll(() => page.locator('#rich-source').getAttribute('data-dual-read-done')).toBe('true');
  await control.restore();
  await expect(page.locator('#rich-source')).toHaveText(expectedRich);
  await expect(page.locator('#receiver')).toHaveText('Edited quoted paragraph.');
  await expect(page.locator('#removed-source, .dual-read-target')).toHaveCount(0);
}
