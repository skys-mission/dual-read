/**
 * DeepSeek V4 enables thinking by default; reasoning tokens share max_tokens
 * with the final answer. Structured JSON probes/translation can burn the whole
 * budget on reasoning and return empty `content`. Disable thinking for any
 * DeepSeek endpoint/model unless the caller already set the field.
 */
export function withThinkingDisabled(
  body: Record<string, unknown>,
  settings: { apiBase: string; model?: string },
): Record<string, unknown> {
  if (body.thinking != null) return body;
  const base = settings.apiBase.toLowerCase();
  const model = String(settings.model || '').toLowerCase();
  const isDeepSeek = base.includes('deepseek') || model.includes('deepseek');
  if (!isDeepSeek) return body;
  return { ...body, thinking: { type: 'disabled' } };
}
