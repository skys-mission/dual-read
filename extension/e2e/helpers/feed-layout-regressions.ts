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
  if (source === 'Photo of the mountain range') return '山脉景观照片，展示山峰与周围景色';
  if (source === 'A useful description of the latest change') return '最新变更的说明应在独立的一行中完整显示';
  if (source.startsWith('Explore the platform') || source.startsWith('Browse the ')) return '探索平台提供的各项服务，了解功能、使用方法和详细说明，发现更多适合自己需求的产品与工具，并查看完整的参考资料。';
  if (source === 'Accessing the developer console') return '访问开发者控制台并查看所有服务';
  if (source === 'Browse docs') return '浏览文档';
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
  caption: HTMLElement;
  captionText: Text;
  photoLink: Element;
  row: HTMLElement;
  rowText: Text;
  rowReference: HTMLAnchorElement;
  rowIcon: Element;
  rowTail: Element;
  rowAdded?: HTMLElement;
  late: HTMLElement[];
  lateText: Node[];
  rowImage: HTMLImageElement;
  rowImageWidth: number;
  sourceStyle: HTMLElement;
  flatControl: HTMLElement;
  flatControlChildren: Node[];
  shadowComponent: HTMLElement;
  shadowParagraph: HTMLParagraphElement;
  shadowText: Text;
  assignedParagraph: HTMLParagraphElement;
  assignedText: Text;
  assignedSlot: HTMLSlotElement;
  shadowAction: HTMLElement;
  shadowActionText: Text;
  shadowActionHeight: number;
  measuredAction: HTMLAnchorElement;
  measuredActionText: Text;
}
declare global {
  interface Window { __feedLayoutSource: FeedSource }
}

