/**
 * OP.GG MCP 接入层（Streamable HTTP / 纯 POST JSON-RPC）
 *
 * 为什么要这一层：
 * 1. src/tools.mjs 里的 mcpClient 只支持 stdio，接不了 http 端点；
 * 2. 该服务 28/29 个工具返回的是 "class X: a,b\n\nX(1,2)" 这种按位置排列的私有格式，
 *    不是 JSON，模型直接读会错列，必须在这里解析成带字段名的对象；
 * 3. 部分工具返回 50KB+，必须在进 context 之前裁到 1KB 级。
 *
 * 服务特性（已实测）：无鉴权、无状态（不校验 Mcp-Session-Id）、恒返 HTTP 200，
 * 错误放在 body 的 error 字段里，所以不能用状态码判断成败。
 */
import { setTimeout as wait } from 'node:timers/promises';
import { log, num } from './core.mjs';

const URL = process.env.OPGG_MCP_URL || 'https://mcp-api.op.gg/mcp';
const TIMEOUT = num('OPGG_TIMEOUT_MS', 25000);
const RETRIES = num('OPGG_RETRIES', 2);

let seq = 0;
let session = null;
let inited = false;
const cache = new Map();

/* ---------------- JSON-RPC ---------------- */

async function post(body, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (session) headers['mcp-session-id'] = session;
  try {
    const r = await fetch(URL, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) session = sid;
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.retryable = true;
      throw e;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function init(signal) {
  if (inited) return;
  inited = true;
  try {
    await post({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jinha', version: '1.0.0' } },
    }, signal);
    // 通知没有 id，服务端正常回 202 空 body；失败也不影响后续（该服务无状态）
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => {});
  } catch (e) {
    if (signal?.aborted) {
      inited = false;
      throw e;
    }
    log('opgg', `握手失败，降级为无会话直连：${e.message}`);
  }
}

/** 业务错误（-326xx）不重试，网络错误/5xx 最多重试 RETRIES 次 */
async function rpc(method, params, signal) {
  signal?.throwIfAborted();
  await init(signal);
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const text = await post({ jsonrpc: '2.0', id: ++seq, method, params }, signal);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
      }
      if (msg.error) {
        const e = new Error(msg.error.message || `JSON-RPC ${msg.error.code}`);
        e.rpcCode = msg.error.code;
        throw e;
      }
      return msg.result;
    } catch (e) {
      last = e;
      if (e.rpcCode || !e.retryable) throw e; // 参数/业务错误不重试
      signal?.throwIfAborted();
      if (attempt < RETRIES) await wait(800 * (attempt + 1), undefined, { signal });
    }
  }
  throw last;
}

/* ---------------- DSL 解析 ---------------- */

function skip(s, i) {
  while (i < s.length && s[i] === ' ') i += 1;
  return i;
}

function atom(t) {
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === 'null' || t === 'None' || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

function unescapeChar(c) {
  if (c === 'n') return '\n';
  if (c === 't') return '\t';
  if (c === 'r') return '\r';
  return c;
}

function construct(name, args, schema) {
  const fields = schema[name];
  if (!fields) return { __class: name, __args: args };
  // 字段数与值个数不一致时不做位置对齐，宁可报错也不要静默错列
  if (fields.length !== args.length) {
    return { __class: name, __args: args, __mismatch: `schema ${fields.length} 字段 / 实际 ${args.length} 值` };
  }
  const o = {};
  fields.forEach((f, k) => {
    o[f] = args[k];
  });
  return o;
}

function parseValue(s, i, schema) {
  i = skip(s, i);
  const c = s[i];

  if (c === '"') {
    let j = i + 1;
    let out = '';
    while (j < s.length) {
      if (s[j] === '\\') {
        out += unescapeChar(s[j + 1]);
        j += 2;
        continue;
      }
      if (s[j] === '"') return { value: out, end: j + 1 };
      out += s[j];
      j += 1;
    }
    return { value: out, end: j };
  }

  if (c === '[') {
    const arr = [];
    let j = i + 1;
    for (;;) {
      j = skip(s, j);
      if (j >= s.length || s[j] === ']') return { value: arr, end: j + 1 };
      if (s[j] === ',') {
        j += 1;
        continue;
      }
      const r = parseValue(s, j, schema);
      arr.push(r.value);
      j = r.end;
    }
  }

  let j = i;
  while (j < s.length && !',)]('.includes(s[j])) j += 1;
  const tok = s.slice(i, j).trim();

  if (s[j] === '(') {
    const args = [];
    let k = j + 1;
    for (;;) {
      k = skip(s, k);
      if (k >= s.length || s[k] === ')') return { value: construct(tok, args, schema), end: k + 1 };
      if (s[k] === ',') {
        k += 1;
        continue;
      }
      const r = parseValue(s, k, schema);
      args.push(r.value);
      k = r.end;
    }
  }

  return { value: atom(tok), end: j };
}

export function parseDsl(text) {
  const src = String(text || '').trim();
  if (!src) return null;
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      return JSON.parse(src);
    } catch {
      // 落到 DSL 分支
    }
  }

  const schema = {};
  let expr = '';
  for (const line of src.split('\n')) {
    const m = line.match(/^class\s+(\w+):\s*(.*)$/);
    if (m) {
      schema[m[1]] = m[2].trim() ? m[2].split(',').map((x) => x.trim()).filter(Boolean) : [];
    } else if (line.trim()) {
      expr += line.trim();
    }
  }
  if (!expr) return schema;
  return parseValue(expr, 0, schema).value;
}

