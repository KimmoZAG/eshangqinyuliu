import { chat, splitReplies } from '../llm.mjs';
import { ALIASES, buildSystemPrompt } from '../persona.mjs';
import { groupConfig, MAX_BURST, nowText, num, trace } from './core.mjs';
import * as memory from './memory.mjs';
import { readMembers, nameOf, markAngle, usedAngles } from './members.mjs';
import { formatDialogue, planningContext } from './context.mjs';
import { needsSemanticSplit, parseReplyMode, questionsOf } from './questions.mjs';
import { parseObject, researchQuestions, splitAmbiguous } from './research.mjs';

const BOT_NAME = process.env.BOT_NAME || '金桦';
const MAX_BUBBLE = 200;
const CLAIM = /(一穿三|上大师|最强|随便赢|我没送|我carry|吊打|稳赢|我全成就|我第一)/i;
const SUPPORT = /难受|想哭|好累|崩溃|心态炸|认真问|求助|失眠|怎么办|怎么练|怎么调整|能帮我/;
const FILLER = /^(?:哈+|呵+|啊+|欸+|6+|嗯+|哦+|好|在|草|卧槽|牛逼|ok|👍)[\s!！。~～?？]*$/i;
const ANGLES = {
  柯希亮: ['对线', '补刀', '走位', '技能命中'],
  刘浩文: ['团战站位', '进场时机', '技能全空', '保命选择'],
  张家斌: ['地图意识', '支援', '决策', '资源团', '复盘嘴硬'],
  刘书豪: ['枪法', '道具', '经济管理', '残局'],
  赵若卿: ['报点', '配合', '心态', '道具时机', '残局思路'],
  陈羽坤: ['运营', 'D牌', '装备', '站位', '海克斯', '经济', '阵容'],
  张睿诚: ['英雄池', '指挥', '意识', '枪法', '残局', '带节奏'],
};

export function sanitizeLines(lines) {
  return lines.map((line) => String(line).trim())
    .filter((line) => line && !/^\s*[{[]|<\/?(?:tool_call|think|analysis)\b|"tool"\s*:/i.test(line));
}

export function publicContent(output) {
  const text = output.replace(/<(think|analysis|tool_call)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').trim();
  return /<\/?(think|analysis|tool_call)\b/i.test(text) ? '' : text;
}

export function systemPrompt(members, options = {}) {
  const names = [...members.keys()].slice(-12).map((id) => nameOf(id, '', members));
  return buildSystemPrompt({ botName: BOT_NAME, members: names, now: nowText(), ...options });
}

function getAngle(key, text, members) {
  const alias = Object.entries(ALIASES).find(([abbr, name]) => text.toLowerCase().includes(abbr) || text.includes(name));
  const member = alias && [...members.values()].find((person) => person.verified && person.name === alias[1]);
  if (!member) return null;
  const { openid: id, name } = member;
  const used = usedAngles(key, id);
  const angle = ANGLES[name]?.find((angle) => !used.includes(angle));
  return angle ? { id, name, angle } : null;
}

async function fetchImage(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || 'image/jpeg';
    const maxBytes = 8 * 1024 * 1024;
    if (!type.startsWith('image/') || Number(response.headers.get('content-length')) > maxBytes || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) return null;
      chunks.push(chunk);
    }
    return 'data:' + type + ';base64,' + Buffer.concat(chunks).toString('base64');
  } catch {
    return null;
  }
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  const shortened = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '');
  const partialUrl = shortened.match(/https?:\/\/\S*$/);
  return (partialUrl ? shortened.slice(0, partialUrl.index).trimEnd() : shortened.trimEnd()) + '…';
}

function packAnswers(answers, limit) {
  const lines = [];
  for (let i = 0; i < answers.length;) {
    const count = Math.ceil((answers.length - i) / (limit - lines.length));
    const parts = answers.slice(i, i + count).map((text, index) => ({ text, index }));
    parts.sort((a, b) => a.text.length - b.text.length);
    const fitted = [];
    let remaining = MAX_BUBBLE - count + 1;
    for (const [j, part] of parts.entries()) {
      const text = clip(part.text, Math.floor(remaining / (count - j)));
      fitted[part.index] = text;
      remaining -= text.length;
    }
    lines.push(fitted.join('\n'));
    i += count;
  }
  return lines;
}

