import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'jinha-replay-'));
process.chdir(scratch);
Object.assign(process.env, {
  LLM_BASE_URL: 'https://model.invalid',
  LLM_API_KEY: 'fixture',
  QQ_APP_ID: 'fixture',
  QQ_APP_SECRET: 'fixture',
  SEND_GAP_MS: '0',
  DATA_TOOLS_ENABLED: '0',
  SEARCH_ENABLED: '0',
  LLM_REASONING_STYLE: 'effort',
  LLM_DEEP_EFFORT: 'low',
  USER_QPM: '100',
});
const { splitQuestions } = await import('../src/agent.mjs');
const { sendLines } = await import('../src/outbox.mjs');
const { handleEvent } = await import('../src/app.mjs');
const { normalize } = await import('../src/transport.mjs');
const { DIRS, patchGroupConfig, writeJson } = await import('../src/core.mjs');
const { callTool, listTools, register, startMcpServers } = await import('../src/tools.mjs');
const memory = await import('../src/memory.mjs');

function group(group, id, content, { at = true, author = 'member', timestamp = new Date().toISOString() } = {}) {
  return normalize({
    t: at ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
    d: { id, group_openid: group, content, author: { member_openid: author, username: '队友' }, timestamp },
  });
}

function c2c(openid, id, content) {
  return normalize({
    t: 'C2C_MESSAGE_CREATE',
    d: { id, content, author: { user_openid: openid }, timestamp: new Date().toISOString() },
  });
}

function fixture(t, model, send) {
  const prompts = [];
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'fixture', expires_in: 7200 });
    const request = JSON.parse(body);
    if (endpoint.hostname === 'model.invalid') {
      const stage = request.messages[0].content.match(/^\[([^\]]+)]/)?.[1];
      const input = JSON.parse(request.messages[1].content);
      prompts.push({ stage, input, request });
      const answer = await model(stage, input, request);
      const choice = typeof answer === 'string'
        ? { finish_reason: 'stop', message: { content: answer } }
        : { finish_reason: 'stop', message: { content: JSON.stringify(answer) } };
      return Response.json({ choices: [answer?.fixtureChoice || choice] });
    }
    if (endpoint.pathname.endsWith('/messages')) {
      sent.push({ endpoint: endpoint.pathname, ...request });
      return send?.(request) || Response.json({ id: 'ack-' + (request.msg_id || endpoint.pathname) + '-' + sent.length });
    }
    assert.fail('意外的外部请求 ' + url);
  });
  return { prompts, sent };
}

const schedule = {
  date: '2026-11-10', league: 'LPL', count: 1,
  matches: [{ start_time: '2026-11-10 19:00', teams: [{ name: '队伍甲' }, { name: '队伍乙' }] }],
};
const ranking = { ranking: [{ team: 'Fixture', rank: 1, points: 901 }] };
function registerSchedule(call = () => schedule) {
  register('lol_matches_by_date', {
    domain: 'lol', call,
    schema: { type: 'object', properties: { date: { type: 'string' }, league: { type: 'string' } } },
  });
}

function registerRanking(call = () => ranking) {
  register('hltv_get_team_ranking', { domain: 'hltv', call });
}

function grounded(items, texts) {
  return { answers: items.map((item, index) => ({
    id: item.id, status: 'answered', text: texts[index], evidence: item.evidence.slice(-1).map(({ id }) => id),
  })) };
}

after(() => {
  process.chdir(root);
  rmSync(scratch, { recursive: true, force: true });
});

test('短追问和逗号连接的独立问题都有位置', () => {
  assert.deepEqual(splitQuestions('谁赢了？几比几？'), ['谁赢了', '几比几']);
  assert.deepEqual(splitQuestions('今天 LPL 有比赛吗，Steam 上艾尔登法环打折没'), [
    '今天 LPL 有比赛吗', 'Steam 上艾尔登法环打折没',
  ]);
});

test('发送 HTTP 502 即使无业务错误码也失败', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('getAppAccessToken')) return Response.json({ access_token: 'fixture', expires_in: 7200 });
    return new Response('upstream error', { status: 502 });
  });
  const [result] = await sendLines({ group: 'outbox', msgId: '502', lines: ['这条没有送达'] });
  assert.equal(result.ok, false);
});

