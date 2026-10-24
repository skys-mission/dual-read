import { expect, type Page } from '@playwright/test';
import type { TranslationMode } from '../../lib/types';

export const layoutCollapseCases = (['local-variable', 'inherited-variable', 'shadow-class', 'slotted-variable'] as const).flatMap(scope =>
  (['bilingual', 'replace'] as const).flatMap(mode =>
    (['watching', 'paused', 'resumed'] as const).map(state => ({ scope, mode, state }))),
);
type Scenario = typeof layoutCollapseCases[number];
type FrameAction = 'install' | 'hold' | 'release' | 'stats' | 'dispose';
interface FrameStats { checks: number; queued: number }
interface FrameGate {
  holding: boolean;
  checks: number;
  pending: Map<number, FrameRequestCallback>;
  scheduled: Map<number, number>;
  request: typeof requestAnimationFrame;
  cancel: typeof cancelAnimationFrame;
  computed: typeof getComputedStyle;
  schedule(id: number, callback: FrameRequestCallback): void;
}
interface CollapseSource {
  box: HTMLElement;
  source: HTMLElement;
  original: Node;
  text: string;
  authored: string | null;
}
declare global { interface Window { __collapseFrames?: FrameGate; __collapseSource: CollapseSource } }

/** Serializable hook in the content script's world. Delay layout frames, while
 * letting the real mutation timer run. Also catch frames queued before hold(). */
export function controlCollapseFrames(action: FrameAction): FrameStats {
  if (action === 'install' && !window.__collapseFrames) {
    const gate: FrameGate = {
      holding: false, checks: 0, pending: new Map(), scheduled: new Map(),
      request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame, computed: window.getComputedStyle,
      schedule(id, callback) {
        gate.scheduled.set(id, gate.request.call(window, time => {
          gate.scheduled.delete(id);
          if (gate.holding) gate.pending.set(id, callback);
          else callback(time);
        }));
      },
    };
    window.__collapseFrames = gate;
    let sequence = -1;
    window.requestAnimationFrame = callback => {
      const id = sequence--;
      if (gate.holding) gate.pending.set(id, callback);
      else gate.schedule(id, callback);
      return id;
    };
    window.cancelAnimationFrame = id => {
      gate.pending.delete(id);
      gate.cancel.call(window, gate.scheduled.get(id) ?? id);
      gate.scheduled.delete(id);
    };
    window.getComputedStyle = (element, pseudo) => {
      if (gate.holding && element.id === 'collapse-box' && document.documentElement.dataset.collapseTest === 'closed') gate.checks++;
      return gate.computed.call(window, element, pseudo);
    };
  }
  const gate = window.__collapseFrames!;
  if (action === 'hold') { gate.holding = true; gate.checks = 0; }
  if (action === 'release' || action === 'dispose') {
    gate.holding = false;
    for (const [id, callback] of gate.pending) gate.schedule(id, callback);
    gate.pending.clear();
  }
  if (action === 'dispose') {
    window.requestAnimationFrame = gate.request;
    window.cancelAnimationFrame = gate.cancel;
    window.getComputedStyle = gate.computed;
    delete window.__collapseFrames;
  }
  return { checks: gate.checks, queued: gate.pending.size };
}

export function translateCollapseSource(): string {
  return '用于检查容器布局和动态页面更新的翻译文本。'.repeat(12);
}

