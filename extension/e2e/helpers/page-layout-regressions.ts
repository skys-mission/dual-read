import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const pageLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].map(delivered => ({
    mode, paused, delivered,
    name: `generic page layout: ${mode}, paused=${paused}, delivered=${delivered}`,
  }))),
);
type LayoutCase = typeof pageLayoutCases[number];
interface LayoutSource {
  caption: HTMLElement;
  children: Node[];
  author: HTMLAnchorElement;
  license: HTMLAnchorElement;
  ordinary: HTMLElement;
  ordinaryChildren: Node[];
  added?: HTMLElement;
  clicks: number;
}
declare global {
  interface Window { __layoutSource: LayoutSource }
}

export async function setupPageLayoutRegression(page: Page): Promise<void> {
  await page.evaluate(() => {
    const caption = document.getElementById('caption')!;
    const ordinary = document.getElementById('ordinary')!;
    window.__layoutSource = {
      caption, children: Array.from(caption.childNodes),
      author: caption.querySelectorAll('a')[0], license: caption.querySelectorAll('a')[1],
      ordinary, ordinaryChildren: Array.from(ordinary.childNodes), clicks: 0,
    };
    document.getElementById('save')!.addEventListener('click', () => { window.__layoutSource.clicks++; });
  });
}

export async function verifyPageLayoutRegression(
  page: Page,
  scenario: LayoutCase,
  control: {
    translate: (mode: TranslationMode) => Promise<unknown>;
    restore: () => Promise<unknown>;
    pause: () => Promise<unknown>;
  },
): Promise<void> {
  await control.translate(scenario.mode);
  await expect.poll(() => page.locator('#caption').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#change-cell').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#slotted-widget .dual-read-target, #slotted-widget .dual-read-replace-text').count()).toBeGreaterThan(0);
  const assignedTranslation = await page.locator('#slotted-widget .dual-read-target, #slotted-widget .dual-read-replace-text').first().evaluate(el => ({
    text: el.textContent, rendered: el.getBoundingClientRect().height > 0,
  }));
  expect(assignedTranslation.text).toContain('Visible assigned label');
  expect(assignedTranslation.rendered).toBe(true);
  const shadowText = await page.evaluate(() => ({
    lightTargets: document.querySelector('#time-widget > .dual-read-target'),
    timeTranslated: !!document.getElementById('time-widget')!.shadowRoot!.querySelector('.dual-read-target, .dual-read-replace-text'),
    hiddenTranslated: !!document.getElementById('hidden-widget')!.shadowRoot!.querySelector('.dual-read-target, .dual-read-replace-text'),
    slotTranslated: !!document.getElementById('slotted-widget')!.shadowRoot!.querySelector('.dual-read-target, .dual-read-replace-text'),
  }));
  expect(shadowText).toEqual({ lightTargets: null, timeTranslated: true, hiddenTranslated: false, slotTranslated: false });
  expect(await page.locator('#icon-tools .dual-read-target, #icon-tools .dual-read-replace-text').count()).toBe(0);
  expect(await page.locator('#controls > .dual-read-target').count()).toBe(0);
  expect((await page.locator('#ordinary .dual-read-target').allTextContents()).join(' ')).not.toContain('Hidden prose helper');
  const captionLinks = await page.locator('#caption').evaluate(el =>
    Array.from(el.querySelectorAll('a')).filter(link =>
      !link.closest('.dual-read-original-hidden')
      && (link.closest('.dual-read-target') || el.getAttribute('data-dual-read-mode') === 'replace'),
    ).map(link => link.getAttribute('href')),
  );
  expect(captionLinks).toEqual(['/author', '/license']);
  const saveLabel = await page.locator('#save').evaluate(el => {
    const target = el.querySelector('.dual-read-target, .dual-read-replace-text')!;
    const box = el.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    return { text: target.textContent, inside: rect.top >= box.top && rect.bottom <= box.bottom && rect.right <= box.right + 1 };
  });
  expect(saveLabel.text).toContain('Save changes');
  expect(saveLabel.inside).toBe(true);
  await page.locator('#save').click();
  expect(await page.evaluate(() => window.__layoutSource.clicks)).toBe(1);
  if (scenario.mode === 'bilingual') {
    const captionLine = await page.evaluate(() => {
      const source = window.__layoutSource;
      const range = document.createRange();
      range.setStartBefore(source.children[0]);
      range.setEndAfter(source.children[source.children.length - 1]);
      return source.caption.querySelector(':scope > .dual-read-target')!.getBoundingClientRect().top >= range.getBoundingClientRect().bottom;
    });
    expect(captionLine).toBe(true);
    const cell = await page.locator('#change-cell').evaluate(el => {
      const companion = el.querySelector(':scope > .dual-read-target')!;
      const source = el.querySelector('.source-clipping-box')!;
      const bounds = el.getBoundingClientRect();
      const targetRect = companion.getBoundingClientRect();
      return {
        separateLine: targetRect.top >= source.getBoundingClientRect().bottom,
        bottomGap: bounds.bottom - targetRect.bottom,
        sourceOverflow: getComputedStyle(source).overflow,
        outsideClippingBox: !companion.closest('.source-clipping-box'),
      };
    });
    expect(cell.separateLine).toBe(true);
    expect(cell.bottomGap).toBeGreaterThanOrEqual(4);
    expect(cell.sourceOverflow).toBe('hidden');
    expect(cell.outsideClippingBox).toBe(true);
  }

  if (scenario.paused) await control.pause();
  // The restore event is wired to the content's public restore entrypoint by
  // each browser harness. It lets this transaction exercise records both
  // before and after observer delivery, with expectations from page operations.
  await page.evaluate(async delivered => {
    const { caption, author, license } = window.__layoutSource;
    author.firstChild!.nodeValue = 'Edited Author';
    author.setAttribute('href', '/edited-author');
    author.parentNode!.insertBefore(license, author);
    const added = document.createElement('span');
    added.textContent = ' Extra note.';
    caption.appendChild(added);
    window.__layoutSource.added = added;
    if (delivered) await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.dispatchEvent(new Event('page-layout-test:restore'));
  }, scenario.delivered);
  const expectedText = 'Image by Open LicenseEdited Author, licensed under . Extra note.';
  await expect(page.locator('#caption')).toHaveText(expectedText);
  const restored = await page.evaluate(() => {
    const source = window.__layoutSource;
    const expected = [source.children[0], source.license, source.author, source.children[2], source.children[4], source.added];
    return {
      childrenMatch: Array.from(source.caption.childNodes).every((node, index) => node === expected[index]) && source.caption.childNodes.length === expected.length,
      href: source.author.getAttribute('href'),
      ordinaryMatches: Array.from(source.ordinary.childNodes).every((node, index) => node === source.ordinaryChildren[index]) && source.ordinary.childNodes.length === source.ordinaryChildren.length,
      helpers: source.ordinary.querySelector('[style]')?.textContent,
    };
  });
  expect(restored).toEqual({ childrenMatch: true, href: '/edited-author', ordinaryMatches: true, helpers: 'Hidden prose helper' });
  // Repeat restoration and switch modes after edits. No removed/moved source
  // can reappear, and re-collection must translate the updated caption as a unit.
  await control.restore();
  await control.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect.poll(() => page.locator('#caption').getAttribute('data-dual-read-done')).toBe('true');
  await control.restore();
  await expect(page.locator('#caption')).toHaveText(expectedText);
  expect(await page.locator('#caption a').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['/license', '/edited-author']);
}
