/**
 * 出站 @ 转换
 *
 * 群消息里 QQ 用 <@openid> 表示提及（入站事件就是这么给的），
 * 但模型只会写“@张睿诚”这种纯文本，直接发出去不会真的 @ 到人。
 * 这里统一在出站前把 @名字 / @缩写 换成 <@openid>。
 */
import { ALIASES } from '../persona.mjs';
import { readMembers } from './members.mjs';
import { botNames } from './transport.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const USER_TAG = /<qqbot-at-user\s+id="([^"]+)"\s*\/>/g;

function mentionMap(names) {
  const byName = new Map();
  for (const [openid, name] of names) {
    byName.set(name, byName.has(name) ? null : openid);
  }
  const map = new Map([...byName].filter(([, openid]) => openid));
  for (const [abbr, name] of Object.entries(ALIASES)) {
    const id = byName.get(name);
    if (id) map.set(abbr, id);
  }
  return map;
}

function renderMentions(text, map, names) {
  let out0 = String(text || '');

  // 1) 先把自己从文本里摘掉：机器人不能 @ 自己，写出来只会变哑文本
  // 先处理带括号后缀的写法（@金桦（黄石版）），再处理纯名字，否则会残留括号
  const base = process.env.BOT_NAME || '金桦';
  out0 = out0.replace(new RegExp(`@${esc(base)}(?:[（(][^）)]{0,20}[）)])?`, 'g'), '');
  const selfNames = botNames().filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of selfNames) {
    out0 = out0.replace(new RegExp(`@${esc(n)}\\s*`, 'g'), '');
  }

  // 长的先替换，避免“张睿诚”被“张”截断
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = out0;

  for (const key of keys) {
    const re = new RegExp(`@${esc(key)}(?![\\u4e00-\\u9fa5A-Za-z0-9])`, 'gi');
    // 用函数替换，避免 openid 里的 $ 被当成替换模式
    out = out.replace(re, () => `<qqbot-at-user id="${map.get(key)}" />`);
  }
  // 2) 只保留绑定成员的提及标签，未知 id 直接去掉标签（避免哑 @）
  out = out.replace(USER_TAG, (tag, id) => (names.has(id) ? tag : ''));

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '').trim();
}

export function prepareGroupLines(lines) {
  const names = new Map([...readMembers().values()]
    .filter((member) => member.canMention)
    .map(({ openid, name }) => [openid, name]));
  const targets = mentionMap(names);
  return lines.map((line) => {
    const content = renderMentions(line, targets, names);
    const text = content.replace(USER_TAG, (_, id) => '@' + names.get(id));
    return { text, content };
  }).filter(({ content }) => content);
}
