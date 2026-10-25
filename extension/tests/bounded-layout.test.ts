// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBoundedLayouts, readBoundedLayouts, releaseBoundedLayout, restoreBoundedLayouts } from '../lib/renderer/bounded-layout';
import { readSourceVisibility } from '../lib/collector';
import * as sourcePolicy from '../lib/renderer/source-layout-policy';

afterEach(() => {
  restoreBoundedLayouts(document);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(containerStyle = 'height:80px;overflow:hidden'): { box: HTMLElement; target: HTMLElement } {
  document.body.innerHTML = `<main><section id="box" style="${containerStyle}"><p>Original prose.<span id="target">完整的译文。</span></p></section></main>`;
  const box = document.getElementById('box')!;
  const target = document.getElementById('target')!;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
    const height = this === box ? 80 : this === target ? 120 : 220;
    const top = this === target ? 32 : 0;
    return { x: 0, y: top, width: 320, height, top, bottom: top + height, left: 0, right: 320, toJSON() {} } as DOMRect;
  });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 170 });
  return { box, target };
}

describe('bounded prose layout', () => {
  it.each(['transient', 'persistent'] as const)('bounds retries after a %s policy read limit', async limit => {
    const { box, target } = fixture();
    applyBoundedLayouts(readBoundedLayouts([target]));
    const policy = vi.spyOn(sourcePolicy, 'readSourceLayoutPolicyState');
    const exhausted = () => ({ signature: '[["@read-limit"]]', complete: false, limited: true });
    if (limit === 'transient') policy.mockImplementationOnce(exhausted);
    else policy.mockImplementation(exhausted);
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(limit === 'transient');
    expect(target.isConnected).toBe(true);
    const reads = policy.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(policy.mock.calls.length).toBe(reads);
  });

  it.each(['center', 'flex-end'])('includes source overflow above a %s column flex box', align => {
    const { box, target } = fixture(`height:80px;overflow:hidden;display:flex;flex-direction:column;justify-content:${align}`);
    const paragraph = target.parentElement!;
    paragraph.style.margin = '8px';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const top = this === paragraph ? (align === 'center' ? -12 : -32) : this === target ? (align === 'center' ? 32 : 12) : 0;
      const height = this === box ? 80 : this === paragraph ? 104 : this === target ? 60 : 220;
      return { x: 0, y: top, width: 320, height, top, bottom: top + height, left: 0, right: 320, toJSON() {} } as DOMRect;
    });
    // A scroll extent omits the unreachable negative overflow. With end
    // alignment even the translation fits, while the original is clipped.
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: align === 'center' ? 100 : 80 });
    const change = readBoundedLayouts([target]).find(change => change.box === box);
    expect(change?.height).toBe(120);
  });

  it('bounds follow-up work when a percentage sibling moves with every height correction', async () => {
    const { box, target } = fixture();
    box.querySelector('p')!.style.height = '100%';
    box.append(target);
    const height = () => {
      const rule = document.querySelector<HTMLStyleElement>('style[data-dual-read-layout-style]')?.sheet?.cssRules[0] as CSSStyleRule | undefined;
      return Math.max(80, parseFloat(rule?.style.getPropertyValue('min-height') || '') || 0);
    };
    const computed = getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computed(element);
      return element !== box ? style : new Proxy(style, { get(style, key) {
        if (key === 'height') return `${height()}px`;
        return Reflect.get(style, key, style);
      } });
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const top = this === target ? height() + 2 : 0;
      const size = this === box ? height() : this === target ? 60 : 1000;
      return { x: 0, y: top, width: 320, height: size, top, bottom: top + size, left: 0, right: 320, toJSON() {} } as DOMRect;
    });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => height() + 65 });
    applyBoundedLayouts(readBoundedLayouts([target]));
    const firstFloor = height();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(height()).toBe(firstFloor);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(height()).toBe(firstFloor);
  });

  it.each([
    { height: 16, extra: '', expands: true },
    { height: 20, extra: '', expands: true },
    { height: 23.5, extra: '', expands: true },
    { height: 0, extra: '', expands: false },
    { height: 2, extra: '', expands: false },
    { height: 20, extra: 'text-overflow:clip', expands: false },
    { height: 20, extra: 'overflow:auto', expands: false },
    { height: 20, extra: '-webkit-line-clamp:1', expands: false },
    { height: 20, extra: '', role: 'button', expands: false },
  ])('keeps a $height px ellipsis translation visible with $extra, expands=$expands', ({ height, extra, role, expands }) => {
    const { box, target } = fixture(`display:block;height:${height}px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;${extra}`);
    if (role) box.setAttribute('role', role);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const top = this === target ? 22 : 0;
      const size = this === box ? height : this === target ? 20 : 100;
      return { x: 0, y: top, width: 320, height: size, top, bottom: top + size, left: 0, right: 320, toJSON() {} } as DOMRect;
    });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 44 });
    const children = [...box.childNodes];
    const authored = box.getAttribute('style');
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(expands);
    if (expands) {
      expect(document.querySelector('style[data-dual-read-layout-style]')!.textContent).toContain('min-height: 44px');
    }
    expect(box.getAttribute('style')).toBe(authored);
    releaseBoundedLayout(target);
    restoreBoundedLayouts(document);
    expect([...box.childNodes]).toEqual(children);
    expect(box.getAttribute('style')).toBe(authored);
    expect(document.querySelector('[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toBeNull();
  });

  it.each(['open', 'collapsed', 'padded'] as const)('reads %s source visibility before the expansion frame runs', state => {
    const { box, target } = fixture('height:80px;width:320px;overflow:hidden');
    const source = box.querySelector('p')!;
    const original = [...source.childNodes];
    applyBoundedLayouts(readBoundedLayouts([target]));
    const sheet = document.querySelector<HTMLStyleElement>('style[data-dual-read-layout-style]')!;
    const rule = sheet.sheet!.cssRules[0] as CSSStyleRule;
    const correction = rule.style.cssText;
    // jsdom has no used geometry. Model the browser's important min-height
    // correction while retaining the real CSSOM rule and page declarations.
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      const style = computed(element);
      if (element !== box) return style;
      return new Proxy(style, { get(style, key) {
        if (key === 'height') return rule.style.getPropertyValue('min-height') ? '170px' : box.style.height;
        return Reflect.get(style, key, style);
      } });
    });
    if (state !== 'open') box.style.height = '0px';
    if (state === 'padded') box.style.padding = '24px';
    const authored = box.getAttribute('style');
    expect(readSourceVisibility([source]).get(source)).toBe(state !== 'collapsed');
    expect(rule.style.cssText).toBe(correction);
    expect(box.getAttribute('style')).toBe(authored);
    expect([...source.childNodes]).toEqual(original);
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
  });

  it('revalidates a later box after a synchronous page callback changes its source', () => {
    const {box, target} = fixture();
    const other = document.createElement('section'); other.style.cssText = 'height:80px;overflow:hidden';
    const owner = document.createElement('span'); owner.textContent = 'Another translation.'; other.append(owner);
    box.after(other);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const height = this === box || this === other ? 80 : this === target || this === owner ? 120 : 220;
      const top = this === target || this === owner ? 32 : 0;
      return {x:0,y:top,width:320,height,top,bottom:top+height,left:0,right:320,toJSON(){}} as DOMRect;
    });
    Object.defineProperty(other, 'scrollHeight', {value:170});
    const set = box.setAttribute.bind(box);
    vi.spyOn(box, 'setAttribute').mockImplementation((name, value) => {
      set(name, value);
      // Model a custom element's synchronous attributeChangedCallback.
      if (name === 'data-dual-read-layout-height') other.style.height = '0px';
    });
    applyBoundedLayouts(readBoundedLayouts([target, owner]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    expect(other.style.height).toBe('0px');
    expect(other.hasAttribute('data-dual-read-layout-height')).toBe(false);
  });

  it('yields when a page removes padding from a translated zero-content-height panel', async () => {
    const {box, target} = fixture('height:0;padding:24px;overflow:hidden');
    applyBoundedLayouts(readBoundedLayouts([target])); expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    box.style.padding = '0px'; await new Promise(resolve => setTimeout(resolve, 100));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(box.style.height).toBe('0px'); expect(box.style.padding).toBe('0px');
  });

  it.each(['variable', 'class', 'stylesheet'] as const)('yields to stylesheet-owned %s collapse and resumes the retained owner', async trigger => {
    const {box, target} = fixture('overflow:hidden');
    const sheet = document.createElement('style');
    sheet.textContent = '#box {height:var(--panel-height,80px)} #box.closed {height:0px}';
    document.head.appendChild(sheet);
    if (trigger === 'variable') {
      // JSDOM does not inherit custom properties. Model this CSSOM input here;
      // native Chromium/Firefox tests cover its actual cascade and geometry.
      const readComputed = getComputedStyle;
      vi.stubGlobal('getComputedStyle', (element: Element) => {
        const style = readComputed(element);
        return new Proxy(style, {get(target, property) {
          if (property === 'getPropertyValue') return (name: string) => name === '--panel-height'
            ? target.getPropertyValue(name) || document.documentElement.style.getPropertyValue(name)
            : target.getPropertyValue(name);
          return Reflect.get(target, property, target);
        }});
      });
    }
    try {
      applyBoundedLayouts(readBoundedLayouts([target]));
      expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
      box.style.color = 'red'; await new Promise(resolve => setTimeout(resolve, 80));
      expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
      if (trigger === 'variable') document.documentElement.style.setProperty('--panel-height', '0px');
      if (trigger === 'class') box.classList.add('closed');
      if (trigger === 'stylesheet') sheet.textContent = '#box {height:0px}';
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
      applyBoundedLayouts(readBoundedLayouts([target]));
      expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
      document.documentElement.style.removeProperty('--panel-height'); box.classList.remove('closed');
      sheet.textContent = '#box {height:var(--panel-height,80px)} #box.closed {height:0px}';
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
      expect(target.isConnected).toBe(true); expect(box.style.color).toBe('red');
    } finally {sheet.remove(); document.documentElement.style.removeProperty('--panel-height');}
  });

  it('honors custom-property block-sizing inputs while ignoring unrelated variables', async () => {
    const {box, target} = fixture('--panel-height:80px;height:var(--panel-height);overflow:hidden');
    applyBoundedLayouts(readBoundedLayouts([target]));
    box.style.setProperty('--paint-color', 'red');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    box.style.setProperty('--panel-height', '0px');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    box.style.setProperty('--panel-height', '80px');
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    expect(box.style.height).toBe('var(--panel-height)');
    expect(box.style.getPropertyValue('--paint-color')).toBe('red');
  });

  it('resumes the same retained translation when the page reopens its original sizing policy', async () => {
    const { box, target } = fixture(); const source = target.firstChild;
    applyBoundedLayouts(readBoundedLayouts([target]));
    box.style.height = '0px'; await new Promise(resolve => setTimeout(resolve, 80));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    box.style.height = '80px'; await new Promise(resolve => setTimeout(resolve, 120));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    expect(target.firstChild).toBe(source); expect(box.style.height).toBe('80px');
    releaseBoundedLayout(target);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  });

  it.each([
    ['collapse', 'height:0px;min-height:0px;overflow:hidden'],
    ['scroll', 'height:120px;overflow:auto'],
    ['position', 'height:80px;overflow:hidden;position:fixed'],
    ['clamp', 'height:80px;overflow:hidden;-webkit-line-clamp:2'],
    ['grid', 'height:80px;overflow:hidden;grid-template-rows:24px'],
    ['logical-height', 'height:80px;overflow:hidden;block-size:44px'],
  ])('yields an installed rule to page-owned %s without a restore', async (_operation, style) => {
    const { box, target } = fixture();
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    box.setAttribute('style', style);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
    // A pending session layout pass must not re-install a policy it just released.
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(box.getAttribute('style')).toBe(style);
    expect(target.isConnected).toBe(true);
  });

  it('retains its sizing contract across color changes and can expand after a new page sizing policy', async () => {
    const { box, target } = fixture();
    applyBoundedLayouts(readBoundedLayouts([target])); box.style.color = 'red';
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    box.style.height = '44px'; await new Promise(resolve => setTimeout(resolve, 80));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    box.style.height = '80px'; applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    expect(box.style.color).toBe('red');
  });

  it('relaxes a historical floor after a same-owner viewport reflow', async () => {
    const { box, target } = fixture();
    let natural = 340, width = 320;
    const floor = () => Number(document.querySelector('style[data-dual-read-layout-style]')?.textContent?.match(/min-height: ([\d.]+)px/)?.[1] || 0);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const height = this === box ? (box.hasAttribute('data-dual-read-layout-height') ? Math.max(natural, floor()) : 80)
        : this === target ? natural - 20 : 500;
      const top = this === target ? 20 : 0;
      return { x: 0, y: top, width, height, top, bottom: top + height, left: 0, right: width, toJSON() {} } as DOMRect;
    });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => natural });
    applyBoundedLayouts(readBoundedLayouts([target])); expect(floor()).toBe(340);
    natural = 125; width = 1000; window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(box.getBoundingClientRect().height).toBe(125); expect(floor()).toBe(80);
    expect(box.getAttribute('style')).toBe('height:80px;overflow:hidden'); expect(target.isConnected).toBe(true);
  });

  it('follows container-only reflow and detaches its shared ResizeObserver on release', async () => {
    let callback: ResizeObserverCallback | undefined;
    const observed = new Set<Element>(); const unobserve = vi.fn((node: Element) => observed.delete(node));
    const disconnect = vi.fn(() => observed.clear());
    vi.stubGlobal('ResizeObserver', class {
      constructor(read: ResizeObserverCallback) { callback = read; }
      observe(node: Element) { observed.add(node); }
      unobserve = unobserve;
      disconnect = disconnect;
    });
    const { box, target } = fixture(); let natural = 340, width = 320;
    const floor = () => Number(document.querySelector('style[data-dual-read-layout-style]')?.textContent?.match(/min-height: ([\d.]+)px/)?.[1] || 0);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const height = this === box ? (box.hasAttribute('data-dual-read-layout-height') ? Math.max(natural, floor()) : 80)
        : this === target ? natural - 20 : 500;
      const top = this === target ? 20 : 0;
      return { x: 0, y: top, width, height, top, bottom: top + height, left: 0, right: width, toJSON() {} } as DOMRect;
    });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => natural });
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(observed.has(box)).toBe(true); expect(observed.has(target)).toBe(true);
    const notify = () => callback!([...observed].map(node => ({ target: node, contentRect: node.getBoundingClientRect() }) as ResizeObserverEntry), {} as ResizeObserver);
    notify(); natural = 125; width = 1000; notify();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(box.getBoundingClientRect().height).toBe(125);
    releaseBoundedLayout(target); expect(disconnect).toHaveBeenCalled(); expect(observed.size).toBe(0);
    notify(); await new Promise(resolve => setTimeout(resolve, 40));
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  });

  it.each(['release','remove','transfer'] as const)('relaxes a shared historical floor after owner %s and cleans up the last owner', async operation => {
    const {box,target} = fixture();
    const second = document.createElement('span'); second.className='dual-read-target'; second.textContent='Remaining translation.'; box.appendChild(second);
    let naturalHeight=340;
    const ruleHeight = () => Number(document.querySelector('style[data-dual-read-layout-style]')?.textContent?.match(/min-height: ([\d.]+)px/)?.[1] || 0);
    // Give each element its own geometry; spying on an inherited spy reuses
    // the prototype mock in Vitest 4+, changing every element's geometry.
    Object.defineProperty(box, 'getBoundingClientRect', { configurable: true, value: () => {
      const height=box.hasAttribute('data-dual-read-layout-height')?Math.max(naturalHeight,ruleHeight()):80;
      return {x:0,y:0,width:320,height,top:0,bottom:height,left:0,right:320,toJSON(){}} as DOMRect;
    } });
    Object.defineProperty(second, 'getBoundingClientRect', { configurable: true, value: () => ({x:0,y:20,width:320,height:naturalHeight-20,top:20,bottom:naturalHeight,left:0,right:320,toJSON(){}} as DOMRect) });
    Object.defineProperty(box,'scrollHeight',{configurable:true,get:()=>naturalHeight});
    applyBoundedLayouts(readBoundedLayouts([target,second]));
    expect(ruleHeight()).toBe(340);
    if (operation==='release') {releaseBoundedLayout(target);target.remove();}
    if (operation==='remove') target.remove();
    if (operation==='transfer') document.body.appendChild(target);
    naturalHeight=180;
    await new Promise(resolve=>setTimeout(resolve,120));
    expect(box.getBoundingClientRect().height).toBe(180);
    expect(box.getAttribute('style')).toBe('height:80px;overflow:hidden');
    expect(second.isConnected).toBe(true);
    if (operation==='transfer') expect(target.parentElement).toBe(document.body);
    second.remove(); await new Promise(resolve=>setTimeout(resolve,100));
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  });

  it('registers a later companion already fitting the shared expansion', () => {
    const { box, target } = fixture();
    applyBoundedLayouts(readBoundedLayouts([target]));
    const second = document.createElement('span');
    second.textContent = 'Later translation.';
    box.appendChild(second);
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 320, height: 200, top: 0, bottom: 200, left: 0, right: 320, toJSON() {} } as DOMRect);
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 10, width: 320, height: 180, top: 10, bottom: 190, left: 0, right: 320, toJSON() {} } as DOMRect);
    applyBoundedLayouts(readBoundedLayouts([second]));
    releaseBoundedLayout(target);
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(true);
    expect(document.querySelector('style[data-dual-read-layout-style]')).not.toBeNull();
    releaseBoundedLayout(second);
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  });

  it('expands a clipped flow container through owned CSS and preserves page changes on release', () => {
    const { box, target } = fixture();
    const original = box.firstChild;
    const style = box.getAttribute('style');
    const changes = readBoundedLayouts([target]);
    expect(changes).toHaveLength(1);
    applyBoundedLayouts(changes);
    expect(box.getAttribute('style')).toBe(style);
    expect(document.querySelector('style[data-dual-read-layout-style]')!.textContent).toContain('min-height: 170px');
    box.style.height = '44px';
    releaseBoundedLayout(target);
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
    expect(box.firstChild).toBe(original);
    expect(box.style.height).toBe('44px');
  });

  it.each([
    'height:80px;overflow-y:auto',
    'height:80px;overflow-y:scroll',
    'height:80px;overflow:hidden;position:fixed',
    'height:80px;overflow:hidden;position:absolute',
    'height:80px;overflow:hidden;-webkit-line-clamp:3',
  ])('retains intentional viewport or source policies: %s', style => {
    const { target } = fixture(style);
    expect(readBoundedLayouts([target])).toEqual([]);
  });

  it('retains chrome dimensions and ignores disconnected companions', () => {
    const { box, target } = fixture();
    box.setAttribute('role', 'navigation');
    expect(readBoundedLayouts([target])).toEqual([]);
    box.removeAttribute('role');
    target.remove();
    expect(readBoundedLayouts([target])).toEqual([]);
  });

  it('clears an orphaned expansion without reviving a source removed by the page', () => {
    const { box, target } = fixture();
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(document.querySelector('style[data-dual-read-layout-style]')).not.toBeNull();
    target.parentElement!.remove();
    restoreBoundedLayouts(document);
    restoreBoundedLayouts(document);
    expect(box.childNodes).toHaveLength(0);
    expect(box.hasAttribute('data-dual-read-layout-height')).toBe(false);
    expect(document.querySelector('style[data-dual-read-layout-style]')).toBeNull();
  });

  it('grows a measured visible-overflow text row rather than overlapping the following content', () => {
    const { box, target } = fixture('height:80px;overflow:visible');
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(box.style.height).toBe('80px');
    const rule = (document.querySelector<HTMLStyleElement>('style[data-dual-read-layout-style]')!.sheet!.cssRules[0] as CSSStyleRule).style;
    expect(rule.getPropertyValue('height')).toBe('');
    expect(rule.getPropertyValue('min-height')).toBe('170px');
  });

  it('keeps named grid lines and source track minimums when allowing translated row growth', () => {
    const { box, target } = fixture('display:grid;grid-template-rows:[badge] 16px [heading] 32px;height:80px');
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(document.querySelector('style[data-dual-read-layout-style]')!.textContent).toContain('[badge] minmax(16px, auto) [heading] minmax(32px, auto)');
    expect(box.style.gridTemplateRows).toBe('[badge] 16px [heading] 32px');
  });
});
