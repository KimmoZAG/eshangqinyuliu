/**
 * 联网搜索适配器（api.anysearch.com，无需鉴权）
 *
 * 用途：群友问新闻/时事/版本更新/价格这类“模型自己不知道”的事，
 * 先搜再答，不许张口就“我不懂 别问我”。
 */
const ENDPOINT = process.env.SEARCH_URL || 'https://api.anysearch.com/v1/search';

// DeepSeek 服务端联网检索：搜索结果与网页抓取都在服务端完成，只需一次普通补全请求。
// 注意：声明 deepseek_web_search 后不能再带任何 function 工具，所以这里单独发一条请求。
const LLM_BASE = (process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, '');
const LLM_KEY = (process.env.LLM_API_KEY || '').trim();
const LLM_MODEL = (process.env.LLM_MODEL || 'deepseek-flash').trim();
const DS_TIMEOUT = Number(process.env.SEARCH_DS_TIMEOUT_MS || 15000);
const PROVIDER = (process.env.SEARCH_PROVIDER || 'deepseek').toLowerCase();
const TIMEOUT = Number(process.env.SEARCH_TIMEOUT_MS || 15000);

// 时政/选举/政治类不接：群是游戏群，这类话题也不适合机器人参与
const POLITICAL = /(选举|大选|翻蓝|翻红|总统|议会|政党|执政|在野|弹劾|外交|制裁|战争|军事|领土|台独|港独|政治|时政|政变|示威|游行)/;

async function search(query, maxResults, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(`搜索 HTTP ${r.status}`), { code: 'upstream_unavailable' });
    const j = await r.json();
    if (j.code !== 0) throw Object.assign(new Error(`搜索返回 code=${j.code} ${j.message || ''}`), { code: 'upstream_unavailable' });
    return j.data?.results || [];
  } finally {
    clearTimeout(timer);
  }
}

async function deepseekSearch(query, signal) {
  if (!LLM_BASE || !LLM_KEY) throw new Error('未配置 LLM_BASE_URL/LLM_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DS_TIMEOUT);
  try {
    const r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        tools: [{ type: 'deepseek_web_search' }],
        messages: [{
          role: 'user',
          content: `检索并回答下面的问题。只给事实、数字和结论，不要客套话，不要猜测：\n${query}`,
        }],
        max_tokens: 1200,
        stream: false,
      }),
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(`DeepSeek 检索 HTTP ${r.status}`), { code: 'upstream_unavailable' });
    const j = await r.json();
    const msg = j.choices?.[0]?.message || {};
    const answer = String(msg.content || '').replace(/\s+/g, ' ').trim();
    const sources = (msg.annotations || [])
      .map((a) => a?.url_citation?.url)
      .filter((x) => typeof x === 'string' && x.startsWith('http'));
    return { answer, sources: [...new Set(sources)] };
  } finally {
    clearTimeout(timer);
  }
}

export default function registerSearchAdapters(register) {
  register('web_search', {
    domain: 'search',
    description:
      '联网搜索最新信息（新闻、版本更新、赛事、价格、事实核查）。回答不了的事实类问题必须先搜，不要直接说“我不懂”。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量具体，中文即可' },
        max_results: { type: 'number', description: '返回几条，默认 5，最多 8' },
      },
      required: ['query'],
    },
    ttlMs: 10 * 60 * 1000,
    call: async ({ query, max_results = 5 }, { signal }) => {
      const q = String(query || '').trim();
      if (!q) throw Object.assign(new Error('query 不能为空'), { code: 'bad_request' });
      if (POLITICAL.test(q)) {
        throw Object.assign(new Error('这类时政话题我不参与，聊点游戏吧'), { code: 'refused' });
      }

      const limit = Math.min(Math.max(Number(max_results) || 5, 1), 8);

      if (PROVIDER === 'deepseek') {
        try {
          const ds = await deepseekSearch(q, signal);
          if (ds.answer) {
            return {
              query: q,
              provider: 'deepseek',
              count: ds.sources.length,
              results: [{
                title: 'DeepSeek 联网检索',
                snippet: ds.answer.slice(0, 800),
                url: ds.sources[0] || '',
              }],
              sources: ds.sources.slice(0, limit),
              note: '这是检索后的摘要，只许用里面出现的事实和数字；引用时说“网上说”。',
            };
          }
        } catch (error) {
          // 服务端检索失败（超时/限流/未配置）时回退到 anysearch，不让整条查询挂掉
          console.error('[search] deepseek 失败，回退 anysearch：' + (error?.message || error));
        }
      }

      const rows = await search(q, limit, signal);
      if (!rows.length) {
        throw Object.assign(new Error('没搜到相关内容'), { code: 'not_found' });
      }

      return {
        query: q,
        provider: 'anysearch',
        count: rows.length,
        results: rows.map((x) => ({
          title: String(x.title || '').slice(0, 80),
          snippet: String(x.snippet || x.content || '').replace(/\s+/g, ' ').slice(0, 180),
          url: x.url || '',
        })),
        note: '只许用这里出现的事实和数字，没写的不要说。引用时可以说“网上说”。',
      };
    },
  });
}
