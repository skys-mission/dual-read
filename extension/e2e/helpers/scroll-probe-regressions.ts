import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const scrollProbeCases = (['document', 'nested', 'shadow', 'slotted'] as const).flatMap(scope =>
  (['bilingual', 'replace'] as const).flatMap(mode => [false, true].map(paused => ({scope, mode, paused}))),
);
interface ScrollProbe {
  computed: typeof getComputedStyle;
  reads: Record<string, number>;
}
interface ScrollSource {
  shell: HTMLElement;
  panel: HTMLElement;
  source: HTMLElement;
  original: Node;
  authored: string | null;
  clicks: number;
}
declare global { interface Window { __scrollProbe?: ScrollProbe; __scrollSource: ScrollSource } }

/** Observe a real unmasked read in the content script's execution world. */
export function controlScrollProbe(action: 'install' | 'stats' | 'dispose'): Record<string, number> {
  if (action === 'install') {
    const probe: ScrollProbe = {computed:window.getComputedStyle, reads:{}};
    window.__scrollProbe = probe;
    window.getComputedStyle = (element, pseudo) => {
      const style = probe.computed.call(window, element, pseudo);
      const phase = element.getAttribute('data-probe-phase');
      if (!pseudo && phase && element.id === 'probe-panel' && element.hasAttribute('data-dual-read-layout-height') && style.height === '80px') {
        probe.reads[phase] = (probe.reads[phase] ?? 0) + 1;
      }
      return style;
    };
  }
  const probe = window.__scrollProbe!;
  if (action === 'dispose') {
    window.getComputedStyle = probe.computed;
    delete window.__scrollProbe;
  }
  return {...probe.reads};
}

export function translateScrollProbe(text: string): string {
  return text.startsWith('Scroll probe') ? '这段译文用于检查尺寸探测期间滚动位置和按钮点击的稳定性。'.repeat(8) : `译:${text}`;
}

export async function verifyScrollProbe(page: Page, scenario: typeof scrollProbeCases[number], driver: {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
  probe(action: 'install' | 'stats' | 'dispose'): Promise<Record<string, number>>;
}): Promise<void> {
  await page.setViewportSize({width:1600, height:900});
  await page.evaluate(scope => {
    document.body.innerHTML = '<main></main>';
    document.documentElement.style.scrollBehavior = 'smooth';
    const shell = document.createElement('section');
    let content = shell;
    if (scope === 'shadow' || scope === 'slotted') {
      const host = document.createElement('scroll-probe-widget');
      document.querySelector('main')!.append(host);
      host.attachShadow({mode:'open'}).append(shell);
      if (scope === 'slotted') {
        shell.innerHTML = '<slot></slot>';
        content = document.createElement('div'); host.append(content);
      }
    } else document.querySelector('main')!.append(shell);
    if (scope === 'document') shell.style.cssText = 'width:320px';
    else shell.style.cssText = 'width:320px;height:320px;overflow:auto;scroll-behavior:smooth';
    content.innerHTML = `<div style="height:${scope === 'document' ? 1100 : 400}px"></div><section id="probe-panel" style="height:80px;width:260px;overflow:hidden;font:16px/20px sans-serif"><p id="probe-source" style="margin:0">Scroll probe documentation with the original text.</p></section><button id="probe-action" style="height:40px">Open documentation</button><div style="height:80px"></div>`;
    const panel = content.querySelector<HTMLElement>('#probe-panel')!, source = content.querySelector<HTMLElement>('#probe-source')!;
    window.__scrollSource = {shell, panel, source, original:source.firstChild!, authored:panel.getAttribute('style'), clicks:0};
    content.querySelector('#probe-action')!.addEventListener('click', () => window.__scrollSource.clicks++);
  }, scenario.scope);
  const panel = page.locator('#probe-panel');
  await driver.probe('install');
  try {
    await panel.scrollIntoViewIfNeeded();
    await driver.translate(scenario.mode);
    await expect(panel).toHaveAttribute('data-dual-read-layout-height', /.+/);
    if (scenario.paused) await driver.pause();
    for (const phase of ['first', 'second', 'third']) {
      const before = await page.evaluate(({scope, phase}) => {
        const s = window.__scrollSource, scrolling = scope === 'document' ? document.scrollingElement! : s.shell;
        scrolling.scrollTo({top:scrolling.scrollHeight, behavior:'instant'});
        s.panel.dataset.probePhase = phase;
        return {x:scrollX, y:scrollY, left:s.shell.scrollLeft, top:s.shell.scrollTop};
      }, {scope:scenario.scope, phase});
      await expect.poll(async () => (await driver.probe('stats'))[phase] ?? 0).toBeGreaterThan(0);
      expect(await page.evaluate(() => ({x:scrollX, y:scrollY, left:window.__scrollSource.shell.scrollLeft, top:window.__scrollSource.shell.scrollTop}))).toEqual(before);
    }
    // Use a real pointer click after the read; forced/programmatic clicks would
    // miss the Gecko hit-target drift that originally timed out for a minute.
    await page.locator('#probe-action').click();
    expect(await page.evaluate(() => window.__scrollSource.clicks)).toBe(1);
    const verifySource = async () => {
      expect(await page.evaluate(() => {
        const s = window.__scrollSource;
        return {text:s.source.textContent, original:s.source.childNodes.length === 1 && s.source.firstChild === s.original,
          parent:s.source.parentElement === s.panel, authored:s.panel.getAttribute('style') === s.authored,
          edit:s.panel.dataset.probePhase, smooth:document.documentElement.style.scrollBehavior};
      })).toEqual({text:'Scroll probe documentation with the original text.', original:true, parent:true, authored:true, edit:'third', smooth:'smooth'});
      await expect(panel).not.toHaveAttribute('data-dual-read-layout-height', /.+/);
    };
    await driver.restore(); await driver.restore(); await verifySource();
    await panel.scrollIntoViewIfNeeded();
    await driver.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
    await expect(panel).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await driver.restore(); await verifySource();
  } finally {
    await driver.restore();
    await driver.probe('dispose');
  }
}
