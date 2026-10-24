import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const relocatedLifecycleCases = (['watching', 'paused'] as const).flatMap(state =>
  (['remove', 'replace', 'transfer', 'container'] as const).map(operation => ({ state, operation })));
export const relocatedTypographyCases = ['direct', 'nested', 'rich', 'shadow'] as const;
export const relocatedFollowCases = (['watching', 'paused'] as const).flatMap(state =>
  (['move', 'reorder', 'cssom-hide', 'media-hide', 'shadow-move', 'unclamp', 'card-reuse'] as const).map(operation => ({ state, operation })));
interface Controls {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  requests(): number;
}
interface RelocatedSource {
  root: Document | ShadowRoot;
  sheet: CSSStyleSheet;
  host: HTMLElement;
  nodes: Node[];
  text: Node;
  clip: HTMLElement;
  retained: HTMLElement;
  retainedText: Node | null;
  code: HTMLElement;
  replacement?: HTMLElement;
  observer?: MutationObserver;
  writes: number;
  target?: HTMLElement;
}
declare global { interface Window { __relocatedSource: RelocatedSource } }

async function setup(page: Page, structure: typeof relocatedTypographyCases[number] | 'lifecycle'): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(structure => {
    document.body.innerHTML = '<relocated-widget></relocated-widget>';
    const root = structure === 'shadow' ? document.querySelector('relocated-widget')!.attachShadow({ mode: 'open' }) : document;
    const body = root instanceof Document ? root.body : root;
    const text = 'Original article excerpt with useful details.';
    const content = structure === 'nested' ? `<span>${text}</span>`
      : structure === 'rich' ? '<strong>Original article</strong> excerpt with useful details.' : text;
    body.innerHTML = `<main id="relocated-card"><div id="relocated-clip"><p id="relocated-copy">${content}</p><p id="relocated-retained">Retained article excerpt with other details.</p></div><div id="relocated-sink"></div><pre><code>const unchanged = true;</code></pre></main>`;
    const style = document.createElement('style');
    style.textContent = '#relocated-card{background:black;color:black;padding:24px;width:450px;font:16px/24px Arial}#relocated-clip{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}#relocated-copy,#relocated-retained{color:white;font:20px/30px Georgia;margin:0}#relocated-card pre{color:orange}';
    (root instanceof Document ? root.head : root).append(style);
    let sheet = style.sheet!;
    if (structure === 'shadow') { sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent); root.adoptedStyleSheets = [sheet]; style.remove(); }
    const host = root.querySelector<HTMLElement>('#relocated-copy')!;
    const retained = root.querySelector<HTMLElement>('#relocated-retained')!;
    window.__relocatedSource = { root, sheet, host, nodes: [...host.childNodes], text: host.firstChild!,
      clip: root.querySelector<HTMLElement>('#relocated-clip')!, retained, retainedText: retained.firstChild,
      code: root.querySelector<HTMLElement>('code')!, writes: 0 };
  }, structure);
}

export async function verifyRelocatedLifecycle(page: Page, scenario: typeof relocatedLifecycleCases[number], driver: Controls): Promise<void> {
  await setup(page, 'lifecycle');
  await driver.translate('bilingual');
  const outside = page.locator('#relocated-card > .dual-read-target');
  await expect(outside).toHaveCount(2);
  if (scenario.state === 'paused') await driver.pause();
  await page.evaluate(operation => {
    const source = window.__relocatedSource;
    if (operation === 'container') source.clip.remove();
    else if (operation === 'replace') {
      const next = document.createElement('p'); next.id = 'relocated-new';
      next.textContent = 'Updated article excerpt with new details.';
      source.host.replaceWith(next); source.replacement = next;
    } else {
      source.host.remove();
      if (operation === 'transfer') {
        const next = document.createElement('p'); next.id = 'relocated-new'; next.append(source.text);
        source.root.querySelector('#relocated-sink')!.append(next); source.replacement = next;
      }
    }
  }, scenario.operation);
  if (scenario.state === 'paused') await driver.translate('bilingual');
  const expected = scenario.operation === 'container' ? 0 : scenario.operation === 'remove' ? 1 : 2;
  // Replacements retain the same count before the mutation batch is processed.
  await expect.poll(async () => (await outside.allTextContents()).join(' ')).not.toContain('Original article');
  await expect(page.locator('.dual-read-target')).toHaveCount(expected);
  await expect.poll(async () => { const s = await driver.status(); return { count: s.count, total: s.total }; }).toEqual({ count: expected, total: expected });
  if (scenario.operation === 'remove') {
    await page.evaluate(() => window.__relocatedSource.clip.prepend(window.__relocatedSource.host));
    await expect(outside).toHaveCount(2);
  }
  await driver.restore(); await driver.restore();
  const proof = () => page.evaluate(operation => {
    const s = window.__relocatedSource;
    return { removed: !s.host.isConnected, text: s.text.nodeValue,
      owner: s.text.parentNode === (operation === 'transfer' ? s.replacement : s.host),
      retained: s.retained.firstChild === s.retainedText,
      code: s.code.isConnected && s.code.textContent === 'const unchanged = true;',
      replacement: !s.replacement || s.replacement.isConnected,
      residual: s.root.querySelectorAll('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text').length };
  }, scenario.operation);
  const expectedProof = { removed: scenario.operation !== 'remove', text: 'Original article excerpt with useful details.', owner: true, retained: true, code: true, replacement: true, residual: 0 };
  expect(await proof()).toEqual(expectedProof);
  await driver.translate('replace'); await driver.restore();
  expect(await proof()).toEqual(expectedProof);
}

