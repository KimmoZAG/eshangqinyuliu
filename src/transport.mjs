import { api, getToken } from '../lib.mjs';
import { log, num, trace, metric } from './core.mjs';

const API = 'https://api.bot.qq.com';
const INTENTS = num('QQ_INTENTS', 1 << 25);

let ws = null;
let seq = null;
let sessionId = null;
let canResume = false;
let hbTimer = null;
let attempt = 0;
let handler = null;

const botIds = new Map(); // group -> 机器人自己的 member_openid

/* ---------------- 事件归一化：message / notice / request / meta ---------------- */

export function normalize(p) {
  const d = p.d || {};
  switch (p.t) {
    case 'READY':
      return { type: 'meta', sub: 'ready', sessionId: d.session_id, user: d.user, shard: d.shard };
    case 'RESUMED':
      return { type: 'meta', sub: 'resumed' };

    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE':
      return { type: 'message', scope: 'group', group: d.group_openid, at: p.t === 'GROUP_AT_MESSAGE_CREATE', data: d };

    case 'C2C_MESSAGE_CREATE':
      return { type: 'message', scope: 'c2c', openid: d.author?.user_openid || d.author?.id, data: d };

    case 'GROUP_ADD_ROBOT':
      return { type: 'notice', sub: 'group_add_robot', group: d.group_openid, data: d };
    case 'GROUP_DEL_ROBOT':
      return { type: 'notice', sub: 'group_del_robot', group: d.group_openid, data: d };
    case 'GROUP_MEMBER_ADD':
      return { type: 'notice', sub: 'group_member_add', group: d.group_openid, data: d };
    case 'GROUP_MEMBER_REMOVE':
      return { type: 'notice', sub: 'group_member_remove', group: d.group_openid, data: d };
    case 'GROUP_MSG_RECEIVE':
      return { type: 'notice', sub: 'proactive_on', group: d.group_openid, data: d };
    case 'GROUP_MSG_REJECT':
      return { type: 'notice', sub: 'proactive_off', group: d.group_openid, data: d };
    case 'FRIEND_ADD':
      return { type: 'notice', sub: 'friend_add', data: d };
    case 'FRIEND_DEL':
      return { type: 'notice', sub: 'friend_del', data: d };
    case 'C2C_MSG_RECEIVE':
      return { type: 'notice', sub: 'c2c_on', data: d };
    case 'C2C_MSG_REJECT':
      return { type: 'notice', sub: 'c2c_off', data: d };
    case 'GROUP_JOIN_REQUEST':
      return { type: 'request', sub: 'group_join_request', group: d.group_openid, data: d };
    case 'INTERACTION_CREATE':
      return { type: 'request', sub: 'interaction', group: d.group_openid, data: d };

    default:
      return { type: 'notice', sub: p.t || 'unknown', data: d };
  }
}

/** 去掉 <@openid> / <@all> */
export function stripAt(text) {
  return (text || '').replace(/<@!?[0-9A-Za-z_-]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function botOpenid(group) {
  if (botIds.has(group)) return botIds.get(group);
  const r = await api('GET', `/v2/groups/${group}/bot_state`).catch(() => null);
  const id = r?.data?.member_openid;
  if (id) botIds.set(group, id);
  return id;
}

export function forgetGroup(group) {
  botIds.delete(group);
}

export async function groupState(group) {
  return api('GET', `/v2/groups/${group}/bot_state`).catch(() => null);
}

/* ---------------- 发送 ---------------- */

export async function sendGroup(group, body) {
  const r = await api('POST', `/v2/groups/${group}/messages`, body);
  metric(r.data?.err_code ? 'send_fail' : 'send_ok');
  return r;
}

export async function sendC2C(openid, body) {
  const r = await api('POST', `/v2/users/${openid}/messages`, body);
  metric(r.data?.err_code ? 'send_fail' : 'send_ok');
  return r;
}

/* ---------------- WebSocket ---------------- */

function wsSend(op, d) {
  ws?.send(JSON.stringify({ op, d }));
}

function startHeartbeat(interval) {
  clearInterval(hbTimer);
  hbTimer = setInterval(() => wsSend(1, seq), interval);
}

async function connect() {
  const token = await getToken();
  const r = await fetch(`${API}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
  const { url } = await r.json();
  log('ws', `connect ${url}`);
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    attempt = 0;
  });

  ws.addEventListener('message', (ev) => {
    let p;
    try {
      p = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (p.op === 10) {
      startHeartbeat(p.d.heartbeat_interval);
      if (canResume && sessionId) {
        wsSend(6, { token: `QQBot ${token}`, session_id: sessionId, seq });
        log('ws', `resume seq=${seq}`);
      } else {
        wsSend(2, {
          token: `QQBot ${token}`,
          intents: INTENTS,
          shard: [0, 1],
          properties: { $os: 'linux', $browser: 'jinha', $device: 'jinha' },
        });
        log('ws', 'identify');
      }
      return;
    }
    if (p.op === 11) return;
    if (p.op === 7) {
      ws.close();
      return;
    }
    if (p.op === 9) {
      canResume = false;
      sessionId = null;
      seq = null;
      return;
    }
    if (p.op !== 0) return;

    if (p.s !== undefined && p.s !== null) seq = p.s;

    if (p.t === 'READY') {
      sessionId = p.d.session_id;
      canResume = true;
      metric('ws_ready');
    }

    const evt = normalize(p);
    if (evt.type === 'meta') {
      log('ws', `${evt.sub} ${evt.user?.username || ''}`);
      return;
    }
    trace({ kind: 'event', t: p.t, s: p.s, type: evt.type, sub: evt.sub, group: evt.group });
    handler?.(evt, p);
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    log('ws', `closed code=${ev.code}`);
    metric('ws_close');
    if (ev.code === 4006) {
      canResume = false;
      sessionId = null;
    }
    if (ev.code === 4001 || ev.code === 4002) log('ws', 'opcode/payload 错误，检查 intents 权限');
    setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
  });

  ws.addEventListener('error', (e) => log('ws', 'error', e.message ?? String(e)));
}

export function startTransport({ onEvent }) {
  handler = onEvent;
  connect();
}
