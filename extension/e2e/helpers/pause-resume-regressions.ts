import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const pauseResumeCases = ['plain', 'rich', 'links', 'replacement', 'delivered'] as const;
type ResumeCase = typeof pauseResumeCases[number];
interface Driver {
  translate(): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  requests(): number;
  delay(ms: number): void;
  sources: string[];
}
interface ResumeSource { host: HTMLElement; text: Text; title: Element | null; link: HTMLAnchorElement | null; fresh: Text | null }
declare global { interface Window { __resumeSource: ResumeSource } }

/** Resume must collect current source before scheduling cancelled entries.
 * Cross plain/rich/link ownership, replacements, and obsolete late responses. */
export async function verifyPauseResume(page: Page, scenario: ResumeCase, mode: TranslationMode, driver: Driver): Promise<void> {
  await page.setViewportSize({width: 1920, height: 1080});
  await page.evaluate(() => { document.body.innerHTML = '<main><p id="stable">Stable translation retained while paused.</p></main>'; });
  await driver.translate();
  await expect(page.locator('#stable')).toHaveAttribute('data-dual-read-done', 'true');
  driver.delay(scenario === 'delivered' ? 0 : 2000);
  const before = driver.requests();
  await page.evaluate(scenario => {
    const host = document.createElement('p'); host.id = 'changing';
    host.innerHTML = (scenario === 'rich' || scenario === 'delivered') ? '<strong>Old pending title</strong> with a pending explanation.'
      : scenario === 'links' ? 'Old pending paragraph with <a href="/old-guide">the separate guide</a> and details.'
        : 'Old pending paragraph with a complete explanation.';
    document.querySelector('main')!.append(host);
    const title = host.querySelector('strong'), link = host.querySelector('a');
    window.__resumeSource = {host, title, link, text: (title ?? host).firstChild as Text, fresh: null};
  }, scenario);
  await expect.poll(driver.requests).toBeGreaterThan(before);
  if (scenario === 'delivered') await expect(page.locator('#changing')).toHaveAttribute('data-dual-read-done', 'true');
  await driver.pause();
  await page.evaluate(scenario => {
    const source = window.__resumeSource;
    const value = (scenario === 'rich' || scenario === 'delivered') ? 'Current edited title' : 'Current edited paragraph with a complete explanation. ';
    if (scenario === 'replacement') {
      source.fresh = document.createTextNode(value); source.text.replaceWith(source.fresh);
    } else source.text.data = value;
    if (source.link) { source.link.firstChild!.nodeValue = 'the current separate guide'; source.link.setAttribute('href', '/current-guide'); }
  }, scenario);
  const requestStart = driver.sources.length;
  driver.delay(0);
  await driver.translate();
  await expect(page.locator('#changing')).toHaveAttribute('data-dual-read-done', 'true');
  await expect(page.locator('#changing')).toContainText((scenario === 'rich' || scenario === 'delivered') ? '译:Current edited title' : '译:Current edited paragraph');
  await expect.poll(async () => {
    const status = await driver.status();
    const frames = status.framePayloads as Record<string, unknown>[] | undefined;
    return {failed: status.failed, translating: frames ? frames.some(frame => frame.translating) : status.translating,
      complete: status.count === status.total && Number(status.total) >= 2};
  }).toEqual({failed: 0, translating: false, complete: true});
  // A cancelled transport can still deliver; it must not overwrite the result.
  await page.waitForTimeout(2200);
  const settledRequests = driver.requests();
  await driver.translate();
  expect(driver.requests()).toBe(settledRequests);
  expect(driver.sources.slice(requestStart).some(source => source.startsWith('Current edited'))).toBe(true);
  expect(driver.sources.slice(requestStart).some(source => source.includes('译:'))).toBe(false);
  await expect(page.locator('#changing')).not.toContainText('译:Old pending');
  await driver.restore();
  expect(await page.evaluate(({scenario, mode}) => {
    const source = window.__resumeSource;
    const current = source.fresh ?? source.text;
    return {host: document.getElementById('changing') === source.host,
      text: current.isConnected && current.data.startsWith('Current edited'),
      removed: scenario !== 'replacement' || !source.text.isConnected,
      title: !source.title || source.host.querySelector('strong') === source.title,
      link: !source.link || source.host.querySelector('a') === source.link && source.link.getAttribute('href') === '/current-guide'
        && source.link.textContent === 'the current separate guide',
      stable: document.getElementById('stable')!.textContent === 'Stable translation retained while paused.',
      mode, residual: document.querySelectorAll('.dual-read-target,.dual-read-replace-text,.dual-read-original-hidden').length};
  }, {scenario, mode})).toEqual({host: true, text: true, removed: true, title: true, link: true, stable: true, mode, residual: 0});
  await driver.restore();
}