export async function verifyRelocatedTypography(page: Page, structure: typeof relocatedTypographyCases[number], driver: Controls): Promise<void> {
  await setup(page, structure);
  await driver.translate('bilingual');
  const target = page.locator('#relocated-card > .dual-read-target').first();
  await expect(page.locator('#relocated-card > .dual-read-target')).toHaveCount(2);
  await expect(target).toContainText('Original article');
  await expect(target).toHaveCSS('color', 'color(srgb 1 1 1 / 0.84)');
  await expect(target).toHaveCSS('font-size', '20px');
  if (structure === 'rich') await expect(target.locator('strong')).toHaveCount(1);
  const requests = driver.requests();
  await target.evaluate(element => {
    const s = window.__relocatedSource;
    s.observer = new MutationObserver(records => { s.writes += records.length; });
    s.observer.observe(element, { attributes: true, attributeFilter: ['style'] });
  });
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => window.__relocatedSource.writes)).toBe(0);
  // CSSOM declaration writes do not produce DOM mutations or replace source nodes.
  await page.evaluate(() => {
    const rule = window.__relocatedSource.sheet.cssRules[2] as CSSStyleRule;
    rule.style.color = 'lime'; rule.style.fontSize = '28px'; rule.style.lineHeight = '42px';
    rule.style.fontFamily = 'monospace'; rule.style.textAlign = 'right';
  });
  await expect(target).toHaveCSS('font-size', '28px');
  await expect(target).toHaveCSS('line-height', '42px');
  await expect(target).toHaveCSS('color', 'color(srgb 0 1 0 / 0.84)');
  await expect(target).toHaveCSS('font-family', 'monospace');
  await expect(target).toHaveCSS('text-align', 'right');
  await driver.pause();
  await target.evaluate(element => (element as HTMLElement).style.setProperty('color', 'orange', 'important'));
  await page.evaluate(() => {
    const s = window.__relocatedSource;
    s.host.style.color = 'red'; s.host.style.fontSize = '32px';
    s.host.style.whiteSpace = 'pre';
  });
  await expect(target).toHaveCSS('font-size', '32px');
  await expect(target).toHaveCSS('color', 'rgb(255, 165, 0)');
  await expect(target).toHaveCSS('white-space', 'pre-wrap');
  expect(driver.requests()).toBe(requests);
  await page.evaluate(() => window.__relocatedSource.observer?.disconnect());
  await driver.restore(); await driver.restore();
  const proof = () => page.evaluate(() => {
    const s = window.__relocatedSource;
    return { nodes: s.host.childNodes.length === s.nodes.length && s.nodes.every((node, i) => s.host.childNodes[i] === node),
      text: s.host.textContent, color: getComputedStyle(s.host).color, size: getComputedStyle(s.host).fontSize,
      code: s.code.isConnected && s.code.textContent === 'const unchanged = true;',
      residual: s.root.querySelectorAll('.dual-read-target,.dual-read-original-hidden,.dual-read-replace-text').length };
  });
  const expected = { nodes: true, text: 'Original article excerpt with useful details.', color: 'rgb(255, 0, 0)', size: '32px', code: true, residual: 0 };
  expect(await proof()).toEqual(expected);
  await driver.translate('replace'); await driver.restore();
  expect(await proof()).toEqual(expected);
}

