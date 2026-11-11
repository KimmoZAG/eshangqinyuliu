import { callTool, listTools } from '../tools.mjs';

const descriptions = {
  lol_next: '按队伍查下一场，如 T1 下场打谁，必填 team',
  lol_schedule: '按北京时间日期和联赛查赛程，date 可为 today/yesterday/tomorrow 或 YYYY-MM-DD',
  lol_results: '查近期赛果、比分和胜者，可用 team 指定队伍',
  lol_vod: '查录像，传队伍、日期、联赛或明确的 event_id。可依赖前题的场次',
  lol_tournament: '查询赛事各阶段与决赛时间，传 league',
  hltv_ranking: '查 CS2 队伍世界排名和积分',
  hltv_results: '查 CS2 近期赛果，指定队伍时填英文 team，可用 opponent 指定对手',
  steam_game: '按 game 查 Steam 价格、折扣、评价或当前在线。game 优先用 Steam 英文完整名，如 Stardew Valley。fields 可选 price/reviews/players，默认价格和评价',
  steam_top: '查 Steam 24 小时峰值在线排行',
  opgg_champion: '查英雄数据，传英文 champion 和 position',
  opgg_lane: '查韩服各位置梯队，传 position',
  opgg_matchup: '查韩服对线，传英文 champion、opponent 和 position',
  opgg_pro: '核对职业选手身份，传 game_name 和 tag_line',
  web_search: '查公开网页，传 query，仅使用公开关键词',
};

const keys = ['team', 'date', 'league', 'event_id', 'game', 'country', 'champion', 'opponent',
  'position', 'game_name', 'tag_line', 'query'];
const statusLabels = {
  bad_args: '参数有误',
  clarify: '需要确认查询对象',
  disabled: '这项查询没开',
  not_found: '这项没查到',
  timeout: '这项查询超时了',
  unavailable: '这项数据源暂不可用',
};

export function lookupSpec(search) {
  const actions = Object.keys(descriptions).filter((action) => search || action !== 'web_search');
  return {
    name: 'jinhua_lookup',
    _meta: { visibility: 'visible' },
    annotations: { readOnlyHint: true, openWorldHint: true },
    description: '查实时游戏、赛事、价格或公开事实。问题包含多个可查事项时，在 questions 中逐题列出并按原文排序。'
      + '传原文问题 text、稳定 id 和明确 action。事实类回复使用对应题的证据和状态。'
      + actions.map((name) => name + '：' + descriptions[name]).join('；'),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['questions'],
      properties: {
        anchor: { type: 'string', maxLength: 512, description: '本轮平台回复锚点，按当前会话给出的值原样传回' },
        deadline_ms: { type: 'integer', description: '当前回合的查询截止时间，由会话配置提供' },
        mode: { type: 'string', enum: ['fast', 'auto', 'deep'] },
        questions: {
          type: 'array', minItems: 1, maxItems: 5,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'text', 'action'],
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,24}$' },
              text: { type: 'string', minLength: 1, maxLength: 240 },
              action: { type: 'string', enum: actions },
              depends_on: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,24}$' },
              fields: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['price', 'reviews', 'players'] } },
              ...Object.fromEntries(keys.map((key) => [key, { type: 'string', minLength: 1, maxLength: 120 }])),
            },
          },
        },
      },
    },
  };
}

function error(code, details) {
  return Object.assign(new Error(statusLabels[code]), { code, details });
}

function dateArg(value) {
  if (!value) return 'today';
  const day = { 今天: 'today', 昨天: 'yesterday', 明天: 'tomorrow' }[value] ?? value;
  if (['today', 'yesterday', 'tomorrow'].includes(day)) return day;
  const time = Date.parse(day);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day) return day;
  throw error('bad_args');
}

