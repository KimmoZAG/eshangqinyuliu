/**
 * WebSocket 事件监听：把平台推来的每一个事件原样落到 logs/events-*.jsonl
 * 并在终端打印摘要。用来验证「默认能收到什么」。
 *
 * 用法：
 *   node --env-file=.env listen.mjs
 *   QQ_INTENTS=33554432 node --env-file=.env listen.mjs   # 默认就是 1<<25
 *
 * 验证步骤：启动后去群里 @机器人 发一句话，看终端有没有 GROUP_AT_MESSAGE_CREATE；
 * 再让群里其他人随便聊两句（不@机器人），看是否收到 GROUP_MESSAGE_CREATE。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getToken } from './lib.mjs';

const API = 'https://api.bot.qq.com';
const INTENTS = Number(process.env.QQ_INTENTS || 1 << 25);
const SHARD = [0, 1];

const LOG_DIR = path.resolve('logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);

let ws = null;
let token = null;
let seq = null;
let sessionId = null;
let canResume = false;
let hbTimer = null;
let attempt = 0;

const save = (obj) => fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n');

function send(op, d) {
  ws?.send(JSON.stringify({ op, d }));
}

function startHeartbeat(interval) {
  clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    send(1, seq);
  }, interval);
  console.log(`[ws] 心跳周期 ${interval}ms`);
}

function summarize(p) {
  const d = p.d || {};
  const who = d.author?.member_openid || d.author?.user_openid || d.author?.id || '-';
  const text = (d.content || '').replace(/\s+/g, ' ').slice(0, 80);
  const bits = [`t=${p.t}`, `s=${p.s}`];
  if (d.group_openid) bits.push(`group=${d.group_openid}`);
  if (d.message_type !== undefined) bits.push(`type=${d.message_type}`);
  if (d.author?.member_role) bits.push(`role=${d.author.member_role}`);
  bits.push(`from=${who}`);
  if (text) bits.push(`content="${text}"`);
  if (d.attachments?.length) bits.push(`attachments=${d.attachments.length}`);
  if (d.mentions?.length) bits.push(`mentions=${d.mentions.length}`);
  console.log(bits.join('  '));
  if (d.author?.username) console.log(`        昵称: ${d.author.username}`);
  return d;
}

async function connect() {
  token = await getToken();
  const r = await fetch(`${API}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
  const { url } = await r.json();
  console.log(`[ws] 连接 ${url}  intents=${INTENTS}`);
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    attempt = 0;
    console.log('[ws] 已连接，等待 Hello');
  });

  ws.addEventListener('message', (ev) => {
    let p;
    try {
      p = JSON.parse(ev.data);
    } catch {
      console.log('[ws] 非 JSON 消息', ev.data);
      return;
    }

    if (p.op === 10) {
      startHeartbeat(p.d.heartbeat_interval);
      if (canResume && sessionId) {
        console.log(`[ws] Resume session=${sessionId} seq=${seq}`);
        send(6, { token: `QQBot ${token}`, session_id: sessionId, seq });
      } else {
        console.log('[ws] Identify');
        send(2, {
          token: `QQBot ${token}`,
          intents: INTENTS,
          shard: SHARD,
          properties: { $os: 'linux', $browser: 'probe', $device: 'probe' },
        });
      }
      return;
    }

    if (p.op === 11) return;
    if (p.op === 7) {
      console.log('[ws] 服务端要求重连');
      ws.close();
      return;
    }
    if (p.op === 9) {
      console.log('[ws] Invalid Session，需要重新 Identify');
      canResume = false;
      sessionId = null;
      seq = null;
      return;
    }

    if (p.op === 0) {
      if (p.s !== undefined && p.s !== null) seq = p.s;
      if (p.t === 'READY') {
        sessionId = p.d.session_id;
        canResume = true;
        console.log(`[ws] READY bot=${p.d.user?.username} id=${p.d.user?.id} shard=${p.d.shard}`);
        console.log(`[ws] 事件已开始写入 ${LOG_FILE}\n`);
        return;
      }
      if (p.t === 'RESUMED') {
        console.log('[ws] RESUMED，补发完成');
        return;
      }
      save(p);
      summarize(p);
    }
  });

  ws.addEventListener('close', (ev) => {
    clearInterval(hbTimer);
    console.log(`[ws] 关闭 code=${ev.code} reason=${ev.reason || '-'}`);
    if (ev.code === 4006) {
      canResume = false;
      sessionId = null;
    }
    if (ev.code === 4001 || ev.code === 4002) {
      console.log('[ws] opcode/payload 错误，检查 intents 是否有权限（无权限的 intent 会直接断连）');
    }
    const delay = Math.min(30_000, 1000 * Math.pow(2, attempt++));
    console.log(`[ws] ${delay}ms 后重连`);
    setTimeout(connect, delay);
  });

  ws.addEventListener('error', (e) => console.log('[ws] error', e.message ?? e));
}

connect();
