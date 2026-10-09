// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readComputedSizing, readSourceLayoutPolicy, readSourceLayoutPolicyState, readUnmaskedLayoutProperty} from '../lib/renderer/source-layout-policy';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.head.querySelectorAll('style[data-test-policy]').forEach(node => node.remove());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture(css: string): {box: HTMLElement; sheet: HTMLStyleElement} {
  document.body.innerHTML = '<main id="parent"><section id="box"></section></main>';
  const sheet = document.createElement('style'); sheet.dataset.testPolicy = 'true'; sheet.textContent = css;
  document.head.appendChild(sheet);
  return {box: document.getElementById('box')!, sheet};
}

describe('layout dependencies and page motion', () => {
  it.each(['height', 'min-height', 'max-height', 'block-size', 'padding-top', 'border-top-width'])('tracks the inherited %s source and ignores parent paint', property => {
    const {box} = fixture(`#parent{${property}:80px}#box{${property}:inherit}`);
    const before = readSourceLayoutPolicyState(box, [property]);
    box.parentElement!.style.color = 'red';
    expect(readSourceLayoutPolicyState(box, [property])).toEqual(before);
    box.parentElement!.style.setProperty(property, '50px');
    expect(readSourceLayoutPolicyState(box, [property]).signature).not.toBe(before.signature);
  });

  it('follows multiple inherited ancestors and changes of parent ownership', () => {
    const {box} = fixture('#parent{height:inherit}#box{height:inherit}body{height:80px}');
    const before = readSourceLayoutPolicy(box, ['height']);
    document.body.style.height = '50px';
    expect(readSourceLayoutPolicy(box, ['height'])).not.toBe(before);
    const parent = document.createElement('article');parent.style.height = '30px';document.body.append(parent);parent.append(box);
    expect(readSourceLayoutPolicy(box, ['height'])).toContain('30px');
    document.body.style.height = '';
  });

  it('tracks inherit used as a variable fallback without treating a variable name as a keyword', () => {
    const {box, sheet} = fixture('#parent{height:80px}#box{height:var(--absent, inherit)}');
    const before = readSourceLayoutPolicy(box, ['height']);box.parentElement!.style.height = '50px';
    expect(readSourceLayoutPolicy(box, ['height'])).not.toBe(before);
    sheet.textContent = '#parent{height:80px}#box{height:var(--inherit)}';box.style.setProperty('--inherit','20px');
    const independent = readSourceLayoutPolicy(box, ['height']);box.parentElement!.style.height = '30px';
    expect(readSourceLayoutPolicy(box, ['height'])).toBe(independent);
  });

  it('uses the rendered slot as the inheritance parent', () => {
    const {box} = fixture('#box{height:inherit}');
    const host = document.createElement('div');document.body.append(host);host.append(box);
    const root = host.attachShadow({mode:'open'});root.innerHTML = '<slot style="height:80px"></slot>';
    const before = readSourceLayoutPolicy(box, ['height']);root.querySelector('slot')!.style.height = '50px';
    expect(readSourceLayoutPolicy(box, ['height'])).not.toBe(before);
  });

  it('inherits the mapped physical property across different writing modes', () => {
    const {box} = fixture('#parent{width:80px;height:20px}#box{writing-mode:vertical-rl;block-size:inherit}');
    const before = readSourceLayoutPolicy(box,['block-size']);box.parentElement!.style.height = '30px';
    expect(readSourceLayoutPolicy(box,['block-size'])).toBe(before);
    box.parentElement!.style.width = '50px';expect(readSourceLayoutPolicy(box,['block-size'])).not.toBe(before);
  });

  it('does not declare a dependency beyond the bounded ancestry budget complete', () => {
    const {box} = fixture('section{height:inherit}#box{height:inherit}');
    for (let i = 0; i < 34; i++) {const parent = document.createElement('section');box.parentNode!.insertBefore(parent,box);parent.append(box);}
    expect(readSourceLayoutPolicyState(box, ['height']).complete).toBe(false);
  });

  function animationFixture(property: string, target?: Element, pseudoElement: string | null = null) {
    const {box} = fixture('#box{height:80px;border-style:solid;height:var(--size,80px)}');
    class Effect {
      target = target ?? box;
      pseudoElement = pseudoElement;
      getKeyframes() {return [{[property]:'80px',offset:0},{[property]:'50px',offset:1}];}
    }
    vi.stubGlobal('KeyframeEffect', Effect);
    const animation = {effect:new Effect(),currentTime:0} as unknown as Animation;
    const getAnimations = vi.fn(() => [animation]);Object.defineProperty(box,'getAnimations',{value:getAnimations,configurable:true});
    return {box,animation,getAnimations};
  }

  it.each(['height','blockSize','minHeight','borderBlockStartWidth','--size'])('detects selected %s motion but keeps frame time out of the signature', property => {
    const {box,animation,getAnimations} = animationFixture(property);
    const selected = ['height','min-height','border-top-width'];
    const before = readSourceLayoutPolicyState(box, selected);expect(before.animated).toBe(true);
    animation.currentTime = 50;
    expect(readSourceLayoutPolicyState(box, selected)).toEqual(before);
    getAnimations.mockReturnValue([]);expect(readSourceLayoutPolicyState(box, selected).animated).toBeUndefined();
    expect(readSourceLayoutPolicyState(box, selected).signature).not.toBe(before.signature);
  });

  it.each(['color','opacity','transform','width'])('ignores unselected %s animation', property => {
    const {box,getAnimations} = animationFixture(property);const before = readSourceLayoutPolicyState(box,['height']);
    expect(before.animated).toBeUndefined();getAnimations.mockReturnValue([]);
    expect(readSourceLayoutPolicyState(box,['height'])).toEqual(before);
  });

  it.each(['other-target','pseudo'])('ignores %s motion', kind => {
    const other = document.createElement('div');
    const {box} = animationFixture('height',kind === 'other-target' ? other : undefined,kind === 'pseudo' ? '::before' : null);
    expect(readSourceLayoutPolicyState(box,['height']).animated).toBeUndefined();
  });

  it('propagates animation ownership through an inherited selected size', () => {
    const {box,animation} = animationFixture('height');
    box.style.height = 'inherit';(animation.effect as KeyframeEffect).target = box.parentElement;
    Object.defineProperty(box.parentElement!, 'getAnimations', {value:() => [animation],configurable:true});
    expect(readSourceLayoutPolicyState(box,['height']).animated).toBe(true);
  });
});

