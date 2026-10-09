import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

const families = ['inherit-parent','inherit-chain','inherit-logical','inherit-all','animation-filled','animation-initial','animation-cancel','animation-no-fill','media-animation','anchor-animation'] as const;
export const motionPolicyGroups = (['bilingual','replace'] as const).flatMap(mode => [false,true].flatMap(paused => [false,true].map(delivered => ({mode,paused,delivered,name:`motion policy regression: ${mode}, paused=${paused}, delivered=${delivered}`}))));
export const translateMotionPolicyText = (text: string): string => text.startsWith('Expansion') ? '用于检查继承尺寸及页面动画的通用布局。'.repeat(20) : `译:${text}`;
interface MotionPolicySource {
  texts: {node: Text; value: string}[];primary: HTMLElement;children: Node[];guide: HTMLAnchorElement;
  images: HTMLImageElement[];attributes: (string | null)[][];removed: HTMLElement;addition?: HTMLElement;
}
declare global {interface Window {__motionPolicySource: MotionPolicySource}}
type Controls = {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>};
export async function verifyMotionPolicyRegression(page: Page, group: typeof motionPolicyGroups[number], controls: Controls, requests: string[]): Promise<void> {
 for (const family of families) await verifyCase(page,group,family,controls,requests);
}
async function verifyCase(page: Page, group: typeof motionPolicyGroups[number], family: typeof families[number], controls: Controls, requests: string[]): Promise<void> {
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(async family => {
    const base = 'body{margin:8px;font:16px/20px sans-serif}p{margin:0}main{min-height:100vh}.bounded{width:260px;height:80px;overflow:hidden;margin-bottom:12px}.parent{width:260px;height:80px}#stable{height:80px}@keyframes shrink{from{height:80px}to{height:50px}}@keyframes paint{from{color:black}to{color:red}}#stable.active{animation:paint 100ms forwards}';
    let policy = '', content = '';
    const rich = '<p id="copy">Expansion source documentation. <strong>Important prose.</strong> <a id="guide" href="/guide">Guide</a> <code>safeMotionPolicy()</code></p>';
    if (family === 'inherit-all') {policy='#parent{height:50px;overflow:hidden}#box.active{all:inherit}';content=`<article id="parent" class="parent"><section id="box" class="bounded">${rich}</section></article>`;}
    else if (family.startsWith('inherit')) {
      policy=family==='inherit-logical'?'#box{height:auto;block-size:inherit;direction:rtl}':'#box{height:inherit}';
      if(family==='inherit-chain') policy+='#middle{height:inherit}';
      content=`<article id="parent" class="parent">${family==='inherit-chain'?'<section id="middle">':''}<section id="box" class="bounded">${rich}</section>${family==='inherit-chain'?'</section>':''}</article>`;
    } else if (family==='media-animation') {
      policy='.row{display:grid;grid-template-columns:260px 260px;width:520px;margin-left:1000px}.row img{display:block;height:100%;width:auto;max-width:none}#photo.active{animation:photo 100ms forwards}@keyframes photo{to{width:120px}}';
      content=`<section class="row"><div>${rich}</div><div><img id="photo" alt="Source image"></div></section>`;
    } else if (family==='anchor-animation') {
      policy='#box{position:relative;height:120px}#footer.active{animation:footer 100ms forwards}@keyframes footer{to{top:20px}}';
      content=`<section id="box" class="bounded">${rich}<div id="footer" style="position:absolute;top:80px;height:calc(100% - 80px)"><button>Source action</button></div></section>`;
    } else {
      policy=`#box.active{animation:shrink ${family==='animation-cancel'?'10000':family==='animation-no-fill'?'1000':'100'}ms linear ${family==='animation-cancel'||family==='animation-no-fill'?'none':'forwards'}}`;
      content=`<section id="box" class="bounded${family==='animation-initial'?' active':''}">${rich}</section>`;
    }
    document.body.innerHTML=`<style>${base}${policy}</style><main>${content}<section class="bounded" id="stable"><p>Expansion stable panel.</p></section><p id="removed">Removal source documentation.</p><pre><code id="protected">function ProtectedMotionPolicy() { return "Do not translate code"; }</code></pre></main><div id="receiver"></div>`;
    const images=Array.from(document.querySelectorAll('img'));for(const image of images){image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="steelblue"/></svg>');await image.decode();}
    if(family==='animation-initial') await new Promise(resolve=>setTimeout(resolve,200));
    const texts: MotionPolicySource['texts']=[],walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walk.nextNode()){const node=walk.currentNode as Text;if(!node.parentElement?.closest('style,script'))texts.push({node,value:node.data});}
    const primary=document.getElementById('copy')!;window.__motionPolicySource={texts,primary,children:Array.from(primary.childNodes),guide:document.getElementById('guide') as HTMLAnchorElement,images,attributes:images.map(image=>['src','class','style'].map(name=>image.getAttribute(name))),removed:document.getElementById('removed')!};
  },family);
  await controls.translate(group.mode);await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  const marker=family==='media-animation'?'data-dual-read-media-bound':family==='anchor-animation'?'data-dual-read-layout-anchor':'data-dual-read-layout-height';
  const subject=page.locator(family==='media-animation'?'#photo':family==='anchor-animation'?'#footer':'#box');
  if(family==='animation-initial'||family==='anchor-animation'&&group.mode==='replace')await expect(subject).not.toHaveAttribute(marker,/.+/);else await expect(subject).toHaveAttribute(marker,/.+/);
  await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-layout-height',/.+/);if(group.paused)await controls.pause();
  await page.evaluate(family=>{
    if(family.startsWith('inherit')&&family!=='inherit-all')document.getElementById('parent')!.style.height='50px';
    else if(family!=='animation-initial')document.getElementById(family==='media-animation'?'photo':family==='anchor-animation'?'footer':'box')!.classList.add('active');
    document.getElementById('stable')!.classList.add('active');
  },family);
  await expect(subject).not.toHaveAttribute(marker,/.+/);
  if(family==='animation-cancel'||family==='animation-no-fill'){
    await page.waitForTimeout(80);
    await expect(subject).not.toHaveAttribute(marker,/.+/);
    if(family==='animation-cancel')await page.evaluate(()=>{const box=document.getElementById('box')!;for(const animation of box.getAnimations())animation.cancel();box.classList.remove('active');});
    await expect(subject).toHaveAttribute(marker,/.+/);
  }else await expect(subject).toHaveCSS(family==='media-animation'?'width':family==='anchor-animation'?'top':'height',family==='media-animation'?'120px':family==='anchor-animation'?'20px':'50px');
  // A reverted inherited source resumes both the inner and outer corrections.
  if(family==='inherit-all'){
    await expect(page.locator('#parent')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);
    await page.evaluate(()=>document.getElementById('box')!.classList.remove('active'));
    await expect(subject).toHaveAttribute(marker,/.+/);await expect(page.locator('#parent')).toHaveAttribute(marker,/.+/);
  }
  await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-layout-height',/.+/);
  await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(120);await page.setViewportSize({width:1920,height:1080});
  await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-layout-height',/.+/);
  await page.evaluate(()=>{const s=window.__motionPolicySource;s.attributes=s.images.map(image=>['src','class','style'].map(name=>image.getAttribute(name)));});
  await page.evaluate(async delivered => {
    const source = window.__motionPolicySource,first = source.texts.find(({node}) => source.primary.contains(node))!;
    first.node.data = 'Updated motion source documentation.';first.value = first.node.data;
    const code = source.texts.find(({node}) => node.parentElement?.id === 'protected')!;code.node.data = 'const CurrentMotionPolicy = "Page code edit";';code.value = code.node.data;
    source.addition = document.createElement('em');source.addition.textContent = 'Page addition';source.primary.appendChild(source.addition);
    source.texts.push({node:source.addition.firstChild as Text,value:source.addition.textContent});
    document.getElementById('receiver')!.appendChild(source.primary);source.removed.remove();source.guide.setAttribute('href','/current-guide');
    if (delivered) await new Promise(resolve => setTimeout(resolve,400));document.dispatchEvent(new Event('motion-policy-test:restore'));
  },group.delivered);
  const readSource = () => page.evaluate(() => {
    const source = window.__motionPolicySource,expected = [...source.children,source.addition!];
    return {values:source.texts.every(({node,value}) => source.removed.contains(node) ? !node.isConnected : node.isConnected && node.data === value),
      order:source.primary.childNodes.length === expected.length && Array.from(source.primary.childNodes).every((node,index) => node === expected[index]),
      transferred:source.primary.parentElement === document.getElementById('receiver'),removed:!source.removed.isConnected,link:source.guide.getAttribute('href') === '/current-guide',
      images:source.images.every((image,index) => ['src','class','style'].every((name,n) => image.getAttribute(name) === source.attributes[index][n]))};
  });
  const expected = {values:true,order:true,transferred:true,removed:true,link:true,images:true};
  expect(await readSource()).toEqual(expected);await controls.restore();expect(await readSource()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,.dual-read-flow,[data-dual-read-layout-height],[data-dual-read-media-bound],[data-dual-read-sizing-probe],style[data-dual-read-sizing-style]')).toHaveCount(0);
  await controls.translate(group.mode === 'bilingual' ? 'replace' : 'bilingual');await expect(page.locator('#copy')).toHaveAttribute('data-dual-read-done','true');
  expect(requests.some(text => text.includes('Updated motion source documentation.'))).toBe(true);
  await controls.restore();expect(await readSource()).toEqual(expected);
  expect(requests.some(text => /ProtectedMotionPolicy|CurrentMotionPolicy|safeMotionPolicy|Do not translate code/.test(text))).toBe(false);
}
