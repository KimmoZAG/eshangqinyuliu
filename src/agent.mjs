import { trace } from './core.mjs';
import { chat, splitReplies } from '../llm.mjs';
import * as memory from './memory.mjs';
import { callTool, toolsByDomain } from './tools.mjs';
import { publicContent, sanitizeLines, systemPrompt } from './reply.mjs';

export { composeReply, decideInterject, rememberClaim, reflect } from './reply.mjs';
export { splitQuestions, parseReplyMode } from './questions.mjs';

/* ---------------- 定时话题（主动发言也能用工具） ---------------- */

async function gatherMaterial() {
  const parts = [];
  const has = (d, n) => toolsByDomain(d).some((t) => t.name === n);

  if (has('lol', 'get-live-matches')) {
    const r = await callTool('get-live-matches', { language: 'zh-CN' }).catch(() => null);
    const t = r?.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)) : '';
    if (t && !/No live/i.test(t)) parts.push({ tag: 'lol_live', text: `正在打的 LoL：\n${t.slice(0, 700)}` });
  }

  if (parts.length < 2 && has('lol', 'get-upcoming-matches')) {
    const r = await callTool('get-upcoming-matches', { language: 'zh-CN', limit: 3 }).catch(() => null);
    const t = r?.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result)) : '';
    if (t && !/❌|Error/i.test(t) && !/No upcoming/i.test(t)) {
      parts.push({ tag: 'lol_upcoming', text: `最近的 LoL 赛程：\n${t.slice(0, 700)}` });
    }
  }

  if (parts.length < 2 && has('hltv', 'hltv_get_matches')) {
    const r = await callTool('hltv_get_matches', {}).catch(() => null);
    if (r?.ok) {
      try {
        const j = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
        const rows = (j.matches || []).slice(0, 4).map((m) => `${m.team1} vs ${m.team2}${m.event ? `（${m.event}）` : ''}`);
        if (rows.length) parts.push({ tag: 'hltv_matches', text: `CS 近期赛程：${rows.join('；')}` });
      } catch {
        // 结构变了就算了，不编数据
      }
    }
  }

  if (parts.length < 2 && has('hltv', 'hltv_get_team_ranking')) {
    const r = await callTool('hltv_get_team_ranking', {}).catch(() => null);
    if (r?.ok) {
      try {
        const j = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
        const top = (j.ranking || []).slice(0, 5).map((x) => `#${x.rank} ${x.team}(${x.points})`);
        if (top.length) parts.push({ tag: 'hltv_rank', text: `CS 世界排名前五：${top.join('，')}` });
      } catch {
        // ignore
      }
    }
  }

  return parts;
}

export async function buildTopic({ group, cfg }) {
  const ctx = memory.buildContext(group, { limit: 30 });
  const parts = cfg.features.tools ? await gatherMaterial() : [];

  const material = parts.length ? parts.map((p) => `[${p.tag}]\n${p.text}`).join('\n\n') : '';
  trace({ kind: 'topic_material', group, tags: parts.map((p) => p.tag) });

  const basis = material
    ? `下面是可以引用的真实数据（只许用这里出现的队伍/时间/比分/数字，不许编）：\n${material}`
    : '没有外部数据，只能从今天的聊天里找话题，别编新闻和比分。';

  const user = `群里最近的聊天：\n${ctx}\n\n${basis}\n\n现在没人说话，你主动抛一个话题，1-2 行，每行不超过 40 字，不@任何人，别说教、别像播报。如果上面有具体数据，至少点出一个队名或一个数字，别只说“没想到”。`;

  const out = await chat([{ role: 'system', content: systemPrompt(group, { scene: 'topic' }) }, { role: 'user', content: user }], {
    effort: 'none',
    maxTokens: 300,
  }).catch(() => '');

  const lines = sanitizeLines(splitReplies(publicContent(out), 2));
  if (!lines.length) return [];
  return lines;
}