export async function setupFeedLayoutRegression(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    document.getElementById('composed-card')!.innerHTML = '<audit-document></audit-document><div>Share your feedback and <a href="/feedback">read more</a>.</div>';
    const shadowComponent = document.querySelector<HTMLElement>('audit-document')!;
    const docRoot = shadowComponent.attachShadow({ mode: 'open' });
    docRoot.innerHTML = '<style>:host { display:block } p { margin:8px 0 }</style><h3>Independent documentation</h3><p id="shadow-copy">Independent documentation paragraph.</p>';
    const shadowParagraph = docRoot.querySelector<HTMLParagraphElement>('p')!;
    const slotComponent = document.createElement('audit-slotted-document');
    slotComponent.innerHTML = '<p slot="body" id="assigned-copy">Assigned documentation paragraph.</p>';
    document.getElementById('slot-card')!.appendChild(slotComponent);
    const slotRoot = slotComponent.attachShadow({ mode: 'open' });
    slotRoot.innerHTML = '<style>:host { display:block }</style><div><span>Documentation heading</span><slot name="body"></slot></div>';
    const assignedParagraph = slotComponent.querySelector<HTMLParagraphElement>('p')!;
    const assignedSlot = slotRoot.querySelector<HTMLSlotElement>('slot')!;
    const shadowAction = document.createElement('audit-action');
    shadowAction.textContent = 'Browse docs';
    const actionContainer = document.createElement('div');
    actionContainer.appendChild(shadowAction);
    document.getElementById('slot-card')!.appendChild(actionContainer);
    shadowAction.attachShadow({ mode: 'open' }).innerHTML = '<style>:host { display:block; width:min-content } button { white-space:nowrap; font:15px/20px system-ui; padding:0; border:0 }</style><button><slot></slot></button>';
    const plain = document.getElementById('plain-source')!;
    const clip = document.getElementById('plain-clip')!;
    const rich = document.getElementById('rich-source')!;
    const actionLabels = Array.from(document.querySelectorAll<HTMLElement>('.action-label'));
    const caption = document.getElementById('plain-caption')!;
    const row = document.getElementById('icon-row')!;
    const late = ['late-style', 'late-class', 'late-hidden', 'late-aria'].map(id => document.getElementById(id)!);
    window.__feedLayoutSource = {
      plain, plainText: plain.firstChild as Text, clip, clipStyle: clip.getAttribute('style'),
      rich, richChildren: Array.from(rich.childNodes), reference: rich.querySelector('a')!,
      emphasis: rich.querySelector('strong')!, removed: document.getElementById('removed-source')!,
      actionLabels, actionText: actionLabels.map(label => label.firstChild!), clicks: 0,
      caption, captionText: caption.firstChild as Text, photoLink: document.getElementById('photo-link')!,
      row, rowText: row.childNodes[1] as Text, rowReference: document.getElementById('row-reference') as HTMLAnchorElement,
      rowIcon: document.getElementById('row-icon')!, rowTail: document.getElementById('row-tail')!,
      late, lateText: late.map(el => el.firstChild!),
      rowImage: document.getElementById('row-image') as HTMLImageElement,
      rowImageWidth: document.getElementById('row-image')!.getBoundingClientRect().width,
      sourceStyle: document.getElementById('source-style')!,
      flatControl: document.getElementById('flat-control')!,
      flatControlChildren: Array.from(document.getElementById('flat-control')!.childNodes),
      shadowComponent, shadowParagraph, shadowText: shadowParagraph.firstChild as Text,
      assignedParagraph, assignedText: assignedParagraph.firstChild as Text, assignedSlot,
      shadowAction, shadowActionText: shadowAction.firstChild as Text,
      shadowActionHeight: shadowAction.getBoundingClientRect().height,
      measuredAction: document.getElementById('measured-action') as HTMLAnchorElement,
      measuredActionText: document.getElementById('measured-action')!.firstChild as Text,
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
  await expect.poll(() => page.locator('#plain-caption').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#ellipsis').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#icon-row').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#bounded-prose').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('#styled-paragraph').getAttribute('data-dual-read-done')).toBe('true');
  const typography = await page.locator('#styled-paragraph .dual-read-target').evaluate(target => {
    const s = getComputedStyle(target);
    return { size: s.fontSize, lineHeight: s.lineHeight, white: /^color\(srgb 1 1 1(?: \/ [\d.]+)?\)$/.test(s.color) || /^rgba?\(255, 255, 255/.test(s.color) };
  });
  expect(typography).toEqual({ size: '20px', lineHeight: '30px', white: true });
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

  await expect.poll(() => page.locator('audit-document #shadow-copy .dual-read-target, audit-document #shadow-copy .dual-read-replace-text').count()).toBe(1);
  const composedLayout = await page.evaluate(() => {
    const source = window.__feedLayoutSource;
    return source.shadowComponent.parentElement === document.getElementById('composed-card')
      && !source.shadowComponent.closest('.dual-read-original-hidden')
      && source.shadowParagraph.getBoundingClientRect().height > 0
      && !source.assignedSlot.closest('.dual-read-original-hidden')
      && source.assignedSlot.assignedElements()[0] === source.assignedParagraph
      && source.assignedParagraph.getBoundingClientRect().height > 0;
  });
  expect(composedLayout).toBe(true);
  await expect.poll(() => page.locator('audit-action .dual-read-target, audit-action .dual-read-replace-text').count()).toBe(1);
  if (scenario.mode === 'replace') {
    expect(await page.locator('audit-action').evaluate(action => action.getBoundingClientRect().height <= window.__feedLayoutSource.shadowActionHeight + 1)).toBe(true);
    expect(await page.locator('audit-action .dual-read-replace-text').evaluate(text => getComputedStyle(text).whiteSpace)).toBe('nowrap');
  }
  await expect.poll(() => page.locator('#row-image').evaluate(image => {
    const source = window.__feedLayoutSource;
    return image.hasAttribute('data-dual-read-media-bound')
      && image.getBoundingClientRect().width <= source.rowImageWidth + 2;
  })).toBe(true);

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
    const documentLayout = await page.evaluate(() => {
      const caption = document.querySelector<HTMLElement>('#plain-caption > .dual-read-target')!;
      const ellipsis = document.querySelector<HTMLElement>('#ellipsis > .dual-read-target')!;
      const row = document.getElementById('icon-row')!;
      const rowTarget = row.querySelector<HTMLElement>('.dual-read-target')!;
      const column = document.getElementById('ellipsis-column')!;
      return {
        captionBlock: !!caption && !caption.classList.contains('dual-read-target--inner'),
        captionFits: caption.getBoundingClientRect().width <= 151,
        captionWraps: caption.getBoundingClientRect().height >= 40,
        sourceStillEllipsized: getComputedStyle(column).whiteSpace === 'nowrap' && getComputedStyle(column).textOverflow === 'ellipsis',
        ellipsisWraps: getComputedStyle(ellipsis).whiteSpace === 'normal' && ellipsis.getBoundingClientRect().right <= column.getBoundingClientRect().right + 1,
        rowFits: rowTarget.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
        rowTextColumn: rowTarget.parentElement === row && rowTarget.classList.contains('dual-read-target--break')
          && rowTarget.getBoundingClientRect().top >= window.__feedLayoutSource.rowReference.getBoundingClientRect().bottom,
        iconsStayDirect: row.firstChild === window.__feedLayoutSource.rowIcon && window.__feedLayoutSource.rowTail.parentElement === row,
      };
    });
    expect(Object.values(documentLayout).every(Boolean), JSON.stringify(documentLayout)).toBe(true);
    await expect.poll(() => page.locator('#column-label .dual-read-target').evaluate(target => {
      const box = document.getElementById('link-column')!.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1;
    })).toBe(true);
    await expect.poll(() => page.locator('#bounded-hero').evaluate(box => {
      const target = box.querySelector('.dual-read-target')!;
      return target.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom + 1;
    })).toBe(true);
    await expect.poll(() => page.locator('#bounded-carousel').evaluate(box => {
      const target = box.querySelector('.dual-read-target')!;
      return target.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom + 1
        && getComputedStyle(box).overflowX === 'hidden';
    })).toBe(true);
    await expect.poll(() => page.locator('#measured-grid').evaluate(grid => {
      const title = grid.querySelector('#measured-title .dual-read-target')!.getBoundingClientRect();
      const description = grid.querySelector('#measured-copy')!.getBoundingClientRect();
      const copy = grid.querySelector('#measured-copy .dual-read-target')!.getBoundingClientRect();
      const action = grid.querySelector('#measured-action')!.getBoundingClientRect();
      return title.bottom <= description.top + 1 && copy.bottom <= action.top + 1;
    })).toBe(true);
    await expect.poll(() => page.locator('#measured-footer').evaluate(footer => {
      const grid = document.getElementById('measured-grid')!.getBoundingClientRect();
      return footer.hasAttribute('data-dual-read-layout-anchor') && footer.getBoundingClientRect().top >= grid.bottom - 1;
    })).toBe(true);
  }

  if (scenario.paused) await control.pause();
  await page.evaluate(() => {
    document.getElementById('late-style')!.style.opacity = '1';
    document.getElementById('late-class')!.classList.remove('concealed');
    document.getElementById('late-hidden')!.hidden = false;
    document.getElementById('late-aria')!.setAttribute('aria-hidden', 'false');
  });
  if (scenario.paused) {
    await expect(page.locator('[id^="late-"] .dual-read-target, [id^="late-"] .dual-read-replace-text')).toHaveCount(0);
  } else {
    await expect.poll(() => page.locator('[id^="late-"][data-dual-read-done="true"]').count()).toBe(4);
  }
  await page.evaluate(async ({ delivered, mode }) => {
    const source = window.__feedLayoutSource;
    document.getElementById('bounded-hero')!.style.height = '44px';
    document.getElementById('bounded-carousel')!.classList.add('page-update');
    source.rowImage.style.objectFit = 'cover';
    source.shadowText.nodeValue = 'Edited independent paragraph.';
    source.assignedText.nodeValue = 'Edited assigned paragraph.';
    source.sourceStyle.style.fontSize = '22px';
    source.measuredActionText.nodeValue = 'Updated product details';
    source.measuredAction.setAttribute('href', '/updated-product-details');
    if (mode === 'replace') {
      // An unchanged ancestor may also be processed before its nested controls.
      document.getElementById('measured-grid')!.setAttribute('data-dual-read-done', 'true');
      document.getElementById('measured-grid')!.setAttribute('data-dual-read-mode', 'replace');
    }
    document.getElementById('measured-title-box')!.style.height = '44px';
    document.getElementById('measured-footer')!.style.top = '132px';
    document.getElementById('measured-footer')!.style.height = 'calc(100% - 132px)';
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
    source.captionText.nodeValue = 'Edited photo caption.';
    source.photoLink.remove();
    source.rowText.nodeValue = 'Read updated ';
    source.rowReference.setAttribute('href', '/edited-guide');
    document.getElementById('doc-receiver')!.appendChild(source.rowReference);
    source.rowIcon.remove();
    const rowAdded = document.createElement('strong');
    rowAdded.textContent = 'Added introduction. ';
    source.rowText.parentNode!.insertBefore(rowAdded, source.rowText);
    source.rowAdded = rowAdded;
    if (delivered) await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    document.dispatchEvent(new Event('feed-layout-test:restore'));
  }, { delivered: scenario.delivered, mode: scenario.mode });

  const expectedRich = 'Edited referenceOriginal emphasis introduces a longer quoted paragraph with useful background and . Every original node must survive editing and restoration. Added page detail.';
  await expect(page.locator('#rich-source')).toHaveText(expectedRich);
  await expect(page.locator('#receiver')).toHaveText('Edited quoted paragraph.');
  await expect(page.locator('.dual-read-target, .dual-read-flow, .dual-read-original-hidden, .dual-read-replace-text')).toHaveCount(0);
  await expect(page.locator('[data-dual-read-layout-height], style[data-dual-read-layout-style]')).toHaveCount(0);
  await expect(page.locator('[data-dual-read-media-bound], style[data-dual-read-media-style]')).toHaveCount(0);
  await expect(page.locator('[data-dual-read-layout-anchor], style[data-dual-read-anchor-style]')).toHaveCount(0);
  expect(await page.locator('#measured-footer').evaluate(footer => (footer as HTMLElement).style.top)).toBe('132px');
  expect(await page.locator('#row-image').evaluate(image => image === window.__feedLayoutSource.rowImage && (image as HTMLElement).style.objectFit === 'cover')).toBe(true);
  expect(await page.locator('#source-style').evaluate(source => source === window.__feedLayoutSource.sourceStyle && (source as HTMLElement).style.fontSize === '22px')).toBe(true);
  expect(await page.locator('#measured-title-box').evaluate(box => (box as HTMLElement).style.height)).toBe('44px');
  expect(await page.locator('#flat-control').evaluate(control => {
    const source = window.__feedLayoutSource;
    return control === source.flatControl && Array.from(control.childNodes).length === source.flatControlChildren.length
      && Array.from(control.childNodes).every((node, i) => node === source.flatControlChildren[i]);
  })).toBe(true);
  expect(await page.locator('#bounded-hero').evaluate(el => el.style.height)).toBe('44px');
  await expect(page.locator('#bounded-carousel')).toHaveClass(/page-update/);
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
      captionNode: source.caption.firstChild === source.captionText && source.caption.childNodes.length === 1,
      photoRemoved: !source.photoLink.isConnected,
      rowNodes: Array.from(source.row.childNodes).length === 3
        && source.row.childNodes[0] === source.rowAdded && source.row.childNodes[1] === source.rowText && source.row.childNodes[2] === source.rowTail,
      rowTransfer: document.getElementById('doc-receiver')!.firstChild === source.rowReference && source.rowReference.getAttribute('href') === '/edited-guide',
      rowIconRemoved: !source.rowIcon.isConnected,
      lateNodes: source.late.every((el, i) => el.firstChild === source.lateText[i] && el.childNodes.length === 1),
      lateVisibility: document.getElementById('late-style')!.style.opacity === '1'
        && !document.getElementById('late-class')!.classList.contains('concealed')
        && !document.getElementById('late-hidden')!.hidden
        && document.getElementById('late-aria')!.getAttribute('aria-hidden') === 'false',
      composedNodes: source.shadowParagraph.firstChild === source.shadowText
        && source.shadowParagraph.textContent === 'Edited independent paragraph.'
        && source.assignedParagraph.firstChild === source.assignedText
        && source.assignedParagraph.textContent === 'Edited assigned paragraph.'
        && source.assignedSlot.assignedElements()[0] === source.assignedParagraph
        && source.shadowAction.firstChild === source.shadowActionText
        && source.shadowAction.textContent === 'Browse docs',
      nestedActionNodes: source.measuredAction.firstChild === source.measuredActionText
        && source.measuredAction.childNodes.length === 1
        && source.measuredAction.textContent === 'Updated product details'
        && source.measuredAction.getAttribute('href') === '/updated-product-details',
    };
  });
  expect(restored).toEqual({
    plainIdentity: true, richNodes: true, href: '/edited-reference', clipStyle: true,
    clipRemoved: true, sourceRemoved: true, actionNodes: true,
    captionNode: true, photoRemoved: true, rowNodes: true, rowTransfer: true, rowIconRemoved: true,
    lateNodes: true, lateVisibility: true, composedNodes: true, nestedActionNodes: true,
  });
  await control.restore();
  await control.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect.poll(() => page.locator('#rich-source').getAttribute('data-dual-read-done')).toBe('true');
  await expect.poll(() => page.locator('[id^="late-"][data-dual-read-done="true"]').count()).toBe(4);
  await control.restore();
  await expect(page.locator('#rich-source')).toHaveText(expectedRich);
  await expect(page.locator('#receiver')).toHaveText('Edited quoted paragraph.');
  await expect(page.locator('#removed-source, .dual-read-target')).toHaveCount(0);
  await expect(page.locator('#plain-caption')).toHaveText('Edited photo caption.');
  await expect(page.locator('#icon-row')).toHaveText('Added introduction. Read updated');
  await expect(page.locator('#doc-receiver a')).toHaveAttribute('href', '/edited-guide');
}
