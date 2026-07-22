// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, renderError, fillTextSlots, restoreDom, restoreUnit, repairStructure, buildSafeRichSkeleton, sanitizeHref, reserveBlockShell, stabilizeBlockShell } from '../lib/renderer';
import { collectSlotTextNodes, collectUnits, extractRichSlots } from '../lib/collector';
import type { TranslationUnit } from '../lib/types';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('fillTextSlots', () => {
  it('fills slots in document order and preserves code text', () => {
    document.body.innerHTML =
      '<p>See <a href="#a">docs</a> for <code>API</code> usage.</p>';
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    expect(slots).toEqual(['See', 'docs', 'for', 'usage.']);

    fillTextSlots(p, ['见', '文档', '了解', '用法。']);
    expect(p.querySelector('a')!.textContent).toBe('文档');
    expect(p.querySelector('code')!.textContent).toBe('API');
    expect(p.textContent).toContain('见');
    expect(p.textContent).toContain('用法。');
  });
});

describe('buildSafeRichSkeleton', () => {
  it('keeps links/code/emphasis and drops id, handlers, ARIA, class', () => {
    document.body.innerHTML = `
      <p id="para" class="prose" onclick="alert(1)" aria-labelledby="x">
        Read the <a id="lnk" href="/docs" onclick="hack()" aria-label="docs" class="x"
          name="n">docs</a> and <strong id="s">note</strong>
        <code id="c" data-x="1">API</code>.
      </p>`;
    const p = document.querySelector('p')!;
    const skel = buildSafeRichSkeleton(p);

    expect(skel.querySelectorAll('[id]')).toHaveLength(0);
    expect(skel.querySelectorAll('[onclick]')).toHaveLength(0);
    expect(skel.querySelectorAll('[aria-label], [aria-labelledby]')).toHaveLength(0);
    expect(skel.querySelectorAll('[name]')).toHaveLength(0);
    expect(skel.querySelectorAll('[class]')).toHaveLength(0);
    expect(skel.querySelectorAll('[data-x]')).toHaveLength(0);

    const a = skel.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/docs');
    expect(skel.querySelector('code')!.textContent).toBe('API');
    expect(skel.querySelector('strong')!.textContent).toBe('note');

    // Slot parity with the live host (identity attrs must not change walks).
    expect(collectSlotTextNodes(skel).map((n) => (n.nodeValue ?? '').trim()).filter(Boolean))
      .toEqual(extractRichSlots(p));
  });

  it('strips javascript: hrefs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeHref('/safe')).toBe('/safe');
    expect(sanitizeHref('https://example.com/a')).toBe('https://example.com/a');

    document.body.innerHTML = `<p><a href="javascript:alert(1)">x</a> <a href="#ok">y</a></p>`;
    const skel = buildSafeRichSkeleton(document.querySelector('p')!);
    expect(skel.querySelector('a[href="javascript:alert(1)"]')).toBeNull();
    expect(skel.querySelector('a[href="#ok"]')).toBeTruthy();
  });

  it('drops forbidden media / script nodes but keeps surrounding text', () => {
    document.body.innerHTML = `<p>Before <img src="x.png" alt="x"> after <script>1</script> end</p>`;
    const skel = buildSafeRichSkeleton(document.querySelector('p')!);
    expect(skel.querySelector('img')).toBeNull();
    expect(skel.querySelector('script')).toBeNull();
    expect(skel.textContent).toMatch(/Before/);
    expect(skel.textContent).toMatch(/after/);
    expect(skel.textContent).toMatch(/end/);
  });
});

