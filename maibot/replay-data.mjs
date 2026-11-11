// Synthetic records shared by the legacy replay and both MaiBot variants.
const match = (event_id, league, teams, start_time, winner) => ({
  event_id, league, teams: teams.map((name, index) => ({ name, ...(winner && { score: index ? 1 : 3 }) })), start_time, winner,
});
const schedule = {
  LCK: [match('fixture-lck', 'LCK', ['T1', 'HLE'], '2026-11-11 18:43', 'T1')],
  LPL: [match('fixture-lpl', 'LPL', ['BLG', 'TES'], '2026-11-11 20:47', 'BLG')],
  LEC: [match('fixture-lec', 'LEC', ['G2', 'FNC'], '2026-11-11 23:53', 'G2')],
  LCS: [match('fixture-lcs', 'LCS', ['C9', 'TL'], '2026-11-12 06:57', 'C9')],
};
const events = Object.values(schedule).flat();
const teamKey = (team) => ({ cloud9: 'c9', 'team liquid': 'tl' })[team?.toLowerCase()] || team?.toLowerCase();
const matchesTeam = (row, team) => !team || row.teams.some((item) => teamKey(item.name) === teamKey(team));
const games = [
  { name: 'Stardew Valley', aliases: ['星露谷物语', '星露谷'], appid: 413150, price: '43', discount: 17, players: 16743, reviews: 282167 },
  { name: 'Hollow Knight', aliases: ['空洞骑士'], appid: 367520, price: '31', discount: 27, players: 10223, reviews: 179237 },
  { name: 'Terraria', aliases: ['泰拉瑞亚'], appid: 105600, price: '29', discount: 33, players: 31279, reviews: 469271 },
  { name: 'Hades', aliases: ['哈迪斯'], appid: 1145360, price: '36', discount: 31, players: 6547, reviews: 149317 },
];
const findGame = (name) => games.find((game) => [game.name, ...game.aliases].some((value) => value.toLowerCase() === name?.toLowerCase()));
const price = ({ appid }) => {
  const game = games.find((item) => item.appid === Number(appid));
  return game && { appid: game.appid, name: game.name, title: game.name, current: '¥' + game.price,
    price: '¥' + game.price, currency: 'CNY', discount: game.discount, discount_percent: game.discount };
};
const reviews = ({ appid }) => {
  const game = games.find((item) => item.appid === Number(appid));
  return game && { appid: game.appid, total: game.reviews, positive: Math.round(game.reviews * 0.97), rating: '好评如潮' };
};
const players = ({ appid }) => {
  const game = games.find((item) => item.appid === Number(appid));
  return game && { appid: game.appid, name: game.name, player_count: game.players };
};
const common = {
  lol_matches_by_date: ['lol', '按日期和联赛查英雄联盟赛程与赛果', ['date', 'league', 'state'],
    ({ date, league }) => ({ date, league, matches: schedule[league?.toUpperCase()] ?? (league ? [] : events) })],
  lol_resolve_event: ['lol', '按队伍和联赛定位一场比赛或下一场比赛', ['team', 'date', 'league', 'state', 'limit'],
    ({ team, league, state, limit }) => ({ events: (schedule[league?.toUpperCase()] || events)
      .filter((row) => matchesTeam(row, team)).slice(0, limit).map((row) => ({ ...row,
        teams: row.teams.map((entry) => entry.name), ...(state === 'upcoming' && { winner: undefined }) })) })],
  lol_recent_results: ['lol', '按队伍查英雄联盟最近赛果和比分', ['team'], ({ team }) => ({ matches: events.filter((row) => matchesTeam(row, team)) })],
  lol_event_vods: ['lol', '按场次 ID 查询录像', ['event_id'], ({ event_id }) => ({
    event_id, vods: events.some((row) => row.event_id === event_id) ? [{ url: 'https://replay.invalid/' + event_id }] : [],
  })],
  steam_find_game: ['steam', '按游戏名找 Steam appid', ['name'], ({ name }) => {
    const game = findGame(name);
    return game ? [{ appid: game.appid, name: game.name }] : [];
  }],
  steam_game_price: ['steam', '根据 appid 查 Steam 售价和折扣', ['appid', 'country'], price],
  steam_game_reviews: ['steam', '根据 appid 查 Steam 评价', ['appid'], reviews],
  steam_app_players: ['steam', '根据 appid 查 Steam 当前在线人数', ['appid', 'name'], players],
  steam_most_played: ['steam', '查 Steam 24 小时峰值在线榜', ['limit'], () => ({
    top: [{ name: 'Counter-Strike 2', peak_24h: 987347 }, { name: 'Dota 2', peak_24h: 654173 }],
  })],
  hltv_get_team_ranking: ['hltv', 'HLTV 最新世界排名和积分', [], () => ({ ranking: [
    { rank: 1, team: 'Vitality', points: 947 }, { rank: 2, team: 'Spirit', points: 841 }, { rank: 3, team: 'NAVI', points: 714 },
  ] })],
  hltv_get_results: ['hltv', 'HLTV 近期 CS2 赛果与比分', [], () => ({ results: [
    { team1: 'Vitality', team2: 'Spirit', result: '2:1', event: '联调杯' },
  ] })],
  opgg_champion_analysis: ['opgg', 'OP.GG 英雄的韩服位置、胜率、装备及符文', ['champion', 'position'], ({ champion, position }) => {
    const values = { ahri: [53.17, '卢登'], jinx: [51.73, '无尽'], garen: [52.19, '挺进破坏者'], lee_sin: [49.87, '焚天'] };
    const [win_rate, item] = values[champion?.toLowerCase().replaceAll(' ', '_')] || [];
    return win_rate ? { champion, position, win_rate, tier: 1, core_items: [item], runes: { primary_runes: ['电刑'] } } : null;
  }],
  opgg_lane_meta: ['opgg', 'OP.GG 韩服位置梯队', ['position'], ({ position }) => ({ position, tier1: [{ champion: '波比' }, { champion: '黛安娜' }] })],
  opgg_matchup: ['opgg', 'OP.GG 韩服英雄对线', ['my_champion', 'opponent_champion', 'position'],
    ({ my_champion, opponent_champion }) => ({ my_champion, opponent_champion, tip: '保留魅惑打反手' })],
};

