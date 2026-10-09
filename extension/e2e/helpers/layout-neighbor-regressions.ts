import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const layoutNeighborCases = (['padding', 'sibling-media', 'parent-media', 'conditional-sizing'] as const).flatMap(family =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].flatMap(paused => [false, true].map(delivered => ({family, mode, paused, delivered,
    name: `layout neighbor regression: ${family}, ${mode}, paused=${paused}, delivered=${delivered}`})))),
);
type NeighborCase = typeof layoutNeighborCases[number];
export const translateNeighborText = (text: string): string => text.startsWith('Expansion')
  ? '用于检查作者尺寸变化及正常译文布局的文字。'.repeat(12) : `译:${text}`;
interface NeighborSource {
  texts: {node: Text; value: string}[];
  paragraphs: HTMLElement[];
  children: Node[][];
  images: HTMLImageElement[];
  imageAttrs: (string | null)[][];
  controlHeight: number;
  addition?: HTMLElement;
  transferred?: HTMLElement;
  removed?: HTMLElement;
}
declare global {interface Window {__neighborSource: NeighborSource}}

export async function verifyLayoutNeighborRegression(
  page: Page, scenario: NeighborCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(async family => {
    const base = 'body{margin:8px;font:16px/20px sans-serif}p{margin:0}main{width:100%;min-height:100vh}.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px;margin-bottom:12px}.row img{display:block;width:auto;height:100%;max-width:none}';
    let css = '', content = '';
    if (family === 'padding') {
      css = '.padded{height:0;padding:24px;overflow:hidden;width:600px;margin-bottom:12px}.border-only{height:0;border-block:24px solid transparent;overflow:hidden}.closed{height:0;padding:0;overflow:hidden}';
      content = '<p id="copy" class="padded">Visible padded documentation.</p><p id="pad-rich" class="padded">Visible rich <strong>padded documentation</strong> with <a id="guide" href="/guide">a guide</a> and <code>createRoot(container)</code>.</p><p id="pad-border-box" class="padded" style="box-sizing:border-box">Visible border-box padded documentation.</p><p id="pad-logical" style="height:0;padding-block:24px;width:600px;overflow:hidden">Visible logical-padding documentation.</p><p id="pad-width" style="width:0;padding:24px;white-space:nowrap;overflow:hidden">Go</p><section id="reveal" class="closed"><p id="late">Late padding documentation.</p></section><section class="closed"><p>Hidden zero-height documentation.</p></section><section class="border-only"><p>Hidden border-only documentation.</p></section><p style="width:0;overflow:hidden">Hidden zero-width documentation.</p>';
    } else if (family === 'conditional-sizing') {
      css = '#box{width:260px;height:80px;overflow:hidden}@layer page{#box::before{content:"*"!important;display:block!important;height:10px!important}}@scope(#box.compact){:scope#box{height:50px}}#auto{display:grid;grid-template-rows:80px;width:260px;overflow:hidden;margin-top:16px}@scope(#auto){:scope#auto{height:auto}}#percent-parent{height:80px;width:260px;margin-top:16px}#percent{height:100%;overflow:hidden}@scope(#percent){:scope#percent{height:100%}}';
      content = '<section id="box"><p id="copy">Expansion conditional panel documentation.</p></section><section id="auto"><p id="auto-copy">Expansion auto-sized grid documentation.</p></section><section id="percent-parent"><section id="percent"><p id="percent-copy">Expansion percent-sized panel documentation.</p></section></section>';
    } else {
      const row = (id: string, text: string) => `<section class="row" id="row-${id}"><div id="text-${id}"><p id="${id === 'a' ? 'copy' : 'copy-' + id}">Expansion ${text} source documentation.</p></div><div id="column-${id}"><img id="photo-${id}" alt="Source image"></div></section>`;
      if (family === 'sibling-media') {
        css = '#toggle.changed + #row-a #photo-a{width:260px;height:220px;object-fit:cover}#external:has(.changed) ~ #row-b #photo-b{width:260px;height:180px;object-fit:cover}';
        content = '<div id="toggle"></div>' + row('a', 'sibling-controlled') + '<div id="external"></div>' + row('b', 'relational-selector');
      } else {
        css = '@scope(#row-a.changed){:scope #column-a{height:220px}}';
        content = row('a', 'containing-column');
      }
      css += '#row-control{height:80px;overflow:hidden}@scope(#row-control){:scope #photo-control{height:100%;object-fit:fill}}';
      content += row('control', 'stable media');
    }
    document.body.innerHTML = `<style>${base}${css}</style><main id="source">${content}<p id="removed">Removal documentation.</p><pre><code id="protected">function ProtectedNeighbor() { return "Do not translate code"; }</code></pre></main><section id="receiver"></section>`;
    const imageSource = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
    for (const image of images) {image.src = imageSource; await image.decode();}
    const texts: NeighborSource['texts'] = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {const node = walk.currentNode as Text; if (!node.parentElement?.closest('script,style')) texts.push({node, value:node.data});}
    const paragraphs = Array.from(document.querySelectorAll<HTMLElement>('p'));
    window.__neighborSource = {texts, paragraphs, children: paragraphs.map(paragraph => Array.from(paragraph.childNodes)), images,
      imageAttrs: images.map(image => ['src','class','style'].map(name => image.getAttribute(name))),
      controlHeight: document.getElementById('photo-control')?.getBoundingClientRect().height || 0};
    if (family === 'padding') for (const id of ['copy','pad-rich','pad-border-box','pad-logical','pad-width']) {
      const host = document.getElementById(id)!, range = document.createRange(); range.selectNode(host.firstChild!);
      const text = range.getBoundingClientRect(), box = host.getBoundingClientRect();
      if (!(text.width > 10 && text.height > 10 && text.top >= box.top && text.bottom <= box.bottom && text.left >= box.left && text.right <= box.right)) throw new Error('Padded source text must actually be visible');
    }
  }, scenario.family);
  await controls.translate(scenario.mode);
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  if (scenario.family === 'padding') {
    for (const id of ['pad-rich','pad-border-box','pad-logical','pad-width']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-done','true');
    expect(requests.some(text => /Hidden |ProtectedNeighbor|Do not translate code|createRoot/.test(text))).toBe(false);
  } else if (scenario.family === 'conditional-sizing') {
    for (const id of ['box','auto','percent']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    await expect(page.locator('#box')).toHaveCSS('height', /.+px/);
    expect(await page.locator('#box').evaluate(box => getComputedStyle(box,'::before').content)).toBe('"*"');
  } else {
    for (const id of ['a', ...(scenario.family === 'sibling-media' ? ['b'] : []), 'control']) await expect(page.locator('#photo-'+id)).toHaveAttribute('data-dual-read-media-bound',/.+/);
  }
  if (scenario.paused) await controls.pause();
  if (scenario.family === 'padding') {
    await page.evaluate(() => document.getElementById('reveal')!.style.padding = '24px');
    if (!scenario.paused) await expect(page.locator('#late')).toHaveAttribute('data-dual-read-done','true');
    else expect(requests.some(text => text.includes('Late padding'))).toBe(false);
    // Closing a padded zero-height panel must also release any expansion; it
    // must not be held open by the newly eligible translated content.
    await page.evaluate(() => document.getElementById('copy')!.style.padding = '0px');
    await expect(page.locator('#copy')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);
    await expect(page.locator('#copy')).toHaveCSS('height','0px');
    await page.evaluate(() => document.getElementById('copy')!.style.removeProperty('padding'));
    if (!scenario.paused) await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  } else if (scenario.family === 'conditional-sizing') {
    const scroll = await page.evaluate(() => ({x:scrollX,y:scrollY}));
    await page.evaluate(() => document.getElementById('box')!.classList.add('compact'));
    await expect(page.locator('#box')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);
    await expect(page.locator('#box')).toHaveCSS('height','50px');
    expect(await page.evaluate(() => ({x:scrollX,y:scrollY}))).toEqual(scroll);
    await page.evaluate(() => document.getElementById('box')!.classList.remove('compact'));
    await expect(page.locator('#box')).toHaveAttribute('data-dual-read-layout-height',/.+/);
    for (const id of ['auto','percent']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
    expect(await page.locator('#box').evaluate(box => getComputedStyle(box,'::before').content)).toBe('"*"');
    await expect(page.locator('[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  } else {
    const controlHeight = await page.evaluate(() => window.__neighborSource.controlHeight);
    await page.evaluate(family => {
      if (family === 'sibling-media') {
        document.getElementById('toggle')!.className = 'changed';
        const marker = document.createElement('i'); marker.className = 'changed'; document.getElementById('external')!.appendChild(marker);
      } else document.getElementById('row-a')!.classList.add('changed');
    }, scenario.family);
    await expect(page.locator('#photo-a')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);
    await expect(page.locator('#photo-a')).toHaveCSS('height','220px');
    if (scenario.family === 'sibling-media') {
      await expect(page.locator('#photo-a')).toHaveCSS('object-fit','cover');
      await expect(page.locator('#photo-b')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);
      await expect(page.locator('#photo-b')).toHaveCSS('height','180px');
    }
    await page.evaluate(() => {
      document.getElementById('row-control')!.style.color = 'red';
      const copy = document.createElement('p'); copy.textContent = 'Additional stable source.'; document.getElementById('text-control')!.appendChild(copy);
      window.__neighborSource.texts.push({node:copy.firstChild as Text,value:copy.textContent});
    });
    if (!scenario.paused) await expect(page.locator('#text-control p').last()).toHaveAttribute('data-dual-read-done','true');
    await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);
    await expect.poll(() => page.locator('#photo-control').evaluate(image => image.getBoundingClientRect().height)).toBeCloseTo(controlHeight, 1);
  }
  await page.setViewportSize({width:1600,height:900}); await page.waitForTimeout(120);
  if (scenario.family.endsWith('media')) await expect(page.locator('#photo-control')).toHaveAttribute('data-dual-read-media-bound',/.+/);
  if (scenario.family === 'conditional-sizing') for (const id of ['box','auto','percent']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-height',/.+/);
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(async delivered => {
    const s = window.__neighborSource, first = s.texts.find(({node}) => document.getElementById('copy')!.contains(node))!;
    first.node.data = 'Updated source documentation.'; first.value = first.node.data;
    const code = s.texts.find(({node}) => node.parentElement?.id === 'protected')!;
    code.node.data = 'const CurrentNeighbor = "Page code edit";'; code.value = code.node.data;
    s.addition = document.createElement('em'); s.addition.textContent = 'Page addition';
    document.getElementById('copy')!.appendChild(s.addition); s.texts.push({node:s.addition.firstChild as Text,value:s.addition.textContent});
    s.transferred = document.getElementById('copy')!; document.getElementById('receiver')!.appendChild(s.transferred);
    s.removed = document.getElementById('removed')!; s.removed.remove();
    document.getElementById('guide')?.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));
    document.dispatchEvent(new Event('layout-neighbor-test:restore'));
  }, scenario.delivered);
  const source = () => page.evaluate(() => {
    const s = window.__neighborSource;
    return {texts:s.texts.every(({node,value}) => s.removed!.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:s.paragraphs.filter(paragraph => paragraph !== s.removed).every(paragraph => {
        const expected = [...s.children[s.paragraphs.indexOf(paragraph)], ...(paragraph === s.transferred ? [s.addition!] : [])];
        return paragraph.childNodes.length === expected.length && Array.from(paragraph.childNodes).every((node,index) => node === expected[index]);
      }), transfer:s.transferred!.parentElement === document.getElementById('receiver'), removed:!s.removed!.isConnected,
      images:s.images.every((image,index) => image.isConnected && ['src','class','style'].every((name,n) => image.getAttribute(name) === s.imageAttrs[index][n])),
      link:!document.getElementById('guide') || document.getElementById('guide')!.getAttribute('href') === '/current-guide'};
  });
  const expected = {texts:true,order:true,transfer:true,removed:true,images:true,link:true};
  expect(await source()).toEqual(expected); await controls.restore(); expect(await source()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-flow,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  await controls.restore(); expect(await source()).toEqual(expected);
  expect(requests.some(text => /Hidden |ProtectedNeighbor|CurrentNeighbor|Do not translate code|createRoot/.test(text))).toBe(false);
}
