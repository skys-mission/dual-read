import {expect, type Page} from '@playwright/test';
import type {TranslationMode} from '../../lib/types';

export const flowStyleCases = (['bilingual', 'replace'] as const).flatMap(mode =>
  [false, true].flatMap(paused => [false, true].flatMap(delivered =>
    (['top', 'height'] as const).map(priority => ({mode, paused, delivered, priority,
      name: `flow style regression: ${mode}, ${priority}, paused=${paused}, delivered=${delivered}`})),
  )),
);
type FlowStyleCase = typeof flowStyleCases[number];
export function translateFlowStyleText(text: string): string {
  return text.startsWith('Expansion')
    ? '用于检查容器布局和动态页面更新的翻译文本。'.repeat(12) : `译:${text}`;
}
interface FlowSource {
  texts: {node: Text; value: string}[];
  removed: Text[];
  row: HTMLElement;
  leading: Text;
  trailing: Text;
  action: HTMLElement;
  label: Text;
  mixed: HTMLElement;
  mixedChildren: Node[];
  code: Element;
  codeText: Text;
  wrapper?: HTMLElement;
  split?: Text;
  addition?: HTMLElement;
  receiver: HTMLElement;
}
declare global {interface Window {__flowStyleSource: FlowSource}}

export async function verifyFlowStyleRegression(
  page: Page,
  scenario: FlowStyleCase,
  controls: {translate: (mode: TranslationMode) => Promise<unknown>; restore: () => Promise<unknown>; pause: () => Promise<unknown>},
  requests: string[],
): Promise<void> {
  await page.setViewportSize({width:1920, height:1080});
  await page.evaluate(() => {
    const texts: FlowSource['texts'] = [];
    for (const root of [document.body, document.getElementById('variable-widget')!.shadowRoot!]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.parentElement?.closest('script,style')) texts.push({node, value:node.data});
      }
    }
    const row = document.getElementById('flow-rich')!;
    const action = document.getElementById('action-rich')!;
    const mixed = document.getElementById('flow-mixed')!;
    window.__flowStyleSource = {texts, removed:[], row, leading:row.firstChild as Text, trailing:row.lastChild as Text,
      action, label:action.firstChild as Text, mixed, mixedChildren:Array.from(mixed.childNodes),
      code:document.getElementById('code')!, codeText:document.querySelector('#code code')!.firstChild as Text,
      receiver:document.getElementById('receiver')!};
  });
  await controls.translate(scenario.mode);
  await expect(page.locator('#flow-rich')).toHaveAttribute('data-dual-read-done', 'true');
  if (scenario.mode === 'bilingual') {
    for (const id of ['action-rich', 'action-mixed']) {
      expect(await page.locator('#'+id).evaluate((node, id) => node.parentElement === document.getElementById(id === 'action-rich' ? 'flow-rich' : 'flow-mixed'), id)).toBe(true);
      await expect(page.locator('#'+id)).toHaveCSS('background-color', 'rgb(9, 105, 218)');
      await expect(page.locator('#'+id)).toHaveCSS('height', '40px');
      await page.locator('#'+id).click(); await expect(page.locator('#'+id)).toHaveAttribute('data-clicked', 'yes');
    }
  }
  for (const id of ['reveal-local', 'reveal-inherited', 'slotted-copy']) await expect(page.locator('#'+id+' .dual-read-target')).toHaveCount(0);
  await page.evaluate(() => {
    document.getElementById('reveal-local')!.style.setProperty('--panel-height', '100px');
    document.documentElement.style.setProperty('--shared-reveal', '100px');
  });
  for (const id of ['reveal-local', 'reveal-inherited', 'slotted-copy']) await expect(page.locator('#'+id)).toContainText('译:');
  await expect(page.locator('#variable-widget').locator('#shadow-copy')).toContainText('译:Shadow');
  await expect(page.locator('#rescan-row')).not.toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#rescan-card')).not.toHaveAttribute('data-dual-read-done', 'true');
  if (scenario.mode==='bilingual') await expect(page.locator('#rescan-row .dual-read-target')).toHaveCount(2);
  await expect(page.locator('#variable-policy')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  if (scenario.paused) await controls.pause();

  const owner = await page.locator('#variable-policy .dual-read-target').elementHandle();
  const beforeClose = requests.length;
  await page.evaluate(() => document.getElementById('variable-policy')!.style.setProperty('--panel-height', '0px'));
  await expect(page.locator('#variable-policy')).toHaveCSS('height', '0px');
  if (!scenario.paused) await expect(page.locator('#variable-policy .dual-read-target')).toHaveCount(0);
  await page.evaluate(() => document.getElementById('variable-policy')!.style.setProperty('--panel-height', '80px'));
  await expect(page.locator('#variable-policy')).toHaveAttribute('data-dual-read-layout-height', /.+/);
  if (scenario.paused) {
    expect(await owner!.evaluate(node => node.isConnected)).toBe(true);
    expect(requests.length).toBe(beforeClose);
  }

  const translatedCopy = () => page.locator(scenario.mode === 'bilingual' ? '#surface > .dual-read-target' : '#clip-copy > .dual-read-target');
  await expect(translatedCopy()).toHaveCSS('font-size', '20px');
  await page.evaluate(() => {const source = document.getElementById('clip-source')!; source.style.fontSize='14px'; source.style.lineHeight='21px';});
  await expect(translatedCopy()).toHaveCSS('font-size', '14px'); await expect(translatedCopy()).toHaveCSS('line-height', '21px');
  await page.evaluate(() => {
    const copy=document.getElementById('clip-copy')!, source=document.getElementById('clip-source')!;
    copy.style.fontSize='18px'; copy.style.lineHeight='27px'; source.style.fontSize='18px'; source.style.lineHeight='27px';
  });
  await expect(translatedCopy()).toHaveCSS('font-size', '18px'); await expect(translatedCopy()).toHaveCSS('line-height', '27px');
  await translatedCopy().evaluate(node => (node as HTMLElement).style.setProperty('font-size', '24px', 'important'));
  await page.evaluate(() => document.getElementById('clip-source')!.style.fontSize='26px');
  await expect(translatedCopy()).toHaveCSS('font-size', '24px');
  expect(await translatedCopy().evaluate(node => (node as HTMLElement).style.getPropertyPriority('font-size'))).toBe('important');

  if (scenario.mode === 'bilingual') await expect(page.locator('#footer')).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await page.evaluate(property => {const footer=document.getElementById('footer')!; footer.style.setProperty(property, footer.style.getPropertyValue(property), 'important');}, scenario.priority);
  await expect(page.locator('#footer')).not.toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await page.locator('#footer-box').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('#footer-action').evaluate(button => {
    const r=button.getBoundingClientRect(), bounds=document.getElementById('footer-box')!.getBoundingClientRect();
    return r.top>=bounds.top&&r.bottom<=bounds.bottom+1&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button;
  })).toBe(true);
  await page.locator('#footer-action').click(); await expect(page.locator('#footer-action')).toHaveAttribute('data-clicked', 'yes');
  expect(requests.some(text => /ProtectedExample|Do not translate code/.test(text))).toBe(false);
  await expect(page.locator('#code .dual-read-target,#code .dual-read-replace-text')).toHaveCount(0);

  // Page operations define expected current nodes/order independently of the
  // renderer. A removed source must stay removed in both restore modes.
  await page.evaluate(async ({mode, delivered}) => {
    const s=window.__flowStyleSource;
    const wrapper=document.createElement('section'); wrapper.id='page-wrapper'; s.wrapper=wrapper;
    if (mode==='bilingual') {
      const flow=s.leading.parentElement!;
      flow.replaceWith(wrapper); wrapper.appendChild(flow); s.receiver.append(wrapper, s.action);
    } else {
      s.leading.parentNode!.insertBefore(wrapper,s.leading); wrapper.appendChild(s.leading); s.receiver.append(wrapper,s.action);
    }
    s.leading.data='Updated source introduction.';
    const normalized=s.leading.splitText(5); s.leading.parentElement!.normalize(); s.removed.push(normalized);
    s.split=s.leading.splitText(5);
    s.addition=document.createElement('em'); s.addition.textContent='Page addition'; s.leading.parentNode!.insertBefore(s.addition,s.split);
    s.label.data='Updated account'; s.action.setAttribute('href','/updated');
    s.texts.find(item=>item.node===s.leading)!.value='Updat';
    s.texts.find(item=>item.node===s.label)!.value='Updated account';
    s.texts.push({node:s.split,value:'ed source introduction.'},{node:s.addition.firstChild as Text,value:'Page addition'});
    s.row.remove(); s.removed.push(s.trailing);
    const removed=document.getElementById('removed')!;
    s.removed.push(...s.texts.filter(({node})=>removed.contains(node)).map(({node})=>node)); removed.remove();
    if (delivered) await new Promise(resolve=>setTimeout(resolve,400));
    document.dispatchEvent(new Event('flow-style-test:restore'));
  }, {mode:scenario.mode, delivered:scenario.delivered});
  const assertSource = () => page.evaluate(priority => {
    const s=window.__flowStyleSource, children=Array.from(s.wrapper!.childNodes), expected=[s.leading,s.addition!,s.split!];
    return {
      wrapperOrder:children.length===expected.length&&children.every((node,index)=>node===expected[index]),
      receiverOrder:s.wrapper!.parentElement===s.receiver&&s.action.parentElement===s.receiver&&s.receiver.childNodes.length===2&&s.receiver.childNodes[0]===s.wrapper&&s.receiver.childNodes[1]===s.action,
      action:s.action.getAttribute('href')==='/updated'&&s.action.firstChild===s.label&&!s.row.isConnected,
      changedTexts:s.texts.filter(({node,value})=>!(s.removed.includes(node)?!node.isConnected:node.isConnected&&node.data===value)).map(({node,value})=>({expected:value,current:node.data,connected:node.isConnected,parent:node.parentElement?.id||node.parentElement?.className})),
      removals:s.removed.every(node=>!node.isConnected),
      mixedOrder:Array.from(s.mixed.childNodes).length===s.mixedChildren.length&&Array.from(s.mixed.childNodes).every((node,index)=>node===s.mixedChildren[index]),
      code:s.code.isConnected&&s.code.querySelector('code')!.firstChild===s.codeText,
      fonts:document.getElementById('clip-source')!.style.fontSize==='26px'&&document.getElementById('clip-copy')!.style.fontSize==='18px',
      priority:document.getElementById('footer')!.style.getPropertyPriority(priority)==='important',
      reveal:document.documentElement.style.getPropertyValue('--shared-reveal')==='100px',
      sizing:document.getElementById('variable-policy')!.style.getPropertyValue('--panel-height')==='80px',
    };
  }, scenario.priority);
  const expectedSource={wrapperOrder:true,receiverOrder:true,action:true,changedTexts:[],removals:true,mixedOrder:true,code:true,fonts:true,priority:true,reveal:true,sizing:true};
  await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-flow,.dual-read-original-hidden,style[data-dual-read-layout-style],style[data-dual-read-anchor-style]')).toHaveCount(0);
  expect(await assertSource()).toEqual(expectedSource);
  await controls.restore(); await page.waitForTimeout(200); expect(await assertSource()).toEqual(expectedSource);
  await controls.translate(scenario.mode==='bilingual'?'replace':'bilingual');
  await expect.poll(() => page.locator('#flow-mixed .dual-read-target,#flow-mixed .dual-read-replace-text').count()).toBeGreaterThan(0);
  await controls.restore(); expect(await assertSource()).toEqual(expectedSource);
  await expect(page.locator('.dual-read-target,.dual-read-flow,.dual-read-original-hidden')).toHaveCount(0);
}
