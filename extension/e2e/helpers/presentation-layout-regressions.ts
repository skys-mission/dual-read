import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const presentationLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => (['source', 'transfer'] as const).flatMap(operation =>
    [false, true].map(delivered => ({ mode, paused, operation, delivered,
      name: `presentation layout regression: ${mode}, ${operation}, paused=${paused}, delivered=${delivered}` })),
  )),
);
type PresentationCase = typeof presentationLayoutCases[number];

export function translatePresentationText(text: string): string {
  return /Expansion|Media caption/.test(text) ? '这是一段用于验证译文对布局和图片尺寸影响的较长正文内容。'.repeat(12) : `译:${text}`;
}

interface PresentationSource {
  text: { node: Text; value: string }[];
  richText: Text;
  mixedText: Text;
  link: HTMLAnchorElement;
  image: HTMLImageElement;
  secondImage: HTMLImageElement;
  unrelated?: Element;
}
declare global { interface Window { __presentationSource: PresentationSource } }

export async function verifyPresentationLayoutRegression(
  page: Page,
  scenario: PresentationCase,
  controls: { translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown> },
  sources: string[],
): Promise<void> {
  await page.setViewportSize({ width:1920, height:1080 });
  await page.evaluate(() => {
    const roots = [document.body, document.getElementById('widget')!.shadowRoot!,
      document.getElementById('widget')!.shadowRoot!.querySelector('nested-widget')!.shadowRoot!, document.querySelector('other-widget')!.shadowRoot!];
    const text: PresentationSource['text'] = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest('script,style')) text.push({node,value:node.data});
      }
    }
    window.__presentationSource = { text, richText:document.getElementById('rich-source')!.firstChild as Text,
      mixedText:document.getElementById('mixed-copy')!.firstChild as Text, link:document.getElementById('rich-link') as HTMLAnchorElement,
      image:document.getElementById('media-image') as HTMLImageElement, secondImage:document.getElementById('other-media-image') as HTMLImageElement };
  });
  await controls.translate(scenario.mode);
  await expect(page.locator('#themed')).toContainText('译:Theme-dependent documentation.');
  await expect(page.locator('#media-image')).toHaveAttribute('data-dual-read-media-bound', /.+/);
  await expect(page.locator('#other-media-image')).toHaveAttribute('data-dual-read-media-bound', /.+/);
  await expect(page.locator('#bounded-rich')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#bounded-mixed')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  const componentTargets = () => page.evaluate(() => {
    const root = document.getElementById('widget')!.shadowRoot!;
    const nested = root.querySelector('nested-widget')!.shadowRoot!;
    return [nested.querySelectorAll('.dual-read-target,.dual-read-replace-text').length,
      document.getElementById('slotted')!.querySelectorAll('.dual-read-target,.dual-read-replace-text').length];
  });
  await expect.poll(componentTargets).toEqual([1,1]);
  // Bilingual expansion above the widget can move it beyond Chromium's lazy
  // translation margin. Test a revealed component that is actually in view.
  await page.locator('#widget').scrollIntoViewIfNeeded();
  await page.evaluate(() => { window.__presentationSource.unrelated = document.querySelector('other-widget')!.shadowRoot!.querySelector('.dual-read-target')!; });
  const unrelatedRequests = sources.filter(text => text === 'Unrelated component documentation.').length;
  await page.evaluate(() => {document.getElementById('widget')!.style.opacity='0';});
  await expect.poll(componentTargets).toEqual([0,0]);
  await page.evaluate(() => {document.getElementById('widget')!.style.opacity='1';});
  await expect.poll(componentTargets).toEqual([1,1]);
  await page.evaluate(() => {document.getElementById('widget')!.shadowRoot!.querySelector<HTMLElement>('#inner')!.hidden=true;});
  await expect.poll(componentTargets).toEqual([0,0]);
  await page.evaluate(() => {document.getElementById('widget')!.shadowRoot!.querySelector<HTMLElement>('#inner')!.hidden=false;});
  await expect.poll(componentTargets).toEqual([1,1]);
  expect(await page.evaluate(() => document.querySelector('other-widget')!.shadowRoot!.querySelector('.dual-read-target') === window.__presentationSource.unrelated)).toBe(true);
  expect(sources.filter(text => text === 'Unrelated component documentation.').length).toBe(unrelatedRequests);

  await page.evaluate(() => {
    const saved = window.__presentationSource;
    saved.richText.data = 'Updated rich documentation.'; saved.mixedText.data = 'Updated mixed documentation.'; saved.link.setAttribute('href','/updated');
    document.getElementById('rich-copy')!.classList.add('cm-editor'); document.getElementById('mixed-copy')!.classList.add('cm-editor');
    for (const entry of saved.text) entry.value=entry.node.data;
  });
  await expect(page.locator('#rich-copy .dual-read-target,#rich-copy .dual-read-original-hidden,#mixed-copy .dual-read-target,#mixed-copy .dual-read-replace-text')).toHaveCount(0);
  await expect(page.locator('#bounded-rich')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#bounded-mixed')).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
  await expect(page.locator('#bounded-rich')).toHaveCSS('height','80px');
  await expect(page.locator('#bounded-mixed')).toHaveCSS('height','80px');

  if (scenario.paused) await controls.pause();
  const presentationRequests = sources.length;
  await page.evaluate(operation => {
    if (operation==='source') document.documentElement.setAttribute('data-presentation-theme','light');
    else document.documentElement.classList.add('presentation-light');
  },scenario.operation);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('#themed .dual-read-target')!.style.color)).toBe('');
  await page.evaluate(() => {
    document.getElementById('themed-source')!.style.fontSize='26px';
    const nested = document.getElementById('widget')!.shadowRoot!.querySelector('nested-widget')!.shadowRoot!;
    nested.querySelector<HTMLElement>('#shadow-theme-source')!.style.color='red';
    const style=document.createElement('style'); style.id='page-presentation-style'; style.textContent='#themed-source { font-weight:700;letter-spacing:2px }'; document.head.appendChild(style);
  });
  await expect(page.locator('#themed .dual-read-target')).toHaveCSS('font-size','26px');
  await expect(page.locator('#themed .dual-read-target')).toHaveCSS('font-weight','700');
  await expect(page.locator('#themed .dual-read-target')).toHaveCSS('letter-spacing','2px');
  await expect.poll(() => page.evaluate(() => {
    const nested = document.getElementById('widget')!.shadowRoot!.querySelector('nested-widget')!.shadowRoot!;
    return nested.querySelector<HTMLElement>('.dual-read-target')!.style.color;
  })).toContain('255, 0, 0');
  await page.evaluate(operation => {
    const {image,secondImage}=window.__presentationSource;
    if (operation==='source') image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>');
    else document.getElementById('receiver')!.appendChild(image);
    for (const node of [image,secondImage]) {node.style.width='200px';node.style.height='80px';node.style.objectFit='cover';}
  },scenario.operation);
  await expect(page.locator('[data-dual-read-media-bound],style[data-dual-read-media-style]')).toHaveCount(0);
  for (const id of ['media-image','other-media-image']) {
    await expect(page.locator(`#${id}`)).toHaveCSS('height','80px'); await expect(page.locator(`#${id}`)).toHaveCSS('object-fit','cover');
  }
  expect(sources.length).toBe(presentationRequests);

  // A queued typography refresh must not reapply paint after synchronous restore.
  await page.evaluate(async delivered => {
    document.getElementById('themed-source')!.style.color='red';
    if (delivered) await new Promise(resolve => setTimeout(resolve,450));
    document.dispatchEvent(new Event('presentation-layout-test:restore'));
  },scenario.delivered);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-media-bound],style[data-dual-read-layout-style],style[data-dual-read-media-style]')).toHaveCount(0);
  const sourceIntact = () => page.evaluate(operation => {
    const saved=window.__presentationSource;
    return saved.text.every(({node,value}) => node.isConnected && node.data===value)
      && document.getElementById('rich-source')!.firstChild===saved.richText
      && document.getElementById('mixed-copy')!.firstChild===saved.mixedText
      && saved.link.getAttribute('href')==='/updated' && document.getElementById('rich-link')===saved.link
      && document.getElementById('media-image')===saved.image && saved.image.style.height==='80px' && saved.image.style.objectFit==='cover'
      && (operation!=='transfer' || saved.image.parentElement?.id==='receiver')
      && document.getElementById('themed-source')!.style.color==='red' && document.getElementById('themed-source')!.style.fontSize==='26px'
      && document.getElementById('page-presentation-style')?.textContent==='#themed-source { font-weight:700;letter-spacing:2px }';
  },scenario.operation);
  expect(await sourceIntact()).toBe(true);
  await controls.restore(); expect(await sourceIntact()).toBe(true);
  const requestsBeforeSwitch=sources.length;
  await controls.translate(scenario.mode==='bilingual'?'replace':'bilingual');
  await expect(page.locator('#themed')).toContainText('译:Theme-dependent documentation.');
  await controls.restore(); expect(await sourceIntact()).toBe(true);
  expect(sources.slice(requestsBeforeSwitch).some(text => /Updated rich|Updated mixed|const example/.test(text))).toBe(false);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-media-bound]')).toHaveCount(0);
}
