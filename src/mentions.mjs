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
  if (!map.size) return text;

  // 长的先替换，避免“张睿诚”被“张”截断
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  let out = String(text || '');

  for (const key of keys) {
    const re = new RegExp(`@${esc(key)}(?![\\u4e00-\\u9fa5A-Za-z0-9])`, 'gi');
    // 用函数替换，避免 openid 里的 $ 被当成替换模式
    out = out.replace(re, () => `<qqbot-at-user id="${map.get(key)}" />`);
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
}

/** 批量处理，顺便合并重复返回的空格 */
export function renderLines(lines) {
  return (lines || []).map((l) => renderMentions(l)).filter(Boolean);
}
