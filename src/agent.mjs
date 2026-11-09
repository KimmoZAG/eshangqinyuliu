import { log, nowText, trace, metric, num, groupConfig } from './core.mjs';
import { chat, splitReplies } from '../llm.mjs';
import { buildSystemPrompt, ALIASES } from '../persona.mjs';
import * as memory from './memory.mjs';
import { listTools, callTool, toolsByDomain } from './tools.mjs';

const BOT_NAME = process.env.BOT_NAME || '金桦';

/* ---------------- 角度表（硬状态，防重复） ---------------- */

export const ANGLES = {
  柯希亮: ['对线细节', '补刀', '走位', '技能命中'],
  刘浩文: ['团战站位', '进场时机', '技能全空', '保命选择'],
  张家斌: ['地图意识', '支援', '决策', '资源团', '复盘嘴硬'],
  刘书豪: ['枪法', '道具', '经济管理', '残局处理'],
  赵若卿: ['报点', '配合', '心态', '道具时机', '残局思路'],
  陈羽坤: ['运营', 'D牌', '装备', '站位', '海克斯', '经济', '阵容理解'],
  张睿诚: ['英雄池', '指挥', '意识', '枪法', '残局', '带节奏'],
};

function roster() {
  const out = {};
  for (const [id, p] of Object.entries(memory.profileTable())) if (p.name) out[id] = p.name;
  return out;
}

function systemPrompt() {
  return buildSystemPrompt({ botName: BOT_NAME, members: roster(), now: nowText() });
}

function findPerson(text) {
  const table = memory.profileTable();
  for (const [id, p] of Object.entries(table)) {
    if (p.name && text.includes(p.name)) return { id, name: p.name };
  }
  const lower = String(text || '').toLowerCase();
  for (const [abbr, name] of Object.entries(ALIASES)) {
    if (lower.includes(abbr)) {
      const hit = Object.entries(table).find(([, p]) => p.name === name);
      return { id: hit?.[0] || null, name };
    }
  }
  return null;
}

function pickAngle(person) {
  if (!person?.id) return null;
  const all = ANGLES[person.name] || [];
  const used = memory.usedAngles(person.id, 6 * 3600 * 1000);
  return all.find((a) => !used.includes(a)) || null;
}

/* ---------------- 图片 ---------------- */

async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 快通道：应答 ---------------- */

export async function composeReply({ key, speaker, uid, text, imageUrl, imageHint, limit = num('MAX_BURST', 5) }) {
  // 需要外部数据的问题先走工具通道（OP.GG 等），拿不到再回落普通应答
  const cfg = groupConfig(key);
  const domain = pickDomain(text);
  if (cfg.features.search && domain) {
    trace({ kind: 'domain_route', key, domain });
    const viaTool = await planAndCompose({ key, speaker, uid, text, domain });
    if (viaTool?.length) {
      metric('reply_via_tool');
      return viaTool;
    }
  }

  const person = findPerson(text);
  const angle = pickAngle(person);
  const ctx = memory.buildContext(key, { query: text, memberIds: [uid, person?.id].filter(Boolean) });

  const angleHint = angle ? `\n如果要锐评${person.name}，这次用「${angle}」这个角度，别用别的。` : '';
  const userText = `${ctx}\n\n现在跟你说话的是「${speaker}」，他说：「${text || '（发了张图，没写文字）'}」\n按运行规则回他 1-${Math.min(limit, 3)} 行，每行一条。${angleHint}`;

  const messages = [{ role: 'system', content: systemPrompt() }];
  const img = imageUrl ? await fetchImage(imageUrl) : null;

  if (img) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: img } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: imageHint ? `${userText}\n（图没取到，别编图里的内容）` : userText });
  }

  let out = '';
  try {
    out = await chat(messages, { effort: 'none', maxTokens: 600 });
    metric('llm_reply_ok');
  } catch (e) {
    log('agent', `应答失败 ${e.message}`);
    metric('llm_reply_fail');
    if (img) {
      out = await chat(
        [{ role: 'system', content: systemPrompt() }, { role: 'user', content: `${userText}\n（图看不到，别提图）` }],
        { effort: 'none', maxTokens: 600 },
      ).catch(() => '');
    }
  }

  let lines = splitReplies(out, limit);
  if (!lines.length) lines = ['我刚卡了一下，你再说一遍'];

  if (person && angle) memory.markAngle(person.id, angle);
  return lines;
}

