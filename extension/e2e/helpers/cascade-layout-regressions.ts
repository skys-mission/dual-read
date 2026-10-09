import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const cascadeLayoutCases = (['layer-bounded', 'layer-media', 'logical-media', 'indent'] as const).flatMap(family =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].flatMap(paused => [false, true].map(delivered => ({family, mode, paused, delivered,
    name: `cascade layout regression: ${family}, ${mode}, paused=${paused}, delivered=${delivered}`})))),
);
type CascadeCase = typeof cascadeLayoutCases[number];
export const translateCascadeText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查页面层叠规则变化和译文尺寸的文字。'.repeat(20) : `译:${text}`;
interface CascadeSource {
  texts: {node: Text; value: string}[];
  paragraphs: HTMLElement[];
  children: Node[][];
  images: HTMLImageElement[];
  attributes: (string | null)[][];
  addition?: HTMLElement;
  transferred?: HTMLElement;
  removed?: HTMLElement;
}
declare global {interface Window {__cascadeSource: CascadeSource}}

export async function verifyCascadeLayoutRegression(
  page: Page, scenario: CascadeCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(async family => {
    const row = (id: string) => `<section class="row" id="row-${id}"><div><p id="${id === 'a' ? 'copy' : 'copy-' + id}">Expansion ${id} source documentation.</p></div><div><img id="photo-${id}" alt="Source ${id}"></div></section>`;
    const base = 'body{margin:8px;font:16px/20px sans-serif}p{margin:0}main{min-height:100vh}.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px;margin-bottom:12px}.row img{display:block;width:auto;max-width:none}';
    let css = '', policy = '', content = '';
    if (family === 'layer-bounded') {
      css = '#box,#nested,#stable{width:260px;overflow:hidden;margin-bottom:12px}';
      policy = '@layer base,large,small,page;@layer base{#stable{height:80px}}@layer small{#box{height:80px}}@layer large{#box{height:50px}}@layer page{@layer large,small;@layer small{#nested{height:80px}}@layer large{#nested{height:50px}}}';
      content = '<section id="box"><p id="copy">Expansion root layered panel.</p></section><section id="nested"><p id="copy-nested">Expansion nested layered panel.</p></section><section id="stable"><p id="copy-stable">Expansion stable layered panel.</p></section>';
    } else if (family === 'layer-media') {
      policy = '@layer base,large,small;@layer base{#photo-control{height:100%}}@layer small{#photo-a{height:100%}}@layer large{#photo-a{height:220px}}';
      content = row('a') + row('control');
    } else if (family === 'logical-media') {
      css = '.row img{height:100%}#toggle.changed ~ main #photo-a{max-inline-size:80px}#toggle.changed ~ main #photo-b{min-inline-size:500px}#toggle.changed ~ main #photo-c{max-block-size:60px}#toggle.changed ~ main #photo-d{min-block-size:220px}';
      content = ['a','b','c','d','control'].map(row).join('');
    } else {
      css = '.indented{width:600px;overflow-x:hidden;text-indent:-9999px}.reset{ text-indent:0 }.mixed strong{display:block;text-indent:0}.multiline{white-space:pre;line-height:20px}';
      content = '<section class="indented"><p id="copy" class="reset">Visible child documentation.</p><p id="hidden-indent">Hidden inherited indentation.</p></section><p class="indented mixed" id="mixed">Hidden leading run <strong id="visible-rich">Visible rich documentation.</strong><code>createRoot()</code></p><p class="indented multiline" id="multiline">Hidden first line.\nVisible following documentation line.</p><section id="reveal" class="indented"><p id="late">Late indent documentation.</p></section><section style="height:0;overflow:hidden"><p>Hidden zero-height documentation.</p></section>';
    }
    document.body.innerHTML = `<style>${base}${css}</style><style id="cascade-author">${policy}</style><div id="toggle"></div><main id="source">${content}<p id="removed">Removal documentation.</p><pre><code id="protected">function ProtectedCascade() { return "Do not translate code"; }</code></pre><a id="guide" href="/guide">A guide</a></main><section id="receiver"></section>`;
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
    for (const image of images) {image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>'); await image.decode();}
    const texts: CascadeSource['texts'] = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {const node = walk.currentNode as Text; if (!node.parentElement?.closest('script,style')) texts.push({node, value:node.data});}
    const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('p'));
    window.__cascadeSource = {texts, paragraphs, children:paragraphs.map(paragraph => Array.from(paragraph.childNodes)), images,
      attributes:images.map(image => ['src','class','style'].map(name => image.getAttribute(name)))};
    if (family === 'indent') {
      const text = document.createRange(); text.selectNodeContents(document.getElementById('copy')!.firstChild!);
      const line = text.getBoundingClientRect(), box = document.getElementById('copy')!.getBoundingClientRect();
      if (!(line.width > 100 && line.height > 10 && line.left >= box.left && line.right <= box.right)) throw new Error('Reset child must be visibly rendered');
    }
  }, scenario.family);
  await controls.translate(scenario.mode);
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  if (scenario.family === 'layer-bounded') for (const id of ['box','nested','stable']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
  else if (scenario.family.endsWith('media')) {
    for (const id of scenario.family === 'logical-media' ? ['a','b','c','d','control'] : ['a','control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
  } else {
    for (const id of ['mixed','multiline']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-done','true');
    expect(requests.some(text => /Hidden leading run|Hidden inherited indentation|Hidden zero-height|ProtectedCascade|createRoot|Do not translate code/.test(text))).toBe(false);
    // A partially visible multi-line source stays one semantic source unit.
    expect(requests.some(text => text.includes('Visible following documentation line.'))).toBe(true);
  }
  if (scenario.paused) await controls.pause();
  if (scenario.family === 'layer-bounded' || scenario.family === 'layer-media') {
    await page.evaluate(() => {const sheet = document.getElementById('cascade-author')!;sheet.textContent = sheet.textContent!.replaceAll('large,small','small,large');});
    if (scenario.family === 'layer-bounded') {
      for (const id of ['box','nested']) {await expect(page.locator('#'+id)).not.toHaveAttribute('data-dual-read-layout-height',/.+/);await expect(page.locator('#'+id)).toHaveCSS('height','50px');}
      await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-layout-height',/.+/);
      await page.evaluate(() => {const sheet = document.getElementById('cascade-author')!;sheet.textContent = sheet.textContent!.replaceAll('small,large','large,small');});
      for (const id of ['box','nested']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    } else {await expect(page.locator('#photo-a')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);await expect(page.locator('#photo-a')).toHaveCSS('height','220px');}
  } else if (scenario.family === 'logical-media') {
    await page.evaluate(() => document.getElementById('toggle')!.className = 'changed');
    for (const id of ['a','b','c','d']) await expect(page.locator('#photo-'+id)).not.toHaveAttribute('data-dual-read-media-bound',/.+/);
    await expect(page.locator('#photo-a')).toHaveCSS('width','80px');
    await expect(page.locator('#photo-b')).toHaveCSS('min-inline-size','500px');
    await expect(page.locator('#photo-c')).toHaveCSS('height','60px');
    await expect(page.locator('#photo-d')).toHaveCSS('min-block-size','220px');
  } else {
    await page.evaluate(() => document.getElementById('reveal')!.style.textIndent = '0px');
    if (!scenario.paused) await expect(page.locator('#late')).toHaveAttribute('data-dual-read-done','true');
    else expect(requests.some(text => text.includes('Late indent documentation.'))).toBe(false);
  }
  if (scenario.family.endsWith('media')) {
    await page.evaluate(() => document.getElementById('row-control')!.style.color = 'red');
    await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);
  }
  await page.setViewportSize({width:1600,height:900}); await page.waitForTimeout(120);
  if (scenario.family.endsWith('media')) await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(async delivered => {
    const source = window.__cascadeSource, host = document.getElementById('copy')!;
    const first = source.texts.find(({node}) => host.contains(node))!;first.node.data = 'Updated source documentation.';first.value = first.node.data;
    const code = source.texts.find(({node}) => node.parentElement?.id === 'protected')!;code.node.data = 'const CurrentCascade = "Page code edit";';code.value = code.node.data;
    source.addition = document.createElement('em');source.addition.textContent = 'Page addition';host.appendChild(source.addition);source.texts.push({node:source.addition.firstChild as Text,value:source.addition.textContent});
    source.transferred = host;document.getElementById('receiver')!.appendChild(host);
    source.removed = document.getElementById('removed')!;source.removed.remove();document.getElementById('guide')!.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));
    document.dispatchEvent(new Event('cascade-test:restore'));
  }, scenario.delivered);
  const sourceState = () => page.evaluate(() => {
    const source = window.__cascadeSource;
    return {values:source.texts.every(({node,value}) => source.removed!.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:source.paragraphs.filter(paragraph => paragraph !== source.removed).every(paragraph => {
        const expected = [...source.children[source.paragraphs.indexOf(paragraph)], ...(paragraph === source.transferred ? [source.addition!] : [])];
        return paragraph.childNodes.length === expected.length && Array.from(paragraph.childNodes).every((node,index) => node === expected[index]);
      }),transfer:source.transferred!.parentElement === document.getElementById('receiver'),removed:!source.removed!.isConnected,
      images:source.images.every((image,index) => image.isConnected && ['src','class','style'].every((name,n) => image.getAttribute(name) === source.attributes[index][n])),link:document.getElementById('guide')!.getAttribute('href') === '/current-guide'};
  });
  const expected = {values:true,order:true,transfer:true,removed:true,images:true,link:true};
  expect(await sourceState()).toEqual(expected);await controls.restore();expect(await sourceState()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,.dual-read-flow,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');await controls.restore();expect(await sourceState()).toEqual(expected);
  expect(requests.some(text => /ProtectedCascade|CurrentCascade|Do not translate code|createRoot/.test(text))).toBe(false);
}
