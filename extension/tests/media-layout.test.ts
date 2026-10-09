// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMediaLayouts, attachMediaLayouts, captureMediaLayouts, readMediaLayouts, releaseMediaLayout, restoreMediaLayouts } from '../lib/renderer/media-layout';
import { renderBatch, restoreUnit } from '../lib/renderer';
import type { TranslationUnit } from '../lib/types';

afterEach(() => { restoreMediaLayouts(document); document.body.innerHTML = ''; vi.restoreAllMocks(); });

function fixture() {
  document.body.innerHTML = '<main><section id="row" style="display:grid;grid-template-columns:200px 200px"><div><p id="host">Original prose.</p></div><div id="column"><img src="/diagram.svg" style="transform:none;position:static" alt="Diagram"></div></section></main>';
  const host = document.getElementById('host')!;
  const column = document.getElementById('column')!;
  const image = document.querySelector('img')!;
  let width = 400, columnWidth = 200;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
    const w = this === image ? width : this === column ? columnWidth : 200;
    const x = this === image ? 800 : 0;
    return { x, y: 0, width: w, height: 100, top: 0, bottom: 100, left: x, right: x + w, toJSON() {} } as DOMRect;
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  captureMediaLayouts([host]);
  const owner = document.createElement('span'); host.appendChild(owner); attachMediaLayouts(host, owner);
  return { host, column, image, owner, resize: (w: number, col = 200) => { width = w; columnWidth = col; } };
}