export async function verifyRelocatedFollow(page: Page, scenario: typeof relocatedFollowCases[number], driver: Controls): Promise<void> {
  await setup(page, 'lifecycle');
  await page.evaluate(() => {
    const s = window.__relocatedSource;
    s.sheet.insertRule('@media(max-width:1400px){#relocated-copy{display:none}}', s.sheet.cssRules.length);
  });
  await driver.translate('bilingual');
  await expect(page.locator('#relocated-card > .dual-read-target')).toHaveCount(2);
  await page.evaluate(() => { window.__relocatedSource.target = document.querySelector<HTMLElement>('#relocated-card > .dual-read-target')!; });
  if (scenario.state === 'paused') await driver.pause();
  const requests = driver.requests();
  await page.evaluate(operation => {
    const s = window.__relocatedSource;
    if (operation === 'reorder') s.clip.prepend(s.retained);
    else if (operation === 'card-reuse') s.clip.parentElement!.remove();
    else if (operation === 'cssom-hide') s.sheet.insertRule('#relocated-copy{display:none}', s.sheet.cssRules.length);
    else if (operation === 'unclamp') (s.sheet.cssRules[1] as CSSStyleRule).style.removeProperty('-webkit-line-clamp');
    else if (operation === 'move' || operation === 'shadow-move') {
      const sink = s.root.querySelector('#relocated-sink')!;
      const root = operation === 'shadow-move' ? sink.attachShadow({ mode: 'open' }) : sink;
      const card = document.createElement('section'), clip = document.createElement('div');
      clip.id = 'destination-clip'; clip.style.cssText = 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden';
      card.append(clip); root.append(card); clip.append(s.host);
    }
  }, scenario.operation);
  if (scenario.operation === 'card-reuse') {
    await page.waitForTimeout(100);
    await page.evaluate(() => { const s = window.__relocatedSource; document.body.append(s.clip.parentElement!); s.host.style.fontSize = '28px'; });
  }
  if (scenario.operation === 'media-hide') await page.setViewportSize({ width: 1280, height: 720 });
  const placement = () => page.evaluate(() => {
    const s = window.__relocatedSource, target = s.target!;
    return { parent: target.parentElement === s.host, previous: target.previousElementSibling?.id,
      visible: getComputedStyle(target).display !== 'none' && target.getBoundingClientRect().height > 0,
      same: target.textContent?.includes('Original article'), count: s.root.querySelectorAll('#relocated-card > .dual-read-target').length };
  });
  if (scenario.operation.endsWith('hide')) await expect.poll(async () => (await placement()).visible).toBe(false);
  else if (scenario.operation === 'unclamp') await expect.poll(async () => (await placement()).parent).toBe(true);
  else if (scenario.operation === 'reorder') await expect.poll(() => page.locator('#relocated-card > .dual-read-target').first().textContent()).toContain('Retained article');
  else if (scenario.operation === 'card-reuse') await expect(page.locator('#relocated-card > .dual-read-target').first()).toHaveCSS('font-size', '28px');
  else {
    await expect.poll(async () => (await placement()).previous).toBe('destination-clip');
    expect((await placement()).count).toBe(1);
  }
  // Reverse the page operation, retaining the same source and translation nodes.
  await page.evaluate(operation => {
    const s = window.__relocatedSource;
    if (operation === 'card-reuse') s.host.style.removeProperty('font-size');
    if (operation === 'cssom-hide') s.sheet.deleteRule(s.sheet.cssRules.length - 1);
    else if (operation === 'unclamp') (s.sheet.cssRules[1] as CSSStyleRule).style.setProperty('-webkit-line-clamp', '4');
    else if (operation !== 'media-hide') s.clip.prepend(s.host);
  }, scenario.operation);
  if (scenario.operation === 'media-hide') await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(placement).toMatchObject({ parent: false, previous: 'relocated-clip', visible: true, same: true, count: 2 });
  expect(driver.requests()).toBe(requests);
  await driver.restore(); await driver.restore();
  const proof = () => page.evaluate(() => {
    const s = window.__relocatedSource;
    return { original: s.host.firstChild === s.text && s.host.textContent === 'Original article excerpt with useful details.',
      order: [...s.clip.children].map(node => node.id), retained: s.retained.firstChild === s.retainedText,
      code: s.code.textContent, remaining: document.querySelectorAll('.dual-read-target').length };
  });
  const expected = { original: true, order: ['relocated-copy', 'relocated-retained'], retained: true, code: 'const unchanged = true;', remaining: 0 };
  expect(await proof()).toEqual(expected);
  await driver.translate('replace'); await driver.restore();
  expect(await proof()).toEqual(expected);
}

export async function verifyRelocatedLateReuse(page: Page, delivery: 'delivered' | 'undelivered', driver: Controls): Promise<void> {
  await setup(page, 'lifecycle');
  await driver.translate('bilingual');
  await expect(page.locator('#relocated-card > .dual-read-target')).toHaveCount(2);
  await driver.pause();
  await page.evaluate(() => window.__relocatedSource.host.remove());
  if (delivery === 'delivered') await page.waitForTimeout(100);
  await driver.restore(); await driver.restore();
  expect(await page.evaluate(() => {
    const s = window.__relocatedSource;
    return { done: s.host.hasAttribute('data-dual-read-done'), mode: s.host.hasAttribute('data-dual-read-mode'), same: s.host.firstChild === s.text };
  })).toEqual({ done: false, mode: false, same: true });
  // The source must return AFTER the public translate entry point's cleanup.
  await driver.translate('bilingual');
  await expect(page.locator('.dual-read-target')).toHaveCount(1);
  await page.evaluate(() => { const s = window.__relocatedSource; s.clip.prepend(s.host); });
  await expect(page.locator('.dual-read-target')).toHaveCount(2);
  await expect(page.locator('#relocated-card > .dual-read-target').first()).toContainText('Original article');
  await expect.poll(async () => { const s = await driver.status(); return { count: s.count, total: s.total }; }).toEqual({ count: 2, total: 2 });
  await driver.restore();
  expect(await page.evaluate(() => { const s = window.__relocatedSource; return s.host.firstChild === s.text && s.host.textContent === 'Original article excerpt with useful details.'; })).toBe(true);
}