test('跨域三问取证后依原顺序发出，单条限制仍覆盖全部', async (t) => {
  patchGroupConfig('mixed', { features: { tools: true, search: false }, replyLimit: 1 });
  let scheduleArgs;
  registerSchedule((args) => { scheduleArgs = args; return schedule; });
  registerRanking();
  register('steam_searchApps', {
    domain: 'steam', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    call: () => ({ appid: 123, title: '艾尔登法环' }),
  });
  register('steam_getPriceOverview', {
    domain: 'steam', schema: { type: 'object', properties: { appid: { type: 'number' } }, required: ['appid'] },
    call: ({ appid }) => ({ appid, title: '艾尔登法环', discount: 25, currency: 'CNY' }),
  });
  const { prompts, sent } = fixture(t, (stage, input) => {
    if (stage === 'tool-plan') return input.steps.length
      ? { tool: 'steam_getPriceOverview', args: { appid: 123 }, finishAfter: true }
      : { tool: 'steam_searchApps', args: { query: '艾尔登法环' } };
    return grounded(input.questions, ['今晚 19:00 队伍甲打队伍乙', '艾尔登法环降了 25%', 'CS 世界第一是 Fixture']);
  });
  await handleEvent(group('mixed', 'mix', '今天 LPL 有比赛吗？Steam 上的艾尔登法环打折了吗？CS2 世界第一是谁？'));
  assert.deepEqual(scheduleArgs, { date: 'today', league: 'LPL' });
  assert.equal(prompts.filter(({ stage }) => stage === 'tool-plan').length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '今晚 19:00 队伍甲打队伍乙\n艾尔登法环降了 25%\nCS 世界第一是 Fixture');
  assert.equal(memory.recentSelf('mixed')[0], sent[0].content);
});

test('第三次工具返回的事实交给成稿，解析 appid 的中间结果不能直接作答', async (t) => {
  patchGroupConfig('three', { features: { tools: true, search: false } });
  register('steam_getAppDetails', { domain: 'steam', call: () => ({ title: '道具游戏' }) });
  const { prompts, sent } = fixture(t, (stage, input) => {
    if (stage === 'tool-plan') {
      return [
        { tool: 'steam_searchApps', args: { query: '道具游戏' } },
        { tool: 'steam_getAppDetails', args: {} },
        { tool: 'steam_getPriceOverview', args: { appid: 123 } },
      ][input.steps.length];
    }
    const item = input.questions[0];
    assert.deepEqual(item.evidence.map(({ id }) => id), ['q1-e2', 'q1-e3']);
    return grounded(input.questions, ['折扣 25%']);
  });
  await handleEvent(group('three', 'third-result', 'Steam 上的道具游戏打折吗？'));
  assert.deepEqual(prompts.map(({ stage }) => stage), ['tool-plan', 'tool-plan', 'tool-plan', 'answer-by-id']);
  assert.equal(sent[0].content, '折扣 25%');
});

test('丢失或串题的答案按各自证据降级，不发跨题数字和链接', async (t) => {
  patchGroupConfig('coverage', { features: { tools: true, search: false } });
  registerSchedule();
  registerRanking();
  const { sent } = fixture(t, () => ({
    answers: [
      { id: 'q1', status: 'answered', text: '今晚 99 场 https://fake.invalid/', evidence: ['q1-e1'] },
      { id: 'q2', status: 'answered', text: '今晚 99 场', evidence: ['q1-e1'] },
    ],
  }));
  await handleEvent(group('coverage', 'missing', '今天 LPL 有比赛吗？CS2 世界第一是谁？'));
  assert.deepEqual(sent.map(({ content }) => content), [
    '今天 LPL 1 场 19:00 队伍甲 vs 队伍乙',
    'CS 世界第一是 Fixture 901 分',
  ]);
});

test('慢工具取消后仍交付另一题，不延长当前回合预算', async (t) => {
  const oldBudget = process.env.REPLY_FAST_MS;
  process.env.REPLY_FAST_MS = '400';
  t.after(() => {
    if (oldBudget === undefined) delete process.env.REPLY_FAST_MS;
    else process.env.REPLY_FAST_MS = oldBudget;
  });
  patchGroupConfig('partial', { features: { tools: true, search: false } });
  registerSchedule();
  let cancelled = false;
  registerRanking(async (_, { signal }) => {
    try {
      await wait(2000, undefined, { signal });
      return ranking;
    } catch (error) {
      cancelled = signal.aborted;
      throw error;
    }
  });
  const { sent } = fixture(t, (_, input) => grounded(input.questions, ['今晚 19:00 队伍甲打队伍乙', '编的事实']));
  await handleEvent(group('partial', 'timeout', '/快答 今天 LPL 有比赛吗？CS2 世界第一是谁？', { at: false }));
  assert.equal(cancelled, true);
  assert.equal(sent[0].content, '今晚 19:00 队伍甲打队伍乙');
  assert.match(sent[1].content, /CS2.*查超时/);
});

