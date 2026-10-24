import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

/** Serializable hook, installed in the content script's execution world. */
export function armIndexYieldMutation(): void {
  const global = globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } };
  const scheduler = global.scheduler ?? (global.scheduler = {});
  const previous = scheduler.yield;
  scheduler.yield = async () => {
    scheduler.yield = previous;
    const node = document.getElementById('yield-source')!.firstChild!;
    const text = node instanceof Text ? node : node.firstChild!;
    text.nodeValue = 'Updated source after page hydration.';
    if (previous) await previous.call(scheduler);
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
  };
}

declare global { interface Window { __indexYieldText: Node } }
export async function verifyIndexYield(page: Page, structure: 'plain' | 'rich', mode: TranslationMode, driver: {
  arm(): Promise<unknown>; translate(mode: TranslationMode): Promise<unknown>; restore(): Promise<unknown>;
}): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(structure => {
    // Keep a real, large collector walk without asking the Gecko harness's
    // forced IO to paint 2,000 offscreen translations before this assertion.
    document.body.innerHTML = `<main><p id="yield-source">${structure === 'rich' ? '<strong>Original source before page hydration.</strong>' : 'Original source before page hydration.'}</p>${Array.from({ length: 2000 }, (_, i) => `<p>无需翻译的静态段落，编号 ${i}。</p>`).join('')}</main>`;
    const host = document.getElementById('yield-source')!;
    window.__indexYieldText = structure === 'rich' ? host.firstChild!.firstChild! : host.firstChild!;
  }, structure);
  await driver.arm();
  expect(await driver.translate(mode)).toMatchObject({ success: true });
  // Both plain companions and rich replacement skeletons expose this string.
  await expect(page.locator('#yield-source')).toContainText('译:Updated source after page hydration.');
  await expect(page.locator('#yield-source')).not.toContainText('译:Original source');
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const host = document.getElementById('yield-source')!;
    return { text: host.textContent, same: host.contains(window.__indexYieldText), targets: document.querySelectorAll('.dual-read-target').length };
  })).toEqual({ text: 'Updated source after page hydration.', same: true, targets: 0 });
}
