import type { Settings } from '../types';
import { buildRequestHeaders } from '../settings/schema';
import { DualReadError, classifyHttpStatus, isAbortError } from '../errors';
import { buildSystemPrompt } from './prompt';
import { parseTranslationArray } from './parse';
import { withThinkingDisabled } from './thinking';

export { PROMPT_VERSION } from './prompt';
export { isLikelyAlreadyTarget } from './lang';

function estimateMaxTokens(texts: string[]): number {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  // ~1 token per 4 chars of source; ×3 headroom for expansion + JSON overhead.
  // Floor is high enough that a short batch still survives if a thinking-capable
  // model ignores our disable flag and spends some budget on reasoning.
  return Math.min(8192, Math.max(1024, Math.ceil((chars / 4) * 3) + 128));
}

async function callLLM(texts: string[], settings: Settings, signal?: AbortSignal): Promise<string> {
  const indexed: Record<string, string> = {};
  texts.forEach((t, i) => {
    indexed[String(i)] = t;
  });

  const body = withThinkingDisabled(
    {
      model: settings.model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: buildSystemPrompt(settings.targetLang) },
        { role: 'user', content: JSON.stringify(indexed) },
      ],
      temperature: 0.3,
      max_tokens: estimateMaxTokens(texts),
    },
    settings,
  );

  const url = `${settings.apiBase.replace(/\/$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildRequestHeaders(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new DualReadError('NETWORK_ERROR', {
      detail: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const code = classifyHttpStatus(response.status, errText);
    throw new DualReadError(code, { detail: `HTTP ${response.status}` });
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  // Last-resort: some thinking models truncate content to empty while still
  // emitting a usable JSON blob inside reasoning_content.
  const reasoning = message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.trim()) {
    const jsonish = reasoning.match(/\{[\s\S]*\}/);
    if (jsonish?.[0]) return jsonish[0];
  }
  throw new DualReadError('RESPONSE_MALFORMED', { detail: 'empty batch response' });
}

/**
 * Translate an array of strings, preserving order and length. On a malformed
 * response, bisects the batch and retries each half *serially* under the same
 * AbortSignal so parse-failure storms cannot amplify concurrency.
 */
export async function translateTexts(
  texts: string[],
  settings: Settings,
  signal?: AbortSignal,
  depth = 0,
): Promise<string[]> {
  if (!texts.length) return [];
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const content = await callLLM(texts, settings, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  try {
    return parseTranslationArray(content, texts.length);
  } catch {
    if (texts.length === 1) {
      const best = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return [best];
    }
    // Cap bisect depth so a pathological parser cannot explode into O(n) serial
    // LLM calls beyond a fixed budget (2^depth leaves).
    const MAX_BISECT_DEPTH = 4;
    if (depth >= MAX_BISECT_DEPTH) {
      const best = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return texts.map(() => best || '');
    }
    const mid = Math.ceil(texts.length / 2);
    const left = await translateTexts(texts.slice(0, mid), settings, signal, depth + 1);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const right = await translateTexts(texts.slice(mid), settings, signal, depth + 1);
    return [...left, ...right];
  }
}
