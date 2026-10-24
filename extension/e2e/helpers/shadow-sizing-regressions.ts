import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const shadowSizingCases = (['host', 'slotted'] as const).flatMap(scope =>
  (['class', 'stylesheet', 'cssom', 'adopted-cssom'] as const).flatMap(change =>
    (['bilingual', 'replace'] as const).flatMap(mode => [false, true].map(paused => ({ scope, change, mode, paused }))),
  ),
);
type ShadowSizingCase = typeof shadowSizingCases[number];

export const translateShadowSizingText = (text: string): string => text.startsWith('Shadow sizing source')
  ? '这是用于验证组件作者尺寸修改后，译文能够正确释放布局限制的说明。'.repeat(8) : `译:${text}`;

interface Source {
  host: HTMLElement;
  paragraph: HTMLElement;
  sheet: CSSStyleSheet;
  style: HTMLStyleElement | null;
  css: string;
  children: Node[];
  text: Text;
  value: string;
}
declare global { interface Window { __shadowSizingSource: Source } }

interface Controls {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}

/** Exercise the normal session path. All expected sizes and source identities
 * come from the author's DOM/CSS, independently of layout-policy helpers. */
export async function verifyShadowSizing(page: Page, scenario: ShadowSizingCase, controls: Controls): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(({ scope, change }) => {
    document.body.innerHTML = '<main><sizing-card id="card"><p id="copy" style="margin:0">Shadow sizing source with useful documentation.</p></sizing-card></main>';
    const host = document.getElementById('card')!;
    const paragraph = document.getElementById('copy')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<slot></slot>';
    const selector = scope === 'host' ? ':host' : '::slotted(p)';
    const collapsed = scope === 'host' ? ':host(.compact)' : ':host(.compact) ::slotted(p)';
    const css = `${selector}{display:block;width:240px;height:40px;overflow:hidden}${collapsed}{height:10px}`;
    let style: HTMLStyleElement | null = null;
    let sheet: CSSStyleSheet;
    if (change === 'adopted-cssom') {
      sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet];
    } else {
      style = document.createElement('style'); style.textContent = css; root.prepend(style); sheet = style.sheet!;
    }
    window.__shadowSizingSource = { host, paragraph, sheet, style, css,
      children: [...paragraph.childNodes], text: paragraph.firstChild as Text, value: paragraph.textContent! };
  }, scenario);
  const box = page.locator(scenario.scope === 'host' ? '#card' : '#copy');
  const marker = 'data-dual-read-layout-height';
  const changeSize = (compact: boolean): Promise<void> => page.evaluate(({ change, compact }) => {
    const source = window.__shadowSizingSource;
    if (change === 'class') source.host.classList.toggle('compact', compact);
    else if (change === 'stylesheet') {
      source.style!.textContent = compact ? source.css.replace('height:40px', 'height:10px') : source.css;
      source.sheet = source.style!.sheet!;
    } else (source.sheet.cssRules[0] as CSSStyleRule).style.height = compact ? '10px' : '40px';
  }, { change: scenario.change, compact });
  const assertRestored = async (): Promise<void> => {
    expect(await page.evaluate(() => {
      const source = window.__shadowSizingSource;
      return document.getElementById('card') === source.host && document.getElementById('copy') === source.paragraph
        && source.paragraph.childNodes.length === source.children.length
        && [...source.paragraph.childNodes].every((node, index) => node === source.children[index])
        && source.text.isConnected && source.text.data === source.value;
    })).toBe(true);
    await expect(page.locator('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden,[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toHaveCount(0);
    await expect(box).toHaveCSS('height', '10px');
  };

  await expect(box).toHaveCSS('height', '40px');
  // Verify the author rule independently before translation can mask it.
  await changeSize(true); await expect(box).toHaveCSS('height', '10px');
  await changeSize(false); await expect(box).toHaveCSS('height', '40px');
  await controls.translate(scenario.mode);
  await expect(box).toHaveAttribute(marker, /.+/);
  if (scenario.paused) await controls.pause();
  // Let the CSSOM watcher establish its baseline, then mutate only CSSOM.
  // No DOM event or resize should be needed to release the masked rule.
  if (scenario.change.includes('cssom')) await page.waitForTimeout(1400);
  await changeSize(true);
  await expect(box).toHaveCSS('height', '10px');
  await expect(box).not.toHaveAttribute(marker, /.+/);

  // Returning to the original policy should revive the existing companion.
  await changeSize(false);
  await expect(box).toHaveAttribute(marker, /.+/);
  await changeSize(true);
  await expect(box).toHaveCSS('height', '10px');
  await controls.restore(); await assertRestored();
  await controls.restore(); await assertRestored();

  // A fresh opposite mode must capture the same source and release its rule.
  await changeSize(false);
  await controls.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
  await expect(box).toHaveAttribute(marker, /.+/);
  await changeSize(true);
  await expect(box).toHaveCSS('height', '10px');
  await controls.restore(); await assertRestored();
}
