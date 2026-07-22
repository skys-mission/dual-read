// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectUnits, collectUnitsAsync, collectVisibleTextNodes, dedupeNestedRoots, mutationHasNewContent, mutationIndexDelta } from '../lib/collector';
import { DONE } from '../lib/dom-const';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('collectUnits nested dedup', () => {
  // Regression: RTD/Sphinx sidebars nest the caption text inside a span,
  // e.g. <p class="caption"><span class="caption-text">Getting Started</span></p>.
  // Both the <p> and the <span> used to be collected as separate units, so the
  // same text was translated twice ("入门指南 入门指南").
  it('collects a nested nav caption exactly once', () => {
    document.body.innerHTML = `
      <nav aria-label="main">
        <p class="caption" role="heading"><span class="caption-text">Getting Started</span></p>
        <ul><li><a href="#intro">Introduction</a></li></ul>
        <p class="caption" role="heading"><span class="caption-text">Manual</span></p>
      </nav>`;

    const units = collectUnits();
    const texts = units.map((u) => u.text);

    expect(texts.filter((t) => t === 'Getting Started')).toHaveLength(1);
    expect(texts.filter((t) => t === 'Manual')).toHaveLength(1);
  });

  it('never yields two units covering the same text nodes', () => {
    document.body.innerHTML = `
      <nav aria-label="main">
        <div class="group"><span class="label">Engine Details</span></div>
      </nav>`;

    const units = collectUnits();
    expect(units.filter((u) => u.text === 'Engine Details')).toHaveLength(1);
  });

  it('skips generically clipped screen-reader labels in icon controls', () => {
    document.body.innerHTML = `
      <nav aria-label="contents">
        <ul>
          <li>
            <a href="#goals">Goals</a>
            <button class="icon-only">
              <span aria-hidden="true">⌄</span>
              <span style="
                position:absolute;
                width:1px;
                height:1px;
                margin:-1px;
                overflow:hidden;
                clip:rect(1px, 1px, 1px, 1px);
                white-space:nowrap
              ">Toggle Goals subsection</span>
            </button>
          </li>
        </ul>
      </nav>`;

    const texts = collectUnits().map((unit) => unit.text);
    expect(texts).toContain('Goals');
    expect(texts).not.toContain('Toggle Goals subsection');
  });

  // Regression (MDN "In this article" TOC): after the child <a> is marked done,
  // a later collectUnits() (MutationObserver re-index) must not re-collect the
  // parent <li> — that produced "Technical summary 技术摘要 技术摘要".
  it('does not re-collect a nav li after its child link was translated', () => {
    // Stub layout so hasInteractiveDescendant sees the <a> (real browsers have
    // non-zero boxes; jsdom defaults to 0×0 and would collect the <li> instead).
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20,
        width: 100, height: 20, toJSON() {},
      } as DOMRect;
    };
    try {
      document.body.innerHTML = `
        <aside class="layout__right-sidebar reference-layout__toc">
          <nav class="reference-toc">
            <h2>In this article</h2>
            <ul>
              <li><a href="#technical_summary">Technical summary</a></li>
              <li><a href="#specifications">Specifications</a></li>
            </ul>
          </nav>
        </aside>`;

      const first = collectUnits();
      const summaryUnits = first.filter((u) => u.text === 'Technical summary');
      expect(summaryUnits).toHaveLength(1);
      // With layout, the link owns the text (not the wrapping <li>).
      expect(summaryUnits[0].el.matches('a[href]')).toBe(true);
      expect(first.filter((u) => u.text === 'Specifications')).toHaveLength(1);

      // Simulate bilingual render on every TOC link (as the scheduler does).
      for (const a of Array.from(document.querySelectorAll('aside a[href]'))) {
        a.setAttribute('data-dual-read-done', 'true');
        a.setAttribute('data-dual-read-mode', 'bilingual');
        const span = document.createElement('span');
        span.className = 'dual-read-target dual-read-target--inner';
        span.textContent = '\u00a0译文';
        a.appendChild(span);
      }

      const second = collectUnits();
      expect(second.filter((u) => u.text === 'Technical summary')).toHaveLength(0);
      expect(second.filter((u) => u.text === 'Specifications')).toHaveLength(0);
      expect(second.some((u) => u.el.matches('li'))).toBe(false);
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  });
});

