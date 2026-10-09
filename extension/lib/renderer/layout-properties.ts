const SIDES = ['top','right','bottom','left'];
const EDGES = ['block-start','block-end','inline-start','inline-end'];
const BORDER_PARTS = ['width','style','color'];

/** CSSOM longhands for the sizing families used by our layout readers. */
export function layoutLonghands(property: string): string[] {
  if (property === 'padding' || property === 'margin') return SIDES.map(side => `${property}-${side}`);
  if (property === 'inset') return SIDES;
  if (/^(padding|margin|inset)-(block|inline)$/.test(property)) return [`${property}-start`,`${property}-end`];
  if (/^border-(width|style|color)$/.test(property)) return SIDES.map(side => `border-${side}-${property.slice(7)}`);
  if (/^border-(block|inline)-(width|style|color)$/.test(property)) {
    const [,axis,part] = property.split('-');return [`border-${axis}-start-${part}`,`border-${axis}-end-${part}`];
  }
  if (property === 'border') return SIDES.flatMap(side => BORDER_PARTS.map(part => `border-${side}-${part}`));
  if (/^border-(block|inline)$/.test(property)) return ['start','end'].flatMap(edge => BORDER_PARTS.map(part => `${property}-${edge}-${part}`));
  if (/^border-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)$/.test(property)) return BORDER_PARTS.map(part => `${property}-${part}`);
  return [property];
}

export const LAYOUT_SHORTHANDS = [
  'padding','padding-block','padding-inline','margin','margin-block','margin-inline','inset','inset-block','inset-inline',
  'border','border-width','border-style','border-color','border-block','border-inline',
  ...SIDES.map(side => `border-${side}`), ...EDGES.map(edge => `border-${edge}`),
  ...['block','inline'].flatMap(axis => BORDER_PARTS.map(part => `border-${axis}-${part}`)),
];

const ALIASES = [
  ...['','min-','max-'].flatMap(prefix => [`${prefix}block-size`,`${prefix}inline-size`]),
  ...['padding','margin','inset'].flatMap(family => EDGES.map(edge => `${family}-${edge}`)),
  ...EDGES.flatMap(edge => BORDER_PARTS.map(part => `border-${edge}-${part}`)),
];

/** Corresponding physical spelling, without changing a page declaration. */
export function physicalLayoutProperty(property: string, style: CSSStyleDeclaration): string {
  const size = property.match(/^(min-|max-)?(block|inline)-size$/);
  const edge = property.match(/^(padding|margin|inset|border)-(block|inline)-(start|end)(-(?:width|style|color))?$/);
  if (!size && !edge) return property;
  const writingMode = style.getPropertyValue('writing-mode');
  const vertical = /^(vertical|sideways)-/.test(writingMode);
  if (size) return `${size[1] || ''}${(size[2] === 'block') !== vertical ? 'height' : 'width'}`;
  const block = vertical ? writingMode.endsWith('-rl') ? ['right','left'] : ['left','right'] : ['top','bottom'];
  const inline = vertical ? writingMode === 'sideways-lr' ? ['bottom','top'] : ['top','bottom'] : ['left','right'];
  if (style.getPropertyValue('direction') === 'rtl') inline.reverse();
  const side = (edge![2] === 'block' ? block : inline)[edge![3] === 'start' ? 0 : 1];
  return edge![1] === 'inset' ? side : `${edge![1]}-${side}${edge![4] || ''}`;
}

/** Close selected properties over equivalent spellings. Border style controls
 * whether a declared width contributes to geometry; color stays unselected. */
export function relatedLayoutProperties(properties: readonly string[], physical: (property: string) => string): string[] {
  const selected = new Set(properties.flatMap(layoutLonghands));
  for (const property of selected) if (/^border-.+-width$/.test(property)) selected.add(property.replace(/-width$/,'-style'));
  const requested = new Set([...selected].map(physical));
  for (const property of ALIASES) {
    const counterpart = physical(property);
    if (!requested.has(counterpart)) continue;
    selected.add(property);selected.add(counterpart);
  }
  return [...selected];
}