/* ---------------- 插话判定（模型二分类 + 概率） ---------------- */

export async function decideInterject({ key, uid, speaker, text, cfg }) {
  const ctx = memory.buildContext(key, { limit: 10, query: text, memberIds: [uid] });
  const prompt = `${ctx}\n\n现在群友「${speaker}」发了一条：「${text}」\n没人@你。你判断一下值不值得插一句。只输出 JSON：{"speak":0或1,"tone":"损|茶|护|正经","target":"要接话的人名，没有就空"}`;

  let verdict = null;
  try {
    const out = await chat([{ role: 'system', content: systemPrompt() }, { role: 'user', content: prompt }], {
      effort: 'none',
      maxTokens: 60,
    });
    verdict = JSON.parse(out.replace(/```json|```/g, '').trim());
  } catch {
    return { speak: false, reason: 'classify_fail' };
  }

  if (!verdict?.speak) return { speak: false, reason: 'model_no' };
  const p = cfg.interjectP ?? 0.35;
  if (Math.random() > p) return { speak: false, reason: 'sampled_out' };
  return { speak: true, tone: verdict.tone, target: verdict.target };
}

/* ---------------- 慢通道：工具循环 ---------------- */

const DOMAIN_HINTS = {
  steam: /steam|游戏|多少钱|价格|打折|折扣|好评|评价|在线人数|销量|发售|新游|dlc|单机|库里/i,
  lol: /赛程|赛果|比赛|战队|联赛|lpl|lck|世界赛|msi|vod|录像|比分|决赛|小组赛|直播/i,
  hltv: /hltv|cs2|csgo|反恐|major|rating|世界排名|选手|教练|阵容|hltv/i,
  opgg: /韩服|胜率|出场率|ban率|出装|符文|对线|克制|梯队|英雄|职业选手|rank|kda/i,
};

/** 先选域，再按需注入该域工具与 schema（64 个工具不全量暴露） */
export function pickDomain(text) {
  const s = String(text || '');
  const scored = [];
  for (const [domain, re] of Object.entries(DOMAIN_HINTS)) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    const hits = (s.match(g) || []).length;
    if (hits) scored.push({ domain, hits });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.hits - a.hits);
  return scored[0].domain;
}

export function wantsTools(text, cfg) {
  return !!cfg.features.search && !!pickDomain(text);
}

const BASE_PROTOCOL = `

【工具协议】你可以调用工具。需要工具时只输出：{"tool":"工具名","args":{...}}
不需要工具、可以直接回答时输出：{"final":"直接给你的回答"}
不要输出其他任何内容。工具最多用 3 次。参数必须符合给定 schema，不许自己编字段名。

【数据规则】
1. 只报工具返回里真实存在的数字和名称，一个都不许编、不许换算、不许写"大概"。
2. 工具返回错误或查不到，就直接说没查到，不许用你的常识补。
3. 不许说"我给你查查"然后不调工具就结束；要数据就必须先调工具。
4. 这是群聊，回答短，最多 3 行。`;

const DOMAIN_PROTOCOL = {
  opgg: `
【OP.GG 专用】
- 区域固定韩服，不要问"哪个区"。
- 英雄名传英文大写（AHRI / ZED / MISSFORTUNE），中文你负责翻译。
- 胜率/登场率已是百分数（51 就是 51%），不要再乘 100。
- 判断职业选手只看 is_pro，不许凭段位或 ID 猜。`,
  steam: `
【Steam 专用】
- 涉及具体游戏先用 steam_searchApps 找 appid，再用 appid 查详情/价格/在线人数。
- 价格照抄返回的币种和数字，不许换算成人民币，不许说"约"。
- 评价只用 review summary 里的数值；拿不到就说拿不到。
- player_count 是在线人数，不是销量，不许混。`,
  lol: `
【LoL 赛事专用】
- 工具返回是纯文本（markdown），不是 JSON，不要尝试解析结构。
- 时间按返回的原文说，换算时区就说明是北京时间。
- 没直播就说"现在没直播"，这是正常结果不是错误。`,
  hltv: `
【HLTV 专用】
- Rating 保留工具给的原值，不要四舍五入成"很高"。
- 世界排名、积分照抄数字。
- 逐地图数据可能为空数组，空就直接说没解析到，不要重试超过 1 次。`,
};

