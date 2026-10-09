// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBoundedLayouts, readBoundedLayouts, releaseBoundedLayout, restoreBoundedLayouts } from '../lib/renderer/bounded-layout';

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
    vi.spyOn(box,'getBoundingClientRect').mockImplementation(() => {
      const height=box.hasAttribute('data-dual-read-layout-height')?Math.max(naturalHeight,ruleHeight()):80;
      return {x:0,y:0,width:320,height,top:0,bottom:height,left:0,right:320,toJSON(){}} as DOMRect;
    });
    vi.spyOn(second,'getBoundingClientRect').mockImplementation(() => ({x:0,y:20,width:320,height:naturalHeight-20,top:20,bottom:naturalHeight,left:0,right:320,toJSON(){}} as DOMRect));
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
    expect(document.querySelector('style[data-dual-read-layout-style]')!.textContent).toContain('height: auto');
  });

  it('keeps named grid lines and source track minimums when allowing translated row growth', () => {
    const { box, target } = fixture('display:grid;grid-template-rows:[badge] 16px [heading] 32px;height:80px');
    applyBoundedLayouts(readBoundedLayouts([target]));
    expect(document.querySelector('style[data-dual-read-layout-style]')!.textContent).toContain('[badge] minmax(16px, auto) [heading] minmax(32px, auto)');
    expect(box.style.gridTemplateRows).toBe('[badge] 16px [heading] 32px');
  });
});