function selectGame(rows, game) {
  if (!rows.length) throw error('not_found');
  const normalize = (value) => String(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
  const exact = rows.filter((row) => normalize(row.name) === normalize(game));
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  throw error('clarify', rows.slice(0, 4).map((row) => row.name));
}

const steamAliases = new Map([['星露谷', 'Stardew Valley'], ['星露谷物语', 'Stardew Valley']]);
const valueQuestion = /值不值|值不值得|入手|值得买|值得入|能买吗/;
const discountQuestion = /折扣|打折|几折|促销|降价/;

function requestedSteamFields(question) {
  if (valueQuestion.test(question.text)) return ['price', 'reviews'];
  const fields = [];
  if (/价格|售价|多少钱|多少块|多少元|贵不贵/.test(question.text) || discountQuestion.test(question.text)) fields.push('price');
  if (/评价|好评|差评|口碑/.test(question.text)) fields.push('reviews');
  if (/在线|活跃玩家|在玩/.test(question.text)) fields.push('players');
  return fields.length ? fields : [...new Set(question.fields || ['price', 'reviews'])];
}

function textSummary(action, facts, question) {
  const formatEvent = (row) => [
    (row.teams || []).map((team) => typeof team === 'string' ? team
      : team.name + (team.score == null ? '' : ' ' + team.score)).join(' vs '),
    row.start_time, row.league, row.winner && row.winner + ' 赢了',
  ].filter(Boolean).join(' ');
  if (Array.isArray(facts.matches) && ['lol_schedule', 'lol_results'].includes(action)) {
    return facts.matches.slice(0, 3).map(formatEvent).join(' / ') || '这段时间没查到比赛';
  }
  if (action === 'lol_next') return formatEvent(facts.event);
  if (action === 'lol_vod') return facts.vods.map((item) => item.url).slice(0, 2).join(' ');
  if (action === 'lol_tournament' && facts.final) return [facts.league, '决赛', facts.final.start_time].filter(Boolean).join(' ');
  if (action === 'hltv_ranking' && facts.ranking?.length) {
    const limit = /第一|榜首/.test(question) ? 1 : 3;
    return facts.ranking.slice(0, limit).map((row) => [row.rank, row.team, row.points != null && row.points + ' 分'].filter(Boolean).join(' ')).join(' / ');
  }
  if (action === 'steam_game') {
    const { name, price, reviews, players, errors } = facts;
    const discount = price?.discount_percent;
    return [name, price?.free ? '免费' : price?.current && [price.current, price.currency].filter(Boolean).join(' '),
      price && !price.free && !price.current && '该区暂无报价',
      discount > 0 ? `降了 ${discount}%` : discount === 0 && discountQuestion.test(question) && '目前没打折',
      reviews?.rating && reviews.rating + '（' + reviews.total + ' 条评价）',
      Number.isFinite(players?.player_count) && '当前在线 ' + players.player_count,
      ...Object.entries(errors).map(([field, code]) =>
        ({ price: '价格', reviews: '评价', players: '在线' })[field] + ' ' + statusLabels[code]),
      valueQuestion.test(question) && reviews?.total > 0 && reviews.positive / reviews.total >= 0.9 &&
        '喜欢这类玩法的话可以考虑，拿不准就等打折',
    ].filter(Boolean).join(' ');
  }
  if (action === 'steam_top' && facts.top?.length) {
    return '24 小时峰值在线 ' + facts.top.slice(0, 3).map((row) => row.name + ' ' + row.peak_24h).join(' / ');
  }
  if (action === 'opgg_champion') {
    const names = (rows) => (Array.isArray(rows) ? rows.flat(1) : [rows])
      .filter((item) => typeof item === 'string').slice(0, 6).join('、');
    return [facts.champion + ' 韩服 ' + facts.position, facts.tier != null && 'T' + facts.tier,
      facts.win_rate != null && '胜率 ' + facts.win_rate + '%',
      /出装|装备/.test(question) && names(facts.core_items) && '核心 ' + names(facts.core_items),
      /符文/.test(question) && facts.runes && names(facts.runes.primary_runes) && '主系 ' + names(facts.runes.primary_runes),
    ].filter(Boolean).join(' ');
  }
  if (action === 'opgg_lane') {
    return facts.tier1?.length ? '韩服 T1 ' + facts.tier1.slice(0, 4).map((row) => row.champion).join('、') : '';
  }
  if (action === 'opgg_matchup') {
    return [facts.my_champion + ' vs ' + facts.opponent_champion, facts.tip, facts.play_style]
      .filter((value) => typeof value === 'string' && value).join(' ').slice(0, 300);
  }
  if (action === 'opgg_pro') {
    const name = facts.game_name + '#' + facts.tag_line;
    return name + (facts.found === false ? ' 韩服没查到' : facts.is_pro
      ? ' 是职业选手 ' + (facts.pro?.nickname || '') : ' 未标注职业身份');
  }
  if (action === 'web_search') {
    return (facts.results || []).slice(0, 2).map((row) => [row.title, row.snippet, row.url].filter(Boolean).join(' ')).join('\n');
  }
  if (action === 'hltv_results' && Array.isArray(facts.results)) {
    return facts.results.slice(0, 3).map((row) => [row.team1,
      row.result || row.score || (Number.isInteger(row.score1) && Number.isInteger(row.score2) ? `${row.score1}:${row.score2}` : ''),
      row.team2, row.event]
      .filter((item) => typeof item === 'string').join(' ')).filter(Boolean).join(' / ');
  }
  return '';
}

export async function runLookup(args, { signal, search = false, mode = 'auto', invoke = callTool, names = listTools().map((t) => t.name) } = {}) {
  const allowed = new Set(names);
  const questions = args?.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 5) throw error('bad_args');
  const spec = lookupSpec(search).inputSchema.properties.questions.items;
  const ids = new Set();
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !/^[a-zA-Z0-9_-]{1,24}$/.test(q.id)
      || ids.has(q.id) || q.depends_on && !ids.has(q.depends_on)
      || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 240
      || !Object.hasOwn(descriptions, q.action) || Object.keys(q).some((key) => !Object.hasOwn(spec.properties, key))
      || keys.some((key) => q[key] != null && (typeof q[key] !== 'string' || q[key].length > 120))
      || q.fields != null && (!Array.isArray(q.fields) || !q.fields.length || q.fields.length > 3
        || q.fields.some((field) => !spec.properties.fields.items.enum.includes(field)))) throw error('bad_args');
    ids.add(q.id);
  }

  const budget = { fast: 4600, auto: 11000, deep: 20500 }[mode] ?? 11000;
  const remaining = Number.isSafeInteger(args.deadline_ms) ? args.deadline_ms - Date.now() : budget;
  const timeout = remaining <= 0 ? AbortSignal.abort() : AbortSignal.timeout(Math.min(budget, remaining));
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const results = new Map();
  const pendingCalls = new Map();

  async function answer(q) {
    const queriedAt = new Date().toISOString();
    const sources = new Map();
    async function lookup(name, values, source) {
      if (signal.aborted) throw error('timeout');
      if (!allowed.has(name)) throw error('unavailable');
      const params = Object.fromEntries(Object.entries(values).filter(([, value]) => value != null && value !== ''));
      const key = name + JSON.stringify(params);
      sources.set(name, { tool: name, source });
      if (!pendingCalls.has(key)) pendingCalls.set(key, invoke(name, params, { signal, allowed }));
      const result = await pendingCalls.get(key);
      if (!result.ok || result.result == null) throw error(statusLabels[result.code] ? result.code : 'unavailable');
      sources.set(name, { tool: name, source, fetched_at: new Date(result.fetchedAt ?? Date.now()).toISOString() });
      return result.result;
    }
    const lol = (name, values) => lookup(name, values, 'LoL Esports');
    const steam = (name, values) => lookup(name, values, 'Steam');
    const source = (name, values) => lookup(name, values, name.startsWith('opgg') ? 'OP.GG' : 'HLTV');
    try {
      const previous = results.get(q.depends_on)?.facts;
      const team = q.team || previous?.event?.teams?.[0];
      let facts;
      switch (q.action) {
        case 'lol_next': {
          if (!team) throw error('clarify');
          const data = await lol('lol_resolve_event', { team, state: 'upcoming', date: q.date && dateArg(q.date), league: q.league, limit: 1 });
          if (!data.events?.length) throw error('not_found');
          facts = { event: data.events[0] };
          break;
        }
        case 'lol_schedule':
          facts = await lol('lol_matches_by_date', { date: dateArg(q.date), league: q.league });
          break;
        case 'lol_results':
          facts = q.date ? await lol('lol_matches_by_date', { date: dateArg(q.date), league: q.league, state: 'completed' })
            : await lol('lol_recent_results', { team });
          break;
        case 'lol_tournament':
          facts = await lol('lol_tournament', { league: q.league });
          break;
        case 'lol_vod': {
          let eventId = q.event_id || previous?.event?.event_id || previous?.event_id
            || (previous?.matches?.length === 1 ? previous.matches[0].event_id : undefined);
          if (!eventId) {
            if (!team && !q.date && !q.league) throw error('clarify');
            const data = await lol('lol_resolve_event', { team, date: q.date && dateArg(q.date), league: q.league, state: 'completed', limit: 4 });
            if (!data.events?.length) throw error('not_found');
            if (data.events.length !== 1) throw error('clarify', data.events.map((event) => event.teams.join(' vs ') + ' ' + event.start_time));
            eventId = data.events[0].event_id;
          }
          facts = await lol('lol_event_vods', { event_id: String(eventId) });
          if (!facts.vods?.length) throw error('not_found');
          break;
        }
        case 'hltv_ranking':
          facts = await source('hltv_get_team_ranking', {});
          break;
        case 'hltv_results': {
          const data = await source('hltv_get_results', { team: q.team, limit: q.opponent ? 20 : 5 });
          const opponent = q.opponent?.toLowerCase();
          facts = opponent && Array.isArray(data.results) ? { ...data, results: data.results.filter((row) =>
            [row.team1, row.team2].some((name) => name?.toLowerCase().includes(opponent))) } : data;
          break;
        }
        case 'steam_game': {
          const input = q.game?.trim() || previous?.name;
          const game = steamAliases.get(input) || input;
          if (!game) throw error('clarify');
          const selected = previous?.appid && previous.name === game ? previous
            : selectGame(await steam('steam_find_game', { name: game }), game);
          const { appid, name } = selected;
          const requests = {
            price: ['steam_game_price', { appid, country: q.country }],
            reviews: ['steam_game_reviews', { appid }],
            players: ['steam_app_players', { appid, name }],
          };
          const fields = requestedSteamFields(q);
          facts = { appid, name, errors: {} };
          await Promise.all(fields.map(async (field) => {
            try { facts[field] = await steam(...requests[field]); }
            catch (e) { facts.errors[field] = statusLabels[e.code] ? e.code : 'unavailable'; }
          }));
          if (fields.every((field) => facts.errors[field])) throw error(facts.errors[fields[0]]);
          break;
        }
        case 'steam_top':
          facts = await steam('steam_most_played', { limit: 5 });
          break;
        case 'opgg_champion':
          facts = await source('opgg_champion_analysis', { champion: q.champion, position: q.position });
          break;
        case 'opgg_lane':
          facts = await source('opgg_lane_meta', { position: q.position });
          break;
        case 'opgg_matchup':
          facts = await source('opgg_matchup', { my_champion: q.champion, opponent_champion: q.opponent, position: q.position });
          break;
        case 'opgg_pro':
          facts = await source('opgg_pro_check', { game_name: q.game_name, tag_line: q.tag_line });
          break;
        case 'web_search':
          if (!search) throw error('disabled');
          facts = await lookup('web_search', { query: q.query, max_results: 3 }, 'Web');
          break;
      }
      if (q.action.startsWith('hltv_') && facts.error) throw error('unavailable');
      const answerText = textSummary(q.action, facts, q.text);
      if (!answerText) throw error('not_found');
      return { id: q.id, text: q.text, status: 'ok', facts, answer: answerText, queried_at: queriedAt, sources: [...sources.values()] };
    } catch (e) {
      const status = statusLabels[e.code] ? e.code : 'unavailable';
      return { id: q.id, text: q.text, status, answer: statusLabels[status], candidates: e.details,
        queried_at: queriedAt, sources: [...sources.values()] };
    }
  }

  const independent = questions.filter((q) => !q.depends_on);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, independent.length) }, async () => {
    while (next < independent.length) {
      const q = independent[next++];
      results.set(q.id, await answer(q));
    }
  }));
  for (const q of questions.filter((item) => item.depends_on)) results.set(q.id, await answer(q));
  return {
    jinhua_evidence: 1, anchor: typeof args.anchor === 'string' ? args.anchor.slice(0, 512) : '',
    questions: questions.map((q) => results.get(q.id)),
  };
}