describe('collectUnits comment-split text runs', () => {
  // jsdom has no layout, so stub a non-zero box to satisfy the viewport check
  // used by non-nav collection.
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON() {} } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });

  // Regression: a wrapper whose text runs are split by comment nodes (React/JSX
  // output, e.g. Tailwind's footer) — the runs get extracted as separate
  // segments while an untranslatable run ("2026") stays unclaimed. The wrapper
  // must not then be re-collected as a whole unit (double translation).
  it('does not double-collect a span split by comment nodes', () => {
    document.body.innerHTML =
      '<div><a href="#home">Home</a>' +
      '<span>Copyright \u00a9\u00a0<!-- -->2026<!-- -->\u00a0Acme Inc.</span></div>';

    const units = collectUnits();

    const seen = new Set<Node>();
    let overlaps = 0;
    for (const u of units) {
      const nodes = u.nodes?.length ? u.nodes : collectVisibleTextNodes(u.el, false);
      for (const n of nodes) {
        if (seen.has(n)) overlaps++;
        seen.add(n);
      }
    }
    expect(overlaps).toBe(0);
  });
});

describe('collectUnits rich prose', () => {
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

  it('collects a paragraph with links/code as one rich unit', () => {
    document.body.innerHTML = `
      <main>
        <p>The <a href="/en-US/docs/Web/HTML/Global_attributes">global attributes</a>
        of <code>Attribution-Reporting-Eligible</code> include
        <a href="/en-US/docs/Web/HTML/Reference">HTML</a> elements.</p>
      </main>`;

    const units = collectUnits();
    const rich = units.filter((u) => u.rich);
    expect(rich).toHaveLength(1);
    expect(rich[0].el.tagName).toBe('P');
    expect(rich[0].rich!.slots.length).toBeGreaterThanOrEqual(2);
    // Nested links must not become separate inner units.
    expect(units.filter((u) => u.kind === 'inner')).toHaveLength(0);
    // CODE text is NO_TEXT — not a slot, but stays in the skeleton.
    expect(rich[0].rich!.slots.join(' ')).not.toContain('Attribution-Reporting-Eligible');
    expect(rich[0].text).toMatch(/global attributes/i);
  });

  it('falls back to mixed content when the host has a button', () => {
    document.body.innerHTML = `
      <main>
        <p>Click <a href="#x">here</a> <button type="button">OK</button> please.</p>
      </main>`;

    const units = collectUnits();
    expect(units.some((u) => u.rich)).toBe(false);
  });
});

describe('collectUnits page-nav never emits block', () => {
  it('downgrades long breadcrumb / toc headings to nav', () => {
    document.body.innerHTML = `
      <main>
        <nav class="breadcrumbs" aria-label="breadcrumb">
          <div role="heading">A reasonably long breadcrumb section title for docs</div>
          <ol><li><a href="/">Home</a></li></ol>
        </nav>
      </main>`;

    const units = collectUnits();
    const heading = units.find((u) => u.text.includes('breadcrumb section title'));
    expect(heading).toBeTruthy();
    expect(heading!.kind).not.toBe('block');
    expect(['nav', 'inline', 'inner']).toContain(heading!.kind);
  });
});

describe('collectUnits body list items prefer block', () => {
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    // Single-line boxes would formerly force short hosts to inline via height
    // heuristics — body <li> must still classify as block for aligned newline.
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 22,
        width: 480, height: 22, toJSON() {},
      } as DOMRect;
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });

  it('classifies short and long prose list items as block (not same-line inline)', () => {
    document.body.innerHTML = `
      <main>
        <ul>
          <li id="short">Updated Azure AI support for GPT-5.6.</li>
          <li id="long">Removed an obsolete Codex workaround that could interfere with OpenAI Luna Responses Lite requests.</li>
        </ul>
      </main>`;

    const units = collectUnits();
    const short = units.find((u) => u.el.id === 'short');
    const long = units.find((u) => u.el.id === 'long');
    expect(short?.kind).toBe('block');
    expect(long?.kind).toBe('block');
    expect(short!.text.length).toBeLessThan(100);
    expect(long!.text.length).toBeGreaterThanOrEqual(90);
  });

  it('keeps nav/toc list labels as nav (same-line chrome), not block', () => {
    document.body.innerHTML = `
      <nav aria-label="toc">
        <ul>
          <li><a href="#intro">Introduction</a></li>
          <li><a href="#api">API reference overview</a></li>
        </ul>
      </nav>`;

    const units = collectUnits();
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.kind === 'nav' || u.kind === 'inner' || u.kind === 'inline')).toBe(true);
    expect(units.some((u) => u.kind === 'block')).toBe(false);
  });
});