function fallbackEvidence(item) {
  const { text } = item;
  for (const { tool, facts } of item.evidence) {
    if (tool === 'lol_matches_by_date' || tool === 'lol_recent_results') {
      const { league, count, matches } = facts || {};
      const day = text.match(/昨天|今天|明天|\d{4}-\d{2}-\d{2}/)?.[0] || '';
      const prefix = [day, league].filter(Boolean).join(' ');
      if (count === 0) return prefix ? prefix + ' 没查到比赛' : '这段时间没查到比赛';
      if (!Array.isArray(matches) || !matches.length) continue;
      if (/谁赢|赛果|比分|几比几/.test(text)) {
        const done = matches.filter((match) => match.winner && match.teams?.length === 2
          && match.teams.every((team) => team.score != null && team.name));
        if (done.length) return done.slice(0, 2).map((m) =>
          m.teams.map((t) => t.name + ' ' + t.score).join(' : ') + ' ' + m.winner + ' 赢了').join(' / ');
      } else {
        const list = matches.slice(0, 2).filter((m) => m.start_time && m.teams?.length === 2);
        if (list.length) {
          return (prefix ? prefix + ' ' : '') + count + ' 场 ' + list.map((m) =>
            (day ? m.start_time.slice(-5) : m.start_time) + ' ' + m.teams.map((t) => t.name).join(' vs ')).join(' / ');
        }
      }
    }
    if (tool === 'hltv_get_team_ranking' && /世界第一|排名第一/.test(text)) {
      const top = facts?.ranking?.[0];
      if (top?.rank === 1 && top.team) return 'CS 世界第一是 ' + top.team + (top.points == null ? '' : ' ' + top.points + ' 分');
    }
    if (tool === 'lol_event_vods' && facts?.vods?.[0]?.url) {
      const url = facts.vods[0].url;
      if (/^https:\/\/(?:www\.youtube\.com|vod\.afreecatv\.com|www\.twitch\.tv)\//.test(url)) return '录像在这 ' + url;
    }
    if (tool === 'steam_app_players' && facts?.name && Number.isFinite(facts.player_count)) {
      return facts.name + ' 现在在线 ' + facts.player_count + ' 人';
    }
  }
  return '';
}

function fallbackAnswer(item, multiple) {
  const fact = sanitizeLines([publicContent(fallbackEvidence(item))])[0];
  if (fact) return { text: fact, status: 'answered' };
  const message = {
    timeout: '这题查超时了', disabled: '这项查询没开', evidence: '资料有了 这题还没确认',
    chat: '这句我刚没接上', refused: '这类话题我就不接啦', unavailable: '这题没查到', clarify: '说的是哪场或者哪个呀',
  }[item.status];
  return { text: multiple ? clip(item.text, 20) + ' 这块 ' + message : message, status: item.status };
}

const numberTokens = (value) => String(value).match(/\d+(?:,\d{3})*(?:\.\d+)?/g)?.map((part) =>
  part.replaceAll(',', '').replace(/^0+(?=\d)/, '')) || [];

function validateAnswer(item, candidate, multiple) {
  const fallback = () => fallbackAnswer(item, multiple);
  const text = typeof candidate?.text === 'string' ? sanitizeLines([candidate.text.trim().replace(/[\r\n]+/g, ' ')])[0] : '';
  if (!text || candidate.status !== 'answered' || !['chat', 'evidence'].includes(item.status)) return fallback();
  if (item.status === 'evidence') {
    if (!Array.isArray(candidate.evidence) || !candidate.evidence.length) return fallback();
    const cited = candidate.evidence.map((id) => item.evidence.find((entry) => entry.id === id));
    if (cited.some((entry) => !entry)) return fallback();
    const numbers = new Set(numberTokens(JSON.stringify(cited.map((entry) => entry.facts))));
    if (numberTokens(text).some((part) => !numbers.has(part))) return fallback();
    const sources = JSON.stringify(cited.map((entry) => entry.facts));
    if ((text.match(/https?:\/\/[^\s，。]+/g) || []).some((url) => !sources.includes(url))) return fallback();
  }
  return { text, status: 'answered' };
}

function workBudget(mode) {
  const defaultMs = { fast: 7000, auto: 15000, deep: 25000 }[mode];
  return Math.max(100, Math.min(120_000, Math.trunc(num('REPLY_' + mode.toUpperCase() + '_MS', defaultMs)) || defaultMs));
}

function thinkingMode(mode, questions) {
  if (process.env.LLM_REASONING_STYLE === 'none') return 'none';
  if (mode === 'deep') return process.env.LLM_DEEP_EFFORT || 'low';
  const complex = questions.filter((q) => q.lookup).length > 1 || questions.some((q) => q.resolve || q.dependsOn);
  return mode === 'auto' && complex ? process.env.LLM_AUTO_EFFORT || 'none' : 'none';
}

export async function composeReply({
  key, speaker, uid, text, imageUrl, imageHint, messageId, cfg = groupConfig(key),
  limit = cfg.replyLimit, mode = cfg.replyMode, turnId, receivedAt = Date.now(), deadline = Infinity, interject,
}) {
  const request = parseReplyMode(text, mode);
  const message = request.text;
  mode = request.mode;
  const maxLines = Math.max(1, Math.min(MAX_BURST, Math.trunc(limit) || 1));
  if (Date.now() >= deadline) return [];
  if (request.explicit && !message && !imageUrl) return ['这档只管这一条 在命令后面带上要问的就行'];
  if (message.length > 3000) return ['这条有点长 拆两段发我吧'];

  const budgetMs = workBudget(mode);
  const workEnd = Math.min(deadline, receivedAt + budgetMs);
  const reserve = Math.min(3500, Math.ceil(budgetMs * 0.35));
  const makeSignal = (end) => {
    const remaining = end - Date.now();
    return remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
  };
  const snapshot = memory.readContext(key, { limit: 12, query: message, excludeId: messageId });
  const members = readMembers([...snapshot.participants, uid]);
  const angle = getAngle(key, message, members);
  const researchEnd = workEnd - reserve;
  const researchSignal = makeSignal(researchEnd);
  let questions = questionsOf(message);
  if (!researchSignal.aborted && needsSemanticSplit(message, questions)) {
    const segments = await splitAmbiguous(message, makeSignal(Math.min(researchEnd, Date.now() + 2300)));
    if (segments) questions = questionsOf(message, segments);
  }
  const maxQuestions = Math.max(1, Math.min(8, Math.trunc(num('REPLY_MAX_QUESTIONS', 5)) || 5));
  const active = questions.slice(0, maxQuestions);
  const deferred = questions.length - active.length;
  const effort = thinkingMode(mode, active);
  let thinkingUsed = false;
  const takeEffort = () => {
    if (thinkingUsed || effort === 'none') return 'none';
    thinkingUsed = true;
    return effort;
  };

  const hasLookup = active.some((q) => q.lookup);
  const structured = hasLookup || active.length > 1 || deferred > 0;
  const [items, image] = await Promise.all([
    researchQuestions(active, {
      cfg, context: planningContext(snapshot), text: message, signal: researchSignal, takeEffort, turnId, fast: mode === 'fast',
    }),
    imageUrl && Date.now() < researchEnd ? fetchImage(imageUrl, researchSignal) : null,
  ]);
  const member = members.get(uid);
  const relationship = member?.verified && member.name === ALIASES.zrc;
  const scene = SUPPORT.test(message) ? 'support' : structured && hasLookup ? 'facts'
    : interject ? 'interject' : relationship ? 'close' : 'chat';
  const available = !structured || items.some((item) => item.status === 'chat' || item.status === 'evidence');
  let output = '';
  let error;
  if (Date.now() < workEnd && available) {
    const prompt = {
      context: formatDialogue(snapshot, members, uid),
      speaker, message, interject, angle: angle && { who: angle.name, topic: angle.angle },
      shortReaction: FILLER.test(message), image: image ? '可见' : imageHint ? '没取到图，别猜' : undefined,
      questions: structured ? items.map(({ id, text, status, evidence }) => ({ id, text, status, evidence })) : undefined,
    };
    const stage = structured ? '[answer-by-id] ' : '[chat-reply] ';
    const messages = [{ role: 'system', content: stage + systemPrompt(members, { scene, structured, relationship }) }];
    const payload = JSON.stringify(prompt);
    messages.push({
      role: 'user', content: image
        ? [{ type: 'text', text: payload }, { type: 'image_url', image_url: { url: image } }]
        : payload,
    });
    const signal = makeSignal(workEnd);
    const canThink = !structured || mode === 'deep' && Date.now() + reserve < workEnd;
    const finalEffort = canThink ? takeEffort() : 'none';
    const generate = (options) => chat(messages, { signal, maxTokens: structured ? 180 + 105 * active.length : 180, ...options });
    try {
      output = await generate({ effort: finalEffort, ...(finalEffort !== 'none' ? { maxTokens: 950 } : {}) });
    } catch (e) {
      error = e.code || e.name;
      if (!signal.aborted && (image || finalEffort !== 'none')) {
        messages[1].content = JSON.stringify({ ...prompt, image: imageHint ? '没取到图，别猜' : undefined });
        output = await generate().catch(() => '');
      }
    }
  }
  output = publicContent(output);
  let lines;
  let statuses;
  if (structured) {
    const answer = parseObject(output)?.answers;
    const entries = Array.isArray(answer) ? answer : [];
    const accepted = new Map();
    const answers = items.map((item) => {
      const matches = entries.filter((entry) => entry?.id === item.id);
      const result = validateAnswer(item, matches.length === 1 ? matches[0] : null, questions.length > 1);
      const same = accepted.get(result.text);
      if (same && item.domain !== same.domain) return fallbackAnswer(item, true);
      if (result.status === 'answered') accepted.set(result.text, item);
      return result;
    });
    statuses = answers.map((result, index) => ({ id: items[index].id, domain: items[index].domain, status: result.status }));
    const rendered = answers.map((result) => result.text);
    if (deferred) rendered.push('后面还有 ' + deferred + ' 题 这轮没来得及 你再甩我一次');
    lines = packAnswers(rendered, maxLines);
  } else {
    lines = sanitizeLines(splitReplies(output, Math.min(maxLines, 2))).map((line) => clip(line, MAX_BUBBLE));
    if (interject && lines.length) {
      const normalized = (line) => line.replace(/[\s\p{P}]/gu, '');
      const recent = new Set(memory.recentSelf(key, 3).map(normalized));
      lines = lines.filter((line) => !recent.has(normalized(line)));
    }
    statuses = [{ id: 'q1', status: lines.length ? 'answered' : 'unavailable' }];
    if (!lines.length && !interject) lines = ['刚卡了一下 你接着说'];
  }
  trace({ kind: 'reply_composed', turnId, key, mode, thinkingUsed, statuses, deferred, error, ms: Date.now() - receivedAt });
  return Date.now() < deadline ? lines : [];
}

export async function decideInterject({ key, uid, speaker, text, cfg, messageId, signal }) {
  if (Math.random() >= cfg.interjectP) return { speak: false, reason: 'sampled_out' };
  const snapshot = memory.readContext(key, { limit: 8, query: text, excludeId: messageId });
  const context = formatDialogue(snapshot, readMembers([...snapshot.participants, uid]), uid);
  try {
    const output = await chat([
      { role: 'system', content: '[interject] 判断金桦有没有值得接的一句。只输出 JSON {"speak":true,"tone":"损|茶|护|正经","target":"要接话的人或空字符串"}。' },
      { role: 'user', content: JSON.stringify({ context, speaker, text }) },
    ], { maxTokens: 90, signal, temperature: 0.3 });
    const decision = parseObject(output);
    if (![true, 1].includes(decision?.speak)) return { speak: false, reason: 'model_no' };
    const tone = ['损', '茶', '护', '正经'].includes(decision.tone) ? decision.tone : '正经';
    return { speak: true, tone, target: typeof decision.target === 'string' ? decision.target.slice(0, 32) : '' };
  } catch {
    return { speak: false, reason: 'classify_fail' };
  }
}

export function rememberClaim({ key, uid, speaker, text, messageId }) {
  if (uid && messageId && CLAIM.test(text)) {
    memory.addEpisode({ key, sourceId: messageId, about: [uid], text: speaker + '说：' + text.slice(0, 90), type: 'claim', weight: 2 });
  }
}

export function reflect({ key, text, replyLines }) {
  const angle = getAngle(key, text, readMembers(memory.memberIds(key)));
  if (angle && replyLines.some((line) => line.includes(angle.angle))) markAngle(key, angle.id, angle.angle);
}