describe('media sharing a prose row', () => {
  it.each(['min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size'])('releases when an external selector changes the author %s constraint', async property => {
    const {image, owner, resize} = fixture(); resize(700);
    const toggle = document.createElement('div'); toggle.id = 'toggle'; document.getElementById('row')!.before(toggle);
    const sheet = document.createElement('style'); sheet.textContent = `#toggle.changed + #row img {${property}:80px}`; document.head.appendChild(sheet);
    try {
      applyMediaLayouts(readMediaLayouts([owner])); expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      toggle.className = 'changed'; await new Promise(resolve => setTimeout(resolve, 100));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      applyMediaLayouts(readMediaLayouts([owner])); expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    } finally {sheet.remove();}
  });
  it.each(['class', 'structure'] as const)('releases an installed rule after an external sibling %s changes author sizing', async trigger => {
    const {image, owner, resize} = fixture(); resize(700);
    const toggle = document.createElement('div'); toggle.id = 'toggle'; document.getElementById('row')!.before(toggle);
    const sheet = document.createElement('style'); sheet.textContent = '#toggle.changed + #row img, #toggle:has(.changed) + #row img {height:220px;object-fit:cover}'; document.head.appendChild(sheet);
    try {
      applyMediaLayouts(readMediaLayouts([owner])); expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      if (trigger === 'class') toggle.className = 'changed';
      else {const marker = document.createElement('i'); marker.className = 'changed'; toggle.appendChild(marker);}
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      expect(image.style.transform).toBe('none');
    } finally {sheet.remove();}
  });

  it.each(['inline', 'class', 'logical-padding'] as const)('releases after authored containing-column %s sizing changes', async trigger => {
    const {image, column, owner, resize} = fixture(); resize(700);
    if (trigger === 'logical-padding') {
      // JSDOM keeps this shorthand without exposing its native longhands.
      // Model the CSSOM values; native regressions exercise real shorthand CSS.
      const value = column.style.getPropertyValue.bind(column.style);
      vi.spyOn(column.style,'getPropertyValue').mockImplementation(property =>
        /^padding-block-(start|end)$/.test(property) ? value('padding-block') : value(property));
    }
    const sheet = document.createElement('style'); sheet.textContent = '#column.changed {height:220px}'; document.head.appendChild(sheet);
    try {
      applyMediaLayouts(readMediaLayouts([owner])); expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      if (trigger === 'inline') column.style.height = '220px';
      else if (trigger === 'logical-padding') column.style.paddingBlock = '12px';
      else column.className = 'changed';
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      applyMediaLayouts(readMediaLayouts([owner])); expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    } finally {sheet.remove();}
  });

  it.each(['class', 'stylesheet'] as const)('releases a media constraint after ancestor %s changes its image sizing and crop', async trigger => {
    const {image, owner, resize} = fixture(); resize(700);
    const sheet = document.createElement('style'); sheet.textContent = '#row.vertical img {height:220px;object-fit:cover}'; document.head.appendChild(sheet);
    try {
      applyMediaLayouts(readMediaLayouts([owner]));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      document.getElementById('row')!.style.color = 'red'; await new Promise(resolve => setTimeout(resolve, 80));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      if (trigger === 'class') document.getElementById('row')!.classList.add('vertical');
      else sheet.textContent = '#row img {height:220px;object-fit:cover}';
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      applyMediaLayouts(readMediaLayouts([owner]));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      expect(image.style.transform).toBe('none'); expect(document.getElementById('row')!.style.color).toBe('red');
    } finally {sheet.remove();}
  });

  it.each(['source', 'srcset', 'sizes', 'inline-style', 'class', 'transfer', 'transform', 'position', 'owner-transfer', 'owner-delete'] as const)(
    'removes an installed media rule after %s without undoing page edits', async operation => {
      const { image, owner, resize } = fixture(); resize(700);
      applyMediaLayouts(readMediaLayouts([owner]));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
      const original = image;
      if (operation === 'source') image.src = '/new.svg';
      if (operation === 'srcset') image.srcset = '/new.svg 2x';
      if (operation === 'sizes') image.sizes = '300px';
      if (operation === 'inline-style') { image.style.height = '80px'; image.style.objectFit = 'cover'; }
      if (operation === 'class') image.classList.add('new-image-layout');
      if (operation === 'transfer') document.body.appendChild(image);
      if (operation === 'transform') image.style.transform = 'scale(1.5)';
      if (operation === 'position') image.style.position = 'absolute';
      if (operation === 'owner-transfer') document.body.appendChild(owner);
      if (operation === 'owner-delete') owner.remove();
      const edited = image.getAttribute('style');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
      expect(document.querySelector('style[data-dual-read-media-style]')).toBeNull();
      expect(image).toBe(original); expect(image.getAttribute('style')).toBe(edited);
      applyMediaLayouts(readMediaLayouts([owner]));
      expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    },
  );

  it('retains a shared media rule while a second owner remains in its row', async () => {
    const { host, image, owner, resize } = fixture(); resize(700);
    const second = document.createElement('span'); host.appendChild(second); attachMediaLayouts(host, second);
    applyMediaLayouts(readMediaLayouts([owner, second]));
    document.body.appendChild(owner);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
    releaseMediaLayout(second);
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
  });

  it('registers a later companion after the first rule has constrained the image', () => {
    const { host, image, owner, resize } = fixture();
    resize(700);
    applyMediaLayouts(readMediaLayouts([owner]));
    resize(400);
    const second = document.createElement('span');
    host.appendChild(second);
    attachMediaLayouts(host, second);
    applyMediaLayouts(readMediaLayouts([second]));
    releaseMediaLayout(owner);
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
    releaseMediaLayout(second);
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    expect(document.querySelector('style[data-dual-read-media-style]')).toBeNull();
  });

  it('preserves source overhang and constrains only newly expanded media, through owned CSS', () => {
    const { image, owner, resize } = fixture();
    const style = image.getAttribute('style');
    expect(readMediaLayouts([owner])).toEqual([]);
    resize(700);
    const changes = readMediaLayouts([owner]);
    expect(changes).toHaveLength(1);
    applyMediaLayouts(changes);
    expect(document.querySelector('style[data-dual-read-media-style]')!.textContent).toContain('max-width: 200%');
    expect(image.getAttribute('style')).toBe(style);
    image.style.objectFit = 'cover';
    releaseMediaLayout(owner);
    expect(image.style.objectFit).toBe('cover');
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    expect(document.querySelector('style[data-dual-read-media-style]')).toBeNull();
  });

  it('allows proportional column resizing and ignores growth that fits the viewport', () => {
    const { owner, resize } = fixture();
    resize(600, 300);
    expect(readMediaLayouts([owner])).toEqual([]);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    resize(700);
    expect(readMediaLayouts([owner])).toEqual([]);
  });

  it('does not apply an old source snapshot after image replacement or transfer', () => {
    const { image, owner, resize } = fixture(); resize(700);
    image.src = '/new-diagram.svg';
    expect(readMediaLayouts([owner])).toEqual([]);
    image.src = '/diagram.svg';
    document.body.appendChild(image);
    expect(readMediaLayouts([owner])).toEqual([]);
  });

  it('retains an image animation introduced by the page', () => {
    const { image, owner, resize } = fixture(); resize(700);
    image.style.transform = 'scale(1.5)';
    expect(readMediaLayouts([owner])).toEqual([]);
  });

  it('keeps a shared rule until all connected translated owners are released', () => {
    const { host, owner, resize } = fixture(); resize(700);
    const second = document.createElement('span'); host.appendChild(second); attachMediaLayouts(host, second);
    applyMediaLayouts(readMediaLayouts([owner, second]));
    releaseMediaLayout(owner);
    expect(document.querySelector('style[data-dual-read-media-style]')).not.toBeNull();
    releaseMediaLayout(second);
    expect(document.querySelector('style[data-dual-read-media-style]')).toBeNull();
  });

  it.each(['plain', 'rich', 'segment'] as const)('protects media after %s replacement and releases it during unit restore', kind => {
    const { host, image, resize } = fixture();
    const original = host.firstChild as Text;
    const unit: TranslationUnit = { el: host, text: 'Original prose.', kind: 'block' };
    if (kind === 'rich') unit.rich = { slots: ['Original prose.'] };
    if (kind === 'segment') { unit.segment = true; unit.nodes = [original]; }
    const reservations = renderBatch([{ unit, payload: kind === 'rich' ? ['翻译后的正文。'] : '翻译后的正文。' }], 'replace');
    resize(700);
    applyMediaLayouts(readMediaLayouts(reservations.map(({ node }) => node)));
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(true);
    image.style.objectFit = 'cover';
    restoreUnit(host);
    expect(image.hasAttribute('data-dual-read-media-bound')).toBe(false);
    expect(image.style.objectFit).toBe('cover');
    expect(host.firstChild).toBe(original);
  });

  it('clears orphaned rules without restoring a removed image', () => {
    const { image, owner, resize } = fixture(); resize(700);
    applyMediaLayouts(readMediaLayouts([owner])); image.remove();
    restoreMediaLayouts(document); restoreMediaLayouts(document);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('style[data-dual-read-media-style]')).toBeNull();
  });

  it.each(['nav', 'div'])('retains chrome and positioned overlay policies: %s', tag => {
    const { host, owner, resize } = fixture();
    restoreMediaLayouts(document);
    const container = document.createElement(tag);
    if (tag === 'div') container.style.position = 'absolute';
    host.replaceWith(container); container.appendChild(host);
    captureMediaLayouts([host]); attachMediaLayouts(host, owner); resize(700);
    expect(readMediaLayouts([owner])).toEqual([]);
  });
});
