import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const sharedPolicyCases = (['root-selector','logical-border','border-order','border-style','root-list','border-media'] as const).flatMap(family =>
  (['bilingual','replace'] as const).flatMap(mode => [false,true].flatMap(paused => [false,true].map(delivered => ({family,mode,paused,delivered,
    name:`shared policy regression: ${family}, ${mode}, paused=${paused}, delivered=${delivered}`})))),
);
type SharedPolicyCase = typeof sharedPolicyCases[number];
export const translateSharedPolicyText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查逻辑尺寸与原生嵌套样式的通用页面布局。'.repeat(20) : `译:${text}`;
interface SharedPolicySource {
  texts: {node: Text; value: string}[];
  primary: HTMLElement;
  children: Node[];
  guide: HTMLAnchorElement;
  images: HTMLImageElement[];
  attributes: (string | null)[][];
  addition?: HTMLElement;
  removed: HTMLElement;
}
declare global {interface Window {__sharedPolicySource: SharedPolicySource}}

export async function verifySharedPolicyCase(
  page: Page, scenario: SharedPolicyCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(async family => {
    const base = 'body{margin:8px;font:16px/20px sans-serif}p{margin:0}main{min-height:100vh}.bounded{width:260px;overflow:hidden;margin-bottom:12px;border-style:solid;border-width:0;--edge:20px}.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px;margin-bottom:12px}.row img{display:block;width:auto;max-width:none}';
    let policy = '';
    if (family === 'root-selector') policy = '&.high #box{height:80px}#box{height:50px}';
    else if (family === 'root-list') policy = ':is(&).high #box,:is(&).high #unused{height:80px}#box{height:50px}';
    else if (family === 'logical-border') policy = '#box{height:80px;border-block-start-width:20px}';
    else if (family === 'border-order') policy = '#box{height:80px;border-top-width:0px;border-block-width:var(--edge)}';
    else if (family === 'border-style') policy = '#box{height:80px;border-block-start-width:20px}';
    else policy = '.row img{height:100%}.high.active #column{border-right-width:20px}:where(.low) #column{border-right-width:20px}#column.bounded{border-inline-end-width:0px}';
    document.documentElement.className = 'high';
    const rich = '<p id="copy">Expansion source documentation. <strong>Important prose.</strong> <a id="guide" href="/guide">Guide</a> <code>safeSharedPolicy()</code></p>';
    const content = family === 'border-media'
      ? `<section class="row"><div>${rich}</div><div id="column" class="bounded"><img id="photo" class="media" alt="Source image"></div></section><section class="row"><div><p>Expansion stable media.</p></div><div><img id="photo-control"></div></section>`
      : `<section id="box" class="box bounded escaped&name" data-token="a&b">${rich}</section><section class="bounded" id="stable"><p>Expansion stable panel.</p></section>`;
    document.body.innerHTML = `<style>${base}</style><style id="logical-author">${policy}</style><style id="logical-control">.one #stable{height:80px;width:260px;color:red}.two #stable{height:80px;width:260px;color:blue}.one #photo-control{height:100%}.two #photo-control{height:100%}#stable{--stable-pad:0px;padding-block:var(--stable-pad);@media(min-width:3000px){height:10px}}</style><main id="source" class="scope high active one">${content}<p id="removed">Removal source documentation.</p><pre><code id="protected">function ProtectedSharedPolicy() { return "Do not translate code"; }</code></pre></main><div id="receiver"></div>`;
    const images = Array.from(document.querySelectorAll('img'));
    for (const image of images) {image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');await image.decode();}
    const texts: SharedPolicySource['texts'] = [],walk = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {const node = walk.currentNode as Text;if (!node.parentElement?.closest('style,script')) texts.push({node,value:node.data});}
    const primary = document.getElementById('copy')!;
    window.__sharedPolicySource = {texts,primary,children:Array.from(primary.childNodes),guide:document.getElementById('guide') as HTMLAnchorElement,
      images,attributes:images.map(image => ['src','class','style'].map(name => image.getAttribute(name))),removed:document.getElementById('removed')!};
    if (family !== 'border-media' && Math.abs(document.getElementById('box')!.getBoundingClientRect().height - (family === 'border-order' ? 120 : family.startsWith('root') ? 80 : 100)) > 1) throw new Error('Unexpected source panel geometry');
  },scenario.family);
  await controls.translate(scenario.mode);
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  const media = scenario.family === 'border-media', marker = media ? 'data-dual-read-media-bound' : 'data-dual-read-layout-height';
  for (const id of media ? ['photo','photo-control'] : ['box','stable']) await expect(page.locator('#'+id)).toHaveAttribute(marker,/.+/);
  if (scenario.paused) await controls.pause();
  await page.evaluate(family => {
    const sheet = document.getElementById('logical-author')!;
    if (family === 'border-order') sheet.textContent = sheet.textContent!.replace('border-top-width:0px;border-block-width:var(--edge)','border-block-width:var(--edge);border-top-width:0px');
    if (family === 'logical-border') sheet.textContent = sheet.textContent!.replace('border-block-start-width:20px','border-block-start-width:0px');
    if (family === 'border-style') document.getElementById('box')!.style.borderBlockStartStyle = 'none';
    document.documentElement.className = 'low';
    document.getElementById('source')!.className = 'scope low active two';
    const control = document.getElementById('logical-control')!;
    control.textContent = control.textContent!.replaceAll('height:80px;width:260px','width:260px;height:80px').replace('height:10px','height:20px');
  },scenario.family);
  const subject = page.locator(media ? '#photo' : '#box');
  await expect(subject).not.toHaveAttribute(marker,/.+/);
  if (media) await expect(page.locator('#column')).toHaveCSS('border-right-width','0px');
  else await expect(subject).toHaveCSS('height',scenario.family.startsWith('root') ? '50px' : '80px');
  if (!media && !scenario.family.startsWith('root')) await expect(subject).toHaveCSS('border-top-width','0px');
  const stable = page.locator(media ? '#photo-control' : '#stable');await expect(stable).toHaveAttribute(marker,/.+/);
  await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(120);await page.setViewportSize({width:1920,height:1080});
  await expect(stable).toHaveAttribute(marker,/.+/);
  await page.evaluate(async delivered => {
    const source = window.__sharedPolicySource,first = source.texts.find(({node}) => source.primary.contains(node))!;
    first.node.data = 'Updated logical source documentation.';first.value = first.node.data;
    const code = source.texts.find(({node}) => node.parentElement?.id === 'protected')!;code.node.data = 'const CurrentSharedPolicy = "Page code edit";';code.value = code.node.data;
    source.addition = document.createElement('em');source.addition.textContent = 'Page addition';source.primary.appendChild(source.addition);
    source.texts.push({node:source.addition.firstChild as Text,value:source.addition.textContent});
    document.getElementById('receiver')!.appendChild(source.primary);source.removed.remove();source.guide.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));document.dispatchEvent(new Event('shared-policy-test:restore'));
  },scenario.delivered);
  const readSource = () => page.evaluate(() => {
    const source = window.__sharedPolicySource,expected = [...source.children,source.addition!];
    return {values:source.texts.every(({node,value}) => source.removed.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:source.primary.childNodes.length === expected.length && Array.from(source.primary.childNodes).every((node,index) => node === expected[index]),
      transferred:source.primary.parentElement === document.getElementById('receiver'),removed:!source.removed.isConnected,link:source.guide.getAttribute('href') === '/current-guide',
      images:source.images.every((image,index) => ['src','class','style'].every((name,n) => image.getAttribute(name) === source.attributes[index][n]))};
  });
  const expected = {values:true,order:true,transferred:true,removed:true,link:true,images:true};
  expect(await readSource()).toEqual(expected);await controls.restore();expect(await readSource()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,.dual-read-flow,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  expect(requests.some(text => text.includes('Updated logical source documentation.'))).toBe(true);
  await controls.restore();expect(await readSource()).toEqual(expected);
  expect(requests.some(text => /ProtectedSharedPolicy|CurrentSharedPolicy|safeSharedPolicy|Do not translate code/.test(text))).toBe(false);
}

// Each family is restored before the next; avoid repeated cold browser boots.
export const sharedPolicyGroups = (['bilingual','replace'] as const).flatMap(mode => [false,true].flatMap(paused => [false,true].map(delivered => ({mode,paused,delivered, name:`shared policy regression: ${mode}, paused=${paused}, delivered=${delivered}`}))));
export async function verifySharedPolicyRegression(page: Page, group: typeof sharedPolicyGroups[number], controls: Parameters<typeof verifySharedPolicyCase>[2], requests: string[]): Promise<void> {
  for (const scenario of sharedPolicyCases.filter(s => s.mode===group.mode && s.paused===group.paused && s.delivered===group.delivered)) await verifySharedPolicyCase(page,scenario,controls,requests);
}
