import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

const families = ['anchor-container', 'anchor-opaque', 'part', 'exported-part', 'closed-slotted', 'closed-cssom', 'hover', 'focus', 'shadow-hover', 'shadow-focus'] as const;
export const layoutCascadeCases = families.flatMap(family =>
  (family.startsWith('anchor') ? ['bilingual'] as const : ['bilingual', 'replace'] as const)
    .flatMap(mode => [false, true].map(paused => ({family, mode, paused}))),
);
type Scenario = typeof layoutCascadeCases[number];
export const translateLayoutCascadeText = (text: string): string => text.startsWith('Cascade source')
  ? '这是用于检查译文布局能否正确响应页面样式和交互状态变化的说明。'.repeat(10) : `译:${text}`;

interface Source {
  subject: HTMLElement;
  paragraph: HTMLElement;
  text: Text;
  value: string;
  children: Node[];
  style: string | null;
  sheet: CSSStyleSheet;
}
declare global { interface Window { __layoutCascadeSource: Source } }

/** Expected dimensions and restoration ownership come from the author's DOM,
 * before translation installs any sizing correction. */
export async function verifyLayoutCascade(page: Page, scenario: Scenario, controls: {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}): Promise<void> {
  await page.setViewportSize({width:1280, height:900});
  if (scenario.family === 'anchor-opaque') {
    const url = new URL('/cascade-author.css', page.url()); url.hostname = 'localhost';
    await page.route(url.href, route => route.fulfill({contentType:'text/css', body:'.compact :where(.anchor){top:20px!important;height:40px!important}'}));
    await page.addStyleTag({url:url.href});
    expect(await page.evaluate(() => {
      try { Array.from(Array.from(document.styleSheets).find(sheet => sheet.href?.endsWith('/cascade-author.css'))!.cssRules); return false; }
      catch { return true; }
    })).toBe(true);
  }
  await page.evaluate(({family}) => {
    const style = document.createElement('style');
    let scope: ParentNode = document, subject: HTMLElement;
    const prose = '<p id="cascade-copy">Cascade source with useful documentation for the reader.</p>';
    if (family.startsWith('anchor')) {
      style.textContent = 'body{font:16px/20px sans-serif}#container{container-type:inline-size;width:800px}#card{position:relative;width:300px;min-height:100px;padding-bottom:40px}#cascade-copy{margin:0}.anchor{position:absolute;left:0;width:100%}'
        + (family === 'anchor-container' ? '@container(max-width:400px){.anchor{top:20px!important;height:40px!important}}' : '');
      document.head.append(style);
      document.body.innerHTML = `<main id="container"><section id="card">${prose}<div class="anchor" style="top:60px;height:calc(100% - 60px)"><button>Continue</button></div></section></main>`;
      subject = document.querySelector('.anchor')!;
    } else if (family === 'part' || family === 'exported-part') {
      document.body.innerHTML = '<main><cascade-card id="component"></cascade-card></main>';
      const root = document.getElementById('component')!.attachShadow({mode:'open'});
      let target = root;
      if (family === 'exported-part') {
        root.innerHTML = '<inner-card exportparts="copy:public-copy"></inner-card>';
        target = root.querySelector('inner-card')!.attachShadow({mode:'open'});
      }
      target.innerHTML = prose; scope = target;
      subject = target.querySelector('p')!; subject.setAttribute('part', 'copy');
      const part = family === 'part' ? 'copy' : 'public-copy';
      style.textContent = `cascade-card::part(${part}){display:block;width:240px;height:40px;overflow:hidden;margin:0;font:16px/20px sans-serif}cascade-card.compact::part(${part}){height:10px}`;
      document.head.append(style);
    } else if (family.startsWith('closed')) {
      document.body.innerHTML = `<main><cascade-card id="component">${prose}</cascade-card></main>`;
      const host = document.getElementById('component')!;
      const root = host.attachShadow({mode:'closed'}); root.innerHTML = '<slot></slot>';
      style.textContent = '::slotted(p){display:block;width:240px;height:40px;overflow:hidden;margin:0;font:16px/20px sans-serif}:host(.compact) ::slotted(p){height:10px}';
      root.prepend(style); subject = document.getElementById('cascade-copy')!;
      if (family === 'closed-cssom') {
        // Real Firefox content scripts expose this privileged property. The
        // Gecko page-world harness supplies that API only; CSS/layout is native.
        // Chromium's isolated content world uses its real chrome.dom API.
        Object.defineProperty(host, 'openOrClosedShadowRoot', {value:root});
      }
    } else {
      const markup = `<div id="trigger"><section id="card" tabindex="0">${prose}</section></div>`;
      style.textContent = '#trigger{margin:80px;width:300px;height:700px}#card{width:240px;height:40px;overflow:hidden;font:16px/20px sans-serif}#cascade-copy{margin:0}'
        + (family.endsWith('hover') ? '#trigger:hover #card{height:10px}' : '#card:focus{height:10px}');
      if (family.startsWith('shadow')) {
        document.body.innerHTML = '<main><cascade-card id="component"></cascade-card></main>';
        const root = document.getElementById('component')!.attachShadow({mode:'open'});
        root.innerHTML = markup; root.prepend(style); scope = root;
      } else { document.body.innerHTML = markup; document.head.append(style); }
      subject = scope.querySelector('#card')!;
    }
    const paragraph = scope.querySelector<HTMLElement>('#cascade-copy')!;
    window.__layoutCascadeSource = {subject, paragraph, text:paragraph.firstChild as Text, value:paragraph.textContent!,
      children:[...paragraph.childNodes], style:subject.getAttribute('style'), sheet:style.sheet!};
  }, scenario);

  const anchor = scenario.family.startsWith('anchor');
  const subject = page.locator(anchor ? '.anchor' : scenario.family.endsWith('hover') || scenario.family.endsWith('focus') ? '#card' : '#cascade-copy');
  const marker = anchor ? 'data-dual-read-layout-anchor' : 'data-dual-read-layout-height';
  const change = async (compact: boolean): Promise<void> => {
    if (scenario.family.endsWith('hover')) {
      const bounds = await page.locator('#trigger').boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(compact ? bounds!.x + 5 : 0, compact ? bounds!.y + 5 : 0);
    } else if (scenario.family.endsWith('focus')) {
      if (compact) await subject.focus();
      else await subject.evaluate(node => (node as HTMLElement).blur());
    } else await page.evaluate(({family, compact}) => {
      if (family === 'anchor-container') document.getElementById('container')!.style.width = compact ? '200px' : '800px';
      else if (family === 'anchor-opaque') document.body.classList.toggle('compact', compact);
      else if (family === 'closed-cssom') (window.__layoutCascadeSource.sheet.cssRules[0] as CSSStyleRule).style.height = compact ? '10px' : '40px';
      else document.getElementById('component')!.classList.toggle('compact', compact);
    }, {family:scenario.family, compact});
  };
  const assertCompact = async (): Promise<void> => {
    await expect(subject).toHaveCSS('height', anchor ? '40px' : '10px');
    if (anchor) await expect(subject).toHaveCSS('top', '20px');
    await expect(subject).not.toHaveAttribute(marker, /.+/);
  };
  const assertRestored = async (): Promise<void> => {
    expect(await page.evaluate(() => {
      const s = window.__layoutCascadeSource;
      return s.text.isConnected && s.text.data === s.value && s.subject.isConnected
        && s.paragraph.childNodes.length === s.children.length
        && [...s.paragraph.childNodes].every((node, i) => node === s.children[i])
        && s.subject.getAttribute('style') === s.style && s.paragraph.dataset.pageEdit === 'retained';
    })).toBe(true);
    await assertCompact();
    await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],[data-dual-read-layout-anchor]')).toHaveCount(0);
  };

  await change(true); await assertCompact(); await change(false);
  if (anchor) await expect(subject).toHaveCSS('top', '60px');
  else await expect(subject).toHaveCSS('height', '40px');
  await controls.translate(scenario.mode);
  await expect(page.locator('#cascade-copy')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(subject).toHaveAttribute(marker, /.+/);
  if (scenario.paused) await controls.pause();
  // A paint-only change and stable parent reflow must retain the correction,
  // including an anchor whose opaque/conditional cascade needs native fallback.
  await page.evaluate(() => {
    const source = window.__layoutCascadeSource; source.paragraph.style.color = 'red';
    source.style = source.subject.getAttribute('style');
  });
  await page.waitForTimeout(1400);
  await expect(subject).toHaveAttribute(marker, /.+/);
  await change(true); await assertCompact();
  if (!anchor) {
    await change(false); await expect(subject).toHaveAttribute(marker, /.+/);
    await change(true); await assertCompact();
  }
  await page.evaluate(() => { window.__layoutCascadeSource.paragraph.dataset.pageEdit = 'retained'; });
  await controls.restore(); await assertRestored();
  await controls.restore(); await assertRestored();
  await change(false);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(page.locator('#cascade-copy')).toHaveAttribute('data-dual-read-done', 'true');
  if (!anchor) await expect(subject).toHaveAttribute(marker, /.+/);
  await change(true); await assertCompact();
  await controls.restore(); await assertRestored();
}
