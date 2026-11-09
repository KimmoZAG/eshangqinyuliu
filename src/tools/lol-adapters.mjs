/**
 * LoL 电竞 MCP 适配层
 *
 * 解决上游三个缺陷（不改源码，GPL-3.0 只自用）：
 * 1. 工具不返回 eventId —— 直连官方 schedule API 补一条链路
 * 2. get-match-vods 只给平台 + id —— 这里拼成可点链接
 * 3. eventId 传错抛 TypeError —— 收敛成结构化 not_found
 */
const BASE = process.env.LOL_API_BASE_URL || 'https://esports-api.lolesports.com';
const KEY = process.env.LOL_API_KEY || '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

async function gw(path, params = {}) {
  const url = new URL(`${BASE}/persisted/gw/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { 'x-api-key': KEY }, signal: ctrl.signal });
    if (!r.ok) throw Object.assign(new Error(`lolesports HTTP ${r.status}`), { code: 'upstream_unavailable' });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const cut = (s, n = 60) => String(s || '').slice(0, n);

function vodUrl(provider, param) {
  const p = String(provider || '').toLowerCase();
  const id = String(param || '').trim();
  if (!id) return null;
  if (p.includes('youtube')) return `https://www.youtube.com/watch?v=${id}`;
  if (p.includes('afreeca')) return `https://vod.afreecatv.com/player/${id}`;
  if (p.includes('twitch')) return `https://www.twitch.tv/videos/${id}`;
  return null;
}

export default function registerLolAdapters(register, client) {
  register('lol_resolve_event', {
    domain: 'lol',
    description:
      '按队伍名或联赛查比赛，返回 event_id。想查某场比赛详情或 VOD 时，必须先用它拿到 event_id，再调 get-event-details / lol_event_vods。',
    schema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: '队伍名，可只写一部分，如 T1 / BLG / FlyQuest' },
        state: { type: 'string', enum: ['upcoming', 'inProgress', 'completed', 'all'] },
        limit: { type: 'number' },
      },
    },
    ttlMs: 180_000,
    call: async ({ team = '', state = 'all', limit = 8 }) => {
      const j = await gw('getSchedule', { hl: 'zh-CN' });
      const events = j?.data?.schedule?.events || [];
      const t = String(team).toLowerCase();
      const rows = events
        .filter((e) => e?.match?.id)
        .filter((e) => (state === 'all' ? true : e.state === state))
        .filter((e) => {
          if (!t) return true;
          const names = (e.match.teams || []).map((x) => `${x.name || ''} ${x.code || ''}`.toLowerCase()).join(' ');
          const league = String(e.league?.name || '').toLowerCase();
          return names.includes(t) || league.includes(t);
        })
        .slice(0, limit)
        .map((e) => ({
          event_id: e.match.id,
          teams: (e.match.teams || []).map((x) => x.name).filter(Boolean),
          start_time: e.startTime,
          state: e.state,
          league: e.league?.name || '',
          block: e.blockName || '',
        }));
      return { count: rows.length, events: rows };
    },
  });

  register('lol_event_vods', {
    domain: 'lol',
    description: '查某场比赛的 VOD 可点链接。需要先用 lol_resolve_event 拿到 event_id。',
    schema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
    ttlMs: 3_600_000,
    call: async ({ event_id }) => {
      let text;
      try {
        const r = await client.callTool('get-match-vods', { eventId: event_id, language: 'zh-CN' }, { timeout: 60_000 });
        text = r.text;
        if (r.isError) throw Object.assign(new Error('该场次没有 VOD 或 event_id 无效'), { code: 'not_found' });
      } catch (e) {
        throw Object.assign(new Error(`取 VOD 失败：${e.message}`), { code: e.code || 'upstream_unavailable' });
      }
      if (/Cannot read properties of null/i.test(text) || /❌ \*\*Error\*\*/.test(text)) {
        throw Object.assign(new Error('event_id 无效或该场无数据'), { code: 'not_found' });
      }

      const providers = [...text.matchAll(/Provider:\s*([^\n]+)/g)].map((m) => m[1].trim());
      const params = [...text.matchAll(/Parameter:\s*([^\n]+)/g)].map((m) => m[1].trim());
      const vods = [];
      for (let i = 0; i < params.length; i += 1) {
        const provider = providers[i] || '';
        const url = vodUrl(provider, params[i]);
        if (url) vods.push({ provider, url });
      }
      return { event_id, count: vods.length, vods: vods.slice(0, 8) };
    },
  });

  register('lol_event_details', {
    domain: 'lol',
    description: '查某场比赛详情（比分、局数、完成状态）。需要先用 lol_resolve_event 拿到 event_id。',
    schema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
    ttlMs: 300_000,
    call: async ({ event_id }) => {
      const r = await client.callTool('get-event-details', { eventId: event_id, language: 'zh-CN' }, { timeout: 60_000 });
      if (r.isError || /Cannot read properties of null/i.test(r.text) || /❌ \*\*Error\*\*/.test(r.text)) {
        throw Object.assign(new Error('event_id 无效，先用 lol_resolve_event 查'), { code: 'not_found' });
      }
      return r.text.slice(0, 1500);
    },
  });
}

export { cut };
