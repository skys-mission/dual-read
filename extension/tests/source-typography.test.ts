// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readSourceTypography } from '../lib/renderer/source-typography';
import { render, restoreDom } from '../lib/renderer';
import type { TranslationUnit } from '../lib/types';

afterEach(() => { restoreDom(); document.body.innerHTML = ''; vi.restoreAllMocks(); });
function fixture(): TranslationUnit {
  document.body.innerHTML = '<main style="background:black"><p style="color:black;font-size:14px;line-height:21px"><span id="source-style" style="color:white;font-size:20px;line-height:30px">Styled paragraph on a dark surface.</span></p></main>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 350, height: 100, top: 0, bottom: 100, left: 0, right: 350, toJSON() {} } as DOMRect);
  return { el: document.querySelector('p')!, kind: 'block', text: 'Styled paragraph on a dark surface.' };
}

it.each(['bilingual', 'replace'] as const)('uses actual uniform source typography in %s without changing source style or identity', mode => {
  const unit = fixture();
  const source = document.getElementById('source-style')!;
  const originalText = source.firstChild;
  const originalStyle = source.getAttribute('style');
  render(unit, '深色背景上的正文译文。', mode);
  const target = document.querySelector<HTMLElement>('.dual-read-target')!;
  expect(target.style.fontSize).toBe('20px');
  expect(target.style.lineHeight).toBe('30px');
  expect(target.style.color).toContain('255');
  expect(source.getAttribute('style')).toBe(originalStyle);
  source.style.fontSize = '22px';
  restoreDom();
  expect(document.getElementById('source-style')).toBe(source);
  expect(source.firstChild).toBe(originalText);
  expect(source.style.fontSize).toBe('22px');
  expect(document.querySelector('.dual-read-target')).toBeNull();
});

it('does not flatten differently styled source runs', () => {
  const unit = fixture();
  unit.el.appendChild(document.createTextNode(' Additional default-colored text.'));
  expect(readSourceTypography([unit]).size).toBe(0);
});

it('leaves gradient color in its paint context and skips navigation', () => {
  const unit = fixture(); document.getElementById('source-style')!.style.color = 'transparent';
  expect(readSourceTypography([unit]).get(unit.el)?.has('color')).toBe(false);
  unit.kind = 'nav';
  expect(readSourceTypography([unit]).size).toBe(0);
});

async function settlePresentation(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));
}

it.each(['inherited', 'mixed'] as const)('restores the current relocated source-host font after nested typography becomes %s', async operation => {
  const unit = fixture();
  unit.el.parentElement!.style.fontSize = '40px';
  unit.el.parentElement!.style.lineHeight = '60px';
  unit.el.style.display = '-webkit-box';
  unit.el.style.setProperty('-webkit-line-clamp', '1');
  const source = document.getElementById('source-style')!;
  const original = source.firstChild;
  const second = source.cloneNode(true) as HTMLElement;
  second.removeAttribute('id');
  if (operation === 'mixed') unit.el.appendChild(second);
  render(unit, '外移的译文需要保持源文字字体。', 'bilingual');
  const target = document.querySelector<HTMLElement>('.dual-read-target')!;
  expect(target.parentElement).toBe(unit.el.parentElement);
  expect(target.style.fontSize).toBe('20px');
  if (operation === 'mixed') second.style.color = 'red';
  else {source.style.fontSize = '14px'; source.style.lineHeight = '21px';}
  await settlePresentation();
  expect(target.style.fontSize).toBe('14px');
  expect(target.style.lineHeight).toBe('21px');
  unit.el.style.fontSize = '18px'; unit.el.style.lineHeight = '27px';
  if (operation === 'inherited') {source.style.fontSize = '18px'; source.style.lineHeight = '27px';}
  await settlePresentation();
  expect(target.style.fontSize).toBe('18px'); expect(target.style.lineHeight).toBe('27px');
  target.style.setProperty('font-size', '24px', 'important');
  source.style.fontSize = '26px'; await settlePresentation();
  expect(target.style.fontSize).toBe('24px'); expect(target.style.getPropertyPriority('font-size')).toBe('important');
  restoreDom();
  expect(source.firstChild).toBe(original); expect(unit.el.style.fontSize).toBe('18px');
});