describe('incremental mutation index', () => {
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

  it('dedupeNestedRoots keeps only outermost roots', () => {
    document.body.innerHTML = `<div id="a"><div id="b"><p>x</p></div></div>`;
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    expect(dedupeNestedRoots([a, b, b]).map((el) => el.id)).toEqual(['a']);
  });

  it('collectUnits on a subtree does not scan siblings', () => {
    document.body.innerHTML = `
      <main>
        <p id="keep">Keep me visible paragraph text</p>
        <section id="scope"><p id="new">Fresh paragraph for translation</p></section>
      </main>`;
    const scope = document.getElementById('scope')!;
    const units = collectUnits(scope);
    expect(units.map((u) => u.el.id)).toEqual(['new']);
    expect(units.every((u) => u.text.includes('Fresh'))).toBe(true);
  });

  it('mutationIndexDelta adds units under inserted subtrees only', async () => {
    document.body.innerHTML = `<main id="root"><p id="old">Original paragraph text here</p></main>`;
    const known = collectUnits().map((u) => u.el);
    expect(known.length).toBeGreaterThan(0);

    const mutations = await captureMutations(() => {
      const p = document.createElement('p');
      p.id = 'added';
      p.textContent = 'Newly inserted paragraph for translation';
      document.getElementById('root')!.appendChild(p);
    });

    expect(mutationHasNewContent(mutations)).toBe(true);
    const delta = mutationIndexDelta(mutations, known);
    expect(delta.removed).toHaveLength(0);
    expect(delta.invalidated).toHaveLength(0);
    expect(delta.added.some((u) => u.el.id === 'added')).toBe(true);
    expect(delta.added.every((u) => u.el.id !== 'old')).toBe(true);
  });

  it('mutationIndexDelta marks disconnected known hosts as removed', async () => {
    document.body.innerHTML = `
      <main>
        <p id="stay">Stay paragraph text here</p>
        <p id="gone">Gone paragraph text here</p>
      </main>`;
    const known = collectUnits().map((u) => u.el);
    expect(known.length).toBe(2);
    const gone = document.getElementById('gone') as HTMLElement;

    const mutations = await captureMutations(() => {
      gone.remove();
    });

    const delta = mutationIndexDelta(mutations, known);
    expect(delta.removed).toContain(gone);
    expect(delta.added).toHaveLength(0);
  });

  it('mutationIndexDelta invalidates known hosts when source text changes', async () => {
    document.body.innerHTML = `<main><p id="host">Original source paragraph text</p></main>`;
    const host = document.getElementById('host') as HTMLElement;
    host.setAttribute(DONE, 'true');
    const known = [host];

    const mutations = await captureMutations(() => {
      host.firstChild!.nodeValue = 'Updated source paragraph text now';
    });

    expect(mutations.length).toBeGreaterThan(0);
    const delta = mutationIndexDelta(mutations, known);
    expect(delta.invalidated).toContain(host);
    expect(delta.removed).toHaveLength(0);
  });
});

