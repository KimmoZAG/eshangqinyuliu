/**
 * Steam 适配层：补 MCP 没有的能力
 *
 * 上游 steam-mcp 没有「最受欢迎/热销榜」（README 里的 getFeatured 没发出来），
 * 这里直连官方 ISteamChartsService（无需 key）+ 商店 appdetails 补游戏名。
 */
import dns from 'node:dns';

// 这台机器的 IPv6 出口是黑洞，Node 默认会先试 IPv6 然后 10s 超时
// 这里把它压成进程级设置，比依赖 NODE_OPTIONS 更可靠
dns.setDefaultResultOrder('ipv4first');

const CHARTS = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';
const STORE = 'https://store.steampowered.com/api/appdetails';

let cache = { at: 0, data: null };
const TTL = 10 * 60 * 1000;

/**
 * Steam 这几个接口会偶发连不上（IPv6 黑洞 + 连接复用拿到死 socket）。
 * 实测：加 connection:close 后 2/3 成功，所以再叠 3 次重试。
 */
import { setTimeout as wait } from 'node:timers/promises';

async function fetchJson(url, { timeout = 6000, attempts = 3, signal } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        headers: { connection: 'close', 'user-agent': 'jinha/1.0' },
      });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'upstream_unavailable' });
      return await r.json();
    } catch (e) {
      last = e;
      signal?.throwIfAborted();
      if (i + 1 < attempts) await wait(400 * (i + 1), undefined, { signal });
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(new Error(`Steam 接口连续 ${attempts} 次不可用：${last?.message || last}`), {
    code: 'upstream_unavailable',
  });
}

async function nameOf(appid, signal) {
  try {
    const j = await fetchJson(`${STORE}?appids=${appid}&l=schinese&cc=cn`, { attempts: 2, signal });
    const d = j?.[String(appid)];
    return d?.success ? d.data?.name || null : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function charts(signal) {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  const j = await fetchJson(CHARTS, { signal });
  const ranks = (j?.response?.ranks || []).map((x) => ({
    rank: x.rank,
    appid: x.appid,
    peak: x.peak_in_game,
    lastWeek: x.last_week_rank,
  }));
  if (!ranks.length) throw Object.assign(new Error('排行接口返回为空'), { code: 'upstream_unavailable' });
  cache = { at: Date.now(), data: ranks };
  return ranks;
}

export default function registerSteamAdapters(register) {
  register('steam_most_played', {
    domain: 'steam',
    description:
      '查 Steam 当前最热门的游戏排行（按在线人数），返回名次、游戏名、24小时峰值在线。问“最受欢迎/最热/在线最多/排行榜”必须用这个，不要用 steam_getPlayerCount。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回前几名，默认 8，最多 15' },
      },
    },
    ttlMs: TTL,
    call: async ({ limit = 8 }, { signal }) => {
      const n = Math.min(Math.max(Number(limit) || 8, 1), 15);
      const ranks = (await charts(signal)).slice(0, n);

      // 并发补名字，失败的用 appid 兜底
      const names = await Promise.all(ranks.map((r) => nameOf(r.appid, signal)));

      return {
        region: 'global',
        metric: 'peak_in_game（24 小时峰值在线，不是当前在线）',
        updated: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        top: ranks.map((r, i) => ({
          rank: r.rank,
          name: names[i] || `appid:${r.appid}`,
          appid: r.appid,
          peak_24h: r.peak,
          last_week_rank: r.lastWeek,
        })),
      };
    },
  });

  register('steam_app_players', {
    domain: 'steam',
    description:
      '查单个游戏当前在线人数（不是排行榜）。需要 appid；不知道 appid 先用 steam_searchApps 查。',
    schema: {
      type: 'object',
      properties: { appid: { type: 'number' }, name: { type: 'string', description: '可选，仅用于把名字带回来' } },
      required: ['appid'],
    },
    ttlMs: 120_000,
    call: async ({ appid, name }, { signal }) => {
      const j = await fetchJson(
        `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(appid)}`,
        { signal },
      );
      const count = j?.response?.player_count;
      if (typeof count !== 'number') throw Object.assign(new Error('拿不到在线人数'), { code: 'upstream_unavailable' });
      return { appid, name: name || null, player_count: count, scale: count > 10000 ? '万' : '' };
    },
  });
}
