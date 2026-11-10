/**
 * LoL 电竞 MCP 适配层
 *
 * 解决上游三个缺陷（不改源码，GPL-3.0 只自用）：
 * 1. 工具不返回 eventId —— 直连官方 schedule API 补一条链路
 * 2. get-match-vods 只给平台 + id —— 这里拼成可点链接
 * 3. eventId 传错抛 TypeError —— 收敛成结构化 not_found
 */
import { setTimeout as wait } from 'node:timers/promises';
const BASE = process.env.LOL_API_BASE_URL || 'https://esports-api.lolesports.com';
const KEY = process.env.LOL_API_KEY || '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';

const scheduleCache = new Map(); // path+params -> {at, data}

async function gwOnce(url, signal) {
  const timeout = AbortSignal.timeout(15_000);
  const r = await fetch(url, { headers: { 'x-api-key': KEY }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!r.ok) throw Object.assign(new Error(`lolesports HTTP ${r.status}`), { code: 'upstream_unavailable' });
  return r.json();
}

async function gw(path, params, signal) {
  const url = new URL(`${BASE}/persisted/gw/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();

  const hit = scheduleCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;

  let last;
  for (let i = 0; i < 3; i += 1) {
    try {
      const data = await gwOnce(url, signal);
      scheduleCache.set(key, { at: Date.now(), data });
      return data;
    } catch (e) {
      last = e;
      signal?.throwIfAborted();
      if (i < 2) await wait(400 * (i + 1), undefined, { signal });
    }
  }
  throw last;
}


const SH_OFFSET = 8 * 3600e3;

function normDay(input) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(input || ''))) return String(input);
  const kw = String(input || 'today').toLowerCase();
  const d = new Date(Date.now() + SH_OFFSET);
  if (kw === 'yesterday') d.setUTCDate(d.getUTCDate() - 1);
  else if (kw === 'tomorrow') d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const shText = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + SH_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
};

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
    call: async ({ team = '', state = 'all', limit = 8 }, { signal }) => {
      const j = await gw('getSchedule', { hl: 'zh-CN' }, signal);
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


  register('lol_matches_by_date', {
    domain: 'lol',
    description:
      '按日期查 LoL 比赛（含赛果比分）。问“今天/明天有没有比赛”“前几天的赛果”“昨天谁赢了”都用这个，不要用 get-live-matches。',
    schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "today / yesterday / tomorrow 或 YYYY-MM-DD，默认 today" },
        days: { type: 'number', description: '从 date 起向后覆盖几天，1-7，默认 1' },
        state: { type: 'string', enum: ['all', 'completed', 'upcoming'] },
        league: { type: 'string', description: '可选联赛名或缩写，如 LPL、LCK、Worlds' },
      },
    },
    ttlMs: 120_000,
    call: async ({ date = 'today', days = 1, state = 'all', league = '' }, { signal }) => {
      const day = normDay(date);
      const span = Math.min(Math.max(Number(days) || 1, 1), 7);
      const start = Date.parse(`${day}T00:00:00+08:00`);
      const end = start + span * 86400e3;

      const j = await gw('getSchedule', { hl: 'zh-CN' }, signal);
      const events = j?.data?.schedule?.events || [];
      const leagueName = league.toLowerCase();
      const rows = events
        .filter((e) => e?.match?.id)
        .filter((e) => !leagueName || [e.league?.name, e.league?.slug].some((name) =>
          String(name || '').toLowerCase() === leagueName))
        .filter((e) => {
          const t = Date.parse(e.startTime);
          return t >= start && t < end;
        })
        .filter((e) => (state === 'all' ? true : e.state === state))
        .map((e) => {
          const teams = (e.match.teams || []).map((x) => ({
            name: x.name,
            score: x.result?.gameWins ?? null,
            outcome: x.result?.outcome ?? null,
          }));
          const winner = teams.find((x) => x.outcome === 'win')?.name || null;
          return {
            event_id: e.match.id,
            teams,
            winner,
            state: e.state,
            start_time: shText(e.startTime),
            league: e.league?.name || '',
            block: e.blockName || '',
            has_vod: (e.match.flags || []).includes('hasVod'),
          };
        })
        .sort((a, b) => a.start_time.localeCompare(b.start_time));

      return {
        date: day,
        league,
        days: span,
        count: rows.length,
        matches: rows.slice(0, 12),
        note: rows.length ? undefined : '这个时间段没有查到比赛，直接告诉用户没有，不要编。',
      };
    },
  });



  register('lol_tournament', {
    domain: 'lol',
    description:
      '查整个赛事（如 S 赛/Worlds）的整体安排：各阶段名称、起止时间、场次数，以及决赛时间。问“S赛什么安排/总共几场/决赛什么时候”用这个。',
    schema: {
      type: 'object',
      properties: {
        league: { type: 'string', description: '赛事关键词，默认 Worlds' },
      },
    },
    ttlMs: 600_000,
    call: async ({ league = 'Worlds' }, { signal }) => {
      const j = await gw('getSchedule', { hl: 'zh-CN' }, signal);
      const events = (j?.data?.schedule?.events || []).filter((e) => e?.match?.id);
      const key = String(league || '').toLowerCase();
      const mine = events.filter(
        (e) => String(e.league?.name || '').toLowerCase().includes(key) || String(e.league?.slug || '').toLowerCase().includes(key),
      );
      if (!mine.length) throw Object.assign(new Error(`没查到 ${league} 的赛程`), { code: 'not_found' });

      const stages = new Map();
      for (const e of mine) {
        const name = e.blockName || '未分阶段';
        const cur = stages.get(name) || { stage: name, from: e.startTime, to: e.startTime, matches: 0, done: 0 };
        cur.matches += 1;
        if (e.state === 'completed') cur.done += 1;
        if (Date.parse(e.startTime) < Date.parse(cur.from)) cur.from = e.startTime;
        if (Date.parse(e.startTime) > Date.parse(cur.to)) cur.to = e.startTime;
        stages.set(name, cur);
      }

      const finalEvent = mine.find((e) => String(e.blockName || '').trim() === '决赛');
      return {
        league,
        total_matches: mine.length,
        stages: [...stages.values()]
          .sort((a, b) => Date.parse(a.from) - Date.parse(b.from))
          .map((x) => ({ stage: x.stage, from: shText(x.from), to: shText(x.to), matches: x.matches, completed: x.done })),
        final: finalEvent
          ? {
              start_time: shText(finalEvent.startTime),
              state: finalEvent.state,
              teams: (finalEvent.match?.teams || []).map((t) => t.name),
            }
          : null,
        note: '时间是北京时间。赛程数据里没有开场演出、转播安排这类信息，问这些要另外搜。',
      };
    },
  });

  register('lol_recent_results', {
    domain: 'lol',
    description:
      '直接返回最近几场已结束比赛的赛果（队名+比分+胜者+时间），不需要日期参数。问“前几天赛果/最近谁赢了/最近有什么比赛”一律先用这个。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回几场，默认 6' },
        team: { type: 'string', description: '可选，只看某队，如 BLG / T1' },
      },
    },
    ttlMs: 120_000,
    call: async ({ limit = 6, team = '' }, { signal }) => {
      const j = await gw('getSchedule', { hl: 'zh-CN' }, signal);
      const events = j?.data?.schedule?.events || [];
      const t = String(team || '').toLowerCase();
      const rows = events
        .filter((e) => e?.match?.id)
        .filter((e) => e.state === 'completed' || (e.match.teams || []).some((x) => x.result?.outcome))
        .filter((e) => {
          if (!t) return true;
          return (e.match.teams || []).some((x) => `${x.name || ''} ${x.code || ''}`.toLowerCase().includes(t));
        })
        .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
        .slice(0, Math.min(Math.max(Number(limit) || 6, 1), 10))
        .map((e) => {
          const teams = (e.match.teams || []).map((x) => ({
            name: x.name,
            score: x.result?.gameWins ?? null,
            outcome: x.result?.outcome ?? null,
          }));
          return {
            event_id: e.match.id,
            teams,
            winner: teams.find((x) => x.outcome === 'win')?.name || null,
            start_time: shText(e.startTime),
            league: e.league?.name || '',
            block: e.blockName || '',
          };
        });
      return { count: rows.length, matches: rows, note: rows.length ? undefined : '赛程源里没有已结束的比赛，直接说没查到。' };
    },
  });

  if (!client) return;

  register('lol_event_vods', {
    domain: 'lol',
    description: '查某场比赛的 VOD 可点链接。需要先用 lol_resolve_event 拿到 event_id。',
    schema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
    ttlMs: 3_600_000,
    call: async ({ event_id }, { signal }) => {
      let text;
      try {
        const r = await client.callTool('get-match-vods', { eventId: event_id, language: 'zh-CN' }, { timeout: 60_000, signal });
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
    call: async ({ event_id }, { signal }) => {
      const r = await client.callTool('get-event-details', { eventId: event_id, language: 'zh-CN' }, { timeout: 60_000, signal });
      if (r.isError || /Cannot read properties of null/i.test(r.text) || /❌ \*\*Error\*\*/.test(r.text)) {
        throw Object.assign(new Error('event_id 无效，先用 lol_resolve_event 查'), { code: 'not_found' });
      }
      return r.text.slice(0, 1500);
    },
  });
}

export { cut };
