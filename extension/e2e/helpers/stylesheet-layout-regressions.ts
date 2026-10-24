import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const stylesheetLayoutCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].map(delivered => ({mode, paused, delivered,
    name:`stylesheet layout regression: ${mode}, paused=${paused}, delivered=${delivered}`}))),
);
type StylesheetCase = typeof stylesheetLayoutCases[number];
export function translateStylesheetText(text: string): string {
  return text.startsWith('Expansion') ? '用于检查动态页面布局和继承样式的翻译文字。'.repeat(12) : `译:${text}`;
}
interface StylesheetSource {
  texts: {node:Text; value:string}[];
  removed: Text[];
  rows: HTMLElement[];
  children: Node[][];
  leading: Text;
  strong: HTMLElement;
  code: Element;
  codeText: Text;
  wrapper?: HTMLElement;
  addition?: HTMLElement;
  split?: Text;
}
declare global {interface Window {__stylesheetSource: StylesheetSource}}

export async function verifyStylesheetLayoutRegression(
  page: Page,
  scenario: StylesheetCase,
  controls: {translate: (mode:TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(async () => {
    await (document.getElementById('photo') as HTMLImageElement).decode();
    const texts: StylesheetSource['texts'] = [], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const node=walker.currentNode as Text;
      if(!node.parentElement?.closest('script,style')) texts.push({node,value:node.data});
    }
    const rows=['prose-rich','prose-mixed'].map(id=>document.getElementById(id)!);
    window.__stylesheetSource={texts,removed:[],rows,children:rows.map(row=>Array.from(row.childNodes)),
      leading:rows[0].firstChild as Text,strong:document.getElementById('strong-rich')!,
      code:document.getElementById('code')!,codeText:document.querySelector('#code code')!.firstChild as Text};
  });
  await controls.translate(scenario.mode);
  for(const id of ['variable-copy','media-copy']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-done','true');
  for(const id of ['prose-rich','prose-mixed']) await expect(page.locator('#'+id)).toContainText('译:');
  if(scenario.mode==='bilingual') {
    for(const suffix of ['rich','mixed']) {
      const row=page.locator('#prose-'+suffix);
      expect(await row.evaluate((row,suffix)=>document.getElementById('strong-'+suffix)!.parentElement===row&&document.getElementById('link-'+suffix)!.parentElement===row,suffix)).toBe(true);
      await expect(page.locator('#strong-'+suffix)).toHaveCSS('color','rgb(200, 0, 0)');
      await expect(page.locator('#strong-'+suffix)).toHaveCSS('font-size','24px');
      await expect(page.locator('#link-'+suffix)).toHaveCSS('color','rgb(9, 105, 218)');
      await page.locator('#link-'+suffix).click(); await expect(page.locator('#link-'+suffix)).toHaveAttribute('data-clicked','yes');
      await expect(row.locator(':scope > .dual-read-target')).toHaveCount(1);
      expect(await row.evaluate(row=>{const target=row.querySelector(':scope > .dual-read-target')!;return target.getBoundingClientRect().top>=document.getElementById(row.id.replace('prose','strong'))!.getBoundingClientRect().bottom-1;})).toBe(true);
    }
  }
  await expect(page.locator('#variable-panel')).toHaveAttribute('data-dual-read-layout-height',/.+/);
  await expect(page.locator('#photo')).toHaveAttribute('data-dual-read-media-bound',/.+/);
  if(scenario.mode==='bilingual') for(const id of ['footer-height','footer-top']) await expect(page.locator('#'+id)).toHaveAttribute('data-dual-read-layout-anchor',/.+/);
  if(scenario.paused) await controls.pause();

  // Color-only page changes preserve an active correction. Each collapse
  // changes authored CSS, never the panel's inline height declaration.
  await page.evaluate(()=>document.getElementById('variable-panel')!.style.color='red');
  await page.waitForTimeout(100);
  await expect(page.locator('#variable-panel')).toHaveAttribute('data-dual-read-layout-height',/.+/);
  for(const trigger of ['variable','class','stylesheet']) {
    const owner=await page.locator('#variable-panel .dual-read-target').elementHandle(), before=requests.length;
    await page.evaluate(trigger=>{
      if(trigger==='variable') document.documentElement.style.setProperty('--panel-height','0px');
      if(trigger==='class') document.getElementById('variable-panel')!.classList.add('closed');
      if(trigger==='stylesheet') document.getElementById('panel-sheet')!.textContent='#variable-panel {height:0px}';
    },trigger);
    await expect(page.locator('#variable-panel')).not.toHaveAttribute('data-dual-read-layout-height',/.+/);
    await expect(page.locator('#variable-panel')).toHaveCSS('height','0px');
    // A stylesheet-only collapse may retain its hidden companion. The layout
    // rule must yield regardless of translation watching or recollection.
    // Finish the debounced visibility update before starting a different
    // trigger; head stylesheet edits do not request fresh text collection.
    if(!scenario.paused) await page.waitForTimeout(400);
    await page.evaluate(()=>{
      document.documentElement.style.setProperty('--panel-height','80px'); document.getElementById('variable-panel')!.classList.remove('closed');
      document.getElementById('panel-sheet')!.textContent='#variable-panel {height:var(--panel-height,80px)} #variable-panel.closed {height:0px}';
    });
    await expect(page.locator('#variable-panel')).toHaveAttribute('data-dual-read-layout-height',/.+/);
    if(scenario.paused) {expect(await owner!.evaluate(node=>node.isConnected)).toBe(true);expect(requests.length).toBe(before);}
    expect(await page.locator('#variable-panel').evaluate(node=>node.style.height)).toBe('');
  }

  for(const suffix of ['height','top']) {
    await page.evaluate(suffix=>document.getElementById('footer-'+suffix+'-box')!.classList.add('compact'),suffix);
    await expect(page.locator('#footer-'+suffix)).not.toHaveAttribute('data-dual-read-layout-anchor',/.+/);
    await page.locator('#'+suffix+'-action').scrollIntoViewIfNeeded();
    await expect.poll(()=>page.locator('#'+suffix+'-action').evaluate((button,suffix)=>{
      const r=button.getBoundingClientRect(),box=document.getElementById('footer-'+suffix+'-box')!.getBoundingClientRect();
      return r.top>=box.top&&r.bottom<=box.bottom+1&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button;
    },suffix)).toBe(true);
    await page.locator('#'+suffix+'-action').click(); await expect(page.locator('#'+suffix+'-action')).toHaveAttribute('data-clicked','yes');
    expect(await page.locator('#footer-'+suffix).evaluate(node=>node.getAttribute('style'))).toBe('position:absolute;top:48px;height:calc(100% - 48px)');
  }
  await page.evaluate(()=>document.getElementById('media-row')!.classList.add('vertical'));
  await expect(page.locator('#photo')).not.toHaveAttribute('data-dual-read-media-bound',/.+/);
  await expect(page.locator('#photo')).toHaveCSS('height','220px'); await expect(page.locator('#photo')).toHaveCSS('object-fit','cover');
  await page.evaluate(()=>document.getElementById('media-sheet')!.textContent='#media-row.vertical #photo {height:200px;object-fit:contain}');
  await expect(page.locator('#photo')).toHaveCSS('height','200px'); await expect(page.locator('#photo')).toHaveCSS('object-fit','contain');
  expect(requests.some(text=>/ProtectedExample|Do not translate code/.test(text))).toBe(false);
  await expect(page.locator('#code .dual-read-target,#code .dual-read-replace-text')).toHaveCount(0);

  // Restore in the same callback as edits, or after mutation delivery. Check
  // page-authored wrappers, split/normalized text and transfers by identity.
  await page.evaluate(async delivered=>{
    const s=window.__stylesheetSource, wrapper=document.createElement('section'); s.wrapper=wrapper;
    s.leading.parentNode!.insertBefore(wrapper,s.leading); wrapper.append(s.leading,s.strong); document.getElementById('receiver')!.appendChild(wrapper);
    s.leading.data='Updated source introduction.';
    const normalized=s.leading.splitText(5); s.leading.parentElement!.normalize(); s.removed.push(normalized);
    s.split=s.leading.splitText(5); s.addition=document.createElement('em'); s.addition.textContent='Page addition'; wrapper.insertBefore(s.addition,s.split);
    s.texts.find(item=>item.node===s.leading)!.value='Updat';
    s.texts.push({node:s.split,value:'ed source introduction.'},{node:s.addition.firstChild as Text,value:'Page addition'});
    s.strong.setAttribute('data-page-edit','retained');
    const removed=document.getElementById('removed')!; s.removed.push(...s.texts.filter(({node})=>removed.contains(node)).map(({node})=>node)); removed.remove();
    if(delivered) await new Promise(resolve=>setTimeout(resolve,400));
    document.dispatchEvent(new Event('stylesheet-layout-test:restore'));
  },scenario.delivered);
  const assertSource=()=>page.evaluate(()=>{
    const s=window.__stylesheetSource, expected=[s.leading,s.addition!,s.split!,s.strong], children=Array.from(s.wrapper!.childNodes);
    return {texts:s.texts.filter(({node,value})=>!(s.removed.includes(node)?!node.isConnected:node.isConnected&&node.data===value)).map(({node,value})=>({expected:value,current:node.data})),
      wrapper:children.length===expected.length&&children.every((node,index)=>node===expected[index])&&s.wrapper!.parentElement===document.getElementById('receiver'),
      untouchedRow:s.rows[1].childNodes.length===s.children[1].length&&Array.from(s.rows[1].childNodes).every((node,index)=>node===s.children[1][index]),
      pageEdit:s.strong.dataset.pageEdit==='retained',removals:s.removed.every(node=>!node.isConnected),
      code:s.code.isConnected&&s.code.querySelector('code')!.firstChild===s.codeText,
      pageStyles:document.getElementById('variable-panel')!.style.color==='red'&&document.documentElement.style.getPropertyValue('--panel-height')==='80px',
      sourceMedia:!document.getElementById('photo')!.hasAttribute('style')&&document.getElementById('media-row')!.classList.contains('vertical')};
  });
  const expected={texts:[],wrapper:true,untouchedRow:true,pageEdit:true,removals:true,code:true,pageStyles:true,sourceMedia:true};
  expect(await assertSource()).toEqual(expected); await controls.restore(); expect(await assertSource()).toEqual(expected);
  await expect(page.locator('.dual-read-target,.dual-read-flow,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-wrap-text],[data-dual-read-layout-height],[data-dual-read-layout-anchor],[data-dual-read-media-bound]')).toHaveCount(0);
  await controls.translate(scenario.mode==='bilingual'?'replace':'bilingual');
  await expect(page.locator('#prose-mixed')).toContainText('译:');
  await expect(page.locator('#photo')).toHaveCSS('height','200px');
  await controls.restore(); expect(await assertSource()).toEqual(expected);
}
