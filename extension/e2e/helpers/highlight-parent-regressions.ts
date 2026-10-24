import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

interface Driver {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}
interface HighlightSource {
  host: HTMLElement;
  strong: HTMLElement;
  wrapper: HTMLElement;
  originals: Node[];
  mark?: HTMLElement;
  prefix?: Text;
  suffix?: Text;
  clicks: number;
}
declare global { interface Window { __highlightSources: HighlightSource[] } }
export const highlightCases = [
  { operation: 'range', paused: false }, { operation: 'range', paused: true },
  { operation: 'split', paused: false }, { operation: 'split', paused: true },
] as const;
export const parentSizingCases = ['inline', 'class', 'variable', 'stylesheet'] as const;

export function translateHighlightSource(text: string): string {
  if (text === 'First source') return '第一译文';
  if (text === 'second source') return '第二译文';
  if (text.startsWith('Anchor source')) return '这是用来验证翻译对布局影响的中文说明文字。'.repeat(10);
  return `译:${text}`;
}

/** Normal collection, live/paused reconciliation, repeated restore, and a mode
 * switch must retain original nodes and page wrappers through partial cuts. */
export async function verifyPartialHighlight(page: Page, scenario: typeof highlightCases[number], driver: Driver): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML = '<main lang="en"></main>';
    window.__highlightSources = ['ordinary', 'nested', 'omitted', 'normalized', 'prefixed'].map((structure, index) => {
      const host = document.createElement('p'); host.id = `highlight-${index}`;
      const strong = document.createElement('strong'); strong.append('First source');
      if (structure === 'normalized') strong.append(document.createComment('slot'), 'second source');
      const originals = [...strong.childNodes];
      const wrapper = document.createElement(structure === 'omitted' ? 'form' : 'span');
      if (structure === 'ordinary' || structure === 'normalized' || structure === 'prefixed') host.append(strong);
      else { wrapper.append(strong); host.append(wrapper); }
      host.append(' tail.'); document.querySelector('main')!.append(host);
      return { host, strong, wrapper, originals, clicks: 0 };
    });
  });
  await driver.translate('replace');
  await expect(page.locator('.dual-read-original-hidden')).toHaveCount(5);
  if (scenario.paused) await driver.pause();
  await page.evaluate(({ operation }) => {
    for (const [index, saved] of window.__highlightSources.entries()) {
      const copy = [...saved.host.querySelectorAll('strong')].find(node => !node.closest('.dual-read-original-hidden'))!;
      const prefix = document.createTextNode('Page prefix '), suffix = document.createTextNode(' page suffix');
      if (index === 4) copy.prepend(prefix);
      copy.normalize();
      const text = copy.firstChild as Text;
      const offset = index === 4 ? 'Page prefix '.length : 0;
      const mark = document.createElement('mark'); mark.dataset.pageNote = 'retained';
      mark.addEventListener('click', () => saved.clicks++);
      if (operation === 'range') {
        const range = document.createRange(); range.setStart(text, offset + 1); range.setEnd(text, offset + 3); range.surroundContents(mark);
      } else {
        const selected = text.splitText(offset + 1); selected.splitText(2);
        selected.before(mark); mark.append(selected);
      }
      if (index !== 4) copy.prepend(prefix);
      copy.append(suffix);
      Object.assign(saved, { mark, prefix, suffix });
    }
  }, scenario);
  if (!scenario.paused) await page.waitForTimeout(1100);
  await driver.pause(); await driver.restore(); await driver.restore();
  const verify = async (): Promise<void> => {
    expect(await page.evaluate(() => window.__highlightSources.map((saved, index) => {
      saved.mark!.click();
      return {
        text: saved.host.textContent,
        identities: saved.originals.every(node => node.parentNode === saved.strong),
        original: saved.originals[0].nodeValue,
        wrappers: saved.strong.contains(saved.mark!) && (index === 0 || index >= 3 || saved.strong.parentNode === saved.wrapper),
        pageEdits: saved.prefix!.parentNode === saved.strong && saved.suffix!.parentNode === saved.strong,
        note: saved.mark!.dataset.pageNote, highlight: saved.mark!.textContent, clicks: saved.clicks,
      };
    }))).toEqual([0, 1, 2, 3, 4].map(index => ({
      text: `Page prefix First source${index === 3 ? 'second source' : ''} page suffix tail.`,
      identities: true, original: 'First source', wrappers: true, pageEdits: true,
      note: 'retained', highlight: '', clicks: expect.any(Number),
    })));
  };
  await verify();
  await driver.translate('bilingual');
  await expect(page.locator('.dual-read-target')).toHaveCount(5);
  await driver.restore(); await verify();
  expect(await page.evaluate(() => window.__highlightSources.map(saved => saved.clicks))).toEqual([2, 2, 2, 2, 2]);
}

export async function verifyParentSizing(page: Page, scenario: typeof parentSizingCases[number], driver: Driver): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML = '<main lang="en"><section id="anchor-frame" style="position:relative;min-height:100px;width:280px;font:16px/20px sans-serif;--parent-size:auto"><p style="margin:0">Anchor source prose.</p><div id="anchor-footer" style="position:absolute;top:60px;height:calc(100% - 60px)"><button>Next</button></div></section></main>';
    const style = document.createElement('style'); style.id = 'parent-sizing-rule';
    style.textContent = '#anchor-frame {height:var(--parent-size)} #anchor-frame.page-sized {height:700px}';
    document.head.append(style);
  });
  await driver.translate('bilingual'); await driver.pause();
  const footer = page.locator('#anchor-footer');
  await expect(footer).toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await page.evaluate(scenario => {
    const frame = document.querySelector<HTMLElement>('#anchor-frame')!;
    if (scenario === 'inline') frame.style.height = '700px';
    if (scenario === 'class') frame.classList.add('page-sized');
    if (scenario === 'variable') frame.style.setProperty('--parent-size', '700px');
    if (scenario === 'stylesheet') {
      const sheet = document.querySelector<HTMLStyleElement>('#parent-sizing-rule')!.sheet!;
      (sheet.cssRules[0] as CSSStyleRule).style.height = '700px';
    }
  }, scenario);
  await expect(footer).not.toHaveAttribute('data-dual-read-layout-anchor', /.+/);
  await expect(footer).toHaveCSS('top', '60px');
  await expect(page.locator('#anchor-frame')).toHaveCSS('height', '700px');
  await driver.restore(); await driver.restore();
  await expect(footer).toHaveAttribute('style', 'position:absolute;top:60px;height:calc(100% - 60px)');
  await expect(page.locator('#anchor-frame')).toHaveCSS('height', '700px');
}
