import { describe, expect, it } from 'vitest';
import { isLikelyAlreadyTarget } from '../lib/provider/lang';

describe('isLikelyAlreadyTarget', () => {
  it('detects Chinese text as already zh-CN (zero-request skip)', () => {
    expect(isLikelyAlreadyTarget('这是一段中文内容', 'zh-CN')).toBe(true);
  });

  it('does not skip English when target is zh-CN', () => {
    expect(isLikelyAlreadyTarget('This is English prose', 'zh-CN')).toBe(false);
  });

  it('never skips Cyrillic targets (Ukrainian/Bulgarian are indistinguishable)', () => {
    expect(isLikelyAlreadyTarget('Это русский текст', 'ru')).toBe(false);
    expect(isLikelyAlreadyTarget('Це український текст', 'ru')).toBe(false);
  });

  it('never skips Japanese for zh-CN (kana present despite Han majority)', () => {
    expect(isLikelyAlreadyTarget('設定を開く', 'zh-CN')).toBe(false);
    expect(isLikelyAlreadyTarget('日本語の文章を中国語に翻訳します', 'zh-CN')).toBe(false);
  });

  it('still skips pure Han text for zh-CN', () => {
    expect(isLikelyAlreadyTarget('这是一段中文内容', 'zh-CN')).toBe(true);
  });

  it('never skips Latin targets (ambiguous script)', () => {
    expect(isLikelyAlreadyTarget('Bonjour le monde', 'fr')).toBe(false);
    expect(isLikelyAlreadyTarget('Hola mundo', 'es')).toBe(false);
    expect(isLikelyAlreadyTarget('Hello world', 'en')).toBe(false);
  });

  it('majority-CJK text with a stray Latin token still counts as target', () => {
    expect(isLikelyAlreadyTarget('这是一段很长的中文内容 API 还有更多中文文字在这里', 'zh-CN')).toBe(true);
  });

  it('majority-Latin text with a few CJK chars is not a target match', () => {
    expect(isLikelyAlreadyTarget('中文 with a few English words 内容', 'zh-CN')).toBe(false);
  });

  it('empty text is not a target match', () => {
    expect(isLikelyAlreadyTarget('   ', 'zh-CN')).toBe(false);
  });
});
