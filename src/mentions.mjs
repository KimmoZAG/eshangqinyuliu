/**
 * 出站 @ 转换
 *
 * 群消息里 QQ 用 <@openid> 表示提及（入站事件就是这么给的），
 * 但模型只会写“@张睿诚”这种纯文本，直接发出去不会真的 @ 到人。
 * 这里统一在出站前把 @名字 / @缩写 换成 <@openid>。
 */
import { ALIASES } from '../persona.mjs';
import { loadAliases } from './bindings.mjs';
import * as memory from './memory.mjs';
import { botNames } from './transport.mjs';

const REAL_OPENID = /^[0-9A-F]{32}$/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 名字/缩写 -> openid */
export function mentionMap() {
  const map = new Map(); // 名字 -> openid
  const byName = new Map();

  for (const [openid, v] of Object.entries(loadAliases())) {
    if (!REAL_OPENID.test(openid) || !v?.name) continue;
    byName.set(v.name, openid);
  }
  for (const [openid, p] of Object.entries(memory.profileTable())) {
    if (REAL_OPENID.test(openid) && p.bound && p.name && !byName.has(p.name)) byName.set(p.name, openid);
  }

  for (const [name, openid] of byName) map.set(name, openid);
  // 缩写映射到同一个 openid
  for (const [abbr, name] of Object.entries(ALIASES)) {
    const id = byName.get(name);
    if (id) map.set(abbr, id);
  }
  return map;
}

/** 把 "@张神" 这类文本换成 <@openid>，已有的 <@...> 保持不动 */
export function renderMentions(text) {
  const map = mentionMap();
  let out0 = String(text || '');

  // 1) 先把自己从文本里摘掉：机器人不能 @ 自己，写出来只会变哑文本
  // 先处理带括号后缀的写法（@金桦（黄石版）），再处理纯名字，否则会残留括号
  const base = process.env.BOT_NAME || '金桦';
  out0 = out0.replace(new RegExp(`@${esc(base)}(?:[（(][^）)]{0,20}[）)])?`, 'g'), '');
  const selfNames = botNames().filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of selfNames) {
    out0 = out0.replace(new RegExp(`@${esc(n)}\\s*`, 'g'), '');
  }

  if (!map.size) return out0.trim();

  // 长的先替换，避免“张睿诚”被“张”截断
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = out0;

  for (const key of keys) {
    const re = new RegExp(`@${esc(key)}(?![\\u4e00-\\u9fa5A-Za-z0-9])`, 'gi');
    // 用函数替换，避免 openid 里的 $ 被当成替换模式
    out = out.replace(re, () => `<qqbot-at-user id="${map.get(key)}" />`);
  }
  // 2) 只保留绑定成员的提及标签，未知 id 直接去掉标签（避免哑 @）
  const allowed = new Set(map.values());
  out = out.replace(/<qqbot-at-user\s+id="([^"]+)"\s*\/>/g, (m, id) => (allowed.has(id) ? m : ''));

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '').trim();
}

/** 批量处理，顺便合并重复返回的空格 */
export function renderLines(lines) {
  return (lines || []).map((l) => renderMentions(l)).filter(Boolean);
}
