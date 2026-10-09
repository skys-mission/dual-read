import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const specificityVisibilityCases = (['specificity-bounded', 'specificity-media', 'specificity-list', 'zero-basic', 'zero-mixed', 'zero-composed'] as const).flatMap(family =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].flatMap(paused => [false, true].map(delivered => ({family, mode, paused, delivered,
    name: `specificity visibility regression: ${family}, ${mode}, paused=${paused}, delivered=${delivered}`})))),
);
type SpecificityCase = typeof specificityVisibilityCases[number];
export const translateSpecificityText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查匿名层与定位文本的通用页面布局。'.repeat(24) : `译:${text}`;
interface SpecificitySource {
  texts: {node: Text; value: string}[];
  paragraphs: HTMLElement[];
  children: Node[][];
  images: HTMLImageElement[];
  attributes: (string | null)[][];
  primary: HTMLElement;
  guide: HTMLAnchorElement;
  addition?: HTMLElement;
  transferred?: HTMLElement;
  removed?: HTMLElement;
}
declare global {interface Window {__specificitySource: SpecificitySource}}

export async function verifySpecificityVisibilityRegression(
  page: Page, scenario: SpecificityCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(async family => {
    const base = 'body{position:relative;margin:8px;font:16px/20px sans-serif}p{margin:0}main{min-height:100vh}.bounded{width:260px;overflow:hidden;margin-bottom:12px}.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px;margin-bottom:12px}.row img{display:block;width:auto;max-width:none}.clip{width:120px;height:60px;overflow:hidden;text-indent:-9999px;margin-bottom:4px}.positioned{position:absolute;left:700px;top:40px;width:400px;text-indent:0}.fixed{position:fixed;left:1150px;top:80px;width:350px;text-indent:0}.hidden-positioned{position:fixed;left:300px;top:0;width:200px;text-indent:0}';
    const rich = 'Visible positioned <strong>source documentation.</strong> <a id="guide" href="/guide">Guide</a> <code>safeSpecificity()</code>';
    let policy = '', content = '';
    if (family === 'specificity-bounded' || family === 'specificity-list') {
      policy = family === 'specificity-list' ? '#box,.box{height:80px}.box.bounded{height:50px}'
        : '.high.active #box{height:80px}:where(.low) #box{height:80px}#box.bounded{height:50px}';
      policy += '.eq-one #stable{height:80px}.eq-two #stable{height:80px}';
      content = '<section class="bounded box" id="box"><p id="copy">Expansion competing panel documentation.</p></section><section class="bounded" id="stable"><p>Expansion equal-specificity panel.</p></section>';
    } else if (family === 'specificity-media') {
      policy = '.high.active #photo-a{height:100%}:where(.low) #photo-a{height:100%}#photo-a.media{height:220px}.eq-one #photo-control{height:100%}.eq-two #photo-control{height:100%}';
      content = ['a','control'].map(id => `<section class="row"><div><p ${id === 'a' ? 'id="copy"' : ''}>Expansion ${id} competing media documentation.</p></div><div><img id="photo-${id}" class="media" alt="Source ${id}"></div></section>`).join('');
    } else if (family === 'zero-basic') {
      content = `<section class="zero"><p id="copy" class="fixed" style="left:700px;top:40px">${rich}</p><p>Hidden inherited zero source.</p></section><section class="zero"><p id="absolute" class="positioned" style="top:120px">Visible absolute zero documentation.</p></section><section class="zero" style="position:relative"><p class="positioned">Hidden control relative zero.</p></section><section class="zero" style="transform:translateX(0)"><p class="hidden-positioned">Hidden control transformed zero.</p></section><section class="zero" style="contain:paint"><p class="hidden-positioned">Hidden control contained zero.</p></section><section style="display:none"><p class="fixed">Hidden control display.</p></section><section style="opacity:0"><p class="fixed">Hidden control opacity.</p></section>`;
    } else if (family === 'zero-mixed') {
      content = `<p class="zero"><strong id="copy" class="fixed" style="left:700px;top:40px">${rich}</strong>Hidden inherited wrapper source.</p>`;
    } else content = '<x-specificity id="component"><p id="slotted" class="fixed">Visible slotted zero documentation.</p></x-specificity>';
    document.body.innerHTML = `<style>${base}.zero{width:120px;height:0;overflow:hidden}</style><style id="specificity-author">${policy}</style><main class="high active eq-one" id="source">${content}<p id="removed">Removal documentation.</p><pre><code id="protected">function ProtectedSpecificity() { return "Do not translate code"; }</code></pre>${family.startsWith('specificity') ? '<a id="guide" href="/guide">Guide</a>' : ''}</main><div id="receiver"></div>`;
    if (family === 'zero-composed') {
      const root = document.getElementById('component')!.attachShadow({mode:'open'});
      root.innerHTML = `<style>:host{display:block}.zero{width:120px;height:0;overflow:clip}#copy{position:fixed;left:700px;top:40px;width:400px}.contained{transform:translateX(0)}.contained p{position:fixed;left:300px;top:0}</style><section class="zero"><p id="copy">${rich}</p><slot></slot><p>Hidden inherited shadow zero.</p></section><section class="zero contained"><p>Hidden control shadow zero.</p></section>`;
    }
    const scopes: ParentNode[] = [document.body, ...Array.from(document.querySelectorAll('*')).flatMap(element => element.shadowRoot ? [element.shadowRoot] : [])];
    const images = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLImageElement>('img')));
    for (const image of images) {image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');await image.decode();}
    const texts: SpecificitySource['texts'] = [];
    for (const scope of scopes) {const walk = document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);while (walk.nextNode()) {const node = walk.currentNode as Text;if (!node.parentElement?.closest('script,style')) texts.push({node,value:node.data});}}
    const paragraphs = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLElement>('p, #copy')));
    const primary = paragraphs.find(paragraph => paragraph.id === 'copy')!;
    const guide = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLAnchorElement>('#guide')))[0];
    window.__specificitySource = {texts,paragraphs,children:paragraphs.map(paragraph => Array.from(paragraph.childNodes)),images,
      attributes:images.map(image => ['src','class','style'].map(name => image.getAttribute(name))),primary,guide};
    if (family.startsWith('zero')) {
      const range = document.createRange();range.selectNodeContents(primary.firstChild!);const line = range.getBoundingClientRect();
      const root = primary.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(line.left + line.width / 2,line.top + line.height / 2);
      if (!(line.width > 50 && line.left > 500 && hit && primary.contains(hit))) throw new Error('Positioned source must be visibly painted');
    }
  }, scenario.family);
  await controls.translate(scenario.mode);
  const primary = page.locator('#copy');
  await expect(primary).toHaveAttribute('data-dual-read-done','true');
  if (scenario.family.startsWith('specificity')) {
    if (scenario.family === 'specificity-media') for (const id of ['a','control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
    else for (const id of ['box','stable']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    if (scenario.paused) await controls.pause();
    await page.evaluate(family => {
      if (family === 'specificity-list') document.getElementById('box')!.id = 'other';
      document.getElementById('source')!.className = 'low active eq-two';
    },scenario.family);
    if (scenario.family === 'specificity-media') {
      await expect(page.locator('#photo-a')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);await expect(page.locator('#photo-a')).toHaveCSS('height','220px');
      await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);
    } else {
      const box = page.locator(scenario.family === 'specificity-list' ? '#other' : '#box');
      await expect(box).not.toHaveAttribute('data-dual-read-layout-height',/.+/);await expect(box).toHaveCSS('height','50px');
      await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-layout-height',/.+/);
      await page.evaluate(family => {if (family === 'specificity-list') document.getElementById('other')!.id = 'box';document.getElementById('source')!.className = 'high active eq-one';},scenario.family);
      await expect(page.locator('#box')).toHaveAttribute('data-dual-read-layout-height',/.+/);
    }
    await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(120);await page.setViewportSize({width:1920,height:1080});
    await expect(page.locator(scenario.family === 'specificity-media' ? '#photo-control' : '#stable')).toHaveAttribute(scenario.family === 'specificity-media' ? 'data-dual-read-media-bound' : 'data-dual-read-layout-height',/.+/);
  } else {
    if (scenario.family !== 'zero-mixed') await expect(page.locator(scenario.family === 'zero-basic' ? '#absolute' : '#slotted')).toHaveAttribute('data-dual-read-done','true');
    expect(requests.some(text => /Hidden control|Hidden inherited|ProtectedSpecificity|safeSpecificity|Do not translate code/.test(text))).toBe(false);
    if (scenario.paused) await controls.pause();
  }
  await page.evaluate(async delivered => {
    const source = window.__specificitySource, host = source.primary;
    const first = source.texts.find(({node}) => host.contains(node))!;first.node.data = 'Updated positioned source documentation.';first.value = first.node.data;
    const code = source.texts.find(({node}) => node.parentElement?.id === 'protected')!;code.node.data = 'const CurrentSpecificity = "Page code edit";';code.value = code.node.data;
    source.addition = document.createElement('em');source.addition.textContent = 'Page addition';host.appendChild(source.addition);source.texts.push({node:source.addition.firstChild as Text,value:source.addition.textContent});
    const parentIndex = source.paragraphs.indexOf(host.parentElement!);
    if (parentIndex >= 0) source.children[parentIndex] = source.children[parentIndex].filter(node => node !== host);
    source.transferred = host;document.getElementById('receiver')!.appendChild(host);source.removed = document.getElementById('removed')!;source.removed.remove();source.guide.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));document.dispatchEvent(new Event('specificity-test:restore'));
  },scenario.delivered);
  const sourceState = () => page.evaluate(() => {
    const source = window.__specificitySource;
    return {values:source.texts.every(({node,value}) => source.removed!.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:source.paragraphs.filter(paragraph => paragraph !== source.removed).every(paragraph => {const expected = [...source.children[source.paragraphs.indexOf(paragraph)],...(paragraph === source.transferred ? [source.addition!] : [])];return paragraph.childNodes.length === expected.length && Array.from(paragraph.childNodes).every((node,index) => node === expected[index]);}),
      transfer:source.transferred!.parentElement === document.getElementById('receiver'),removed:!source.removed!.isConnected,
      images:source.images.every((image,index) => image.isConnected && ['src','class','style'].every((name,n) => image.getAttribute(name) === source.attributes[index][n])),link:source.guide.getAttribute('href') === '/current-guide'};
  });
  const expected = {values:true,order:true,transfer:true,removed:true,images:true,link:true};
  expect(await sourceState()).toEqual(expected);await controls.restore();expect(await sourceState()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,.dual-read-flow,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  // The page moved a formatting element into a normal prose container. That
  // container now owns collection, while the original formatting node survives.
  await expect(scenario.family === 'zero-mixed' ? page.locator('#receiver') : primary).toHaveAttribute('data-dual-read-done','true');
  expect(requests.some(text => text.includes('Updated positioned source documentation.'))).toBe(true);
  await controls.restore();expect(await sourceState()).toEqual(expected);
  expect(requests.some(text => /Hidden control|Hidden inherited|ProtectedSpecificity|CurrentSpecificity|safeSpecificity|Do not translate code/.test(text))).toBe(false);
}
