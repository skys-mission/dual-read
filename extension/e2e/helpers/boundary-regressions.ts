import { expect, type Page } from '@playwright/test';

type Change = 'existing shadow' | 'new shadow' | 'detached element' | 'known shadow' | 'connected element'
  | 'empty slot' | 'identical empty slots' | 'ambiguous deletion' | 'ambiguous fragment' | 'equal replacement' | 'edited unknown source'
  | 'discarded single' | 'discarded merged';
interface Scenario { name: string; change: Change; watching: boolean }
export const boundaryRegressions: Scenario[] = [];
for (const watching of [false, true]) for (const change of [
  'existing shadow', 'new shadow', 'detached element', 'known shadow', 'connected element',
  'empty slot', 'identical empty slots', 'ambiguous deletion', 'ambiguous fragment', 'equal replacement', 'edited unknown source',
  'discarded single', 'discarded merged',
] as const) boundaryRegressions.push({ name: `source boundary ${change} with watching ${watching}`, change, watching });

export function translateBoundarySource(text: string, scenario: Scenario): string {
  if (['identical empty slots', 'ambiguous deletion', 'ambiguous fragment'].includes(scenario.change)) {
    if (['First source', 'second source', 'third source'].includes(text)) return '相同译文';
  }
  if (text === 'First source') return '第一译文';
  if (text === 'second source') return '第二译文';
  return `译:${text}`;
}

interface Saved {
  boundaryNodes: { title: Element; originals: Node[]; target: Element | null; prefix: Text | null; fresh: Text | null; uncertain: Element | null; clicks: number };
}
interface Driver {
  translate(mode: 'bilingual' | 'replace'): Promise<unknown>;
  restore(): Promise<unknown>;
  pause(): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  sources: string[];
}

export async function setupBoundaryRegression(page: Page, scenario: Scenario): Promise<void> {
  await page.evaluate(({ change }) => {
    const multiple = ['empty slot', 'identical empty slots', 'ambiguous deletion', 'ambiguous fragment'].includes(change);
    const slots = multiple ? '<!--a-->second source<!--b-->third source'
      : ['edited unknown source', 'discarded merged'].includes(change) ? '<!--a-->second source' : '';
    document.body.innerHTML = `<p id="one" lang="en"><strong>First source${slots}</strong> tail.</p><div id="shadow"></div><div id="holder"></div>`;
    if (change === 'known shadow') document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    const title = document.querySelector('strong')!;
    const g = globalThis as typeof globalThis & Saved;
    g.boundaryNodes = { title, originals: [...title.childNodes], target: null, prefix: null, fresh: null, uncertain: null, clicks: 0 };
    title.addEventListener('click', () => { g.boundaryNodes.clicks++; });
  }, scenario);
}

