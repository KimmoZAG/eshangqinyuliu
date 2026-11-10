import { log, groupConfig, patchGroupConfig, trace, metric, num, uid as newId } from './core.mjs';
import { startTransport, stripAt, botOpenid, botNames, groupState, forgetGroup } from './transport.mjs';
import * as pipeline from './pipeline.mjs';
import * as memory from './memory.mjs';
import * as agent from './agent.mjs';
import { runPlugin, runSession, commandOf, pluginList } from './plugins.mjs';
import { deliver } from './delivery.mjs';
import { startJobs, noteGroup, runTopic, ensure } from './jobs.mjs';
import { startMcpServers, listTools } from './tools.mjs';
import { ALIASES } from '../persona.mjs';
import { nameOf, setNickname } from './members.mjs';

const BOT_NAME = process.env.BOT_NAME || '金桦';
const REPLY_WINDOW = num('REPLY_WINDOW_MS', 4.5 * 60 * 1000);
const C2C_WINDOW = 55 * 60 * 1000;
const INTERJECT_WINDOW = num('INTERJECT_WINDOW_MS', 6500);

const lastSpeak = new Map(); // group -> ts
const latestMessage = new Map();
const interjecting = new Set();

function bindAlias(text) {
  const names = Object.values(ALIASES).join('|');
  const keys = Object.keys(ALIASES).join('|');
  const re = new RegExp(`^我是\\s*(${keys}|${names})\\s*(?:标记一下)?\\s*[，,。！!~～.\\s]*$`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return ALIASES[m[1].toLowerCase()] || Object.values(ALIASES).find((n) => n === m[1]) || null;
}


function replyTurn(key, data, receivedAt, window) {
  const sentAt = typeof data.timestamp === 'number'
    ? data.timestamp * (data.timestamp < 1e12 ? 1000 : 1) : Date.parse(data.timestamp);
  const origin = Number.isFinite(sentAt) ? Math.min(sentAt, receivedAt) : receivedAt;
  return { turnId: key + ':' + (data.id || newId()), sourceId: data.id, receivedAt, deadline: origin + window };
}

function atts(d) {
  return (d.attachments || []).map((a) => ({ t: a.content_type, url: a.url, n: a.filename }));
}

/* ---------------- 群消息 ---------------- */

async function onGroupMessage(evt, receivedAt) {
  const d = evt.data;
  const group = evt.group;
  const author = d.author || {};

  if (!group || author.bot || !pipeline.dedupe(d.id)) return;
  const turn = replyTurn(group, d, receivedAt, REPLY_WINDOW);
  if (receivedAt >= turn.deadline) return;
  noteGroup(group);
  latestMessage.set(group, turn.turnId);

  const uid = author.member_openid || author.id;
  const raw = (d.content || '').trim();
  const names = botNames();

  // 真提及（<@openid>）或手打的「@金桦」「@金桦（黄石版）」都算 @
  const byText = names.some((n) => raw.startsWith(`@${n}`) || raw.includes(`@${n}`));
  const selfId = !evt.at && !byText && raw.includes('<@') ? await botOpenid(group) : null;
  const byTag = !!selfId && (raw.includes('<@' + selfId + '>') || raw.includes('<@!' + selfId + '>'));
  const mentioned = evt.at === true || byTag || byText;

  let text = stripAt(raw);
  if (mentioned) {
    for (const n of names) {
      text = text.replace(new RegExp(`^@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,，:：]*`), '').trim();
    }
  }
  const cfg = groupConfig(group);
  const speaker = nameOf(uid, author.username);
  const override = agent.parseReplyMode(text, cfg.replyMode);
  const isAt = mentioned || override.explicit;

  if (!memory.addMessage(group, {
    id: d.id,
    ts: d.timestamp,
    u: uid,
    n: speaker,
    rawName: author.username,
    c: override.text,
    att: atts(d),
  })) return;

  const gate = pipeline.guardIn(cfg, evt);
  if (!gate.ok) {
    trace({ kind: 'guard_in', group, reason: gate.reason });
    return;
  }

  const ctx = { group, uid, sessionKey: group + ':' + uid, role: author.member_role || 'member', cfg, speaker };

  // 张睿诚说闭嘴/说话，直接执行（服从的具体落点）
  if (speaker === '张睿诚') {
    if (/^(闭嘴|安静|别说了|别说话)/.test(text)) {
      patchGroupConfig(group, { features: { interject: false } });
      await sendLines({ scope: 'group', group, lines: ['行 我闭嘴'], msgId: isAt ? d.id : undefined, kind: isAt ? 'reply' : 'proactive', turnId: `${group}:${d.id}` });
      return;
    }
    if (/^(说话|别憋着|继续)/.test(text)) {
      patchGroupConfig(group, { features: { interject: true } });
      await sendLines({ scope: 'group', group, lines: ['那我可就不客气了'], msgId: isAt ? d.id : undefined, kind: isAt ? 'reply' : 'proactive', turnId: `${group}:${d.id}` });
      return;
    }
  }

  // 1) 命令
  const cmd = commandOf(text);
  if (cmd && !override.explicit) {
    const out = runPlugin(ctx, text);
    if (out?.triggerTopic) {
      await runTopic(group, { manual: true, sourceId: d.id });
      return;
    }
    if (out?.lines) {
      await deliver({ ...turn, group, lines: out.lines, kind: 'command', msgId: mentioned ? d.id : undefined });
    }
    return;
  }

  // 2) 多轮会话（仅非 @ 时接管，避免打断正常对话）
  if (!isAt) {
    const s = pipeline.getSession(ctx.sessionKey);
    if (s) {
      const out = runSession(ctx, text);
      if (out?.lines) {
        await deliver({ ...turn, group, lines: out.lines, kind: 'command' });
      }
      return;
    }
  }

  // 3) 认人
  const bound = !override.explicit && bindAlias(text);
  if (bound && uid) {
    const name = setNickname(uid, bound);
    await deliver({
      ...turn,
      scope: 'group',
      group,
      lines: ['行 记下了 你是' + name],
      msgId: isAt ? d.id : undefined,
      kind: isAt ? 'reply' : 'proactive',
    });
    log('app', `bind ${uid.slice(0, 8)} -> ${bound}`);
    return;
  }

  const image = (d.attachments || []).find((a) => (a.content_type || '').startsWith('image/'));
  agent.rememberClaim({ key: group, uid, speaker, text: override.text, messageId: d.id });

  // 4) 被 @ → 应答
  if (isAt) {
    const lines = await agent.composeReply({
      ...turn,
      key: group,
      speaker,
      uid,
      text,
      imageUrl: image?.url,
      imageHint: !!image,
      messageId: d.id,
      cfg,
    });

    const delivered = await deliver({
      ...turn,
      scope: 'group',
      group,
      lines,
      msgId: d.id,
      kind: 'reply',
    });
    if (delivered.length) {
      lastSpeak.set(group, Date.now());
      agent.reflect({ key: group, text: override.text, replyLines: delivered });
      metric('reply_at');
    }
    return;
  }

  // 5) 插话（三道闸门）
  const rules = pipeline.interjectRules(cfg, text, isAt, Date.now() - (lastSpeak.get(group) || 0) < 3 * 60e3);
  if (!rules.ok) {
    trace({ kind: 'interject_skip', group, reason: rules.reason });
    return;
  }
  if (!pipeline.canInterject(group) || interjecting.has(group)) {
    trace({ kind: 'interject_skip', group, reason: 'cooldown' });
    return;
  }

  interjecting.add(group);
  try {
    const deadline = Math.min(turn.deadline, receivedAt + INTERJECT_WINDOW);
    const shouldSend = () => latestMessage.get(group) === turn.turnId && Date.now() < deadline;
    if (!shouldSend()) return;
    const signal = AbortSignal.timeout(Math.max(0, Math.min(2000, deadline - Date.now())));
    const decision = await agent.decideInterject({ key: group, uid, speaker, text, cfg, messageId: d.id, signal });
    if (!decision.speak || !shouldSend()) {
      trace({ kind: 'interject_skip', group, reason: decision.reason || 'stale' });
      return;
    }
    const lines = await agent.composeReply({
      ...turn, deadline, key: group, speaker, uid, text, messageId: d.id,
      cfg, mode: 'fast', limit: 1, interject: { tone: decision.tone, target: decision.target },
      imageUrl: image?.url, imageHint: !!image,
    });
    const delivered = await deliver({ ...turn, deadline, group, lines, kind: 'proactive', shouldSend });
    if (delivered.length) {
      pipeline.markInterject(group);
      lastSpeak.set(group, Date.now());
      agent.reflect({ key: group, text, replyLines: delivered });
      metric('interject');
      trace({ kind: 'interject', group, tone: decision.tone, target: decision.target });
    }
  } finally {
    interjecting.delete(group);
  }
}

/* ---------------- 单聊 ---------------- */

async function onC2C(evt, receivedAt) {
  const d = evt.data;
  const openid = evt.openid;
  const author = d.author || {};
  if (!openid || author.bot || !pipeline.dedupe(d.id)) return;

  const text = stripAt(d.content || '');
  const key = `c2c:${openid}`;
  const turn = replyTurn(key, d, receivedAt, C2C_WINDOW);
  if (receivedAt >= turn.deadline) return;
  const cfg = groupConfig(key);
  const override = agent.parseReplyMode(text, cfg.replyMode);
  const speaker = nameOf(openid, author.username || '你');

  if (!memory.addMessage(key, {
    id: d.id,
    ts: d.timestamp,
    u: openid,
    n: speaker,
    rawName: author.username,
    c: override.text,
    att: atts(d),
  })) return;

  const bound = !override.explicit && bindAlias(text);
  if (bound) {
    const name = setNickname(openid, bound);
    await deliver({ ...turn, scope: 'c2c', openid, lines: ['行 记下了 你是' + name], msgId: d.id });
    return;
  }

  const image = (d.attachments || []).find((a) => (a.content_type || '').startsWith('image/'));
  agent.rememberClaim({ key, uid: openid, speaker, text: override.text, messageId: d.id });
  const lines = await agent.composeReply({
    ...turn, key, speaker, uid: openid, text, cfg, messageId: d.id,
    imageUrl: image?.url, imageHint: !!image, limit: Math.min(cfg.replyLimit, 4),
  });

  const delivered = await deliver({
    ...turn,
    scope: 'c2c',
    openid,
    lines,
    msgId: d.id,
    kind: 'reply',
  });
  if (delivered.length) {
    agent.reflect({ key, text: override.text, replyLines: delivered });
    metric('reply_c2c');
  }
}

/* ---------------- 通知 ---------------- */

async function onNotice(evt) {
  const group = evt.group;
  log('notice', evt.sub, group || '');

  if (evt.sub === 'group_add_robot' && group) {
    noteGroup(group);
    ensure(group);
    const st = await groupState(group);
    const setting = st?.data?.recv_msg_setting;
    const lines =
      setting === 'all'
        ? ['我进来了。诚哥在不在？今晚谁开黑，先说好谁菜。']
        : ['我进来了。先去我资料页把“接收消息”开一下，不然我只能看见有人@我。'];
    await deliver({ scope: 'group', group, lines, kind: 'proactive', turnId: `join:${group}` });
  }

  if (evt.sub === 'group_del_robot' && group) forgetGroup(group);
}

/* ---------------- 启动 ---------------- */

export async function handleEvent(evt, raw = {}) {
  const receivedAt = Date.now();
  if (evt.type === 'message' && evt.scope === 'group') await onGroupMessage(evt, receivedAt);
  else if (evt.type === 'message' && evt.scope === 'c2c') await onC2C(evt, receivedAt);
  else if (evt.type === 'notice') await onNotice(evt);
  else if (evt.type === 'request') log('request', evt.sub, JSON.stringify(raw.d || {}).slice(0, 200));
}

export async function startApp() {
  const boot = await startMcpServers();
  const tools = boot.tools;
  const opgg = listTools().filter((t) => t.name.startsWith('opgg_')).length;
  log('app', `${BOT_NAME} 启动 | stdio MCP ${tools} 个 | OP.GG ${opgg} 个 | 插件 ${pluginList().length} 个`);
  log('app', `策略：回复≤${num('MAX_BURST', 5)}条 | 插话P=${num('INTERJECT_P', 0.35)} | 周期${num('TOPIC_CYCLE_H', 6)}h`);

  startTransport({
    onEvent: (evt, raw) => {
      handleEvent(evt, raw).catch((e) => log('app', `处理异常 ${evt.type}/${evt.sub}: ${e.stack || e.message}`));
    },
  });

  startJobs();
}