export const toolNames = Object.keys(common);

export function invokeFixture(name, args) {
  const result = common[name]?.[3](args);
  return result == null ? { ok: false, code: 'not_found' } : { ok: true, result, fetchedAt: Date.UTC(2026, 10, 11) };
}

export function registerFixtures(register, onCall) {
  const legacy = {
    steam_searchApps: ['steam', '按游戏名称搜索 Steam appid', ['query'], ({ query }) => {
      const game = findGame(query);
      return game && { appid: game.appid, title: game.name };
    }],
    steam_getPriceOverview: ['steam', '查价格与折扣', ['appid', 'country'], price],
    steam_getAppReviewSummary: ['steam', '查评价摘要', ['appid'], reviews],
    steam_getPlayerCount: ['steam', '查游戏当前在线', ['appid'], players],
    steam_getAppDetails: ['steam', '查 Steam 游戏详情', ['appid'], price],
  };
  for (const [name, [domain, description, params, invoke]] of Object.entries({ ...common, ...legacy })) {
    const properties = Object.fromEntries(params.map((key) => [key, { type: /^(appid|limit)$/.test(key) ? 'number' : 'string' }]));
    register(name, { domain, description, schema: { type: 'object', properties }, call: (args) => {
      const result = invoke(args);
      onCall({ name, arguments: args, result });
      if (result == null) throw Object.assign(new Error('没有对应的固定数据'), { code: 'not_found' });
      return result;
    } });
  }
}
