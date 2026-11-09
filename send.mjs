/**
 * 发消息测试：验证「被动回复」与「主动消息」两种形态。
 *
 * 被动回复（5 分钟内，带 msg_id，不计主动频次）：
 *   node --env-file=.env send.mjs --group <group_openid> --msg-id <事件 d.id> --text "你好"
 *
 * 主动消息（不带 msg_id，走主动频次：未认证 30 qpm / 单群 20 qpm 且 1000 条/天）：
 *   node --env-file=.env send.mjs --group <group_openid> --text "定时播报测试"
 *
 * 单聊同理：--user <user_openid>
 */
import { api, show } from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const group = arg('group');
const user = arg('user');
const msgId = arg('msg-id');
const seq = Number(arg('seq', 1));
const text = arg('text');

if ((!group && !user) || !text) {
  console.error('用法: node --env-file=.env send.mjs (--group <group_openid> | --user <user_openid>) --text "内容" [--msg-id <被动回复的消息ID>] [--seq 1]');
  process.exit(1);
}

const md = process.argv.includes('--md');

const body = md
  ? { msg_type: 2, markdown: { content: text }, msg_seq: seq }
  : { msg_type: 0, content: text, msg_seq: seq };
if (msgId) body.msg_id = msgId;

const path = group ? `/v2/groups/${group}/messages` : `/v2/users/${user}/messages`;
console.log(`POST ${path}  ${msgId ? '被动回复' : '主动消息'}`);
show('发送结果', await api('POST', path, body));
