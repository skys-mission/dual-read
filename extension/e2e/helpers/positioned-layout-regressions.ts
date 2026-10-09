import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const positionedLayoutCases = (['anonymous-bounded', 'anonymous-media', 'positioned-basic', 'positioned-composed'] as const).flatMap(family =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].flatMap(paused => [false, true].map(delivered => ({family, mode, paused, delivered,
    name: `positioned layout regression: ${family}, ${mode}, paused=${paused}, delivered=${delivered}`})))),
);
type PositionedCase = typeof positionedLayoutCases[number];
export const translatePositionedText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查匿名层与定位文本的通用页面布局。'.repeat(24) : `译:${text}`;
interface PositionedSource {
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
declare global {interface Window {__positionedSource: PositionedSource}}

export async function verifyPositionedLayoutRegression(
  page: Page, scenario: PositionedCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(async family => {
    const base = 'body{position:relative;margin:8px;font:16px/20px sans-serif}p{margin:0}main{min-height:100vh}.bounded{width:260px;overflow:hidden;margin-bottom:12px}.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px;margin-bottom:12px}.row img{display:block;width:auto;max-width:none}.clip{width:120px;height:60px;overflow:hidden;text-indent:-9999px;margin-bottom:4px}.positioned{position:absolute;left:700px;top:40px;width:400px;text-indent:0}.fixed{position:fixed;left:1150px;top:80px;width:350px;text-indent:0}.hidden-positioned{position:fixed;left:300px;top:0;width:200px;text-indent:0}';
    const rich = 'Visible positioned <strong>source documentation.</strong> <a id="guide" href="/guide">Guide</a> <code>safePositioned()</code>';
    let policy = '', content = '';
    if (family === 'anonymous-bounded') {
      policy = '@layer{#box{height:80px}}@layer{@layer{#nested{height:80px}}}@layer stable{#stable{height:80px}}';
      content = '<section class="bounded" id="box"><p id="copy">Expansion anonymous panel documentation.</p></section><section class="bounded" id="nested"><p>Expansion nested anonymous panel.</p></section><section class="bounded" id="stable"><p>Expansion named stable panel.</p></section>';
    } else if (family === 'anonymous-media') {
      policy = '@layer{#photo-a{height:100%}}@layer stable{#photo-control{height:100%}}';
      content = ['a','control'].map(id => `<section class="row"><div><p ${id === 'a' ? 'id="copy"' : ''}>Expansion ${id} neighboring media documentation.</p></div><div><img id="photo-${id}" alt="Source ${id}"></div></section>`).join('');
    } else if (family === 'positioned-basic') {
      content = `<section class="clip"><p id="copy" class="positioned">${rich}</p><p>Hidden inherited source.</p></section><section class="clip" style="position:relative"><p id="fixed" class="fixed">Visible viewport fixed documentation.</p><p style="position:absolute;left:300px;top:0;text-indent:0">Hidden control absolute.</p></section>`;
      const containing = ['transform:translateX(0)', 'translate:0px', 'rotate:0deg', 'scale:1', 'perspective:1000px', 'filter:blur(0px)', 'backdrop-filter:blur(0px)', 'will-change:transform', 'contain:layout', 'contain:paint', 'content-visibility:auto'];
      content += containing.map((style,index) => `<section class="clip" style="${style}"><p class="hidden-positioned">Hidden control ${index}.</p></section>`).join('');
      content += '<section class="clip" style="will-change:opacity;contain:style"><p id="hint-fixed" class="fixed" style="top:140px">Visible non-containing hints.</p></section>';
    } else content = '<x-positioned id="component"><p id="slotted" class="fixed">Visible slotted fixed documentation.</p></x-positioned>';
    document.body.innerHTML = `<style>${base}</style><style id="positioned-author">${policy}</style><main id="source">${content}<p id="removed">Removal documentation.</p><pre><code id="protected">function ProtectedPositioned() { return "Do not translate code"; }</code></pre>${family.startsWith('anonymous') ? '<a id="guide" href="/guide">Guide</a>' : ''}</main><section id="receiver"></section>`;
    if (family === 'positioned-composed') {
      const root = document.getElementById('component')!.attachShadow({mode:'open'});
      root.innerHTML = `<style>:host{display:block}.clip{width:120px;height:120px;overflow:clip;text-indent:-9999px}#copy{position:absolute;left:700px;top:40px;width:400px;text-indent:0}.contained{transform:translateX(0)}.contained p{position:fixed;left:300px;top:0;text-indent:0}</style><section class="clip"><p id="copy">${rich}</p><slot></slot><p>Hidden inherited shadow source.</p></section><section class="clip contained"><p>Hidden control shadow fixed.</p></section>`;
    }
    const scopes: ParentNode[] = [document.body, ...Array.from(document.querySelectorAll('*')).flatMap(element => element.shadowRoot ? [element.shadowRoot] : [])];
    const images = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLImageElement>('img')));
    for (const image of images) {image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');await image.decode();}
    const texts: PositionedSource['texts'] = [];
    for (const scope of scopes) {const walk = document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);while (walk.nextNode()) {const node = walk.currentNode as Text;if (!node.parentElement?.closest('script,style')) texts.push({node,value:node.data});}}
    const paragraphs = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLElement>('p')));
    const primary = paragraphs.find(paragraph => paragraph.id === 'copy')!;
    const guide = scopes.flatMap(scope => Array.from(scope.querySelectorAll<HTMLAnchorElement>('#guide')))[0];
    window.__positionedSource = {texts,paragraphs,children:paragraphs.map(paragraph => Array.from(paragraph.childNodes)),images,
      attributes:images.map(image => ['src','class','style'].map(name => image.getAttribute(name))),primary,guide};
    if (family.startsWith('positioned')) {
      const range = document.createRange();range.selectNodeContents(primary.firstChild!);const line = range.getBoundingClientRect();
      const root = primary.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(line.left + line.width / 2,line.top + line.height / 2);
      if (!(line.width > 50 && line.left > 500 && hit && primary.contains(hit))) throw new Error('Positioned source must be visibly painted');
    }
  }, scenario.family);
  await controls.translate(scenario.mode);
  const primary = page.locator('#copy');
  await expect(primary).toHaveAttribute('data-dual-read-done','true');
  const bounded = ['box','nested','stable'];
  if (scenario.family === 'anonymous-bounded') for (const id of bounded) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
  else if (scenario.family === 'anonymous-media') for (const id of ['a','control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
  else {
    await expect(page.locator(scenario.family === 'positioned-basic' ? '#fixed' : '#slotted')).toHaveAttribute('data-dual-read-done','true');
    expect(requests.some(text => /Hidden control|Hidden inherited|ProtectedPositioned|safePositioned|Do not translate code/.test(text))).toBe(false);
  }
  if (scenario.paused) await controls.pause();
  if (scenario.family.startsWith('anonymous')) {
    await page.evaluate(() => {const paint = document.createElement('style');paint.id = 'paint-only';paint.textContent = '@layer{body{color:rgb(30,50,70)}}';document.head.prepend(paint);});
    await page.waitForTimeout(180);
    if (scenario.family === 'anonymous-bounded') for (const id of bounded) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    else for (const id of ['a','control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
    await page.evaluate(() => {const paint = document.getElementById('paint-only')!;paint.textContent = '@layer{@layer{body{color:rgb(70,50,30)}}}';paint.remove();});
    await page.waitForTimeout(100);
  }
  await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(120);await page.setViewportSize({width:1920,height:1080});
  if (scenario.family.startsWith('anonymous')) {
    if (scenario.family === 'anonymous-bounded') for (const id of bounded) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    else for (const id of ['a','control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
    await page.evaluate(family => {const sizing = document.createElement('style');sizing.id = 'author-change';sizing.textContent = family === 'anonymous-bounded' ? '@layer{#box{height:50px}}' : '@layer{#photo-a{height:220px}}';document.body.append(sizing);},scenario.family);
    if (scenario.family === 'anonymous-bounded') {await expect(page.locator('#box')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);await expect(page.locator('#box')).toHaveCSS('height','50px');await expect(page.locator('#nested')).toHaveAttribute('data-dual-read-layout-height',/.+/);await page.evaluate(() => document.getElementById('author-change')!.remove());await expect(page.locator('#box')).toHaveAttribute('data-dual-read-layout-height',/.+/);}
    else {await expect(page.locator('#photo-a')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);await expect(page.locator('#photo-a')).toHaveCSS('height','220px');await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);}
  }
  await page.evaluate(async delivered => {
    const source = window.__positionedSource, host = source.primary;
    const first = source.texts.find(({node}) => host.contains(node))!;first.node.data = 'Updated positioned source documentation.';first.value = first.node.data;
    const code = source.texts.find(({node}) => node.parentElement?.id === 'protected')!;code.node.data = 'const CurrentPositioned = "Page code edit";';code.value = code.node.data;
    source.addition = document.createElement('em');source.addition.textContent = 'Page addition';host.appendChild(source.addition);source.texts.push({node:source.addition.firstChild as Text,value:source.addition.textContent});
    source.transferred = host;document.getElementById('receiver')!.appendChild(host);source.removed = document.getElementById('removed')!;source.removed.remove();source.guide.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));document.dispatchEvent(new Event('positioned-test:restore'));
  },scenario.delivered);
  const sourceState = () => page.evaluate(() => {
    const source = window.__positionedSource;
    return {values:source.texts.every(({node,value}) => source.removed!.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:source.paragraphs.filter(paragraph => paragraph !== source.removed).every(paragraph => {const expected = [...source.children[source.paragraphs.indexOf(paragraph)],...(paragraph === source.transferred ? [source.addition!] : [])];return paragraph.childNodes.length === expected.length && Array.from(paragraph.childNodes).every((node,index) => node === expected[index]);}),
      transfer:source.transferred!.parentElement === document.getElementById('receiver'),removed:!source.removed!.isConnected,
      images:source.images.every((image,index) => image.isConnected && ['src','class','style'].every((name,n) => image.getAttribute(name) === source.attributes[index][n])),link:source.guide.getAttribute('href') === '/current-guide'};
  });
  const expected = {values:true,order:true,transfer:true,removed:true,images:true,link:true};
  expect(await sourceState()).toEqual(expected);await controls.restore();expect(await sourceState()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,.dual-read-flow,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');await expect(primary).toHaveAttribute('data-dual-read-done','true');await controls.restore();expect(await sourceState()).toEqual(expected);
  expect(requests.some(text => /Hidden control|Hidden inherited|ProtectedPositioned|CurrentPositioned|safePositioned|Do not translate code/.test(text))).toBe(false);
}
