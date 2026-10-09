import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const layoutLifecycleCases = (['bilingual','replace'] as const).flatMap(mode =>
  [false,true].flatMap(paused => (['attribute','change'] as const).flatMap(trigger =>
    [false,true].map(delivered => ({mode,paused,trigger,delivered,
      name:`layout lifecycle regression: ${mode}, ${trigger}, paused=${paused}, delivered=${delivered}`})),
  )),
);
type LifecycleCase = typeof layoutLifecycleCases[number];
export function translateLayoutLifecycleText(text: string): string {
  return /^(Expansion|Media caption|Anchored)/.test(text)
    ? '这是一段用于验证译文对页面尺寸变化影响的正文内容。'.repeat(9) : `译:${text}`;
}
interface LifecycleSource { text: {node:Text;value:string}[]; removed:Text[]; code:Element; codeText:string; image:Element; lifecycle:Element }
declare global {interface Window {__layoutLifecycleSource:LifecycleSource; lifecycleArmed:boolean}}

export async function verifyLayoutLifecycleRegression(
  page: Page,
  scenario: LifecycleCase,
  controls: {translate:(mode:TranslationMode)=>Promise<unknown>;restore:()=>Promise<unknown>;pause:()=>Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(() => {
    const text:LifecycleSource['text']=[];
    for (const root of [document.body,document.getElementById('state-widget')!.shadowRoot!]) {
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      while(walker.nextNode()) {
        const node=walker.currentNode as Text;
        if(!node.parentElement?.closest('script,style'))text.push({node,value:node.data});
      }
    }
    const code=document.getElementById('protected-code')!;
    window.__layoutLifecycleSource={text,removed:[],code,codeText:code.textContent!,image:document.getElementById('image')!,lifecycle:document.getElementById('lifecycle')!};
  });
  await controls.translate(scenario.mode);
  await expect(page.locator('#themed .dual-read-target')).toContainText('译:Documentation');
  await expect(page.locator('#image')).toHaveAttribute('data-dual-read-media-bound',/.+/);
  await expect(page.locator('#bounded')).toHaveAttribute('data-dual-read-layout-height',/.+/);
  if(scenario.mode==='bilingual') await expect(page.locator('#footer')).toHaveAttribute('data-dual-read-layout-anchor',/.+/);
  const initialHeight=await page.locator('#bounded').evaluate(node=>node.getBoundingClientRect().height);
  await page.evaluate(() => {
    window.lifecycleArmed=true;
    const saved=window.__layoutLifecycleSource;
    // Structured prose keeps its source parent during translation. Trigger a
    // real page-owned reconnect instead of relying on a renderer wrapper to
    // cause the custom element's callback when the translation is restored.
    const parent=saved.lifecycle.parentNode!, next=saved.lifecycle.nextSibling;
    saved.lifecycle.remove(); parent.insertBefore(saved.lifecycle,next);
    const first=document.getElementById('first')!;
    const source=saved.text.find(entry=>first.contains(entry.node))!;source.node.data='Updated first source documentation.';source.value=source.node.data;
    document.getElementById('flow')!.classList.add('cm-editor');
    document.getElementById('media-copy')!.classList.add('cm-editor');
    first.classList.add('cm-editor');
  });
  await expect(page.locator('#flow .dual-read-target,#flow .dual-read-flow,#media-copy .dual-read-target,#first .dual-read-target')).toHaveCount(0);
  await expect(page.locator('#image')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);
  await expect.poll(()=>page.locator('#styled .dual-read-target').evaluate(node=>(node as HTMLElement).style.color)).toContain('255, 0, 0');
  await expect.poll(()=>page.locator('#bounded').evaluate(node => {
    const second=document.getElementById('second')!;
    return node.getBoundingClientRect().height-(second.getBoundingClientRect().bottom-node.getBoundingClientRect().top);
  })).toBeLessThan(8);
  expect(initialHeight-await page.locator('#bounded').evaluate(node=>node.getBoundingClientRect().height)).toBeGreaterThan(200);
  await expect(page.locator('#bounded')).toHaveCSS('overflow','hidden');
  if(scenario.paused) await controls.pause();
  const beforeStateChange=requests.length;
  await page.evaluate(trigger => {
    const toggle=document.getElementById('toggle') as HTMLInputElement;
    const shadowToggle=document.getElementById('state-widget')!.shadowRoot!.querySelector('input')!;
    for(const input of [toggle,shadowToggle]) {
      if(trigger==='attribute') {input.checked=true;input.setAttribute('checked','');}
      else input.click();
    }
    const footer=document.getElementById('footer')!;footer.style.top='10px';footer.style.height='32px';
    const second=document.getElementById('second')!;
    window.__layoutLifecycleSource.removed=window.__layoutLifecycleSource.text.filter(entry=>second.contains(entry.node)).map(entry=>entry.node);
    second.remove();
  },scenario.trigger);
  await expect.poll(()=>page.locator('#themed .dual-read-target').evaluate(node=>(node as HTMLElement).style.color)).toBe('');
  await expect.poll(()=>page.evaluate(()=>document.getElementById('state-widget')!.shadowRoot!.querySelector<HTMLElement>('.dual-read-target')!.style.color)).toBe('');
  await expect(page.locator('#footer')).toHaveCSS('top','10px');
  await expect(page.locator('#footer')).toHaveCSS('height','32px');
  await expect(page.locator('[data-dual-read-layout-anchor],style[data-dual-read-anchor-style]')).toHaveCount(0);
  await expect(page.locator('#bounded')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);
  await expect(page.locator('#bounded')).toHaveCSS('height','80px');
  await page.waitForTimeout(400);expect(requests.length).toBe(beforeStateChange);
  expect(requests.some(text=>text.includes('Untranslated source code'))).toBe(false);

  await page.evaluate(async delivered => {
    document.getElementById('theme-source')!.style.color='blue';
    if(delivered)await new Promise(resolve=>setTimeout(resolve,100));
    document.dispatchEvent(new Event('layout-lifecycle-test:restore'));
  },scenario.delivered);
  await expect(page.locator('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text,[data-dual-read-layout-height],[data-dual-read-layout-anchor],[data-dual-read-media-bound],style[data-dual-read-layout-style],style[data-dual-read-anchor-style],style[data-dual-read-media-style]')).toHaveCount(0);
  const intact=()=>page.evaluate(()=> {
    const saved=window.__layoutLifecycleSource;
    return saved.text.every(({node,value})=>saved.removed.includes(node)?!node.isConnected:node.isConnected&&node.data===value)
      && document.getElementById('second')===null && document.getElementById('protected-code')===saved.code && saved.code.textContent===saved.codeText
      && document.getElementById('image')===saved.image && document.getElementById('lifecycle')===saved.lifecycle
      && document.getElementById('theme-source')!.style.color==='blue' && document.getElementById('lifecycle-source')!.style.color==='red'
      && document.getElementById('footer')!.style.top==='10px' && document.getElementById('footer')!.style.height==='32px';
  });
  expect(await intact()).toBe(true);await controls.restore();expect(await intact()).toBe(true);
  await controls.translate(scenario.mode==='bilingual'?'replace':'bilingual');
  await expect(page.locator('#themed .dual-read-target')).toContainText('译:Documentation');
  await controls.restore();expect(await intact()).toBe(true);
}
