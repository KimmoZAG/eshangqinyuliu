/**
 * 能力探测：不产生任何副作用，只读接口 + 打印权限结论。
 *
 * 用法：
 *   node --env-file=.env probe.mjs                     # 探测全局能力
 *   node --env-file=.env probe.mjs <group_openid>      # 额外探测某个群
 */
import { api, show } from './lib.mjs';

const groupOpenid = process.argv[2];

console.log('=== 1. 机器人身份 ===');
const me = await api('GET', '/users/@me');
show('GET /users/@me', me);

console.log('\n=== 2. WebSocket 接入点 ===');
const gw = await api('GET', '/gateway');
show('GET /gateway', gw);

if (!groupOpenid) {
  console.log('\n(传入 group_openid 可继续探测群内能力：node --env-file=.env probe.mjs <group_openid>)');
  process.exit(0);
}

console.log(`\n=== 3. 群内能力（group_openid=${groupOpenid}）===`);

const state = await api('GET', `/v2/groups/${groupOpenid}/bot_state`);
const s = show('群内状态 /bot_state', state);
if (s.data?.recv_msg_setting) {
  const explain = {
    only_mention: '只推送 @机器人 的那一条消息',
    all: '群里每条消息都推送（全量模式）',
    mention_and_context: '推送 @机器人 的消息 + 其前后最近若干条群聊作为上下文',
  }[s.data.recv_msg_setting];
  console.log(`  → 接收设置: ${s.data.recv_msg_setting}（${explain ?? '未知取值'}）`);
  console.log(`  → 是否接受主动推送: ${s.data.allow_proactive_msg}`);
  console.log(`  → 机器人身份: ${s.data.member_role}（群管理员才能禁言/撤回他人消息）`);
}

show('群基本信息 /info', await api('GET', `/v2/groups/${groupOpenid}/info`));
show('群成员列表 /members', await api('GET', `/v2/groups/${groupOpenid}/members`));
show('群禁言状态 /restrict_chat_setting', await api('GET', `/v2/groups/${groupOpenid}/restrict_chat_setting`));