test('短追问沿用会话的赛事对象并逐题成稿', async (t) => {
  patchGroupConfig('follow-up', { features: { tools: true, search: false } });
  register('lol_recent_results', {
    domain: 'lol', call: () => ({ matches: [{ winner: '队伍甲', teams: [{ name: '队伍甲', score: 2 }, { name: '队伍乙', score: 1 }] }] }),
  });
  memory.addMessage('follow-up', { id: 'previous', u: 'member', n: '队友', c: '昨天 LPL 那场 队伍甲打队伍乙' });
  const { prompts, sent } = fixture(t, (stage, input) => {
    if (stage === 'route') return { routes: input.questions.map(({ id }) => ({ id, domain: 'lol' })) };
    if (stage === 'tool-plan') return { tool: 'lol_recent_results', args: {}, finishAfter: true };
    return grounded(input.questions, ['队伍甲赢了', '2 比 1']);
  });
  await handleEvent(group('follow-up', 'short', '谁赢了？几比几？'));
  assert.match(prompts[0].input.context, /昨天 LPL 那场/);
  assert.equal(prompts[2].input.previous?.id, 'q1');
  assert.deepEqual(sent.map(({ content }) => content), ['队伍甲赢了', '2 比 1']);
});

test('显式深想启用一轮思考，截断时退回正常成稿，私聊记住实际送达', async (t) => {
  const { prompts, sent } = fixture(t, (_, __, request) => request.reasoning_effort === 'low'
    ? { fixtureChoice: { finish_reason: 'length', message: { content: '半截话', reasoning_content: '内部内容' } } }
    : '先退队列喝口水 等会儿再看哪把最冤');
  await handleEvent(c2c('friend', 'deep', '/深想 连跪了怎么调整'));
  assert.deepEqual(prompts.map(({ request }) => request.reasoning_effort), ['low', 'none']);
  assert.equal(sent[0].content, '先退队列喝口水 等会儿再看哪把最冤');
  assert.equal(memory.recentSelf('c2c:friend')[0], sent[0].content);
  assert.ok(prompts[0].request.messages[0].content.includes('先接情绪'));
});

test('闲聊和禁用工具的问句不会先做路由，群聊记忆不会串到别处', async (t) => {
  const { prompts, sent } = fixture(t, () => '行 我先截图');
  await handleEvent(group('casual', 'chat', '输一把就睡'));
  await handleEvent(group('casual', 'off', '今天 LPL 有比赛吗？'));
  assert.deepEqual(prompts.map(({ stage }) => stage), ['chat-reply']);
  assert.equal(sent[1].content, '这项查询没开');
  await handleEvent(group('casual', 'claim', '刚才一穿三'));
  assert.equal(memory.memberClaims('casual', 'member')[0]?.sourceId, 'claim');
  assert.match(memory.buildContext('casual', { query: '一穿三' }), /一穿三/);
  assert.doesNotMatch(memory.buildContext('other', { query: '一穿三' }), /一穿三/);
  assert.doesNotMatch(memory.buildContext('c2c:member', { query: '一穿三' }), /一穿三/);
});

test('插话语气和目标进成稿，已经过时的主动插话不发', async (t) => {
  patchGroupConfig('interject', { interjectP: 1, quiet: [0, 0] });
  const { prompts, sent } = fixture(t, (stage) =>
    stage === 'interject' ? { speak: true, tone: '茶', target: '队友' } : '好一个有想法');
  await handleEvent(group('interject', 'fresh', '刚才那波我有想法的', { at: false }));
  assert.deepEqual(prompts[1].input.interject, { tone: '茶', target: '队友' });
  assert.equal(sent[0].content, '好一个有想法');

  patchGroupConfig('stale', { interjectP: 1, quiet: [0, 0] });
  let release;
  let started;
  const waiting = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  // 在两次事件之间替换分类调用的返回时机。
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('model.invalid') && JSON.parse(init.body).messages[0].content.startsWith('[interject]')) {
      started();
      await waiting;
    }
    return original(url, init);
  });
  const old = handleEvent(group('stale', 'old', '那波我有想法的', { at: false }));
  await entered;
  await handleEvent(group('stale', 'fresh-at', '过来一下'));
  release();
  await old;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].msg_id, 'fresh-at');
});

test('未送达的回复不入记忆，过期消息不启动模型或发送', async (t) => {
  const { prompts, sent } = fixture(t, () => '只在成功时入记忆', () => new Response('bad gateway', { status: 502 }));
  await handleEvent(group('failure', 'failed', '醒啦'));
  assert.deepEqual(memory.recentSelf('failure'), []);
  await handleEvent(group('failure', 'expired', '迟到的消息', { timestamp: new Date(Date.now() - 600_000).toISOString() }));
  assert.equal(prompts.length, 1);
  assert.equal(sent.length, 1);
});