describe('authored layout policy', () => {
  it('observes stylesheet root & changes using document scope', () => {
    const {box} = fixture('&.high #box{height:80px}#box{height:50px}');document.documentElement.className='high';
    const before=readSourceLayoutPolicyState(box,['height']);expect(before.complete).toBe(true);expect(before.signature).toContain('80px');
    document.documentElement.className='low';expect(readSourceLayoutPolicyState(box,['height']).signature).not.toBe(before.signature);document.documentElement.className='';
  });
  it('reads a logical border width and its effective style from a physical edge request', () => {
    const {box} = fixture('#box{border-width:0;border-style:solid}');box.style.borderBlockStartWidth='20px';
    const before=readSourceLayoutPolicyState(box,['height','border-top-width']);expect(before.signature).toContain('border-block-start-width');
    box.style.borderBlockStartWidth='0px';expect(readSourceLayoutPolicyState(box,['height','border-top-width']).signature).not.toBe(before.signature);
  });
  it('detects border style collapse while ignoring a border color change', () => {
    const {box,sheet} = fixture('#box{border-width:20px;border-style:solid}');const before=readSourceLayoutPolicy(box,['border-top-width']);
    box.style.borderTopColor='red';expect(readSourceLayoutPolicy(box,['border-top-width'])).toBe(before);
    sheet.textContent='#box{border-width:20px;border-style:none}';expect(readSourceLayoutPolicy(box,['border-top-width'])).not.toBe(before);
  });
  it('tracks different specificity when matching declarations remain identical', () => {
    const {box} = fixture('.high #box{height:80px}:where(.low) #box{height:80px}#box.bounded{height:50px}');
    box.className = 'bounded';const parent = box.parentElement!;parent.className = 'high';
    const before = readSourceLayoutPolicy(box,['height']);parent.className = 'low';
    expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('tracks a changed matching arm within a constant selector list', () => {
    const {box} = fixture('#box,.box{height:80px}.box.bounded{height:50px}');box.className = 'box bounded';
    const before = readSourceLayoutPolicy(box,['height']);box.id = 'other';
    expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('keeps equal-specificity state rules and reordered selector lists stable', () => {
    const {box, sheet} = fixture('.high #box,.same #box{height:80px}.low #box{height:80px}#box.bounded{height:50px}');
    const parent = box.parentElement!;parent.className = 'high';box.className = 'bounded';
    const before = readSourceLayoutPolicy(box,['height']);parent.className = 'low';
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
    parent.className = 'high';sheet.textContent = sheet.textContent!.replace('.high #box,.same #box','.same #box,.high #box');
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });

  it('keeps a stable precedence relationship when the stronger selector gains specificity', () => {
    const {box, sheet} = fixture('#box{height:80px}.bounded{height:50px}');box.className = 'bounded';
    const before = readSourceLayoutPolicy(box,['height']);sheet.textContent = '#box.bounded{height:80px}.bounded{height:50px}';
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });

  it('does not compare specificity between different selected properties', () => {
    const {box, sheet} = fixture('#box{height:80px}.bounded{width:260px}');box.className = 'bounded';
    const before = readSourceLayoutPolicy(box,['height','width']);sheet.textContent = '#box{height:80px}#box.bounded{width:260px}';
    expect(readSourceLayoutPolicy(box,['height','width'])).toBe(before);
  });

  const dimensions = [
    ['height','block-size'], ['width','inline-size'],
    ['min-height','min-block-size'], ['max-height','max-block-size'],
    ['min-width','min-inline-size'], ['max-width','max-inline-size'],
  ];
  it.each(dimensions)('tracks competing specificity between %s and %s', (physical, logical) => {
    const {box} = fixture(`.high #box{${physical}:80px}:where(.low) #box{${physical}:80px}#box.bounded{${logical}:50px}`);
    box.className = 'bounded';box.parentElement!.className = 'high';
    const before = readSourceLayoutPolicy(box,[physical,logical]);box.parentElement!.className = 'low';
    expect(readSourceLayoutPolicy(box,[physical,logical])).not.toBe(before);
  });

  it.each(dimensions)('tracks declaration order between %s and %s', (physical, logical) => {
    const {box, sheet} = fixture(`#box{${physical}:50px;${logical}:80px}`);
    const before = readSourceLayoutPolicy(box,[physical,logical]);sheet.textContent = `#box{${logical}:80px;${physical}:50px}`;
    expect(readSourceLayoutPolicy(box,[physical,logical])).not.toBe(before);
  });

  it('tracks competing inline declaration order without reacting to unrelated paint order', () => {
    const {box} = fixture('');box.style.cssText = 'height:50px;color:red;block-size:80px';
    const before = readSourceLayoutPolicy(box,['height','block-size','width']);
    box.style.cssText = 'color:blue;height:50px;block-size:80px;width:260px';
    const width = readSourceLayoutPolicy(box,['height','block-size','width']);expect(width).not.toBe(before);
    box.style.cssText = 'width:260px;height:50px;block-size:80px;color:green';
    expect(readSourceLayoutPolicy(box,['height','block-size','width'])).toBe(width);
    box.style.cssText = 'width:260px;block-size:80px;height:50px';
    expect(readSourceLayoutPolicy(box,['height','block-size','width'])).not.toBe(width);
  });

  it('ignores order changes between differently important aliases', () => {
    const {box, sheet} = fixture('#box{height:50px!important;block-size:80px}');
    const before = readSourceLayoutPolicy(box,['height','block-size']);sheet.textContent = '#box{block-size:80px;height:50px!important}';
    expect(readSourceLayoutPolicy(box,['height','block-size'])).toBe(before);
  });

  it.each(['vertical-rl','vertical-lr','sideways-rl','sideways-lr'])('maps size competition under %s', writingMode => {
    const {box, sheet} = fixture('.high #box{width:80px}:where(.low) #box{width:80px}#box.bounded{block-size:50px}');
    box.className = 'bounded';box.style.writingMode = writingMode;box.parentElement!.className = 'high';
    const before = readSourceLayoutPolicy(box,['width','block-size']);box.parentElement!.className = 'low';
    expect(readSourceLayoutPolicy(box,['width','block-size'])).not.toBe(before);
    sheet.textContent = '.high #box{height:80px}:where(.low) #box{height:80px}#box.bounded{block-size:50px}';
    box.parentElement!.className = 'high';const unrelated = readSourceLayoutPolicy(box,['height','block-size']);
    box.parentElement!.className = 'low';expect(readSourceLayoutPolicy(box,['height','block-size'])).toBe(unrelated);
  });

  it('tracks mapping changes but retains a stronger competing selector whose numeric weight grows', () => {
    const {box, sheet} = fixture('#box{height:80px}.bounded{block-size:50px}');box.className = 'bounded';
    const before = readSourceLayoutPolicy(box,['height','block-size']);sheet.textContent = '#box.bounded{height:80px}.bounded{block-size:50px}';
    expect(readSourceLayoutPolicy(box,['height','block-size'])).toBe(before);
    box.style.writingMode = 'vertical-rl';expect(readSourceLayoutPolicy(box,['height','block-size'])).not.toBe(before);
  });

  function nestedFixture(selector = '#box') {
    const {box, sheet} = fixture('');
    const parentStyle = document.createElement('span').style;parentStyle.height = '80px';
    const nestedStyle = document.createElement('span').style;nestedStyle.height = '80px';
    const nested = {type:0, constructor:{name:'CSSNestedDeclarations'}, cssText:'height:80px', style:nestedStyle};
    const parent = {type:1, selectorText:selector, cssText:`${selector} {}`, style:parentStyle, cssRules:[nested] as unknown[]};
    Object.defineProperty(sheet.sheet!, 'cssRules', {value:[parent], configurable:true});
    return {box, sheet, parent, nested, nestedStyle};
  }

  it('reads declarations after nested rules at their original cascade position', () => {
    const {box, parent, nested, nestedStyle} = nestedFixture();
    parent.cssRules.unshift({type:4,conditionText:'',cssText:'@media all {}',cssRules:[]});
    const before = readSourceLayoutPolicyState(box,['height']);expect(before.complete).toBe(true);
    nestedStyle.height = '50px';expect(readSourceLayoutPolicyState(box,['height']).signature).not.toBe(before.signature);
    nestedStyle.height = '80px';parent.cssRules = [nested,...parent.cssRules.slice(0,1)];
    expect(readSourceLayoutPolicyState(box,['height']).signature).toBe(before.signature);
  });

  it('honors active media conditions around raw nested declarations', () => {
    const {box, parent, nested, nestedStyle} = nestedFixture();
    parent.cssRules = [{type:4,conditionText:'(min-width:1px)',cssText:'@media {}',cssRules:[nested]}];
    let matches = false;vi.stubGlobal('matchMedia',() => ({matches}));
    const inactive = readSourceLayoutPolicy(box,['height']);nestedStyle.height = '50px';expect(readSourceLayoutPolicy(box,['height'])).toBe(inactive);
    matches = true;expect(readSourceLayoutPolicy(box,['height'])).not.toBe(inactive);
  });

  it('uses matching parent-list specificity for nested declarations instead of implicit &:is()', () => {
    const {box, sheet, parent, nestedStyle} = nestedFixture('#missing,.bounded');box.className = 'bounded';parent.style.height = '';
    const competitor = document.createElement('span').style;competitor.height = '50px';
    (sheet.sheet!.cssRules as unknown as unknown[]).push({type:1,selectorText:'.bounded.bounded',cssText:'.bounded.bounded {}',style:competitor});
    const low = readSourceLayoutPolicy(box,['height']);parent.selectorText = '#box,.bounded';
    expect(readSourceLayoutPolicy(box,['height'])).not.toBe(low);
    nestedStyle.setProperty('height','80px','important');expect(readSourceLayoutPolicy(box,['height'])).not.toBe(low);
  });

  it('does not fingerprint unrelated properties or a nonmatching nested parent', () => {
    const {box, nestedStyle} = nestedFixture('#other');
    const before = readSourceLayoutPolicyState(box,['height']);nestedStyle.height = '50px';expect(readSourceLayoutPolicyState(box,['height'])).toEqual(before);
    expect(readSourceLayoutPolicyState(box,['width'])).toEqual({signature:'[[],[]]',complete:true});
  });

  it('marks an unknown raw declaration rule uncertain rather than silently complete', () => {
    const {box, nested} = nestedFixture();nested.constructor.name = 'UnknownDeclarations';
    expect(readSourceLayoutPolicyState(box,['height']).complete).toBe(false);
    expect(readSourceLayoutPolicyState(box,['width']).complete).toBe(true);
  });

  const paddingModes = [
    ['horizontal-tb','ltr',['top','bottom','left','right']],
    ['horizontal-tb','rtl',['top','bottom','right','left']],
    ['vertical-rl','ltr',['right','left','top','bottom']],
    ['vertical-rl','rtl',['right','left','bottom','top']],
    ['vertical-lr','ltr',['left','right','top','bottom']],
    ['vertical-lr','rtl',['left','right','bottom','top']],
    ['sideways-rl','ltr',['right','left','top','bottom']],
    ['sideways-rl','rtl',['right','left','bottom','top']],
    ['sideways-lr','ltr',['left','right','bottom','top']],
    ['sideways-lr','rtl',['left','right','top','bottom']],
  ] as const;
  const paddingCases = paddingModes.flatMap(([writingMode,direction,sides]) =>
    ['block-start','block-end','inline-start','inline-end'].map((edge,index) => ({writingMode,direction,logical:`padding-${edge}`,physical:`padding-${sides[index]}`})));
  it.each(paddingCases)('tracks $logical against $physical under $writingMode/$direction', ({writingMode,direction,logical,physical}) => {
    const {box,sheet} = fixture(`.high.active #box{${physical}:20px}:where(.low) #box{${physical}:20px}#box.bounded{${logical}:0px}`);
    box.className = 'bounded';box.style.writingMode = writingMode;box.style.direction = direction;box.parentElement!.className = 'high active';
    const before = readSourceLayoutPolicy(box,[physical,logical]);box.parentElement!.className = 'low';
    expect(readSourceLayoutPolicy(box,[physical,logical])).not.toBe(before);
    sheet.textContent = `#box{${physical}:20px;${logical}:0px}`;
    const order = readSourceLayoutPolicy(box,[physical,logical]);sheet.textContent = `#box{${logical}:0px;${physical}:20px}`;
    expect(readSourceLayoutPolicy(box,[physical,logical])).not.toBe(order);
  });

  it('keeps unrelated edges, paint order and stronger padding selectors stable', () => {
    const {box,sheet} = fixture('#box{padding-top:20px}.bounded{padding-block-start:0px;padding-left:12px;color:red}');box.className = 'bounded';
    const before = readSourceLayoutPolicy(box,['padding-top','padding-block-start','padding-left']);
    sheet.textContent = '#box.bounded{padding-top:20px}.bounded{color:blue;padding-left:12px;padding-block-start:0px}';
    expect(readSourceLayoutPolicy(box,['padding-top','padding-block-start','padding-left'])).toBe(before);
  });

  it('tracks direction changes without changing a block edge or an unrelated physical dimension', () => {
    const {box} = fixture('#box{padding-inline-start:20px;padding-block-start:10px;height:80px}');
    box.style.direction = 'ltr';const inline = readSourceLayoutPolicy(box,['padding-inline-start']);const block = readSourceLayoutPolicy(box,['padding-block-start','height']);
    box.style.direction = 'rtl';expect(readSourceLayoutPolicy(box,['padding-inline-start'])).not.toBe(inline);expect(readSourceLayoutPolicy(box,['padding-block-start','height'])).toBe(block);
  });

  it('retains a raw shorthand when its longhands cannot be read', () => {
    const {box} = fixture('#box{padding-block:var(--pad)}');
    const computed = document.createElement('span').style;computed.setProperty('--pad','20px');
    const before = readSourceLayoutPolicyState(box,['padding-top','padding-block'],computed);expect(before.complete).toBe(false);
    expect(before.signature).toContain('var(--pad)');computed.setProperty('--pad','0px');
    expect(readSourceLayoutPolicyState(box,['padding-top','padding-block'],computed).signature).not.toBe(before.signature);
  });

  it('detects a pending physical shorthand from a selected longhand alone', () => {
    const {box,sheet} = fixture('#box{padding:var(--pad)}');
    const computed = document.createElement('span').style;computed.setProperty('--pad','20px');
    // Model pending substitution: native matrix verifies the actual CSSOM.
    const style = (sheet.sheet!.cssRules[0] as CSSStyleRule).style;
    const value = style.getPropertyValue.bind(style);
    vi.spyOn(style,'getPropertyValue').mockImplementation(property => /^padding-(top|right|bottom|left)$/.test(property) ? '' : value(property));
    const before = readSourceLayoutPolicyState(box,['padding-top'],computed);expect(before.complete).toBe(false);expect(before.signature).toContain('var(--pad)');
    computed.setProperty('--pad','0px');expect(readSourceLayoutPolicyState(box,['padding-top'],computed).signature).not.toBe(before.signature);
    expect(readSourceLayoutPolicyState(box,['height']).complete).toBe(true);
  });

  it('includes a requested edge alias while ignoring other edges', () => {
    const {box,sheet} = fixture('#box{padding-block-start:20px;padding-inline-start:12px}');
    const top = readSourceLayoutPolicy(box,['padding-top']);expect(top).toContain('padding-block-start');
    sheet.textContent = '#box{padding-block-start:20px;padding-inline-start:24px}';expect(readSourceLayoutPolicy(box,['padding-top'])).toBe(top);
    sheet.textContent = '#box{padding-block-start:0px;padding-inline-start:24px}';expect(readSourceLayoutPolicy(box,['padding-top'])).not.toBe(top);
  });

  function layerFixture() {
    const {box, sheet} = fixture('#box {height:80px}');
    const declaration = (height: string, priority = '') => {
      const style = document.createElement('span').style; style.setProperty('height', height, priority);
      return {type: 1, selectorText: '#box', style, cssText: '#box {}'};
    };
    const block = (name: string, cssRules: unknown[]) => ({type:0, name, cssRules, cssText:`@layer ${name} {}`});
    const statement = (nameList: string[]) => ({type:0, nameList, cssText:`@layer ${nameList.join(',')};`});
    const set = (rules: unknown[]) => Object.defineProperty(sheet.sheet!, 'cssRules', {value:rules, configurable:true});
    return {box, sheet, declaration, block, statement, set};
  }

  it('tracks reordered layers even when matching declarations and their traversal order do not change', () => {
    const {box, declaration, block, statement, set} = layerFixture();
    const order = statement(['large','small']); set([order, block('small',[declaration('80px')]), block('large',[declaration('50px')])]);
    const initial = readSourceLayoutPolicyState(box,['height']); expect(initial.complete).toBe(true);
    order.nameList.reverse(); expect(readSourceLayoutPolicyState(box,['height']).signature).not.toBe(initial.signature);
  });

  it('tracks relative order within nested layers', () => {
    const {box, declaration, block, statement, set} = layerFixture();
    const order = statement(['large','small']); set([block('page',[order, block('small',[declaration('80px')]), block('large',[declaration('50px')])])]);
    const before = readSourceLayoutPolicy(box,['height']); order.nameList.reverse();
    expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('ignores paint-only layers that do not change the relative order of sizing inputs', () => {
    const {box, declaration, block, statement, set} = layerFixture();
    const order = statement(['paint','small','large']); set([order, block('paint',[]), block('small',[declaration('80px')]), block('large',[declaration('50px')])]);
    const before = readSourceLayoutPolicy(box,['height']); order.nameList = ['small','paint','large'];
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });

  it('distinguishes layered, anonymous and unlayered declaration ownership', () => {
    const {box, declaration, block, set} = layerFixture();
    set([block('page',[declaration('80px')])]); const named = readSourceLayoutPolicy(box,['height']);
    set([block('',[declaration('80px')])]); const anonymous = readSourceLayoutPolicy(box,['height']);
    set([declaration('80px')]); const unlayered = readSourceLayoutPolicy(box,['height']);
    expect(new Set([named,anonymous,unlayered]).size).toBe(3);
  });

  it.each(['insert', 'remove', 'move', 'replace'] as const)('keeps anonymous sizing layers stable after a paint-only layer %s', operation => {
    const {box, declaration, block, set} = layerFixture();
    const sizing = block('',[declaration('80px')]), paint = block('',[]);
    set(operation === 'insert' ? [sizing] : [paint,sizing]);
    const before = readSourceLayoutPolicy(box,['height']);
    set(operation === 'remove' ? [sizing] : operation === 'move' ? [sizing,paint]
      : operation === 'replace' ? [block('',[]),block('',[declaration('80px')])] : [paint,sizing]);
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });

  it('normalizes relevant anonymous parents and nested layers independently of unrelated siblings', () => {
    const {box, declaration, block, set} = layerFixture();
    set([block('',[block('',[declaration('80px')])])]);
    const before = readSourceLayoutPolicy(box,['height']);
    set([block('',[]),block('',[block('',[]),block('',[declaration('80px')]),block('',[])])]);
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });

  it('still invalidates reordered or newly matching anonymous sizing layers', () => {
    const {box, declaration, block, set} = layerFixture();
    const small = block('',[declaration('80px')]), large = block('',[declaration('50px')]);
    set([small,large]); const before = readSourceLayoutPolicy(box,['height']);
    set([large,small]); expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
    set([small]); expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('retains importance alongside layer context', () => {
    const {box, declaration, block, set} = layerFixture();
    const rule = declaration('80px'); set([block('page',[rule])]); const before = readSourceLayoutPolicy(box,['height']);
    rule.style.setProperty('height','80px','important'); expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('records an imported stylesheet in its declared layer', () => {
    const {box, declaration, statement, set} = layerFixture();
    const imported = {disabled:false, media:{mediaText:''}, cssRules:[declaration('80px')]};
    const rule = {type:3, cssText:'@import url(test.css) layer(small);', layerName:'small', styleSheet:imported};
    set([statement(['small','large']),rule]); const before = readSourceLayoutPolicy(box,['height']);
    rule.layerName = 'large'; expect(readSourceLayoutPolicy(box,['height'])).not.toBe(before);
  });

  it('omits owned layer order statements', () => {
    const {box, declaration, block, statement, set} = layerFixture();
    set([statement(['small','large']),block('small',[declaration('80px')]),block('large',[declaration('50px')])]);
    const before = readSourceLayoutPolicy(box,['height']);
    const owned = document.createElement('style'); owned.dataset.testPolicy = 'true'; owned.setAttribute('data-dual-read-layout-style','true');
    owned.textContent = '#box {height:auto!important}'; document.head.prepend(owned);
    Object.defineProperty(owned.sheet!, 'cssRules', {value:[statement(['large','small'])],configurable:true});
    expect(readSourceLayoutPolicy(box,['height'])).toBe(before);
  });
  it.each([':scope #box', '& #box'])('keeps scope-relative %s declarations uncertain even when Element.matches cannot select them', selector => {
    const {box, sheet} = fixture('#box {height:80px}');
    const style = document.createElement('span').style; style.height = '220px';
    const scope = {type: 0, cssText: '@scope (#parent) {}', cssRules: [{type: 1, selectorText: selector, style}]};
    Object.defineProperty(sheet.sheet!, 'cssRules', {value: [{type: 4, conditionText: '', cssText: '@media all {}', cssRules: [scope]}], configurable: true});
    vi.spyOn(box, 'matches').mockReturnValue(false);
    expect(readSourceLayoutPolicyState(box, ['height']).complete).toBe(false);
    expect(readSourceLayoutPolicyState(box, ['width']).complete).toBe(true);
  });

  it('distinguishes an opaque sheet from a complete empty author policy', () => {
    const {box, sheet} = fixture('#other {height:80px}');
    expect(readSourceLayoutPolicyState(box, ['height'])).toEqual({signature: '[[],[]]', complete: true});
    Object.defineProperty(sheet.sheet!, 'cssRules', {get: () => {throw new DOMException('Opaque sheet', 'SecurityError');}, configurable: true});
    expect(readSourceLayoutPolicyState(box, ['height'])).toEqual({signature: '[[],[]]', complete: false});
  });

  it.each(['container', 'scope'])('marks matching @%s inputs uncertain while keeping unrelated rules complete', condition => {
    const {box, sheet} = fixture('#box {height:80px}');
    const style = document.createElement('span').style; style.height = '220px';
    const rule = {type: 0, cssText: `@${condition} (width < 400px) {#box {height:220px}}`,
      cssRules: [{type: 1, selectorText: '#box', style}]};
    Object.defineProperty(sheet.sheet!, 'cssRules', {value: [rule], configurable: true});
    expect(readSourceLayoutPolicyState(box, ['height']).complete).toBe(false);
    expect(readSourceLayoutPolicyState(box, ['width']).complete).toBe(true);
    rule.cssRules[0].selectorText = '#other';
    expect(readSourceLayoutPolicyState(box, ['height']).complete).toBe(true);
  });

  it('tracks selected declarations and matching ancestry, ignoring unrelated paint and nonmatching rules', () => {
    const {box, sheet} = fixture('#box {height:80px;color:red} #parent.closed #box {height:0px!important} #other {height:10px}');
    const read = () => readSourceLayoutPolicy(box, ['height']);
    const before = read(); box.style.color = 'blue'; box.style.setProperty('--unrelated', '9px');
    sheet.textContent = sheet.textContent!.replace('color:red', 'color:green').replace('height:10px', 'height:20px');
    expect(read()).toBe(before);
    document.getElementById('parent')!.classList.add('closed'); expect(read()).not.toBe(before);
    document.getElementById('parent')!.classList.remove('closed'); expect(read()).toBe(before);
    box.style.setProperty('height', '80px', 'important'); expect(read()).not.toBe(before);
  });

  it('tracks resolved dependencies and fallback variables used by stylesheet declarations', () => {
    const {box} = fixture('#box {height:var(--Alias, var(--Fallback, 80px))}');
    const computed = document.createElement('div').style;
    computed.setProperty('--Alias', '80px'); computed.setProperty('--Fallback', '80px'); computed.setProperty('--unrelated', 'red');
    const read = () => readSourceLayoutPolicy(box, ['height'], computed);
    const before = read(); computed.setProperty('--unrelated', 'blue'); expect(read()).toBe(before);
    computed.setProperty('--Alias', '0px'); expect(read()).not.toBe(before);
    computed.setProperty('--Alias', '80px'); computed.setProperty('--Fallback', '0px'); expect(read()).not.toBe(before);
  });

  it('omits extension-owned rules so installing or rewriting a correction is not an author change', () => {
    const {box, sheet} = fixture('#box {height:80px}');
    const before = readSourceLayoutPolicy(box, ['height']);
    const owned = document.createElement('style'); owned.setAttribute('data-dual-read-layout-style', 'true');
    owned.dataset.testPolicy = 'true'; owned.textContent = '#box {height:auto!important;min-height:365px!important}'; document.head.appendChild(owned);
    expect(readSourceLayoutPolicy(box, ['height'])).toBe(before);
    owned.textContent = '#box {height:auto!important;min-height:80px!important}'; expect(readSourceLayoutPolicy(box, ['height'])).toBe(before);
    // Exercise live CSSOM declarations, not the style element's text.
    (sheet.sheet!.cssRules[0] as CSSStyleRule).style.height = '0px'; expect(readSourceLayoutPolicy(box, ['height'])).not.toBe(before);
  });

  it('honors stylesheet media conditions without treating computed reflow as a new authored dimension', () => {
    const {box} = fixture('@media (max-width:1000px) {#box {height:0px}} #box {height:80px}');
    let matches = false; vi.stubGlobal('matchMedia', () => ({matches}));
    const before = readSourceLayoutPolicy(box, ['height']);
    matches = true; expect(readSourceLayoutPolicy(box, ['height'])).not.toBe(before);
    matches = false; box.getBoundingClientRect = () => ({height:365} as DOMRect);
    expect(readSourceLayoutPolicy(box, ['height'])).toBe(before);
  });

  it('reads adopted shadow styles without mixing document and shadow rules', () => {
    const {box} = fixture('#shadow-box {height:999px}');
    const root = box.attachShadow({mode:'open'}); root.innerHTML = '<section id="shadow-box"></section>';
    const adopted = document.createElement('style'); adopted.dataset.testPolicy = 'true'; adopted.textContent = '#shadow-box {height:80px}'; document.head.appendChild(adopted);
    Object.defineProperty(root, 'adoptedStyleSheets', {value:[adopted.sheet], configurable:true});
    const source = root.getElementById('shadow-box') as HTMLElement;
    const before = readSourceLayoutPolicy(source, ['height']);
    (adopted.sheet!.cssRules[0] as CSSStyleRule).style.height = '0px'; expect(readSourceLayoutPolicy(source, ['height'])).not.toBe(before);
    expect(before).not.toContain('999');
  });
});

describe('unmasked cascade read', () => {
  function modelLayerInsertion(): void {
    // JSDOM's CSS parser lacks @layer. Native regressions verify its real
    // priority; these unit cases model insertion to verify cleanup/throws.
    const insert = CSSStyleSheet.prototype.insertRule;
    vi.spyOn(CSSStyleSheet.prototype, 'insertRule').mockImplementation(function(this: CSSStyleSheet, rule, index) {
      return insert.call(this, rule.startsWith('@layer ') ? rule.replace(/^@layer [^{]+\{/, '').slice(0, -1) : rule, index);
    });
  }

  it.each([false, true])('cleans the computed sizing probe and preserves owned rules and source attributes when throws=%s', throws => {
    const {box, sheet} = fixture('#box {height:auto!important;min-height:365px!important}');
    modelLayerInsertion();
    const original = (sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText;
    box.setAttribute('data-dual-read-sizing-probe', 'page-value');
    vi.stubGlobal('getComputedStyle', (_element: Element, pseudo?: string) => {
      if (!pseudo) return {getPropertyValue: () => '365px'};
      expect(pseudo).toBe('::before'); expect(sheet.sheet!.cssRules.length).toBe(1);
      expect(document.querySelector<HTMLStyleElement>('style[data-dual-read-sizing-style]')!.sheet!.cssRules.length).toBe(1);
      expect((sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText).toBe('');
      if (throws) throw new Error('sizing read failed');
      return {getPropertyValue: () => 'auto'};
    });
    if (throws) expect(() => readComputedSizing(box, ['height'], sheet)).toThrow('sizing read failed');
    else expect(readComputedSizing(box, ['height'], sheet)).toBe('[["height","auto"]]');
    expect(box.getAttribute('data-dual-read-sizing-probe')).toBe('page-value');
    expect(sheet.sheet!.cssRules.length).toBe(1); expect((sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText).toBe(original);
    expect(document.querySelector('style[data-dual-read-sizing-style]')).toBeNull();
  });

  it('removes a temporary probe sheet and marker after a read without an installed rule', () => {
    const {box} = fixture('#box {height:50%}');
    modelLayerInsertion();
    vi.stubGlobal('getComputedStyle', () => ({getPropertyValue: () => '50%'}));
    expect(readComputedSizing(box, ['height'])).toBe('[["height","50%"]]');
    expect(box.hasAttribute('data-dual-read-sizing-probe')).toBe(false);
    expect(document.querySelector('style[data-dual-read-sizing-style]')).toBeNull();
  });

  it('omits a matching owned expansion when a different reader asks for author sizing', () => {
    const {box, sheet} = fixture('#box {height:auto!important;min-height:365px!important}');
    sheet.setAttribute('data-dual-read-layout-style', 'true'); modelLayerInsertion();
    const original = (sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText;
    vi.stubGlobal('getComputedStyle', (_element: Element, pseudo?: string) => {
      if (pseudo) expect((sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText).toBe('');
      return {getPropertyValue: () => '80px'};
    });
    expect(readComputedSizing(box, ['height'])).toBe('[["height","80px"]]');
    expect((sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText).toBe(original);
  });

  it('preserves viewport-derived lengths while still detecting collapse and reopening at the new viewport', () => {
    const {box} = fixture('#box {height:80px;min-height:100vh}'); modelLayerInsertion();
    vi.stubGlobal('innerWidth', 1920); vi.stubGlobal('innerHeight', 1080);
    let height = '80px', minimum = '1080px';
    vi.stubGlobal('getComputedStyle', () => ({getPropertyValue: (property: string) => property === 'height' ? height : minimum}));
    const read = () => readComputedSizing(box, ['height','min-height']);
    const initial = read();
    vi.stubGlobal('innerWidth', 1600); vi.stubGlobal('innerHeight', 900); minimum = '900px';
    expect(read()).toBe(initial); expect(read()).toBe(initial);
    height = '0px'; expect(read()).not.toBe(initial);
    height = '80px'; expect(read()).toBe(initial);
    height = '220px'; expect(read()).not.toBe(initial);
  });

  it('restores owned rules and removes private probe chrome when rule insertion fails', () => {
    const {box, sheet} = fixture('#box {height:auto!important;min-height:365px!important}');
    const original = (sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText;
    vi.spyOn(CSSStyleSheet.prototype, 'insertRule').mockImplementation(() => {throw new Error('probe rejected');});
    expect(() => readComputedSizing(box, ['height'], sheet)).toThrow('probe rejected');
    expect((sheet.sheet!.cssRules[0] as CSSStyleRule).style.cssText).toBe(original);
    expect(box.hasAttribute('data-dual-read-sizing-probe')).toBe(false);
    expect(document.querySelector('style[data-dual-read-sizing-style]')).toBeNull();
  });

  it.each([false, true])('restores every owned declaration without DOM records when a computed read throws=%s', throws => {
    const {box, sheet} = fixture('#box {height:auto!important;min-height:365px!important} #box::before {content:""}');
    const rules = Array.from(sheet.sheet!.cssRules) as CSSStyleRule[], original = rules.map(rule => rule.style.cssText);
    const observer = new MutationObserver(() => {}); observer.observe(document.documentElement, {subtree:true, attributes:true, childList:true, characterData:true});
    vi.stubGlobal('getComputedStyle', () => {
      expect(rules.every(rule => !rule.style.cssText)).toBe(true);
      if (throws) throw new Error('cascade read failed');
      return {getPropertyValue: () => '0px'};
    });
    if (throws) expect(() => readUnmaskedLayoutProperty(box, 'height', sheet)).toThrow('cascade read failed');
    else expect(readUnmaskedLayoutProperty(box, 'height', sheet)).toBe('0px');
    expect(rules.map(rule => rule.style.cssText)).toEqual(original); expect(observer.takeRecords()).toEqual([]); observer.disconnect();
  });
});