export async function planAndCompose({ key, speaker, uid, text, domain }) {
  const tools = toolsByDomain(domain).filter((t) => !['recall_memory', 'member_profile'].includes(t.name));
  if (!tools.length) return null;

  const catalog = tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  const ctx = memory.buildContext(key, { query: text, memberIds: [uid] });
  const messages = [
    {
      role: 'system',
      content:
        systemPrompt() +
        BASE_PROTOCOL +
        (DOMAIN_PROTOCOL[domain] || '') +
        `\n可用工具（JSON）：${JSON.stringify(catalog)}`,
    },
    { role: 'user', content: `${ctx}\n\n「${speaker}」问：「${text}」` },
  ];

  for (let i = 0; i < 3; i += 1) {
    let out;
    try {
      out = await chat(messages, { effort: 'none', maxTokens: 500 });
    } catch {
      return null;
    }

    let plan;
    const cleaned = out.replace(/```json|```/g, '').trim();
    try {
      plan = JSON.parse(cleaned);
    } catch {
      // 模型偶尔不按协议、直接说人话：当成 final 用，别把整条回复丢掉
      if (cleaned && !cleaned.startsWith('{')) return splitReplies(cleaned, 5);
      return null;
    }

    if (plan.final) {
      trace({ kind: 'plan_final', key, steps: i });
      return splitReplies(plan.final, 5);
    }
    if (!plan.tool) return null;

    const r = await callTool(plan.tool, plan.args);
    trace({ kind: 'tool_call', key, tool: plan.tool, ok: r.ok });
    messages.push({ role: 'assistant', content: out });
    messages.push({
      role: 'user',
      content: `工具 ${plan.tool} 返回：${JSON.stringify(r.result ?? r.error).slice(0, 3000)}\n继续：需要再查就输出下一个 tool，够了就输出 final。`,
    });
  }
  return null;
}

/* ---------------- 定时话题 ---------------- */

export async function buildTopic({ group, cfg }) {
  const ctx = memory.buildContext(group, { limit: 30 });
  // 定时话题是「拿一个关键词去搜资讯」，opgg_* 是结构化查询工具，参数对不上，必须排除
  const tools = listTools().filter(
    (t) => !['recall_memory', 'member_profile'].includes(t.name) && !t.name.startsWith('opgg_'),
  );
  const canSearch = cfg.features.search && tools.length > 0;

  let material = '';
  if (canSearch) {
    const searchName = tools[0].name;
    const q = await chat(
      [
        { role: 'system', content: '你是话题策划。只输出一个搜索关键词，不要别的。' },
        { role: 'user', content: `群里最近在聊：\n${ctx.slice(-600)}\n\n他们玩 LOL、CS、金铲铲。给一个能聊起来的最新资讯搜索词（版本更新/赛事/英雄改动），只输出词。` },
      ],
      { maxTokens: 40 },
    ).catch(() => '');

    if (q) {
      const r = await callTool(searchName, { query: q.replace(/["'“”]/g, '').trim() });
      if (r.ok && r.result) material = String(r.result).slice(0, 1200);
      trace({ kind: 'topic_search', group, tool: searchName, ok: r.ok, query: q.slice(0, 40) });
    }
  }

  const basis = material
    ? `你可以引用这条信息（别编造，别报没有的数字）：\n${material}`
    : `没有外部信息，只能从今天的聊天里找话题，别编新闻。`;

  const user = `群里最近的聊天：\n${ctx}\n\n${basis}\n\n现在没人说话，你主动抛一个话题，1-2 行，每行不超过 40 字，不@任何人，别说教、别像播报。`;

  const out = await chat([{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }], {
    effort: 'none',
    maxTokens: 300,
  }).catch(() => '');

  const lines = splitReplies(out, 2);
  if (!lines.length) return [];
  return lines;
}

/* ---------------- 反思 ---------------- */

const CLAIM = /(一穿三|上大师|最强|随便赢|我没送|我carry|吊打|稳赢|我全成就|我第一)/;

export function reflect({ key, uid, speaker, text, replyLines }) {
  if (CLAIM.test(text)) {
    memory.addEpisode({ about: [uid], text: `${speaker}说：${text.slice(0, 60)}`, type: 'claim', weight: 2 });
  }
  if (replyLines?.length) {
    memory.addBit(uid, replyLines[0].slice(0, 40));
  }
  trace({ kind: 'reflect', key, claim: CLAIM.test(text), lines: replyLines?.length || 0 });
}
