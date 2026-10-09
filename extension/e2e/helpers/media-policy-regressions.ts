import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const mediaPolicyCases = (['container', 'opaque', 'scope'] as const).flatMap(trigger =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].map(paused => ({trigger, mode, paused,
    name: `media policy regression: ${trigger}, ${mode}, paused=${paused}`}))),
);
type MediaPolicyCase = typeof mediaPolicyCases[number];
export const translateMediaPolicyText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查动态页面布局和作者图片尺寸及裁剪方式的翻译文字。'.repeat(12) : `译:${text}`;

interface MediaPolicySource {
  texts: {node: Text; value: string}[];
  images: HTMLImageElement[];
  attributes: (string | null)[][];
  controlHeight: number;
  addition?: HTMLElement;
}
declare global {interface Window {__mediaPolicySource: MediaPolicySource}}

export async function verifyMediaPolicyRegression(
  page: Page, scenario: MediaPolicyCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  const base = '.media-container{container-type:inline-size;width:600px;margin-bottom:24px}.media-row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:600px}.media-row p{margin:0;font:16px/20px sans-serif}.media-row img{display:block;width:auto;height:100%;max-width:none}#photo-control{box-sizing:border-box;border:4px solid transparent;padding:4px}#row-control > div:last-child{box-sizing:border-box;border:2px solid transparent;padding:6px}.media-container.changed{width:300px}';
  const changes = '#photo-a{height:220px;width:260px;object-fit:cover}#photo-b{height:220px}';
  if (scenario.trigger === 'container') {
    await page.addStyleTag({content: base + '@container(max-width:400px){' + changes + '#photo-control{height:100%;object-fit:fill}}'});
  } else if (scenario.trigger === 'scope') {
    await page.addStyleTag({content: base + '@media(min-width:1px){'
      + '@scope(#container-a.changed){:scope .media-row #photo-a{height:220px;width:260px;object-fit:cover}}'
      + '@scope(#container-b.changed){& .media-row #photo-b{height:220px}}'
      + '@scope(#container-control){:scope .media-row #photo-control{height:100%;object-fit:fill}}}'});
  } else {
    const url = new URL('/media-policy.css', page.url()); url.hostname = 'localhost';
    await page.route(url.href, route => route.fulfill({contentType: 'text/css', body: base
      + '#row-a.changed #photo-a{height:220px;width:260px;object-fit:cover}#row-b.changed #photo-b{height:220px}'}));
    await page.addStyleTag({url: url.href});
    expect(await page.evaluate(() => {try {Array.from(Array.from(document.styleSheets).find(sheet => sheet.href?.endsWith('/media-policy.css'))!.cssRules); return false;} catch {return true;}})).toBe(true);
  }
  await page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('.media-row img'));
    const source = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');
    for (const image of images) {image.src = source; await image.decode();}
    const texts: MediaPolicySource['texts'] = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {const node = walk.currentNode as Text; if (!node.parentElement?.closest('script,style')) texts.push({node, value: node.data});}
    window.__mediaPolicySource = {texts, images, attributes: images.map(image => ['src', 'style', 'class'].map(name => image.getAttribute(name))),
      controlHeight: images[2].getBoundingClientRect().height};
  });
  await controls.translate(scenario.mode);
  for (const suffix of ['a', 'b', 'control']) await expect(page.locator('#photo-' + suffix)).toHaveAttribute('data-dual-read-media-bound', /.+/);
  if (scenario.paused) await controls.pause();
  // An uncertain stylesheet must not make ordinary page paint/reflow cancel
  // the correction. Keep the same source ratio while more prose grows the row.
  await page.evaluate(() => {
    document.getElementById('row-control')!.classList.add('paint-only');
    document.getElementById('row-control')!.style.color = 'red';
    const addition = document.createElement('p'); addition.textContent = 'Expansion additional source documentation.';
    document.getElementById('control-copy')!.appendChild(addition);
    window.__mediaPolicySource.addition = addition;
    window.__mediaPolicySource.texts.push({node: addition.firstChild as Text, value: addition.textContent});
  });
  if (!scenario.paused) await expect(page.locator('#control-copy > p').last()).toHaveAttribute('data-dual-read-done', 'true');
  await page.setViewportSize({width: 1600, height: 900}); await page.waitForTimeout(150);
  await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound', /.+/);
  await expect.poll(() => page.locator('#photo-control').evaluate(image => Math.abs(image.getBoundingClientRect().height - window.__mediaPolicySource.controlHeight))).toBeLessThan(0.1);
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(trigger => {
    for (const suffix of ['a', 'b']) document.getElementById((trigger === 'opaque' ? 'row-' : 'container-') + suffix)!.classList.add('changed');
  }, scenario.trigger);
  for (const suffix of ['a', 'b']) {
    await expect(page.locator('#photo-' + suffix)).not.toHaveAttribute('data-dual-read-media-bound', /.+/);
    await expect(page.locator('#photo-' + suffix)).toHaveCSS('height', '220px');
  }
  await expect(page.locator('#photo-a')).toHaveCSS('object-fit', 'cover');
  await expect.poll(() => page.locator('#photo-b').evaluate(image => Math.abs(parseFloat(getComputedStyle(image).width) - 880))).toBeLessThan(0.1);
  await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound', /.+/);
  expect(requests.some(text => /ProtectedMedia|Do not translate code/.test(text))).toBe(false);
  // Keep current page edits and transferred source identities during immediate
  // restore and a repeated restore. The opposite mode reuses the edited page.
  await page.evaluate(() => {
    const source = window.__mediaPolicySource.texts.find(({node}) => node.data.startsWith('Expansion cropped'))!;
    source.node.data = 'Updated cropped source documentation.'; source.value = source.node.data;
    document.getElementById('receiver')!.appendChild(window.__mediaPolicySource.addition!);
    document.dispatchEvent(new Event('media-policy-test:restore'));
  });
  const assertSource = () => page.evaluate(() => {
    const s = window.__mediaPolicySource;
    return {texts: s.texts.every(({node, value}) => node.isConnected && node.data === value),
      images: s.images.every((image, index) => image.isConnected && ['src', 'style', 'class'].every((name, n) => image.getAttribute(name) === s.attributes[index][n])),
      transfer: s.addition!.parentElement === document.getElementById('receiver'),
      paint: document.getElementById('row-control')!.style.color === 'red'};
  });
  expect(await assertSource()).toEqual({texts: true, images: true, transfer: true, paint: true});
  await controls.restore(); expect(await assertSource()).toEqual({texts: true, images: true, transfer: true, paint: true});
  await expect(page.locator('[data-dual-read-media-bound],style[data-dual-read-media-style],.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#copy-a')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#photo-a')).toHaveCSS('height', '220px');
  await expect(page.locator('#photo-a')).toHaveCSS('object-fit', 'cover');
  await controls.restore(); expect(await assertSource()).toEqual({texts: true, images: true, transfer: true, paint: true});
}