describe('render rich bilingual', () => {
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 40,
        width: 400, height: 40, toJSON() {},
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });

  it('mounts a structured companion with working links and code', () => {
    document.body.innerHTML = `
      <main>
        <p>The <a href="/global">global attributes</a> of
        <code>Foo</code> include <a href="/html">HTML</a> elements.</p>
      </main>`;
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    const unit: TranslationUnit = {
      el: p,
      text: slots.join(' '),
      kind: 'block',
      rich: { slots },
    };

    const translated = slots.map((s) => {
      if (s === 'The') return '这些';
      if (s === 'global attributes') return '全局属性';
      if (s === 'of') return '的';
      if (s === 'include') return '包括';
      if (s === 'HTML') return 'HTML';
      if (s === 'elements.') return '元素。';
      return s;
    });

    render(unit, translated, 'bilingual');

    // Immersive-style: companion is nested inside the host (not afterend sibling).
    const companion = p.querySelector(':scope > .dual-read-target') as HTMLElement;
    expect(companion).toBeTruthy();
    expect(companion?.classList.contains('dual-read-target')).toBe(true);
    expect(p.nextElementSibling?.classList.contains('dual-read-target')).toBeFalsy();
    const links = companion.querySelectorAll('a[href]');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/global');
    expect(links[0].textContent).toBe('全局属性');
    expect(companion.querySelector('code')!.textContent).toBe('Foo');
    // Original paragraph text nodes still present (first link unchanged).
    expect(p.querySelector('a')!.textContent).toBe('global attributes');
    expect(p.getAttribute('data-dual-read-done')).toBe('true');
  });

  it('does not copy identity or event attributes into the companion', () => {
    document.body.innerHTML = `
      <p id="host">Go to <a id="a1" href="/x" onclick="return false" aria-describedby="h">site</a>.</p>`;
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    render(
      { el: p, text: slots.join(' '), kind: 'block', rich: { slots } },
      slots.map((s) => (s === 'site' ? '站点' : s === 'Go to' ? '前往' : s)),
      'bilingual',
    );
    const companion = p.querySelector(':scope > .dual-read-target')!;
    expect(companion.querySelectorAll('[id]')).toHaveLength(0);
    expect(companion.querySelectorAll('[onclick]')).toHaveLength(0);
    expect(companion.querySelectorAll('[aria-describedby]')).toHaveLength(0);
    expect(companion.querySelector('a')!.getAttribute('href')).toBe('/x');
  });

  it('restoreDom is idempotent for rich bilingual and replace', () => {
    document.body.innerHTML = `
      <p>See <a href="/a">docs</a> and <code>X</code> now.</p>`;
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);

    render(
      { el: p, text: slots.join(' '), kind: 'block', rich: { slots } },
      slots.map((s) => `译:${s}`),
      'bilingual',
    );
    expect(p.querySelector('.dual-read-target')).toBeTruthy();

    restoreDom();
    expect(p.querySelector('.dual-read-target')).toBeNull();
    expect(p.hasAttribute('data-dual-read-done')).toBe(false);
    const afterFirst = p.innerHTML;

    restoreDom();
    restoreUnit(p);
    expect(p.innerHTML).toBe(afterFirst);
    expect(p.textContent).toContain('docs');
    expect(p.querySelector('code')!.textContent).toBe('X');

    // Replace mode + double restore
    const slots2 = extractRichSlots(p);
    render(
      { el: p, text: slots2.join(' '), kind: 'block', rich: { slots: slots2 } },
      slots2.map((s) => `R:${s}`),
      'replace',
    );
    expect(p.getAttribute('data-dual-read-mode')).toBe('replace');
    restoreDom();
    restoreDom();
    expect(p.querySelector('.dual-read-original-hidden')).toBeNull();
    expect(p.hasAttribute('data-dual-read-done')).toBe(false);
    expect(p.querySelector('a')!.getAttribute('href')).toBe('/a');
    expect(p.textContent).not.toContain('R:');
    expect(p.textContent).toContain('docs');
  });

  it('rich replace + restore removes translation siblings (no bilingual leftover)', () => {
    // Mirrors IANA example-domains: linked prose + linked list item.
    document.body.innerHTML = `
      <p id="intro">As described in <a href="https://www.rfc-editor.org/rfc/rfc2606">RFC 2606</a>
      and <a href="https://www.rfc-editor.org/rfc/rfc6761">RFC 6761</a>, some domain names.</p>
      <ul><li><a id="link" href="/reserved">IANA-managed Reserved Domains</a></li></ul>`;
    const intro = document.getElementById('intro')!;
    const link = document.getElementById('link')!;
    const introSlots = extractRichSlots(intro);
    const linkSlots = extractRichSlots(link);
    const introBefore = intro.innerHTML;
    const linkBefore = link.innerHTML;

    render(
      { el: intro, text: introSlots.join(' '), kind: 'block', rich: { slots: introSlots } },
      introSlots.map((s) => `译:${s}`),
      'replace',
    );
    render(
      { el: link, text: linkSlots.join(' '), kind: 'inline', rich: { slots: linkSlots } },
      ['IANA管理的保留域名'],
      'replace',
    );

    expect(intro.textContent).toContain('译:');
    expect(link.textContent).toContain('IANA管理的保留域名');

    restoreDom();

    expect(intro.textContent).not.toContain('译:');
    expect(link.textContent).not.toContain('IANA管理');
    expect(intro.textContent).toContain('RFC 2606');
    expect(link.textContent).toBe('IANA-managed Reserved Domains');
    expect(intro.querySelectorAll('a')).toHaveLength(2);
    expect(intro.innerHTML).toBe(introBefore);
    expect(link.innerHTML).toBe(linkBefore);
  });

  it('rich replace + restore preserves original lang and dir exactly', () => {
    document.body.innerHTML = `
      <p id="explicit" lang="en" dir="ltr">Read <a href="/docs">the docs</a>.</p>
      <p id="empty" lang="" dir="auto">Empty language attribute.</p>
      <p id="absent">No language attributes.</p>`;
    const explicit = document.getElementById('explicit')!;
    const empty = document.getElementById('empty')!;
    const absent = document.getElementById('absent')!;

    for (const el of [explicit, empty, absent]) {
      const slots = extractRichSlots(el);
      render(
        { el, text: slots.join(' '), kind: 'block', rich: { slots } },
        slots.map((slot) => `译:${slot}`),
        'replace',
        { targetLang: 'zh-CN' },
      );
      expect(el.getAttribute('lang')).toBe('zh-CN');
      expect(el.getAttribute('dir')).toBe('auto');
    }

    restoreDom();

    expect(explicit.getAttribute('lang')).toBe('en');
    expect(explicit.getAttribute('dir')).toBe('ltr');
    expect(empty.hasAttribute('lang')).toBe(true);
    expect(empty.getAttribute('lang')).toBe('');
    expect(empty.getAttribute('dir')).toBe('auto');
    expect(absent.hasAttribute('lang')).toBe(false);
    expect(absent.hasAttribute('dir')).toBe(false);
    for (const el of [explicit, empty, absent]) {
      expect(el.hasAttribute('data-dual-read-stash-language-attrs')).toBe(false);
    }
  });

  it('nests a plain block companion inside flex hosts (no afterend sibling)', () => {
    document.body.innerHTML = `
      <div style="display:flex">
        <div id="card">Explore agents for general work, coding, and support</div>
      </div>`;
    const card = document.getElementById('card')!;
    const unit: TranslationUnit = {
      el: card,
      text: card.textContent!.trim(),
      kind: 'block',
    };
    render(unit, '探索适用于通用工作、编程与客服等场景的智能体', 'bilingual');

    expect(card.querySelector(':scope > .dual-read-target')?.textContent)
      .toBe('探索适用于通用工作、编程与客服等场景的智能体');
    // Must NOT become a flex sibling — that collapses into a vertical glyph strip.
    expect(card.nextElementSibling?.classList.contains('dual-read-target')).toBeFalsy();
  });

  it('appends block companion as last child, not inside nested links', () => {
    document.body.innerHTML =
      '<p id="p">See the <a href="/docs">docs</a> for details.</p>';
    const p = document.getElementById('p')!;
    render(
      { el: p, text: p.textContent!.trim(), kind: 'block' },
      '详见文档了解详情。',
      'bilingual',
    );
    const companion = p.querySelector(':scope > .dual-read-target');
    expect(companion).toBeTruthy();
    expect(companion!.parentElement).toBe(p);
    expect(p.querySelector('a .dual-read-target')).toBeNull();
  });

  it('nests list-item block companions inside the li (aligned newline)', () => {
    document.body.innerHTML = `
      <ul>
        <li id="item">Updated Azure AI support for GPT-5.6.</li>
      </ul>`;
    const li = document.getElementById('item')!;
    render(
      { el: li, text: li.textContent!.trim(), kind: 'block' },
      '更新了 GPT-5.6 版本的 Azure 人工智能支持。',
      'bilingual',
    );

    const companion = li.querySelector(':scope > .dual-read-target') as HTMLElement;
    expect(companion).toBeTruthy();
    expect(companion.parentElement).toBe(li);
    expect(li.nextElementSibling?.classList.contains('dual-read-target')).toBeFalsy();
    expect(companion.classList.contains('dual-read-target--inline')).toBe(false);
    expect(companion.textContent).toContain('Azure');
  });

  it('reparents legacy afterend list companions back into the li', () => {
    document.body.innerHTML = `
      <ul>
        <li id="item">Removed an obsolete Codex workaround.</li>
      </ul>`;
    const li = document.getElementById('item')!;
    const stray = document.createElement('span');
    stray.className = 'dual-read-target';
    stray.textContent = '删除了过时的 Codex 变通方案。';
    li.insertAdjacentElement('afterend', stray);

    expect(li.nextElementSibling).toBe(stray);
    repairStructure();
    expect(li.querySelector(':scope > .dual-read-target')).toBe(stray);
    expect(li.nextElementSibling?.classList.contains('dual-read-target')).toBeFalsy();
  });

  it('forces list-style outside when the host used inside markers', () => {
    document.body.innerHTML = `
      <ul>
        <li id="item" style="list-style-position: inside">Short bullet text here.</li>
      </ul>`;
    const li = document.getElementById('item')!;
    render(
      { el: li, text: li.textContent!.trim(), kind: 'block' },
      '这里是短列表项译文。',
      'bilingual',
    );
    expect(li.getAttribute('data-dual-read-list-outside')).toBe('true');
    restoreUnit(li);
    expect(li.hasAttribute('data-dual-read-list-outside')).toBe(false);
  });

  it('keeps nav translations as inline suffixes inside the host', () => {
    document.body.innerHTML = `
      <nav><a id="link" href="#models">Models</a></nav>`;
    const link = document.getElementById('link') as HTMLAnchorElement;
    const unit: TranslationUnit = { el: link, text: 'Models', kind: 'inner' };
    render(unit, '模型', 'bilingual');

    const sub = link.querySelector('.dual-read-target--inner');
    expect(sub?.textContent).toBe('\u200b\u00a0模型');
    expect(link.childNodes[0].nodeValue).toBe('Models');
    // Ordinary nav links may wrap between languages in a narrow column.
    expect(link.hasAttribute('data-dual-read-nowrap')).toBe(false);
  });

  it('nests block companions inside display:block card links (aligned newline)', () => {
    document.body.innerHTML = `
      <a id="title" class="cards-item-title" href="/post" style="display:block">
        Geometry Nodes Workshop: September 2025
      </a>`;
    const a = document.getElementById('title') as HTMLAnchorElement;
    render(
      { el: a, text: 'Geometry Nodes Workshop: September 2025', kind: 'block' },
      '几何节点研讨会：2025 年 9 月',
      'bilingual',
    );

    const companion = a.querySelector(':scope > .dual-read-target') as HTMLElement;
    expect(companion).toBeTruthy();
    expect(companion.classList.contains('dual-read-target--inner')).toBe(false);
    expect(companion.textContent).toContain('几何节点研讨会');
    expect(a.nextElementSibling?.classList.contains('dual-read-target')).toBeFalsy();
  });

  it('marks unchanged plain translations done without duplicating source text', () => {
    document.body.innerHTML = '<nav><a id="link" href="https://example.com">Example.COM</a></nav>';
    const link = document.getElementById('link') as HTMLAnchorElement;

    render({ el: link, text: 'Example.COM', kind: 'inner' }, '  example.com  ', 'bilingual');

    expect(link.querySelector('.dual-read-target')).toBeNull();
    expect(link.textContent).toBe('Example.COM');
    expect(link.getAttribute('data-dual-read-done')).toBe('true');
    expect(link.hasAttribute('data-dual-read-nowrap')).toBe(false);

    restoreUnit(link);
    expect(link.hasAttribute('data-dual-read-done')).toBe(false);
    expect(link.textContent).toBe('Example.COM');
  });

  it('suppresses only fully unchanged rich translations', () => {
    document.body.innerHTML = '<p id="p">Published <time>Jun 29, 2026</time></p>';
    const p = document.getElementById('p')!;
    const slots = extractRichSlots(p);
    const unit: TranslationUnit = {
      el: p,
      text: slots.join(' '),
      kind: 'block',
      rich: { slots },
    };

    render(unit, slots.map((slot) => ` ${slot} `), 'bilingual');
    expect(p.querySelector('.dual-read-target')).toBeNull();

    restoreUnit(p);
    render(unit, slots.map((slot) => (slot === 'Published' ? '发布于' : slot)), 'bilingual');
    expect(p.querySelector('.dual-read-target')?.textContent).toContain('发布于');
    expect(p.querySelector('.dual-read-target')?.textContent).toContain('Jun 29, 2026');
  });

  it('marks CTA links for horizontal nowrap (Premium 高级版, not stacked)', () => {
    document.body.innerHTML =
      '<a id="premium" href="/premium" style="display:inline-flex;width:5.5em">Premium</a>';
    const a = document.getElementById('premium') as HTMLAnchorElement;
    render({ el: a, text: 'Premium', kind: 'inner' }, '高级版', 'bilingual');

    expect(a.getAttribute('data-dual-read-nowrap')).toBe('true');
    expect(a.querySelector('.dual-read-target--inner')?.textContent).toBe('\u200b\u00a0高级版');
    // Flex hosts wrap original+companion into one flow item (not a block below).
    expect(a.querySelector('.dual-read-flow .dual-read-target--inner')).toBeTruthy();
    expect(a.querySelector(':scope > .dual-read-target:not(.dual-read-target--inner)')).toBeNull();
  });

  it('preserves structured flex-button markup and mounts inside its label', () => {
    document.body.innerHTML = `
      <a id="organization" class="Button--secondary Button Button--labelWrap"
         href="/organization" style="display:flex">
        <span class="Button-content">
          <span class="Button-label">View organization</span>
        </span>
      </a>`;
    const action = document.getElementById('organization') as HTMLAnchorElement;

    render(
      { el: action, text: 'View organization', kind: 'inner' },
      '查看组织',
      'bilingual',
    );

    const label = action.querySelector('.Button-label')!;
    expect(label.querySelector(':scope > .dual-read-target--inner')?.textContent)
      .toBe('\u200b\u00a0查看组织');
    expect(action.querySelector('.dual-read-flow')).toBeNull();
    expect(action.querySelector('.dual-read-target--break')).toBeNull();
    expect(action.querySelector(':scope > .Button-content')).toBeTruthy();
    expect(action.getAttribute('data-dual-read-nowrap')).toBe('true');

    restoreUnit(action);
    expect(action.querySelector('.dual-read-target')).toBeNull();
    expect(action.querySelector(':scope > .Button-content > .Button-label')?.textContent?.trim())
      .toBe('View organization');
  });

  it('marks button and class-based pill hosts for nowrap', () => {
    document.body.innerHTML = `
      <button id="go">Go</button>
      <a id="upgrade" class="btn-primary" href="/upgrade">Upgrade</a>
      <a id="chip" class="Pill" href="/chip">Chip</a>
      <a id="role" role="button" href="/role">Open</a>`;
    const cases: Array<[string, string]> = [
      ['go', '前往'],
      ['upgrade', '升级'],
      ['chip', '标签'],
      ['role', '打开'],
    ];
    for (const [id, zh] of cases) {
      const el = document.getElementById(id) as HTMLElement;
      render({ el, text: el.textContent || '', kind: 'inner' }, zh, 'bilingual');
      expect(el.getAttribute('data-dual-read-nowrap'), id).toBe('true');
      expect(el.querySelector('.dual-read-target--inner')?.textContent, id)
        .toBe(`\u200b\u00a0${zh}`);
      expect(Boolean(el.nextElementSibling?.classList.contains('dual-read-target')), id).toBe(false);
    }
  });

  it('keeps Donate translation inside the painted CTA with icon alignment', () => {
    document.body.innerHTML = `
      <nav>
        <ul style="display:flex">
          <li style="display:flex">
            <a id="donate" class="nav-link" href="/donate"
               style="display:flex;white-space:nowrap;background:linear-gradient(#6183ff,#47aaf5);border-radius:6px;padding:4px 16px">
              <i class="i-heart" aria-hidden="true"></i> Donate
            </a>
          </li>
        </ul>
      </nav>`;
    const donate = document.getElementById('donate') as HTMLAnchorElement;
    render({ el: donate, text: 'Donate', kind: 'inner' }, '捐款', 'bilingual');

    expect(donate.hasAttribute('data-dual-read-outside')).toBe(false);
    expect(donate.getAttribute('data-dual-read-nowrap')).toBe('true');
    expect(donate.querySelector(':scope > .i-heart')).toBeTruthy();
    expect(donate.querySelector('.dual-read-flow')?.textContent).toContain('Donate');
    expect(donate.querySelector('.dual-read-flow .dual-read-target--inner')?.textContent)
      .toBe('\u200b\u00a0捐款');
    expect(Boolean(donate.nextElementSibling?.classList.contains('dual-read-target'))).toBe(false);

    restoreUnit(donate);
    expect(donate.querySelector('.dual-read-target')).toBeNull();
    expect(donate.querySelector('.dual-read-flow')).toBeNull();
    expect(donate.textContent?.replace(/\s+/g, ' ').trim()).toBe('Donate');
    expect(donate.querySelector('.i-heart')).toBeTruthy();
  });

  it('flow-wraps flex nav links so translation shares the text run', () => {
    document.body.innerHTML = `
      <nav>
        <ul style="display:flex;flex-direction:row">
          <li style="display:flex">
            <a id="involved" class="nav-link" href="/get-involved" style="display:flex">Get Involved</a>
          </li>
        </ul>
      </nav>`;
    const involved = document.getElementById('involved') as HTMLAnchorElement;

    render({ el: involved, text: 'Get Involved', kind: 'inner' }, '参与', 'bilingual');

    const flow = involved.querySelector(':scope > .dual-read-flow');
    expect(flow).toBeTruthy();
    expect(flow?.textContent).toContain('Get Involved');
    expect(flow?.querySelector('.dual-read-target--inner')?.textContent)
      .toBe('\u200b\u00a0参与');

    restoreUnit(involved);
    expect(involved.querySelector('.dual-read-flow')).toBeNull();
    expect(involved.textContent).toBe('Get Involved');
  });

  it('collects and renders Blender-style nav without block-break companions', () => {
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 160, bottom: 32,
        width: 160, height: 32, toJSON() {},
      } as DOMRect;
    };
    try {
      document.body.innerHTML = `
        <nav aria-label="Primary">
          <ul style="display:flex;flex-wrap:wrap">
            <li style="display:flex">
              <a id="involved" class="nav-link" href="/get-involved" style="display:flex">Get Involved</a>
            </li>
            <li style="display:flex">
              <a id="donate" class="nav-link" href="/donate"
                 style="display:flex;white-space:nowrap;background:linear-gradient(#6183ff,#47aaf5);border-radius:6px">
                <i class="i-heart"></i> Donate
              </a>
            </li>
          </ul>
        </nav>`;

      const units = collectUnits();
      const involvedUnit = units.find((unit) => unit.el.id === 'involved');
      const donateUnit = units.find((unit) => unit.el.id === 'donate');
      expect(involvedUnit?.kind).toBe('nav');
      expect(donateUnit?.kind).toBe('nav');

      render(involvedUnit!, '参与', 'bilingual');
      render(donateUnit!, '捐赠', 'bilingual');

      const involved = document.getElementById('involved')!;
      const donate = document.getElementById('donate')!;
      expect(involved.querySelector('.dual-read-target--break')).toBeNull();
      expect(involved.querySelector('.dual-read-flow .dual-read-nav-sub')?.textContent)
        .toBe('\u200b\u00a0参与');
      expect(donate.querySelector('.dual-read-target--break')).toBeNull();
      expect(donate.getAttribute('data-dual-read-nowrap')).toBe('true');
      expect(donate.querySelector(':scope > .i-heart')).toBeTruthy();
      expect(donate.querySelector('.dual-read-flow .dual-read-nav-sub')?.textContent)
        .toBe('\u200b\u00a0捐赠');
      expect(Boolean(donate.nextElementSibling?.classList.contains('dual-read-target'))).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  });

  it('sets lang and dir=auto on translation companions', () => {
    document.body.innerHTML = '<p id="p">Hello world</p>';
    const p = document.getElementById('p')!;
    render({ el: p, text: 'Hello world', kind: 'block' }, '你好世界', 'bilingual', {
      targetLang: 'zh-CN',
    });
    const node = p.querySelector('.dual-read-target') as HTMLElement;
    expect(node.getAttribute('lang')).toBe('zh-CN');
    expect(node.getAttribute('dir')).toBe('auto');
  });

  it('reserves block shell then restore clears companion', () => {
    document.body.innerHTML = '<p id="p">Hello world paragraph for height</p>';
    const p = document.getElementById('p')!;
    // Empty shell path: reserve before fill.
    const empty = document.createElement('span');
    empty.className = 'dual-read-target';
    p.appendChild(empty);
    reserveBlockShell(p, empty);
    expect(empty.getAttribute('data-dual-read-shell')).toBeTruthy();
    expect(empty.style.minHeight).toMatch(/px$/);
    empty.remove();

    render({ el: p, text: 'Hello world paragraph for height', kind: 'block' }, '你好世界段落', 'bilingual');
    const node = p.querySelector('.dual-read-target') as HTMLElement;
    expect(node).toBeTruthy();
    expect(node.textContent).toContain('你好');

    restoreUnit(p);
    expect(p.querySelector('.dual-read-target')).toBeNull();
    expect(p.hasAttribute('data-dual-read-done')).toBe(false);
  });

  it('reserveBlockShell is idempotent and skips inner companions', () => {
    document.body.innerHTML = '<p id="p">Hello</p><a id="a" href="#">Link</a>';
    const p = document.getElementById('p')!;
    const shell = document.createElement('span');
    shell.className = 'dual-read-target';
    p.appendChild(shell);
    reserveBlockShell(p, shell);
    const first = shell.getAttribute('data-dual-read-shell');
    reserveBlockShell(p, shell);
    expect(shell.getAttribute('data-dual-read-shell')).toBe(first);

    const a = document.getElementById('a')!;
    const inner = document.createElement('span');
    inner.className = 'dual-read-target dual-read-target--inner';
    a.appendChild(inner);
    reserveBlockShell(a, inner);
    expect(inner.getAttribute('data-dual-read-shell')).toBeNull();

    shell.textContent = '短';
    stabilizeBlockShell(shell);
    // Still has shell attr or cleared if height exceeded — either is valid.
    expect(shell.isConnected).toBe(true);
  });

  it('renders compact errors without in-page controls', () => {
    document.body.innerHTML = '<p id="p">Hello</p>';
    const p = document.getElementById('p')!;
    renderError(
      { el: p, text: 'Hello', kind: 'block' },
      'Translation failed',
      'HTTP 429',
      { uiLocale: 'en' },
    );
    const err = p.querySelector('.dual-read-error') as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.getAttribute('dir')).toBe('auto');
    expect(err.getAttribute('lang')).toBe('en');
    expect(err.title).toBe('HTTP 429');
    expect(err.querySelector('button')).toBeNull();
    expect(err.querySelector('.dual-read-retry')).toBeNull();
  });
});

