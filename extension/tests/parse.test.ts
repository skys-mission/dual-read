import { describe, expect, it } from 'vitest';
import { parseTranslationArray } from '../lib/provider/parse';

describe('parseTranslationArray', () => {
  it('L1: parses a plain JSON object keyed by index', () => {
    expect(parseTranslationArray('{"0":"你好","1":"世界"}', 2)).toEqual(['你好', '世界']);
  });

  it('L1: parses a JSON array', () => {
    expect(parseTranslationArray('["a","b","c"]', 3)).toEqual(['a', 'b', 'c']);
  });

  it('L2: strips markdown code fences', () => {
    const raw = '```json\n{"0":"hola"}\n```';
    expect(parseTranslationArray(raw, 1)).toEqual(['hola']);
  });

  it('L3: extracts a JSON snippet embedded in prose', () => {
    const raw = 'Sure! Here is your translation: {"0":"bonjour","1":"monde"} — done.';
    expect(parseTranslationArray(raw, 2)).toEqual(['bonjour', 'monde']);
  });

  it('L4: falls back to line alignment when JSON is unavailable', () => {
    const raw = '1. Hello\n2. World';
    expect(parseTranslationArray(raw, 2)).toEqual(['Hello', 'World']);
  });

  it('trims values', () => {
    expect(parseTranslationArray('{"0":"  spaced  "}', 1)).toEqual(['spaced']);
  });

  it('throws when the count cannot be recovered (triggers bisect upstream)', () => {
    expect(() => parseTranslationArray('totally unparseable\nblob\nof\ntext', 2)).toThrow();
  });

  it('object with a missing index is rejected', () => {
    expect(() => parseTranslationArray('{"0":"a"}', 2)).toThrow();
  });
});
