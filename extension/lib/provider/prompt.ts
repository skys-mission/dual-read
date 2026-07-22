import type { TargetLang } from '../types';
import { TARGET_LANG_NAMES } from '../settings/schema';
import { PROMPT_VERSION } from './version';

export { PROMPT_VERSION };

export function buildSystemPrompt(targetLang: TargetLang): string {
  const name = TARGET_LANG_NAMES[targetLang] ?? targetLang;
  return [
    'You are a professional translation engine embedded in a browser extension.',
    `Translate each value in the user's JSON object into ${name}.`,
    'Return ONLY a JSON object with exactly the same keys ("0","1",...) mapped to translated strings.',
    'Rules:',
    '- Preserve URLs, code, HTML entities, {placeholders}, version numbers, and proper nouns as-is.',
    '- Keep numbers, dates and times unchanged; never convert relative times (e.g. "40 minutes ago") to absolute dates.',
    '- Translate natural language only; if a value is not natural language, return it unchanged.',
    '- Do not add explanations, notes, or markdown code fences.',
    'Example input: {"0":"Hello","1":"Read the docs"}',
    `Example output: ${JSON.stringify(exampleOutput(targetLang))}`,
  ].join('\n');
}

function exampleOutput(targetLang: TargetLang): Record<string, string> {
  switch (targetLang) {
    case 'zh-CN':
      return { '0': '你好', '1': '阅读文档' };
    case 'ru':
      return { '0': 'Привет', '1': 'Прочтите документацию' };
    case 'es':
      return { '0': 'Hola', '1': 'Lee la documentación' };
    case 'fr':
      return { '0': 'Bonjour', '1': 'Lisez la documentation' };
    default:
      return { '0': 'Hello', '1': 'Read the docs' };
  }
}
