// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {layoutLonghands,physicalLayoutProperty,relatedLayoutProperties} from '../lib/renderer/layout-properties';

const modes = [
  ['horizontal-tb','ltr',['top','bottom','left','right']],['horizontal-tb','rtl',['top','bottom','right','left']],
  ['vertical-rl','ltr',['right','left','top','bottom']],['vertical-rl','rtl',['right','left','bottom','top']],
  ['vertical-lr','ltr',['left','right','top','bottom']],['vertical-lr','rtl',['left','right','bottom','top']],
  ['sideways-rl','ltr',['right','left','top','bottom']],['sideways-rl','rtl',['right','left','bottom','top']],
  ['sideways-lr','ltr',['left','right','bottom','top']],['sideways-lr','rtl',['left','right','top','bottom']],
] as const;
const cases = modes.flatMap(([writingMode,direction,sides]) => ['block-start','block-end','inline-start','inline-end'].flatMap((edge,index) =>
  ['padding','margin','inset','border'].map(family => ({writingMode,direction,property:`${family}-${edge}${family==='border'?'-width':''}`,physical:family==='inset'?sides[index]:`${family}-${sides[index]}${family==='border'?'-width':''}`}))));
describe('shared layout property contract', () => {
  it.each(cases)('maps $property under $writingMode/$direction to $physical', ({writingMode,direction,property,physical}) => {
    const style = document.createElement('span').style;style.writingMode = writingMode;style.direction = direction;
    const map = (value: string) => physicalLayoutProperty(value,style);
    expect(map(property)).toBe(physical);const selected = relatedLayoutProperties([physical],map);expect(selected).toContain(property);
    if (property.startsWith('border')) {expect(selected).toContain(physical.replace(/-width$/,'-style'));expect(selected.some(name=>name.endsWith('-color'))).toBe(false);}
  });
  it.each([
    ['border-block-width',['border-block-start-width','border-block-end-width']],
    ['border-inline-style',['border-inline-start-style','border-inline-end-style']],
    ['border-top',['border-top-width','border-top-style','border-top-color']],
    ['inset-block',['inset-block-start','inset-block-end']],
    ['inset',['top','right','bottom','left']],
    ['margin-inline',['margin-inline-start','margin-inline-end']],
  ])('expands the CSSOM longhands of %s', (source,expected) => {expect(layoutLonghands(source as string)).toEqual(expected);});
  it('keeps unrelated property families and edges outside the selected policy', () => {
    const style = document.createElement('span').style;style.writingMode='horizontal-tb';style.direction='ltr';
    const map=(p: string)=>physicalLayoutProperty(p,style), selected=relatedLayoutProperties(['border-top-width'],map);
    expect(selected).not.toContain('border-right-width');expect(selected).not.toContain('padding-top');expect(selected).not.toContain('top');
  });
});
