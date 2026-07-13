import type { TargetLang } from '../types';

// Zero-dependency script detection. We only skip translation when the source
// script is UNAMBIGUOUSLY the target's script (Han→zh, no kana). Latin
// targets (en/es/fr) share a script and cannot be told apart safely, so we
// never skip those — avoiding false negatives that would leave text untranslated.
// Cyrillic→ru was dropped for the same reason: Ukrainian/Bulgarian text is
// all-Cyrillic and would be mis-skipped.

const HAN = /\p{Script=Han}/u;
const KANA = /\p{Script=Hiragana}|\p{Script=Katakana}/u;
const LETTER = /\p{L}/u;

function scriptRatio(text: string, re: RegExp): number {
  let letters = 0;
  let hits = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (re.test(ch)) hits++;
  }
  return letters === 0 ? 0 : hits / letters;
}

/** True when text is already overwhelmingly in the target's own script. */
export function isLikelyAlreadyTarget(text: string, targetLang: TargetLang): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (targetLang === 'zh-CN') {
    // Japanese mixes Han with kana; a Han-only ratio would mis-skip it.
    if (KANA.test(trimmed)) return false;
    return scriptRatio(trimmed, HAN) >= 0.5;
  }
  return false;
}
