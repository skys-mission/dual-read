// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {matchingSpecificity, resolveNestedSelector, resolveRootSelector} from '../lib/renderer/selector-specificity';

const rule = (): CSSRule => ({type:1} as CSSRule);
describe('matching author selector specificity', () => {
  it.each([
    ['#box', [1,0,0]], ['.box.bounded', [0,2,0]], ['section.box[data-note]', [0,2,1]],
    [':where(#box,.box)', [0,0,0]], [':is(#missing,.box)', [1,0,0]],
    [':not(#missing)', [1,0,0]], [':has(> #child)', [1,0,0]],
    ['*|section.box', [0,1,1]], ['[data-note="a,b"]', [0,1,0]],
    ['.\\62 ox', [0,1,0]], [':is(.box,[data-note="a,b"])', [0,1,0]],
  ] as const)('reads %s without confusing list commas or escaped identifiers', (selector, expected) => {
    document.body.innerHTML = '<section id="box" class="box bounded" data-note="a,b"><span id="child"></span></section>';
    const box = document.getElementById('box')!;
    // JSDOM cannot match wildcard namespaces or this hex escape. Syntax and
    // specificity are parsed here; the native matrix verifies real matching.
    if (selector.startsWith('*|') || selector.includes('\\62')) box.matches = () => true;
    expect(matchingSpecificity(rule(),selector,box)).toEqual([...expected]);
  });

  it('re-evaluates matching list arms while retaining cached syntax', () => {
    document.body.innerHTML = '<section id="box" class="box"></section>';
    const box = document.getElementById('box')!, source = '#box, .box', stylesheetRule = rule();
    expect(matchingSpecificity(stylesheetRule,source,box)).toEqual([1,0,0]);
    box.id = 'other';expect(matchingSpecificity(stylesheetRule,source,box)).toEqual([0,1,0]);
  });

  it('does not count an unmatched high-specificity arm in a rule list', () => {
    document.body.innerHTML = '<section class="box"></section>';
    expect(matchingSpecificity(rule(),'#missing, .box',document.querySelector('section')!)).toEqual([0,1,0]);
  });

  it('invalidates syntax cache after CSSOM selector replacement', () => {
    document.body.innerHTML = '<section id="box" class="box"></section>';
    const box = document.getElementById('box')!, stylesheetRule = rule();
    expect(matchingSpecificity(stylesheetRule,'.box',box)).toEqual([0,1,0]);
    expect(matchingSpecificity(stylesheetRule,'#box',box)).toEqual([1,0,0]);
  });

  it('bounds deeply nested selectors and conservatively rejects unsupported parsing', () => {
    document.body.innerHTML = '<section id="box"></section>';
    const box = document.getElementById('box')!;
    expect(matchingSpecificity(rule(),':is('.repeat(80)+'#box'+')'.repeat(80),box)).toBeNull();
    expect(matchingSpecificity(rule(),'#box'+ ' '.repeat(16384),box)).toBeNull();
    expect(matchingSpecificity(rule(),'[',box)).toBeNull();
  });
});

describe('native nesting selector expansion', () => {
  it.each([
    ['& .box[data-note="a&b"]', ':is(#scope) .box[data-note="a&b"]'],
    ["& [data-note='a&b']", ":is(#scope) [data-note='a&b']"],
    ['& .escaped\\&name', ':is(#scope) .escaped\\&name'],
    ['& [data-note="a,b&c"]', ':is(#scope) [data-note="a,b&c"]'],
    ['& :is(.box,[data-note="a&b"])', ':is(#scope) :is(.box,[data-note="a&b"])'],
    ['.box[data-note="a&b"]', ':is(#scope) .box[data-note="a&b"]'],
    ['& > .box', ':is(#scope) > .box'],
    ['> .box', ':is(#scope) > .box'],
    [':where(&) .box', ':where(:is(#scope)) .box'],
    ['& + &', ':is(#scope) + :is(#scope)'],
  ])('expands nesting while preserving literals in %s', (source, expected) => {
    expect(resolveNestedSelector(rule(),source,'#scope')).toBe(expected);
  });

  it('scopes every implicit arm and preserves parent selector-list specificity', () => {
    const source = resolveNestedSelector(rule(),'.box,.other','.scope,#missing')!;
    document.body.innerHTML = '<main class="scope"><p class="box"></p><p class="other"></p></main><p class="other" id="outside"></p>';
    for (const element of document.querySelectorAll('main p')) {
      expect(element.matches(source)).toBe(true);expect(matchingSpecificity(rule(),source,element)).toEqual([1,1,0]);
    }
    expect(document.getElementById('outside')!.matches(source)).toBe(false);
  });

  it('uses cached syntax only while both the child and parent selectors remain identical', () => {
    const styleRule = rule(), first = resolveNestedSelector(styleRule,'& .box','.one');
    expect(resolveNestedSelector(styleRule,'& .box','.one')).toBe(first);
    expect(resolveNestedSelector(styleRule,'& .box','.two')).not.toBe(first);
    expect(resolveNestedSelector(styleRule,'& .other','.two')).toBe(':is(.two) .other');
  });

  it('conservatively bounds parsing and expanded selector growth', () => {
    expect(resolveNestedSelector(rule(),'[','#scope')).toBeNull();
    expect(resolveNestedSelector(rule(),':is('.repeat(80)+'&'+')'.repeat(80),'#scope')).toBeNull();
    expect(resolveNestedSelector(rule(),'&','x'.repeat(16384))).toBeNull();
    expect(resolveNestedSelector(rule(),'& '.repeat(100),'.'+'x'.repeat(300))).toBeNull();
  });
});

describe('stylesheet root scope', () => {
  it.each(['&.high .box', ':is(&).high .box', ':where(&).high .box', '& .box,& .other'])('roots %s without adding nesting specificity', source => {
    document.documentElement.className = 'high';document.body.innerHTML = '<p class="box"></p>';
    const box = document.querySelector('p')!, resolved = resolveRootSelector(rule(),source);
    // NWSAPI cannot match these nested functional forms. The browser matrix
    // checks their actual matching and winning cascade on both engines.
    if (source.startsWith(':')) box.matches = () => true;
    expect(resolved.contextual).toBe(true);expect(box.matches(resolved.selector!)).toBe(true);
    expect(matchingSpecificity(rule(),resolved.selector!,box)).toEqual(source.includes('.high')?[0,2,0]:[0,1,0]);
    document.documentElement.className = '';
  });
  it('keeps literal ampersands and marks actual host/scope selectors contextual', () => {
    expect(resolveRootSelector(rule(),'[data-note="a&b"]')).toEqual({source:'[data-note="a&b"]',selector:'[data-note="a&b"]',contextual:false});
    for (const source of [':scope .box',':host(.high) .box','::slotted(.box)']) expect(resolveRootSelector(rule(),source).contextual).toBe(true);
  });
  it('invalidates root syntax after selector replacement and bounds parsing', () => {
    const r = rule();expect(resolveRootSelector(r,'& .one').selector).not.toBe(resolveRootSelector(r,'& .two').selector);
    expect(resolveRootSelector(r,'[').selector).toBeNull();expect(resolveRootSelector(r,'&'+' '.repeat(16384)).selector).toBeNull();
  });
});
