/**
 * 联网搜索适配器（api.anysearch.com，无需鉴权）
 *
 * 用途：群友问新闻/时事/版本更新/价格这类“模型自己不知道”的事，
 * 先搜再答，不许张口就“我不懂 别问我”。
 */
const ENDPOINT = process.env.SEARCH_URL || 'https://api.anysearch.com/v1/search';
const TIMEOUT = Number(process.env.SEARCH_TIMEOUT_MS || 15000);

// 时政/选举/政治类不接：群是游戏群，这类话题也不适合机器人参与
const POLITICAL = /(选举|大选|翻蓝|翻红|总统|议会|政党|执政|在野|弹劾|外交|制裁|战争|军事|领土|台独|港独|政治|时政|政变|示威|游行)/;

async function search(query, maxResults = 5) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(`搜索 HTTP ${r.status}`), { code: 'upstream_unavailable' });
    const j = await r.json();
    if (j.code !== 0) throw Object.assign(new Error(`搜索返回 code=${j.code} ${j.message || ''}`), { code: 'upstream_unavailable' });
    return j.data?.results || [];
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
    call: async ({ query, max_results = 5 }) => {
      const q = String(query || '').trim();
      if (!q) throw Object.assign(new Error('query 不能为空'), { code: 'bad_request' });
      if (POLITICAL.test(q)) {
        throw Object.assign(new Error('这类时政话题我不参与，聊点游戏吧'), { code: 'refused' });
      }

      const rows = await search(q, Math.min(Math.max(Number(max_results) || 5, 1), 8));
      if (!rows.length) {
        throw Object.assign(new Error('没搜到相关内容'), { code: 'not_found' });
      }

      return {
        query: q,
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
