import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const ellipsisCases = (['height', 'max-height', 'block-size'] as const).flatMap(sizing =>
  (['short', 'long'] as const).flatMap(length => [false, true].map(paused => ({ sizing, length, paused }))),
);

interface Driver {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
}

interface EllipsisSource {
  host: HTMLAnchorElement;
  parent: Node | null;
  children: Node[];
  text: Text;
  textParent: Node | null;
  value: string;
  style: string | null;
}

declare global {
  interface Window {
    __ellipsisSources: EllipsisSource[];
    __ellipsisClicks: number;
  }
}

export function translateEllipsisText(source: string): string {
  const translation = source.includes('detailed') ? '请阅读详细文档以了解操作步骤和更多信息。'.repeat(5) : '了解更多';
  return translation + (source.endsWith(' Updated.') ? '（已更新）' : '');
}

/** Verify translated layout against the actual clipping box, independently of the
 * collector's kind or any layout markers. Original nodes and page edits must
 * survive resizing, a mode switch and repeated restoration. */
export async function verifyEllipsis(page: Page, scenario: typeof ellipsisCases[number], driver: Driver): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const source = scenario.length === 'short' ? 'Read more'
    : 'Read the detailed documentation for instructions and additional information about this feature.';
  await page.evaluate(({ sizing, source }) => {
    document.body.innerHTML = `<style>
      body { margin:8px; --label-width:260px }
      .ellipsis { display:block; width:var(--label-width); font:16px/20px sans-serif;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:12px }
      .ellipsis:not(#inline) { ${sizing}:20px }
      #clipped { overflow:clip }
      #scaled { transform:scale(.75); transform-origin:top left }
    </style><main>
      <a id="inline" class="ellipsis" href="/guide" style="${sizing}:20px">${source}</a>
      <a id="nested" class="ellipsis" href="/guide"><span>${source}</span></a>
      <a id="clipped" class="ellipsis" href="/guide">${source}</a>
      <a id="scaled" class="ellipsis" href="/guide">${source}</a>
    </main>`;
    window.__ellipsisClicks = 0;
    window.__ellipsisSources = [...document.querySelectorAll<HTMLAnchorElement>('.ellipsis')].map(host => {
      const text = (host.querySelector('span')?.firstChild ?? host.firstChild) as Text;
      host.addEventListener('click', event => { event.preventDefault(); window.__ellipsisClicks++; });
      return { host, parent: host.parentNode, children: [...host.childNodes], text,
        textParent: text.parentNode, value: text.data, style: host.getAttribute('style') };
    });
  }, { sizing: scenario.sizing, source });

  const expectVisible = async (updated = false) => {
    await expect(page.locator('.ellipsis > .dual-read-target')).toHaveCount(4);
    for (const id of ['inline', 'nested', 'clipped', 'scaled']) {
      await expect(page.locator(`#${id} > .dual-read-target`)).toHaveText(translateEllipsisText(source + (updated ? ' Updated.' : '')));
    }
    await expect.poll(() => page.evaluate(() => window.__ellipsisSources.flatMap(({ host }) => {
      const target = host.querySelector(':scope > .dual-read-target');
      if (!target) return [{ id: host.id, box: null, target: null, lines: [] }];
      const range = document.createRange();
      range.selectNodeContents(target);
      const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const box = host.getBoundingClientRect();
      const layout = target.getBoundingClientRect();
      // Gecko's fallback glyph bounds can exceed the authored line-height.
      // Check vertical line-box layout and horizontal text wrapping separately.
      const visible = layout.top >= box.top - 1 && layout.bottom <= box.bottom + 1
        && lines.length > 0 && lines.every(line => line.left >= box.left - 1 && line.right <= box.right + 1);
      return visible ? [] : [{ id: host.id, box: box.toJSON(), target: layout.toJSON(), lines: lines.map(line => line.toJSON()) }];
    }))).toEqual([]);
    expect(await page.evaluate(() => window.__ellipsisSources.every(({ host, style }) => {
      const computed = getComputedStyle(host);
      return host.getAttribute('style') === style && computed.whiteSpace === 'nowrap'
        && computed.textOverflow === 'ellipsis' && /^(hidden|clip)$/.test(computed.overflowY);
    }))).toBe(true);
  };

  try {
    await driver.translate('bilingual');
    await expectVisible();
    // The translation remains in the original link's interactive area.
    await page.locator('#inline > .dual-read-target').click();
    expect(await page.evaluate(() => window.__ellipsisClicks)).toBe(1);
    expect(await page.evaluate(() => window.__ellipsisSources.every(({ host, parent, children, text, textParent, value }) =>
      host.parentNode === parent && children.every((child, index) => host.childNodes[index] === child)
      && text.parentNode === textParent && text.data === value,
    ))).toBe(true);

    if (scenario.paused) await driver.pause();
    const height = () => page.locator('#inline').evaluate(node => node.getBoundingClientRect().height);
    const initialHeight = await height();
    await page.evaluate(() => document.body.style.setProperty('--label-width', '130px'));
    await expectVisible();
    if (scenario.length === 'long') await expect.poll(height).toBeGreaterThan(initialHeight + 20);
    await page.evaluate(() => document.body.style.setProperty('--label-width', '520px'));
    await expectVisible();
    if (scenario.length === 'long') await expect.poll(height).toBeLessThan(initialHeight - 20);

    // A page-authored collapse must still win while the translation is kept.
    await page.evaluate(sizing => window.__ellipsisSources.forEach(({ host }) => host.style.setProperty(sizing, '0px')), scenario.sizing);
    await expect.poll(height).toBe(0);
    await page.evaluate(() => window.__ellipsisSources.forEach(({ host, style }) => {
      if (style === null) host.removeAttribute('style');
      else host.setAttribute('style', style);
    }));
    await expectVisible();

    await page.evaluate(() => window.__ellipsisSources.forEach(saved => {
      saved.text.appendData(' Updated.');
      saved.value += ' Updated.';
      saved.host.setAttribute('href', '/updated');
    }));
    if (!scenario.paused) await expectVisible(true);
    // Switching mode restores the current source before translating again,
    // including source edits made while mutation watching was paused.
    await driver.translate('replace');
    await expectVisible(true);
    await driver.restore();
    await driver.restore();
    expect(await page.evaluate(() => window.__ellipsisSources.every(({ host, parent, children, text, textParent, value, style }) =>
      host.parentNode === parent && host.childNodes.length === children.length
      && children.every((child, index) => host.childNodes[index] === child)
      && text.parentNode === textParent && text.data === value && host.textContent === value
      && host.getAttribute('style') === style && host.getAttribute('href') === '/updated',
    ))).toBe(true);
    expect(await height()).toBe(20);
    await expect(page.locator('.dual-read-target,[data-dual-read-layout-height],style[data-dual-read-layout-style]')).toHaveCount(0);
  } finally {
    await driver.restore();
  }
}