export async function verifyBoundaryRegression(page: Page, scenario: Scenario, driver: Driver): Promise<void> {
  await driver.translate('replace');
  await expect(page.locator('#one > strong')).toContainText(
    ['identical empty slots', 'ambiguous deletion', 'ambiguous fragment'].includes(scenario.change) ? '相同译文' : '第一译文');
  if (!scenario.watching) await driver.pause();
  await page.evaluate(({ change }) => {
    const saved = (globalThis as typeof globalThis & Saved).boundaryNodes;
    let root: ParentNode = document.querySelector('#holder')!;
    if (change === 'known shadow') root = document.querySelector('#shadow')!.shadowRoot!;
    if (['existing shadow', 'edited unknown source', 'discarded single', 'discarded merged'].includes(change)) root = document.querySelector('#shadow')!.attachShadow({ mode: 'open' });
    if (change === 'new shadow') {
      const host = document.createElement('section'); document.body.append(host);
      root = host.attachShadow({ mode: 'open' });
    }
    const target = document.createElement('p'); target.id = 'target';
    const prefix = document.createTextNode('Fresh source '); target.append(prefix);
    if (change !== 'detached element') root.appendChild(target);
    const copy = document.querySelector('#one > strong')!;
    let moved = copy.firstChild as Text;
    if (change === 'equal replacement') {
      const fresh = document.createTextNode(moved.data); saved.fresh = fresh;
      moved.replaceWith(fresh);
      target.append('Independent source');
    } else {
      if (change === 'identical empty slots') {
        (copy.firstChild as Text).data = '';
        (copy.childNodes[1] as Text).data = '';
      }
      if (change === 'edited unknown source') {
        copy.normalize(); moved = copy.firstChild as Text;
        moved.data = 'Entirely new source'; moved.appendData(' added');
      } else if (change === 'discarded merged') {
        const discarded = copy.lastChild as Text;
        copy.normalize(); discarded.data = ''; moved = copy.firstChild as Text;
      } else if (change === 'ambiguous fragment') {
        copy.normalize(); moved = copy.firstChild as Text;
        const remainder = moved.splitText(4); remainder.deleteData(0, 4);
        const uncertain = document.createElement('p'); uncertain.append('Current text ');
        root.appendChild(uncertain); uncertain.append(remainder); uncertain.normalize();
        saved.uncertain = uncertain;
      } else if (['empty slot', 'identical empty slots', 'ambiguous deletion'].includes(change)) {
        copy.normalize(); moved = copy.firstChild as Text;
        if (change === 'empty slot') moved.deleteData(0, '第一译文'.length);
        if (change === 'ambiguous deletion') moved.deleteData(0, '相同译文'.length);
        moved = moved.splitText(0);
      }
      target.append(moved); target.normalize();
      if (change === 'discarded single' || change === 'edited unknown source') moved.data = '';
    }
    if (change === 'detached element') root.appendChild(target);
    saved.target = target; saved.prefix = prefix;
  }, scenario);
  const count = scenario.change === 'ambiguous fragment' ? 3 : 2;
  if (scenario.watching) {
    await page.waitForTimeout(1100); // include root discovery and the observer debounce
    await expect.poll(driver.status).toMatchObject({ count, total: count, failed: 0 });
  }
  await driver.pause();
  await driver.restore();
  const unknown = ['existing shadow', 'new shadow', 'detached element', 'discarded single', 'discarded merged'].includes(scenario.change);
  const ambiguous = scenario.change === 'ambiguous deletion';
  const ambiguousFragment = scenario.change === 'ambiguous fragment';
  const replacement = scenario.change === 'equal replacement';
  const editedUnknown = scenario.change === 'edited unknown source';
  const expectedOne = scenario.change === 'discarded merged' ? 'First sourcesecond source tail.' : editedUnknown ? 'Entirely new source added tail.' : ambiguousFragment ? 'second sourcethird source tail.' : ambiguous ? 'First sourcesecond sourcethird source tail.'
    : unknown ? 'First source tail.' : replacement ? '第一译文 tail.' : ' tail.';
  const expectedTarget = `Fresh source ${scenario.change === 'discarded merged' ? '第一译文第二译文' : editedUnknown ? 'Entirely new source added' : ambiguous ? '相同译文相同译文' : unknown ? '第一译文'
    : scenario.change === 'empty slot' ? 'second sourcethird source'
    : scenario.change === 'identical empty slots' ? 'third source' : replacement ? 'Independent source' : 'First source'}`;
  const check = async (click: boolean): Promise<void> => {
    const observed = await page.evaluate((click) => {
      const saved = (globalThis as typeof globalThis & Saved).boundaryNodes;
      if (click) saved.title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return {
        one: document.querySelector('#one')!.textContent, target: saved.target!.textContent,
        title: document.querySelector('#one strong') === saved.title,
        parents: saved.originals.filter(node => node instanceof Text).map(node =>
          node.parentNode === saved.target ? 'target' : node.parentNode === saved.title ? 'source' : 'removed'),
        prefix: saved.target!.firstChild === saved.prefix,
        uncertain: saved.uncertain?.textContent ?? null,
        fresh: !saved.fresh || saved.fresh.parentNode === saved.title, clicks: saved.clicks,
        markers: [document, ...[...document.querySelectorAll('*')].flatMap(el => el.shadowRoot ? [el.shadowRoot] : [])]
          .reduce((count, root) => count + root.querySelectorAll('[data-dual-read-done], .dual-read-original-hidden, .dual-read-target, style[data-dual-read-style]').length, 0),
      };
    }, click);
    expect(observed).toMatchObject({ one: expectedOne, target: expectedTarget, title: true,
      prefix: true, fresh: true, clicks: 1, markers: 0, uncertain: ambiguousFragment ? 'Current text 相同译文' : null });
    const retained = scenario.change === 'empty slot' ? [1, 2] : scenario.change === 'identical empty slots' ? [2] : [0];
    for (const [index, parent] of observed.parents.entries()) {
      if (editedUnknown) expect(parent).toBe(index === 0 ? 'source' : 'removed');
      else if (ambiguousFragment) expect(parent).toBe(index === 0 ? 'target' : 'source');
      else if (unknown || ambiguous) expect(parent).toBe('source');
      else if (replacement) expect(parent).toBe('removed');
      else if (retained.includes(index)) expect(parent).toBe('target');
    }
    // Only page-current text with unresolved provenance (or an explicit equal
    // replacement) can legitimately be sent again. Proven transfers use source.
    const literal = ambiguousFragment ? 'Current text 相同译文' : replacement ? '第一译文' : unknown || ambiguous ? expectedTarget.trim() : null;
    expect(driver.sources.filter(text => /第一译文|第二译文|相同译文|译:/.test(text) && text !== literal)).toEqual([]);
  };
  await check(true);
  await driver.translate('bilingual');
  await expect.poll(driver.status).toMatchObject({ count, total: count, failed: 0 });
  await driver.restore();
  await driver.restore();
  await check(false);
}