it.each((['bilingual', 'replace'] as const).flatMap(mode => (['class', 'attribute'] as const).map(trigger => ({mode,trigger}))))('refreshes copied colors after a $trigger theme change in $mode', async ({mode,trigger}) => {
  const unit = fixture();
  document.getElementById('source-style')!.style.removeProperty('color');
  const style = document.createElement('style');
  style.textContent = '#source-style { color:white } html.light #source-style, html[data-presentation-theme="light"] #source-style { color:black }';
  document.head.appendChild(style);
  const original = document.getElementById('source-style')!.firstChild;
  try {
    render(unit, '主题变化后的译文。', mode);
    const target = document.querySelector<HTMLElement>('.dual-read-target')!;
    expect(target.style.color).toContain('255');
    if (trigger==='class') document.documentElement.classList.add('light');
    else document.documentElement.setAttribute('data-presentation-theme','light');
    await settlePresentation();
    expect(target.style.color).toBe('');
    expect(target.style.fontSize).toBe('20px');
    restoreDom(); restoreDom();
    expect(document.getElementById('source-style')!.firstChild).toBe(original);
    expect(trigger==='class' ? document.documentElement.classList.contains('light') : document.documentElement.getAttribute('data-presentation-theme')==='light').toBe(true);
  } finally { document.documentElement.classList.remove('light'); document.documentElement.removeAttribute('data-presentation-theme'); style.remove(); }
});

it.each(['bilingual', 'replace'] as const)('refreshes source inline styles and clears values that now inherit in %s', async mode => {
  const unit = fixture();
  const source = document.getElementById('source-style')!;
  render(unit, '动态样式译文。', mode);
  const target = document.querySelector<HTMLElement>('.dual-read-target')!;
  source.style.color = 'red'; source.style.fontSize = '24px';
  await settlePresentation();
  expect(target.style.color).toContain('255, 0, 0');
  expect(target.style.fontSize).toBe('24px');
  source.style.color = 'black'; source.style.fontSize = '14px'; source.style.lineHeight = '21px';
  await settlePresentation();
  expect(target.style.color).toBe(''); expect(target.style.fontSize).toBe(''); expect(target.style.lineHeight).toBe('');
  expect(source.style.fontSize).toBe('14px');
});

it('refreshes after a stylesheet edit and preserves a page override on the companion', async () => {
  const unit = fixture();
  const source = document.getElementById('source-style')!;
  source.style.removeProperty('color');
  const style = document.createElement('style'); style.textContent = '#source-style { color:white }'; document.head.appendChild(style);
  try {
    render(unit, '样式表变化后的译文。', 'bilingual');
    const target = document.querySelector<HTMLElement>('.dual-read-target')!;
    style.textContent = '#source-style { color:blue }';
    await settlePresentation(); expect(target.style.color).toContain('0, 0, 255');
    target.style.setProperty('color', 'green', 'important');
    source.style.color = 'red'; source.style.fontSize = '26px';
    await settlePresentation();
    expect(target.style.color).toBe('green'); expect(target.style.getPropertyPriority('color')).toBe('important');
    expect(target.style.fontSize).toBe('26px');
  } finally { style.remove(); }
});

it('removes stale copied styles when a uniform source becomes mixed and can follow uniform styles again', async () => {
  const unit = fixture();
  const source = document.getElementById('source-style')!;
  const second = document.createElement('span'); second.setAttribute('style', source.getAttribute('style')!); second.textContent = ' Second source run.';
  unit.el.appendChild(second);
  render(unit, '源文字样式变化。', 'bilingual');
  const target = document.querySelector<HTMLElement>('.dual-read-target')!;
  second.style.color = 'red'; await settlePresentation(); expect(target.style.color).toBe('');
  source.style.color = 'red'; await settlePresentation(); expect(target.style.color).toContain('255, 0, 0');
});