test('工具参数、工具授权和当前会话范围由执行器检查', async () => {
  register('fixture_schema', {
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    call: ({ id }) => ({ id }),
  });
  assert.equal((await callTool('fixture_schema', { id: 3 }, { allowed: new Set() })).code, 'tool_not_allowed');
  assert.equal((await callTool('fixture_schema', { id: '3' }, { allowed: new Set(['fixture_schema']) })).code, 'bad_args');
  assert.equal((await callTool('fixture_schema', { id: 3 }, { allowed: new Set(['fixture_schema']) })).ok, true);
  const allowed = new Set(['recall_memory']);
  assert.deepEqual((await callTool('recall_memory', { query: '一穿三' }, { key: 'other', allowed })).result, []);
});

test('没有标点的跨域问题只加一次拆解，保留原文顺序', async (t) => {
  patchGroupConfig('run-on', { features: { tools: true, search: false } });
  registerSchedule();
  registerRanking();
  const { prompts, sent } = fixture(t, (stage, input) => stage === 'split'
    ? { parts: ['今天 LPL 有比赛吗', 'CS2 世界第一是谁'] }
    : grounded(input.questions, ['今晚 19:00 队伍甲打队伍乙', 'CS 世界第一是 Fixture']));
  await handleEvent(group('run-on', 'no-punctuation', '今天 LPL 有比赛吗CS2 世界第一是谁'));
  assert.deepEqual(prompts.map(({ stage }) => stage), ['split', 'answer-by-id']);
  assert.deepEqual(sent.map(({ content }) => content), ['今晚 19:00 队伍甲打队伍乙', 'CS 世界第一是 Fixture']);
});

test('超出每轮问题上限会说明，发言条数上限不会吞掉已处理的题', async (t) => {
  const previous = process.env.REPLY_MAX_QUESTIONS;
  process.env.REPLY_MAX_QUESTIONS = '2';
  t.after(() => {
    if (previous === undefined) delete process.env.REPLY_MAX_QUESTIONS;
    else process.env.REPLY_MAX_QUESTIONS = previous;
  });
  patchGroupConfig('overflow', { replyLimit: 1 });
  const { sent } = fixture(t, (_, input) => grounded(input.questions, ['等一下就来', '我在这呢']));
  await handleEvent(group('overflow', 'overflow', '来吗？你在哪？还等谁？'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^等一下就来\n我在这呢\n后面还有 1 题/);
});

test('模型把思考标签混进正文时，发送前去掉整个内容块', async (t) => {
  const { sent } = fixture(t, (_, input) => input.message === '到哪了'
    ? '<think>\n内部分析\n</think>\n来了来了'
    : '<think>\n残缺的内部分析');
  await handleEvent(c2c('hidden', 'closed-think', '到哪了'));
  await handleEvent(c2c('hidden', 'open-think', '还来吗'));
  assert.deepEqual(sent.map(({ content }) => content), ['来了来了', '刚卡了一下 你接着说']);
});

test('同群慢回复不挡住后到的 @，两条消息按各自 msg_id 回', async (t) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { sent } = fixture(t, async (_, input) => {
    if (input.message === '等我的这条') {
      entered();
      await gate;
    }
    return '接到了 ' + input.message;
  });
  const slow = handleEvent(group('race', 'slower', '等我的这条', { author: 'one' }));
  await started;
  await handleEvent(group('race', 'quicker', '先回我的', { author: 'two' }));
  release();
  await slow;
  assert.deepEqual(sent.map(({ msg_id }) => msg_id), ['quicker', 'slower']);
  assert.deepEqual(sent.map(({ content }) => content), ['接到了 先回我的', '接到了 等我的这条']);
});

test('MCP 子进程无法启动时，LoL 直连适配器仍能按联赛筛赛程', async (t) => {
  writeJson(join(DIRS.config, 'mcp.json'), [{
    name: 'offline-lol', domain: 'lol',
    command: join(scratch, 'missing-executable'), initTimeoutMs: 200,
    adapters: [join(root, 'src', 'tools', 'lol-adapters.mjs')],
  }]);
  const up = await startMcpServers();
  assert.equal(up.servers, 0);
  assert.ok(listTools().some(({ name }) => name === 'lol_matches_by_date'));
  const events = ['LPL', 'LCK'].map((league, index) => ({
    startTime: '2026-11-10T11:00:00Z', state: 'unstarted',
    league: { name: league }, match: { id: String(index + 1), teams: [{ name: league + ' 甲' }, { name: league + ' 乙' }] },
  }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { schedule: { events } } }));
  const result = await callTool('lol_matches_by_date', { league: 'LPL', date: '2026-11-10' });
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 1);
  assert.equal(result.result.matches[0].league, 'LPL');
});
