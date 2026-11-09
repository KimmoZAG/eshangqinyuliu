import { log, groupConfig, trace, metric, num } from './core.mjs';
import { startTransport, stripAt, botOpenid, botNames, groupState, forgetGroup } from './transport.mjs';
import * as pipeline from './pipeline.mjs';
import * as memory from './memory.mjs';
import * as agent from './agent.mjs';
import { runPlugin, runSession, commandOf, pluginList } from './plugins.mjs';
import { sendLines } from './outbox.mjs';
import { startJobs, noteGroup, runTopic, ensure } from './jobs.mjs';
import { startMcpServers, listTools } from './tools.mjs';
import { ALIASES } from '../persona.mjs';

const BOT_NAME = process.env.BOT_NAME || '金桦';
const REPLY_WINDOW = num('REPLY_WINDOW_MS', 4.5 * 60 * 1000);

const lastSpeak = new Map(); // group -> ts

function bindAlias(text) {
  const names = Object.values(ALIASES).join('|');
  const keys = Object.keys(ALIASES).join('|');
  const re = new RegExp(`^我是\\s*(${keys}|${names})\\s*(?:标记一下)?\\s*[，,。！!~～.\\s]*$`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return ALIASES[m[1].toLowerCase()] || Object.values(ALIASES).find((n) => n === m[1]) || null;
}


/** 把自己发出去的话也记进上下文，避免复读自己 */
function remember(key, lines, results) {
  const ok = (results || []).filter((r) => r.ok).length;
  for (let i = 0; i < Math.min(ok, lines.length); i += 1) memory.addSelf(key, lines[i]);
}

function atts(d) {
  return (d.attachments || []).map((a) => ({ t: a.content_type, url: a.url, n: a.filename }));
}

/* ---------------- 群消息 ---------------- */

async function onGroupMessage(evt) {
  const d = evt.data;
  const group = evt.group;
  const author = d.author || {};

  noteGroup(group);
  if (author.bot) return;
  if (!pipeline.dedupe(d.id)) return;

  const uid = author.member_openid || author.id;
  const raw = (d.content || '').trim();
  const selfId = await botOpenid(group);
  const names = botNames();

  // 真提及（<@openid>）或手打的「@金桦」「@金桦（黄石版）」都算 @
  const byTag = !!selfId && raw.includes(`<@${selfId}>`);
  const byText = names.some((n) => raw.startsWith(`@${n}`) || raw.includes(`@${n}`));
  const isAt = evt.at === true || byTag || byText;

  let text = stripAt(raw);
  if (isAt) {
    for (const n of names) {
      text = text.replace(new RegExp(`^@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,，:：]*`), '').trim();
    }
  }
  const cfg = groupConfig(group);
  const speaker = memory.nameOf(uid, author.username);

  memory.addMessage(group, {
    id: d.id,
    ts: d.timestamp,
    u: uid,
    n: speaker,
    rawName: author.username,
    c: text,
    att: atts(d),
  });

  const gate = pipeline.guardIn(cfg, evt);
  if (!gate.ok) {
    trace({ kind: 'guard_in', group, reason: gate.reason });
    return;
  }

  const ctx = { group, uid, role: author.member_role || 'member', cfg, speaker };

  // 1) 命令
  const cmd = commandOf(text);
  if (cmd) {
    const out = runPlugin(ctx, text);
    if (out?.triggerTopic) {
      await runTopic(group, { manual: true });
      return;
    }
    if (out?.lines) {
      await sendLines({ scope: 'group', group, lines: out.lines, kind: 'proactive', turnId: `cmd:${uid}:${Date.now()}` });
    }
    return;
  }

  // 2) 多轮会话（仅非 @ 时接管，避免打断正常对话）
  if (!isAt) {
    const s = pipeline.getSession(uid);
    if (s) {
      const out = runSession(ctx, text);
      if (out?.lines) {
        await sendLines({ scope: 'group', group, lines: out.lines, kind: 'proactive', turnId: `sess:${uid}:${Date.now()}` });
      }
      return;
    }
  }

  // 3) 认人
  const bound = bindAlias(text);
  if (bound) {
    memory.setAlias(uid, bound);
    await sendLines({
      scope: 'group',
      group,
      lines: [`行，记下了，你是${bound}`],
      msgId: isAt ? d.id : undefined,
      kind: isAt ? 'reply' : 'proactive',
      turnId: `${group}:${d.id}`,
    });
    log('app', `bind ${uid.slice(0, 8)} -> ${bound}`);
    return;
  }

  const image = (d.attachments || []).find((a) => (a.content_type || '').startsWith('image/'));

  // 4) 被 @ → 应答
  if (isAt) {
    const turnId = `${group}:${d.id}`;
    const lines = await agent.composeReply({
      key: group,
      speaker,
      uid,
      text,
      imageUrl: image?.url,
      imageHint: !!image,
      limit: cfg.replyLimit || 5,
    });

    const sent = await sendLines({
      scope: 'group',
      group,
      lines,
      msgId: d.id,
      kind: 'reply',
      turnId,
      deadlineMs: REPLY_WINDOW,
    });
    remember(group, lines, sent);

    lastSpeak.set(group, Date.now());
    agent.reflect({ key: group, uid, speaker, text, replyLines: lines });
    metric('reply_at');
    return;
  }

  // 5) 插话（三道闸门）
  const rules = pipeline.interjectRules(cfg, text, isAt, Date.now() - (lastSpeak.get(group) || 0) < 3 * 60e3);
  if (!rules.ok) {
    trace({ kind: 'interject_skip', group, reason: rules.reason });
    return;
  }
  if (!pipeline.canInterject(group)) {
    trace({ kind: 'interject_skip', group, reason: 'cooldown' });
    return;
  }

  const decision = await agent.decideInterject({ key: group, uid, speaker, text, cfg });
  if (!decision.speak) {
    trace({ kind: 'interject_skip', group, reason: decision.reason });
    return;
  }

  pipeline.markInterject(group);
  const lines = await agent.composeReply({
    key: group,
    speaker,
    uid,
    text,
    imageUrl: image?.url,
    imageHint: !!image,
    limit: 2,
  });

  const one = lines.slice(0, 1);
  const sentIj = await sendLines({
    scope: 'group',
    group,
    lines: one,
    kind: 'proactive',
    turnId: `ij:${group}:${d.id}`,
  });
  remember(group, one, sentIj);

  lastSpeak.set(group, Date.now());
  agent.reflect({ key: group, uid, speaker, text, replyLines: lines });
  metric('interject');
  trace({ kind: 'interject', group, tone: decision.tone, target: decision.target });
}

/* ---------------- 单聊 ---------------- */

async function onC2C(evt) {
  const d = evt.data;
  const openid = evt.openid;
  const author = d.author || {};
  if (author.bot) return;
  if (!pipeline.dedupe(d.id)) return;

  const text = stripAt(d.content || '');
  const key = `c2c:${openid}`;
  const speaker = memory.nameOf(openid, author.username || '你');

  memory.addMessage(key, {
    id: d.id,
    ts: d.timestamp,
    u: openid,
    n: speaker,
    rawName: author.username,
    c: text,
    att: atts(d),
  });

  const bound = bindAlias(text);
  if (bound) {
    memory.setAlias(openid, bound);
    await sendLines({ scope: 'c2c', openid, lines: [`行，记下了，你是${bound}`], msgId: d.id, kind: 'reply', turnId: `c2c:${d.id}` });
    return;
  }

  const image = (d.attachments || []).find((a) => (a.content_type || '').startsWith('image/'));
  const lines = await agent.composeReply({ key, speaker, uid: openid, text, imageUrl: image?.url, imageHint: !!image, limit: 4 });

  await sendLines({
    scope: 'c2c',
    openid,
    lines,
    msgId: d.id,
    kind: 'reply',
    turnId: `c2c:${d.id}`,
    deadlineMs: 55 * 60 * 1000,
  });
  metric('reply_c2c');
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
    await sendLines({ scope: 'group', group, lines, kind: 'proactive', turnId: `join:${group}` });
  }

  if (evt.sub === 'group_del_robot' && group) forgetGroup(group);
}

