const BASE = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL || 'deepseek-flash';

function assertConfig() {
  if (!BASE || !KEY || !MODEL) throw new Error('LLM 配置缺失：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
}

/**
 * 单次调用，带超时。默认关闭思考（reasoning_effort=none），
 * deepseek-flash 默认 high 会把 token 全烧在 reasoning 上导致 content 为空。
 */
export async function chat(messages, {
  effort = 'none', maxTokens = 500, timeoutMs = 25_000, signal, temperature = 1,
} = {}) {
  assertConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const reasoningStyle = process.env.LLM_REASONING_STYLE || 'effort';
  const reasoning = reasoningStyle === 'thinking'
    ? { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } }
    : reasoningStyle === 'effort' ? { reasoning_effort: effort } : {};

  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...reasoning,
      }),
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${text.slice(0, 300)}`);

    const j = JSON.parse(text);
    const finish = j.choices?.[0]?.finish_reason;
    if (finish === 'length' || finish === 'content_filter') {
      throw Object.assign(new Error('模型没有返回完整回复'), { code: finish });
    }
    const msg = j.choices?.[0]?.message ?? {};
    const content = (msg.content || '').trim();
    if (!content) throw new Error(`LLM 返回空内容（finish=${j.choices?.[0]?.finish_reason}，可能 token 被思考耗尽）`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 把模型输出切成最多 3 条群消息 */
export function splitReplies(text, max = 3) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    .filter(Boolean);

  const out = [];
  for (let line of lines) {
    if (line.length <= 200) {
      out.push(line);
    } else {
      // 超长按句号切
      for (const part of line.split(/(?<=[。！？!?])/)) {
        const p = part.trim();
        if (p) out.push(p);
      }
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