export async function verifyLayoutCollapse(page: Page, scenario: Scenario, driver: {
  translate(mode: TranslationMode): Promise<unknown>;
  pause(): Promise<unknown>;
  restore(): Promise<unknown>;
  frames(action: FrameAction): Promise<FrameStats>;
  requests(): number;
}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(scope => {
    document.body.innerHTML = '<main lang="en"></main>';
    document.documentElement.style.setProperty('--collapse-height', '80px');
    const box = document.createElement(scope === 'slotted-variable' ? 'collapse-widget' : 'section');
    box.id = 'collapse-box';
    box.style.cssText = 'display:block;width:260px;overflow:hidden;font:16px/20px sans-serif';
    if (scope === 'shadow-class') {
      const widget = document.createElement('collapse-widget');
      document.querySelector('main')!.append(widget);
      const root = widget.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = '#collapse-box{height:80px}#collapse-box.closed{height:0px}';
      root.append(style, box);
    } else {
      box.style.height = 'var(--collapse-height)';
      if (scope === 'local-variable') box.style.setProperty('--collapse-height', '80px');
      if (scope === 'slotted-variable') box.attachShadow({ mode: 'open' }).innerHTML = '<slot name="copy"></slot>';
      document.querySelector('main')!.append(box);
    }
    const source = document.createElement('p'); source.id = 'collapse-source'; source.style.margin = '0'; source.slot = 'copy';
    source.textContent = 'Expansion variable-controlled documentation.';
    box.append(source);
    window.__collapseSource = { box, source, original: source.firstChild!, text: source.textContent, authored: box.getAttribute('style') };
  }, scenario.scope);
  await driver.frames('install');
  const box = page.locator('#collapse-box'), target = page.locator('#collapse-source .dual-read-target');
  const setClosed = (closed: boolean) => page.evaluate(({ scope, closed }) => {
    const { box } = window.__collapseSource;
    document.documentElement.dataset.collapseTest = closed ? 'closed' : 'open';
    if (scope === 'shadow-class') box.classList.toggle('closed', closed);
    else (scope === 'local-variable' ? box : document.documentElement).style.setProperty('--collapse-height', closed ? '0px' : '80px');
  }, { scope: scenario.scope, closed });
  try {
    await driver.translate(scenario.mode);
    await expect(box).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await expect(target).toHaveCount(1);
    const owner = await target.elementHandle(), requests = driver.requests();
    if (scenario.state !== 'watching') await driver.pause();
    await driver.frames('hold');
    await setClosed(true);
    if (scenario.state === 'resumed') await driver.translate(scenario.mode);
    if (scenario.state !== 'paused') {
      // Positive proof that source inspection happened while layout frames were
      // held. No fixed sleep or relaxed timeout can mask the original race.
      await expect.poll(async () => (await driver.frames('stats')).checks).toBeGreaterThan(0);
      await expect(target).toHaveCount(0);
    } else {
      await expect.poll(async () => (await driver.frames('stats')).queued).toBeGreaterThan(0);
      await expect(target).toHaveCount(1);
    }
    await driver.frames('release');
    await expect(box).toHaveCSS('height', '0px');
    await expect(target).toHaveCount(scenario.state === 'paused' ? 1 : 0);
    await setClosed(false);
    await expect(box).toHaveAttribute('data-dual-read-layout-height', /.+/);
    await expect(target).toHaveCount(1);
    if (scenario.state === 'paused') {
      expect(await owner!.evaluate(node => node.isConnected)).toBe(true);
      expect(driver.requests()).toBe(requests);
    }
    const assertRestored = async () => {
      expect(await page.evaluate(() => {
        const s = window.__collapseSource;
        return { text: s.source.textContent, original: s.source.childNodes.length === 1 && s.source.firstChild === s.original,
          parent: s.source.parentNode === s.box, authored: s.box.getAttribute('style') === s.authored };
      })).toEqual({ text: 'Expansion variable-controlled documentation.', original: true, parent: true, authored: true });
      await expect(box).toHaveCSS('height', '80px');
      await expect(target).toHaveCount(0);
    };
    await driver.restore(); await driver.restore(); await assertRestored();
    await driver.translate(scenario.mode === 'bilingual' ? 'replace' : 'bilingual');
    await expect(target).toHaveCount(1);
    await driver.restore(); await assertRestored();
  } finally {
    await driver.frames('release');
    await driver.restore();
    await driver.frames('dispose');
  }
}