/* ---------------- 启动 ---------------- */

async function main() {
  const boot = await startMcpServers();
  const tools = boot.tools;
  const opgg = listTools().filter((t) => t.name.startsWith('opgg_')).length;
  log('app', `${BOT_NAME} 启动 | stdio MCP ${tools} 个 | OP.GG ${opgg} 个 | 插件 ${pluginList().length} 个`);
  log('app', `策略：回复≤${num('MAX_BURST', 5)}条 | 插话P=${num('INTERJECT_P', 0.35)} | 周期${num('TOPIC_CYCLE_H', 6)}h`);

  startTransport({
    onEvent: (evt, raw) => {
      const run = async () => {
        if (evt.type === 'message' && evt.scope === 'group') await onGroupMessage(evt);
        else if (evt.type === 'message' && evt.scope === 'c2c') await onC2C(evt);
        else if (evt.type === 'notice') await onNotice(evt);
        else if (evt.type === 'request') log('request', evt.sub, JSON.stringify(raw.d).slice(0, 200));
      };
      run().catch((e) => log('app', `处理异常 ${evt.type}/${evt.sub}: ${e.stack || e.message}`));
    },
  });

  startJobs();
}

process.on('unhandledRejection', (e) => log('app', '[unhandled]', e?.stack || e));
process.on('uncaughtException', (e) => log('app', '[uncaught]', e?.stack || e));
process.on('SIGTERM', () => {
  log('app', 'SIGTERM，退出');
  process.exit(0);
});

main();