describe('error badge lifecycle', () => {
  it('restoreDom removes error badges', () => {
    document.body.innerHTML = '<p id="p">Hello there</p>';
    const p = document.getElementById('p')!;
    renderError({ el: p, text: 'Hello there', kind: 'block' }, 'Translation failed', undefined, { uiLocale: 'en' });
    expect(p.querySelector('.dual-read-error')).toBeTruthy();

    restoreDom();

    expect(document.querySelector('.dual-read-error')).toBeNull();
    expect(p.textContent).toBe('Hello there');
  });

  it('a successful render after an error replaces the badge instead of coexisting', () => {
    document.body.innerHTML = '<p id="p">Hello there friend</p>';
    const p = document.getElementById('p')!;
    const unit = { el: p, text: 'Hello there friend', kind: 'block' as const };
    renderError(unit, 'Translation failed', undefined, { uiLocale: 'en' });

    render(unit, '你好，朋友', 'bilingual');

    expect(p.querySelector('.dual-read-error')).toBeNull();
    expect(p.textContent).toContain('你好，朋友');
    expect(p.querySelectorAll('.dual-read-target')).toHaveLength(1);
  });
});

describe('rich slot parity', () => {
  it('prunes sr-only subtrees in the skeleton so slots stay aligned', () => {
    document.body.innerHTML =
      '<p>Visible <span class="sr-only">screen reader note</span> more text <a href="/x">link</a> end here.</p>';
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    expect(slots).toEqual(['Visible', 'more text', 'link', 'end here.']);

    const skel = buildSafeRichSkeleton(p);
    expect(collectSlotTextNodes(skel)).toHaveLength(slots.length);
    expect(skel.textContent).not.toContain('screen reader note');
  });

  it('rich render keeps sr-only text out of the companion and fills slots in order', () => {
    document.body.innerHTML =
      '<p>Visible <span class="sr-only">screen reader note</span> more text <a href="/x">link</a> end here.</p>';
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    const translated = ['可见', '更多文字', '链接', '结尾。'];

    render(
      { el: p, text: slots.join(' '), kind: 'block', rich: { slots } },
      translated,
      'bilingual',
    );

    const companion = p.querySelector('.dual-read-target') as HTMLElement;
    expect(companion).toBeTruthy();
    expect(companion.textContent).not.toContain('screen reader note');
    expect(companion.textContent).toContain('可见');
    expect(companion.textContent).toContain('更多文字');
    expect(companion.querySelector('a')?.textContent).toBe('链接');
    expect(companion.textContent).toContain('结尾。');
    // Original (including sr-only) is untouched in bilingual mode.
    expect(p.querySelector('.sr-only')?.textContent).toBe('screen reader note');
  });

  it('degrades to plain text when the skeleton drifts from the slot list', () => {
    document.body.innerHTML = '<p>See <a href="#a">docs</a> here.</p>';
    const p = document.querySelector('p')!;
    const slots = extractRichSlots(p);
    expect(slots).toEqual(['See', 'docs', 'here.']);

    render(
      { el: p, text: 'x', kind: 'block', rich: { slots: [...slots, 'EXTRA'] } },
      ['一', '二', '三', '四'],
      'bilingual',
    );

    const companion = p.querySelector('.dual-read-target') as HTMLElement;
    expect(companion).toBeTruthy();
    // Plain fallback joins the payload — no slot-wise distribution happened.
    expect(companion.textContent).toBe('一 二 三 四');
    expect(companion.querySelector('a')).toBeNull();
  });
});

