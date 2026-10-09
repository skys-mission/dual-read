// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAnchoredLayouts, attachAnchoredLayouts, captureAnchoredLayouts, readAnchoredLayouts, releaseAnchoredLayout, restoreAnchoredLayouts } from '../lib/renderer/anchored-layout';

afterEach(() => { restoreAnchoredLayouts(document); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function fixture() {
  document.body.innerHTML = '<main><section id="frame" style="position:relative"><div id="content"><p id="host">Original prose.</p></div><div id="footer" style="position:absolute;top:300px;height:calc(100% - 300px)"><button>Next</button></div></section></main>';
  const frame = document.getElementById('frame')!;
  const footer = document.getElementById('footer')!;
  const host = document.getElementById('host')!;
  let height = 400, width = 600;
  Object.defineProperties(frame, { clientHeight: { configurable: true, get: () => height }, clientWidth: { configurable: true, get: () => width } });
  captureAnchoredLayouts([host]);
  const owner = document.createElement('span'); host.appendChild(owner); attachAnchoredLayouts(host, owner);
  return { frame, footer, host, owner, resize: (h: number, w = 600) => { height = h; width = w; } };
}

describe('absolute footers tied to prose height', () => {
  it.each(['top', 'height'] as const)('releases paired anchoring after a stylesheet overrides only %s', async property => {
    const {frame, footer, owner, resize} = fixture();
    const sheet = document.createElement('style');
    sheet.textContent = `#frame.changed #footer {${property}:${property === 'top' ? '300px' : 'calc(100% - 300px)'}!important}`;
    document.head.appendChild(sheet);
    try {
      resize(550); applyAnchoredLayouts(readAnchoredLayouts([owner]));
      expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(true);
      frame.classList.add('changed'); await new Promise(resolve => setTimeout(resolve, 100));
      expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
      applyAnchoredLayouts(readAnchoredLayouts([owner]));
      expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
      expect(frame.classList.contains('changed')).toBe(true);
      expect(footer.style.top).toBe('300px'); expect(footer.style.height).toBe('calc(100% - 300px)');
    } finally {sheet.remove();}
  });

  it('rejects a stale anchor apply when the page changes a stylesheet after the read', () => {
    const {frame, footer, owner, resize} = fixture(); resize(550);
    const changes = readAnchoredLayouts([owner]);
    const sheet = document.createElement('style'); sheet.textContent = '#frame #footer {height:44px!important}';
    document.head.appendChild(sheet);
    try {applyAnchoredLayouts(changes); expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false); expect(frame.isConnected).toBe(true);}
    finally {sheet.remove();}
  });

  it.each(['top', 'height'] as const)('releases a paired rule when only the source %s priority changes', async property => {
    const {footer, owner, resize} = fixture(); resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    const value = footer.style.getPropertyValue(property);
    footer.style.setProperty(property, value, 'important');
    // jsdom does not emit a style record for a same-value priority-only write.
    footer.setAttribute('style', footer.style.cssText);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(footer.style.getPropertyValue(property)).toBe(value);
    expect(footer.style.getPropertyPriority(property)).toBe('important');
    expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
  });

  it.each(['top', 'height'] as const)('does not apply a captured footer write after a same-value %s priority edit', property => {
    const {footer, owner, resize} = fixture(); resize(550);
    const changes = readAnchoredLayouts([owner]);
    footer.style.setProperty(property, footer.style.getPropertyValue(property), 'important');
    applyAnchoredLayouts(changes);
    expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
  });

  it.each(['top', 'height'] as const)('retains an initially author-important %s constraint', property => {
    const {footer, host, owner, resize} = fixture();
    restoreAnchoredLayouts(document);
    footer.style.setProperty(property, footer.style.getPropertyValue(property), 'important');
    captureAnchoredLayouts([host]); attachAnchoredLayouts(host, owner); resize(550);
    expect(readAnchoredLayouts([owner])).toEqual([]);
  });

  it.each(['page-style','position','resize','transfer','owner-removal'] as const)('automatically releases an installed rule after %s without another render', async operation => {
    const {footer,host,owner,resize} = fixture(); resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    expect(document.querySelector('style[data-dual-read-anchor-style]')).not.toBeNull();
    if (operation==='page-style') {footer.style.top='10px';footer.style.height='32px';}
    if (operation==='position') footer.style.position='fixed';
    if (operation==='resize') {resize(550,400);window.dispatchEvent(new Event('resize'));}
    if (operation==='transfer') document.body.appendChild(footer);
    if (operation==='owner-removal') owner.remove();
    await new Promise(resolve => setTimeout(resolve,100));
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
    expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
    expect(footer.style.top).toBe(operation==='page-style'?'10px':'300px');
    expect(footer.parentElement).toBe(operation==='transfer'?document.body:host.parentElement!.parentElement);
  });

  it.each(['shrink', 'page-style', 'resize', 'transfer', 'full-restore'] as const)(
    'settles a shared footer after owner removal without undoing %s', operation => {
      const frames = new Map<number, FrameRequestCallback>();
      let sequence = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
      const { footer, host, owner, resize } = fixture();
      const second = document.createElement('span'); host.appendChild(second); attachAnchoredLayouts(host, second);
      resize(650);
      applyAnchoredLayouts(readAnchoredLayouts([owner, second]));
      releaseAnchoredLayout(owner);
      owner.remove(); resize(450);
      if (operation === 'page-style') { footer.style.top = '330px'; footer.style.height = 'calc(100% - 330px)'; }
      if (operation === 'resize') resize(450, 400);
      if (operation === 'transfer') document.body.appendChild(second);
      if (operation === 'full-restore') restoreAnchoredLayouts(document);
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(16); }
      const style = document.querySelector('style[data-dual-read-anchor-style]');
      if (operation === 'shrink') {
        expect(style!.textContent).toContain('top: 350px');
        expect(style!.textContent).toContain('height: calc(100% - 350px)');
        releaseAnchoredLayout(second); second.remove();
        expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
      } else {
        expect(style).toBeNull();
        expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
      }
      expect(footer.style.top).toBe(operation === 'page-style' ? '330px' : '300px');
      expect(frames.size).toBe(0);
    },
  );

  it('retains the reserved footer region as translated prose grows', () => {
    const { footer, owner, resize } = fixture();
    const source = footer.getAttribute('style');
    expect(readAnchoredLayouts([owner])).toEqual([]);
    resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    expect(document.querySelector('style[data-dual-read-anchor-style]')!.textContent).toContain('top: 450px');
    expect(document.querySelector('style[data-dual-read-anchor-style]')!.textContent).toContain('height: calc(100% - 450px)');
    expect(footer.getAttribute('style')).toBe(source);
    releaseAnchoredLayout(owner);
    expect(footer.getAttribute('style')).toBe(source);
    expect(footer.hasAttribute('data-dual-read-layout-anchor')).toBe(false);
  });

  it('returns to the source anchor when the containing content shrinks', () => {
    const { owner, resize } = fixture(); resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner])); resize(400);
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
  });

  it('releases its rule when the page changes the footer contract', () => {
    const { footer, owner, resize } = fixture(); resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner]));
    footer.style.top = '360px'; footer.style.height = 'calc(100% - 360px)';
    applyAnchoredLayouts(readAnchoredLayouts([owner])); restoreAnchoredLayouts(document);
    expect(footer.style.top).toBe('360px');
    expect(footer.style.height).toBe('calc(100% - 360px)');
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
  });

  it('does not reuse a source measurement after responsive resizing or transfer', () => {
    const { footer, owner, resize } = fixture(); resize(550, 400);
    expect(readAnchoredLayouts([owner])).toEqual([]);
    resize(550); document.body.appendChild(footer);
    expect(readAnchoredLayouts([owner])).toEqual([]);
  });

  it('keeps a shared rule until the last connected companion is removed', () => {
    const { host, owner, resize } = fixture(); resize(550);
    const second = document.createElement('span'); host.appendChild(second); attachAnchoredLayouts(host, second);
    applyAnchoredLayouts(readAnchoredLayouts([owner])); applyAnchoredLayouts(readAnchoredLayouts([second]));
    releaseAnchoredLayout(owner);
    expect(document.querySelector('style[data-dual-read-anchor-style]')).not.toBeNull();
    releaseAnchoredLayout(second);
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
  });

  it('clears orphaned rules without recreating a footer removed by the page', () => {
    const { footer, owner, resize } = fixture(); resize(550);
    applyAnchoredLayouts(readAnchoredLayouts([owner])); footer.remove();
    restoreAnchoredLayouts(document); restoreAnchoredLayouts(document);
    expect(document.getElementById('footer')).toBeNull();
    expect(document.querySelector('style[data-dual-read-anchor-style]')).toBeNull();
  });

  it.each(['mismatched', 'positioned-content', 'chrome'])('leaves unrelated layouts alone: %s', scenario => {
    const { footer, host, owner, resize } = fixture();
    restoreAnchoredLayouts(document);
    if (scenario === 'mismatched') footer.style.height = 'calc(100% - 100px)';
    if (scenario === 'positioned-content') host.parentElement!.style.position = 'absolute';
    if (scenario === 'chrome') host.parentElement!.setAttribute('role', 'navigation');
    captureAnchoredLayouts([host]); attachAnchoredLayouts(host, owner); resize(550);
    expect(readAnchoredLayouts([owner])).toEqual([]);
  });
});