describe('collectUnitsAsync partitioning', () => {
  function stubLayoutBoxes(): () => void {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 20, width: 640, height: 20, toJSON() {},
      } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = real;
    };
  }

  it('matches sync collectUnits on a nested wide forest', async () => {
    const restore = stubLayoutBoxes();
    try {
      const main = document.createElement('main');
      main.id = 'root';
      for (let i = 0; i < 120; i++) {
        const p = document.createElement('p');
        p.id = `u${i}`;
        p.textContent = `Async unit ${i}: The quick brown fox jumps over the lazy dog.`;
        main.appendChild(p);
      }
      document.body.appendChild(main);

      const sync = collectUnits(document.body).map((u) => u.el.id).sort();
      const asyncResult = await collectUnitsAsync(document.body, { budgetMs: 1 });
      const asyncIds = asyncResult.units.map((u) => u.el.id).sort();
      expect(asyncIds).toEqual(sync);
      expect(asyncResult.cpuMs).toBeGreaterThan(0);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('skips display:none subtrees', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <main>
          <p id="vis">Visible paragraph for translation here</p>
          <div style="display:none"><p id="hid">Hidden paragraph must not be collected</p></div>
        </main>`;
      // jsdom may not apply style attrs to getComputedStyle — stub via CSSOM if needed.
      const hidWrap = document.querySelector('div') as HTMLElement;
      hidWrap.style.display = 'none';
      const units = collectUnits();
      expect(units.map((u) => u.el.id)).toContain('vis');
      expect(units.map((u) => u.el.id)).not.toContain('hid');
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });
});

describe('dashboard aside + feed card coverage', () => {
  function stubLayoutBoxes(): () => void {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 24, width: 640, height: 24, toJSON() {},
      } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = real;
    };
  }

  it('collects prose changelog blurbs inside aside (not only the heading)', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <aside aria-label="Changelog">
          <h2>Latest from our changelog</h2>
          <ul>
            <li><a id="c1" href="/changelog/1">CodeQL 2.26.0 adds Kotlin 2.4.0 support and analyzer improvements</a></li>
            <li><a id="c2" href="/changelog/2">Clearer names for secret scanning detector types in settings</a></li>
            <li><a id="c3" href="/changelog/3">Per-user states for multi-user budgets in the REST API surface</a></li>
          </ul>
        </aside>`;
      const units = collectUnits();
      const texts = units.map((u) => u.text);
      expect(texts.some((t) => t.includes('Latest from our changelog'))).toBe(true);
      expect(texts.some((t) => t.includes('CodeQL 2.26.0'))).toBe(true);
      expect(texts.some((t) => t.includes('secret scanning'))).toBe(true);
      expect(texts.some((t) => t.includes('multi-user budgets'))).toBe(true);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('collects long feed-card body text hosted in div (beyond INLINE_MAX)', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <main>
          <div class="feed-card">
            <div id="title">ai/nanoid released 6.0.0</div>
            <div id="body">Made nanoid() and customAlphabet() four times faster by rewriting the core random path carefully for browsers.</div>
          </div>
        </main>`;
      const units = collectUnits();
      expect(units.some((u) => u.el.id === 'body' || u.text.includes('four times faster'))).toBe(true);
      expect(units.some((u) => u.text.includes('nanoid'))).toBe(true);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('keeps true nav menus on the chrome path (short labels only)', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <nav aria-label="Primary">
          <ul>
            <li><a href="/issues">Issues</a></li>
            <li><a href="/pulls">Pull requests</a></li>
          </ul>
        </nav>`;
      const units = collectUnits();
      expect(units.every((u) => u.kind === 'nav' || u.kind === 'inner' || u.kind === 'inline')).toBe(true);
      expect(units.some((u) => u.text === 'Issues' || u.text.includes('Issues'))).toBe(true);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('classifies display:flex Blender-style nav links as nav, never block', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <nav aria-label="Primary">
          <ul class="navbar-nav" style="display:flex;flex-wrap:wrap">
            <li style="display:flex">
              <a id="features" class="nav-link" href="/features" style="display:flex">Features</a>
            </li>
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

      const byId = new Map(collectUnits().map((unit) => [unit.el.id, unit]));
      expect(byId.get('features')?.kind).toBe('nav');
      expect(byId.get('involved')?.kind).toBe('nav');
      expect(byId.get('donate')?.kind).toBe('nav');
      expect([...byId.values()].some((unit) => unit.kind === 'block')).toBe(false);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });
});

describe('block-layout card links (Immersive dual-mode alignment)', () => {
  function stubLayoutBoxes(): () => void {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 28, width: 320, height: 28, toJSON() {},
      } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = real;
    };
  }

  it('classifies display:block card title/excerpt links as block (not inner suffix)', () => {
    const restore = stubLayoutBoxes();
    try {
      // Mirrors blender.org cards-item: block-styled anchors for title + excerpt.
      document.body.innerHTML = `
        <main>
          <div class="cards-item">
            <a id="title" class="cards-item-title" href="/post/1" style="display:block">
              Geometry Nodes Workshop: September 2025
            </a>
            <a id="excerpt" class="cards-item-excerpt" href="/post/1" style="display:block">
              <p>Summary of what was discussed at the Geometry Nodes workshop in September 2025.</p>
            </a>
          </div>
        </main>`;

      const units = collectUnits();
      const title = units.find((u) => u.el.id === 'title' || u.text.includes('Geometry Nodes Workshop'));
      const excerpt = units.find(
        (u) => u.el.id === 'excerpt' || u.el.closest?.('#excerpt') || u.text.includes('Summary of what was discussed'),
      );

      expect(title).toBeTruthy();
      expect(title!.kind).toBe('block');
      expect(excerpt).toBeTruthy();
      expect(excerpt!.kind).toBe('block');
      // Must not collapse card prose into same-line inner suffixes.
      expect(units.filter((u) => u.text.includes('Geometry Nodes Workshop') && u.kind === 'inner')).toHaveLength(0);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('classifies flex button links by control semantics before block layout', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <main>
          <a id="action" class="Button--secondary Button Button--labelWrap"
             href="/organization" style="display:flex">
            <span class="Button-content"><span class="Button-label">View organization</span></span>
          </a>
          <a id="card" class="feature-card" href="/story" style="display:flex">
            Flexible prose card title
          </a>
          <div id="long-action" role="button">
            Continue to organization settings and review all pending membership
            permissions before accepting this invitation to the shared workspace
          </div>
        </main>`;

      const units = collectUnits();
      const action = units.find((u) => u.el.id === 'action');
      const card = units.find((u) => u.el.id === 'card');
      const longAction = units.find((u) => u.el.id === 'long-action');

      expect(action?.kind).toBe('inner');
      expect(longAction?.kind).toBe('inner');
      // A generic flex link remains prose; this guards against replacing one
      // broad display-based workaround with another.
      expect(card?.kind).toBe('block');
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('keeps true inline body links as inner', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `
        <main>
          <p>See the <a id="inline" href="/docs">documentation overview page</a> for details.</p>
        </main>`;
      // Rich path claims the paragraph; ensure a lone inline link unit (if any) is not block.
      const units = collectUnits();
      const inline = units.find((u) => u.el.id === 'inline');
      if (inline) expect(inline.kind).toBe('inner');
      expect(units.some((u) => u.rich || u.el.tagName === 'P')).toBe(true);
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });

  it('classifies headings as block even when short', () => {
    const restore = stubLayoutBoxes();
    try {
      document.body.innerHTML = `<main><h3 id="h">Cycles Texture Cache</h3></main>`;
      const units = collectUnits();
      const h = units.find((u) => u.el.id === 'h');
      expect(h?.kind).toBe('block');
    } finally {
      restore();
      document.body.innerHTML = '';
    }
  });
});

async function captureMutations(mutate: () => void): Promise<MutationRecord[]> {
  return new Promise((resolve) => {
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((batch) => {
      records.push(...batch);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    mutate();
    queueMicrotask(() => {
      mo.disconnect();
      resolve(records);
    });
  });
}

describe('collectUnits mixed-content anchor merge', () => {
  // Regression: interactive chrome (link/button) splits a paragraph's text into
  // multiple runs sharing one anchor. Sessions key units by anchor element, so
  // unmerged runs silently dropped every run after the first ("and close"
  // never translated).
  function stubLayout(): () => void {
    const realRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20,
        width: 100, height: 20, toJSON() {},
      } as DOMRect;
    };
    return () => {
      Element.prototype.getBoundingClientRect = realRect;
    };
  }

  it('merges text runs sharing an anchor across interactive chrome', () => {
    const restore = stubLayout();
    try {
      document.body.innerHTML = `
        <main>
          <p>Save <a href="#f">the file</a> <button type="button">OK</button> and close the dialog.</p>
        </main>`;

      const units = collectUnits();
      const segments = units.filter((u) => u.el.tagName === 'P' && u.segment);
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toContain('Save');
      expect(segments[0].text).toContain('and close the dialog.');
      expect(segments[0].nodes).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('never emits two segment units for the same anchor element', () => {
    const restore = stubLayout();
    try {
      document.body.innerHTML = `
        <main>
          <p>First <b>bold words here</b> trailing <button type="button">OK</button> final words.</p>
        </main>`;

      const units = collectUnits();
      const segments = units.filter((u) => u.segment);
      const anchors = new Set(segments.map((u) => u.el));
      expect(segments.length).toBe(anchors.size);
    } finally {
      restore();
    }
  });
});