describe('segment replace across interactive chrome', () => {
  it('replace + restore preserves text runs split by a button', () => {
    document.body.innerHTML = '<p>Save <button type="button">OK</button> and close it now.</p>';
    const p = document.querySelector('p')!;
    const nodes = [p.childNodes[0] as Text, p.childNodes[2] as Text];
    const unit = {
      el: p,
      text: 'Save and close it now.',
      kind: 'inner' as const,
      segment: true,
      nodes,
    };

    render(unit, '保存并关闭。', 'replace');

    expect(p.textContent).toContain('保存并关闭。');
    // Both runs are stashed in place (CSS-hidden), not merged or relocated.
    const stashes = p.querySelectorAll('.dual-read-original-hidden');
    expect(stashes).toHaveLength(2);
    expect(stashes[0].textContent).toBe('Save ');
    expect(stashes[1].textContent).toBe(' and close it now.');
    expect(p.querySelector('button')).toBeTruthy();

    restoreDom();

    expect(p.textContent).not.toContain('保存并关闭。');
    expect(p.childNodes).toHaveLength(3);
    expect(p.childNodes[0].textContent).toBe('Save ');
    expect(p.childNodes[1].nodeName).toBe('BUTTON');
    expect(p.childNodes[2].textContent).toBe(' and close it now.');
  });
});