/* ---------------- 工具调用 ---------------- */

async function callTool(name, args, signal) {
  const r = await rpc('tools/call', { name, arguments: args }, signal);
  const text = (r?.content || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n');
  if (r?.isError) throw new Error(text.slice(0, 200) || '工具返回 isError');
  const parsed = parseDsl(text);
  // 裁剪字段没命中时服务端不报错，而是塞一个诊断对象
  if (parsed?._field_diagnostics) {
    throw new Error(`字段未命中：${(parsed._field_diagnostics.unmatched_fields || []).join(',')}`);
  }
  return parsed;
}

function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.val);
  return Promise.resolve(fn()).then((val) => {
    cache.set(key, { at: Date.now(), val });
    return val;
  });
}

const POSITIONS = ['top', 'mid', 'jungle', 'adc', 'support'];
const norm = (s) => String(s || '').trim().toUpperCase().replace(/[\s'-]/g, '');
const pct = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 10 : v);

/* ---------------- 工具注册 ---------------- */

export function registerOpggTools(register) {
  register('opgg_champion_analysis', {
    description:
      '查某英雄在韩服的强度：胜率/登场率/禁用率/梯队、核心出装、符文、克制关系。champion 传英文大写无空格（AHRI、MISSFORTUNE），position 必填 top|mid|jungle|adc|support。',
    schema: {
      type: 'object',
      properties: {
        champion: { type: 'string', description: '英文英雄名，全大写，多词不加空格，如 AHRI / MISSFORTUNE / TWISTEDFATE' },
        position: { type: 'string', enum: POSITIONS },
      },
      required: ['champion', 'position'],
    },
    call: async ({ champion, position }, { signal }) => {
      const pos = String(position || '').toLowerCase();
      if (!POSITIONS.includes(pos)) throw new Error(`position 必须是 ${POSITIONS.join('/')}`);
      const key = `ca:${norm(champion)}:${pos}`;
      return memo(key, 30 * 60e3, async () => {
        const d = await callTool('lol_get_champion_analysis', {
          champion: norm(champion),
          position: pos,
          game_mode: 'ranked',
          desired_output_fields: [
            'champion',
            'data.summary.average_stats.{win_rate,pick_rate,ban_rate,play,tier,kda}',
            'data.core_items.{ids_names,pick_rate,win}',
            'data.boots.{ids_names,pick_rate,win}',
            'data.runes.{primary_page_name,primary_rune_names,secondary_page_name,secondary_rune_names,win,pick_rate}',
            'data.strong_counters[].{champion_name,my_win_rate,counter_win_rate}',
            'data.weak_counters[].{champion_name,my_win_rate,counter_win_rate}',
          ],
        }, signal);
        const s = d?.data?.summary?.average_stats || {};
        return {
          champion: d?.champion || norm(champion),
          position: pos,
          region: 'KR',
          tier: s.tier,
          win_rate: pct(s.win_rate),
          pick_rate: pct(s.pick_rate),
          ban_rate: pct(s.ban_rate),
          play: s.play,
          kda: s.kda,
          core_items: d?.data?.core_items?.ids_names || [],
          boots: d?.data?.boots?.ids_names || [],
          runes: d?.data?.runes
            ? {
                primary: d.data.runes.primary_page_name,
                primary_runes: d.data.runes.primary_rune_names,
                secondary: d.data.runes.secondary_page_name,
                secondary_runes: d.data.runes.secondary_rune_names,
                win: d.data.runes.win,
                pick_rate: pct(d.data.runes.pick_rate),
              }
            : null,
          counters: (d?.data?.strong_counters || []).slice(0, 4).map((c) => ({
            vs: c.champion_name,
            my_win: pct(c.my_win_rate),
            their_win: pct(c.counter_win_rate),
          })),
          lose_to: (d?.data?.weak_counters || []).slice(0, 4).map((c) => ({
            vs: c.champion_name,
            my_win: pct(c.my_win_rate),
            their_win: pct(c.counter_win_rate),
          })),
        };
      });
    },
  });

  register('opgg_lane_meta', {
    description:
      '查韩服某分路的英雄梯队（Tier1 最强 → Tier5 最弱），含胜率/登场率/禁用率/样本量。position 必填 top|mid|jungle|adc|support。',
    schema: {
      type: 'object',
      properties: { position: { type: 'string', enum: POSITIONS } },
      required: ['position'],
    },
    call: async ({ position }, { signal }) => {
      const pos = String(position || '').toLowerCase();
      if (!POSITIONS.includes(pos)) throw new Error(`position 必须是 ${POSITIONS.join('/')}`);
      return memo(`lm:${pos}`, 30 * 60e3, async () => {
        const d = await callTool('lol_list_lane_meta_champions', {
          position: pos,
          desired_output_fields: [`data.positions.${pos}[].{champion,tier,win_rate,pick_rate,ban_rate,play}`],
        }, signal);
        const list = d?.data?.positions?.[pos] || [];
        const byTier = {};
        for (const c of list) {
          (byTier[c.tier] = byTier[c.tier] || []).push(c);
        }
        // 控制体积：每档取样本量最大的 6 个，Tier1/2 优先
        const pick = [];
        for (const t of [1, 2, 3]) {
          const arr = (byTier[t] || []).sort((a, b) => (b.play || 0) - (a.play || 0)).slice(0, 6);
          for (const c of arr) {
            pick.push({
              champion: c.champion,
              tier: c.tier,
              win_rate: pct(c.win_rate),
              pick_rate: pct(c.pick_rate),
              ban_rate: pct(c.ban_rate),
              play: c.play,
            });
          }
        }
        return {
          region: 'KR',
          position: pos,
          total_champions: list.length,
          tier1: pick.filter((c) => c.tier === 1),
          tier2: pick.filter((c) => c.tier === 2),
          tier3_top: pick.filter((c) => c.tier === 3).slice(0, 3),
          note: '胜率已四舍五入到一位小数（百分数）。样本 play<5000 参考价值有限。',
        };
      });
    },
  });

  register('opgg_matchup', {
    description:
      '查“我的英雄对线对面英雄”该怎么打，返回一条针对性对线要点 + 对局强度判断。my_champion/opponent_champion 用英文大写无空格，position 必填。',
    schema: {
      type: 'object',
      properties: {
        my_champion: { type: 'string', description: '英文大写，如 AHRI' },
        opponent_champion: { type: 'string', description: '英文大写，如 ZED' },
        position: { type: 'string', enum: POSITIONS },
      },
      required: ['my_champion', 'opponent_champion', 'position'],
    },
    call: async ({ my_champion, opponent_champion, position }, { signal }) => {
      const pos = String(position || '').toLowerCase();
      if (!POSITIONS.includes(pos)) throw new Error(`position 必须是 ${POSITIONS.join('/')}`);
      return memo(`mu:${norm(my_champion)}:${norm(opponent_champion)}:${pos}`, 6 * 3600e3, async () => {
        // 这个工具没有 desired_output_fields，原始返回实测 54KB，必须在这里剥
        const d = await callTool('lol_get_lane_matchup_guide', {
          position: pos,
          my_champion: norm(my_champion),
          opponent_champion: norm(opponent_champion),
        }, signal);
        if (!d?.data) throw new Error('对线数据为空');
        const s = d.data.summary?.average_stats || {};
        return {
          my_champion: d.my_champion || norm(my_champion),
          opponent_champion: d.opponent_champion || norm(opponent_champion),
          position: pos,
          region: 'KR',
          tip: d.data.opponent_champion_tip || null,
          play_style: d.data.recommended_play_style || null,
          lane_advantage: d.data.lane_advantage_champion || null,
          solo_kill_advantage: d.data.lane_solo_kill_advantage_champion || null,
          my_stats: { tier: s.tier, win_rate: pct(s.win_rate), pick_rate: pct(s.pick_rate), play: s.play },
        };
      });
    },
  });

  register('opgg_pro_check', {
    description:
      '判断某个韩服账号是不是职业选手。是则返回战队、真名、场上位置、韩服名次；否则明确返回不是。game_name 是 Riot ID 的 # 前部分，tag_line 是 # 后部分。',
    schema: {
      type: 'object',
      properties: {
        game_name: { type: 'string', description: 'Riot ID 的 # 前部分，如 Hide on bush' },
        tag_line: { type: 'string', description: 'Riot ID 的 # 后部分，如 KR1' },
      },
      required: ['game_name', 'tag_line'],
    },
    call: async ({ game_name, tag_line }, { signal }) => {
      const gn = String(game_name || '').trim();
      const tl = String(tag_line || '').trim().replace(/^#/, '');
      if (!gn || !tl) throw new Error('game_name 和 tag_line 都要给');
      return memo(`pro:${gn.toLowerCase()}#${tl.toLowerCase()}`, 10 * 60e3, async () => {
        const fetchProfile = (g, t) =>
          callTool('lol_get_summoner_profile', {
            game_name: g,
            tag_line: t,
            region: 'KR',
            desired_output_fields: ['data.summoner.{game_name,tagline,level,player,ladder_rank}'],
          }, signal);

        // 该服务对不存在的 Riot ID 会直接抛 "Summoner not found"，这里统一收敛成 null
        const read = async (g, t) => {
          try {
            return (await fetchProfile(g, t))?.data?.summoner || null;
          } catch (e) {
            if (/not found/i.test(e.message)) return null;
            throw e;
          }
        };
        // 空壳 = 没有职业标记也没有段位（如 Faker#KR1 这个 3 级空号）
        const isEmpty = (x) => !x || (!x.player && !x.ladder_rank);

        let s = await read(gn, tl);
        let resolvedFromAlias = null;

        // 名字查不到或查到空壳 → 把入参当选手别名反查一次。
        // 例：用户说「Faker」，Faker#KR1 是 3 级空号，真号是 Hide on bush#KR1。
        if (isEmpty(s)) {
          const alias = await callTool('lol_get_pro_player_riot_id', { player_name: gn, region: 'KR' }, signal).catch(() => {
            signal?.throwIfAborted();
            return null;
          });
          const p = alias?.data?.player;
          if (p?.riot_id?.game_name) {
            const s2 = await read(p.riot_id.game_name, p.riot_id.tagline);
            if (s2) {
              s = s2;
              resolvedFromAlias = p.nickname || gn;
            }
          }
        }

        if (!s) {
          return {
            found: false,
            region: 'KR',
            game_name: gn,
            tag_line: tl,
            note: '韩服查不到这个 Riot ID（不存在或从未打过），不要据此推断此人水平。',
          };
        }

        const player = s.player && !Array.isArray(s.player) ? s.player : null;
        const team = player?.current_pro_team?.pro_team || null;
        return {
          found: true,
          region: 'KR',
          game_name: s.game_name,
          tag_line: s.tagline,
          level: s.level,
          ladder: s.ladder_rank ? { rank: s.ladder_rank.rank, total: s.ladder_rank.total } : null,
          resolved_from_alias: resolvedFromAlias,
          is_pro: !!player,
          pro: player
            ? {
                nickname: player.nickname,
                real_name: player.real_name,
                team: team?.name || null,
                team_short: team?.short_name || null,
                position: player.current_pro_team?.position || null,
                is_starter: player.current_pro_team?.is_starter ?? null,
                esports_url: player.esports_url || null,
              }
            : null,
          note: player
            ? null
            : '系统没有该账号的职业标记（可能是二队/青训/退役，或确实不是职业选手），不能据此断言"绝对不是"。',
        };
      });
    },
  });
}