it('cancels a queued style refresh during restore and leaves current source edits intact', async () => {
  const unit = fixture(); const source = document.getElementById('source-style')!; const text = source.firstChild;
  render(unit, '取消待处理的样式更新。', 'replace');
  source.style.color = 'red'; source.style.fontSize = '28px';
  restoreDom(); restoreDom(); await settlePresentation();
  expect(source.firstChild).toBe(text); expect(source.style.color).toBe('red'); expect(source.style.fontSize).toBe('28px');
  expect(document.querySelector('.dual-read-target,style[data-dual-read-layout-style]')).toBeNull();
});

it.each(['bilingual', 'replace'] as const)('follows a retained source span after the page replaces its Text node in %s', async mode => {
  const unit=fixture(); const source=document.getElementById('source-style')!;
  render(unit,'保留源元素的样式。',mode);
  const target=document.querySelector<HTMLElement>('.dual-read-target')!;
  source.textContent='Updated source documentation.'; const current=source.firstChild;
  source.style.color='red'; await settlePresentation();
  expect(target.style.color).toContain('255, 0, 0'); expect(target.style.fontSize).toBe('20px');
  restoreDom(); expect(source.firstChild).toBe(current); expect(source.textContent).toBe('Updated source documentation.');
});

it('does not rewrite unchanged companion typography during ancestor transform animation', async () => {
  const unit=fixture(); render(unit,'动画中的稳定译文。','bilingual');
  const target=document.querySelector<HTMLElement>('.dual-read-target')!;
  const writes:MutationRecord[]=[];
  const observer=new MutationObserver(records => writes.push(...records));
  observer.observe(target,{attributes:true,attributeFilter:['style']});
  try {
    for (let frame=0;frame<3;frame++) {
      unit.el.parentElement!.style.transform=`translateX(${frame}px)`;
      await settlePresentation();
    }
    expect(writes).toEqual([]);
    expect(target.style.fontSize).toBe('20px');
  } finally {observer.disconnect();}
});

it.each((['bilingual','replace'] as const).flatMap(mode => (['attribute','input','change'] as const).map(trigger => ({mode,trigger}))))('follows a sibling checkbox state via $trigger in $mode', async ({mode,trigger}) => {
  const unit = fixture();
  const source = document.getElementById('source-style')!; source.style.removeProperty('color');
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = 'theme-toggle'; unit.el.before(toggle);
  const sheet = document.createElement('style');
  sheet.textContent = '#theme-toggle:not(:checked) ~ p #source-style {color:white} #theme-toggle:checked ~ p #source-style {color:black}';
  document.head.appendChild(sheet);
  try {
    render(unit,'兄弟元素触发的主题更新。',mode);
    const target = document.querySelector<HTMLElement>('.dual-read-target')!;
    expect(target.style.color).toContain('255');
    toggle.checked = true;
    if (trigger==='attribute') toggle.setAttribute('checked','');
    else toggle.dispatchEvent(new Event(trigger,{bubbles:true}));
    await settlePresentation(); expect(target.style.color).toBe('');
    toggle.checked = false;
    if (trigger==='attribute') toggle.removeAttribute('checked');
    else toggle.dispatchEvent(new Event(trigger,{bubbles:true}));
    await settlePresentation(); expect(target.style.color).toContain('255');
    target.style.setProperty('color','green','important'); toggle.checked=true; toggle.dispatchEvent(new Event('change',{bubbles:true}));
    await settlePresentation(); expect(target.style.color).toBe('green');
    expect(target.style.getPropertyPriority('color')).toBe('important');
  } finally {sheet.remove();}
});
