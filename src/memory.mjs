import path from 'node:path';
import { DIRS, dayKey, hhmm, readJson, writeJson, appendLine, readLines, uid } from './core.mjs';

const MAX_WORKING = 300;

/* ---------------- working：按天滑动的原文 ---------------- */

const working = new Map(); // key -> {day, rows}

const safeName = (key) => key.replace(/[^a-zA-Z0-9_-]/g, '_');
const wfile = (key, day = dayKey()) => path.join(DIRS.working, safeName(key), `${day}.jsonl`);

export function loadWorking(key) {
  const day = dayKey();
  const cached = working.get(key);
  if (cached?.day === day) return cached.rows;
  const yesterday = dayKey(new Date(Date.now() - 86400_000));
  const rows = [...readLines(wfile(key, yesterday)), ...readLines(wfile(key, day))].slice(-MAX_WORKING);
  working.set(key, { day, rows });
  return rows;
}

/** 记录机器人自己发出去的话，避免复读自己 */
export function addSelf(key, text, { id, sourceId } = {}) {
  const row = {
    id: id || 'self:' + uid(),
    sourceId,
    ts: new Date().toISOString(),
    u: '',
    n: '你',
    c: String(text || '').trim().slice(0, 200),
    self: true,
    att: [],
  };
  if (!row.c) return;
  const arr = loadWorking(key);
  if (arr.some((message) => message.id === row.id)) return;
  arr.push(row);
  if (arr.length > MAX_WORKING) arr.splice(0, arr.length - MAX_WORKING);
  appendLine(wfile(key), row);
}

export function recentSelf(key, n = 3) {
  return loadWorking(key)
    .filter((m) => m.self)
    .slice(-n)
    .map((m) => m.c);
}

export function addMessage(key, rec) {
  const arr = loadWorking(key);
  if (rec.id && arr.some((r) => r.id === rec.id)) return false;
  const row = {
    id: rec.id || uid(),
    ts: rec.ts || new Date().toISOString(),
    u: rec.u || '',
    n: rec.n || '群友',
    c: (rec.c || '').trim(),
    att: rec.att || [],
  };
  arr.push(row);
  if (arr.length > MAX_WORKING) arr.splice(0, arr.length - MAX_WORKING);
  appendLine(wfile(key), row);
  if (row.u) touchProfile(row.u, rec.rawName);
  return true;
}

export function recent(key, limit = 40) {
  return loadWorking(key).slice(-limit);
}

export function memberIds(key) {
  return [...new Set(loadWorking(key).map((message) => message.u).filter(Boolean))];
}

export function dayMessages(key, day) {
  return readLines(wfile(key, day));
}

/* ---------------- profiles：人物画像 ---------------- */

const PROFILES_FILE = path.join(DIRS.data, 'profiles.json');
let profiles = readJson(PROFILES_FILE, {});

const saveProfiles = () => writeJson(PROFILES_FILE, profiles);

function touchProfile(id, rawName) {
  const p = profile(id);
  const changedName = !p.name && rawName;
  if (changedName) p.name = rawName;
  if (!changedName && Date.now() - Date.parse(p.lastSeen) < 5 * 60_000) return;
  p.lastSeen = new Date().toISOString();
  saveProfiles();
}

export function profile(id) {
  if (!profiles[id]) {
    profiles[id] = { name: '', angles: {}, bits: [], weaknesses: [], lastSeen: null };
  }
  return profiles[id];
}

export function setAlias(id, name, { verified = true } = {}) {
  const p = profile(id);
  if (p.verified && !verified) return p.name;
  p.name = name;
  p.bound = true;
  p.verified = verified;
  p.boundAt = new Date().toISOString();
  saveProfiles();
  return p.name;
}

export function isVerified(id, name) {
  return !!profiles[id]?.verified && profiles[id].name === name;
}

export function nameOf(id, fallback) {
  return profiles[id]?.name || fallback || '群友';
}

export function markAngle(key, id, angle) {
  const p = profile(id);
  p.angleByConversation ??= {};
  const scope = p.angleByConversation[key] || {};
  p.angleByConversation[key] = { ...scope, [angle]: Date.now() };
  saveProfiles();
}

export function usedAngles(key, id, withinMs = 6 * 3600 * 1000) {
  const cutoff = Date.now() - withinMs;
  return Object.entries(profiles[id]?.angleByConversation?.[key] || {})
    .filter(([, ts]) => ts > cutoff)
    .map(([a]) => a);
}

export function profileTable() {
  return profiles;
}

/* ---------------- episodes：事件卡 ---------------- */

const EP_FILE = path.join(DIRS.data, 'episodes.jsonl');
let episodes = readLines(EP_FILE).slice(-2000);

export function addEpisode({ key, sourceId, about = [], text, type = 'memo', weight = 1 }) {
  if (!key || !sourceId || episodes.some((ep) => ep.key === key && ep.sourceId === sourceId && ep.type === type)) return null;
  const rec = { id: uid(), key, sourceId, ts: Date.now(), type, about, text: String(text).slice(0, 200), weight };
  episodes.push(rec);
  if (episodes.length > 2000) episodes = episodes.slice(-2000);
  appendLine(EP_FILE, rec);
  return rec;
}

function tokens(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
  const set = new Set(t.split(/\s+/).filter((x) => x.length >= 2));
  for (const ch of t.replace(/\s+/g, '')) if (/[\u4e00-\u9fa5]/.test(ch)) set.add(ch);
  return set;
}

export function searchEpisodes(key, query, limit = 5, excludeId) {
  if (!key) return [];
  const q = tokens(query);
  if (!q.size) return [];
  const scored = [];
  for (const ep of episodes.filter((ep) => ep.key === key && ep.sourceId && ep.sourceId !== excludeId).slice(-800)) {
    const t = tokens(ep.text + ' ' + (ep.about || []).join(' '));
    let score = 0;
    for (const w of q) if (t.has(w)) score += w.length > 1 ? 2 : 1;
    if (score > 0) scored.push({ ep, score: score * (ep.weight || 1) });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.ep.ts - a.ep.ts)
    .slice(0, limit)
    .map((x) => x.ep);
}

export function memberClaims(key, id, limit = 3) {
  return episodes.filter((ep) => ep.key === key && ep.type === 'claim' && ep.sourceId && ep.about.includes(id)).slice(-limit);
}

/* ---------------- 上下文组装 ---------------- */

export function buildContext(key, { limit = 40, query = '', memberIds = [], excludeId } = {}) {
  const working = loadWorking(key);
  const current = excludeId ? working.findIndex((message) => message.id === excludeId) : -1;
  const rows = current < 0 ? working.slice(-limit) : working.slice(Math.max(0, current - limit), current);
  const lines = rows.length
    ? rows.map((m) => `${hhmm(m.ts)} ${m.self ? '你（金桦）' : m.n}：${m.c?.slice(0, 360) || '（发了东西）'}${m.att?.length ? ` [${m.att.map((a) => a.t).join(',')}]` : ''}`).join('\n')
    : '（今天还没有聊天记录）';

  const eps = searchEpisodes(key, query || rows.slice(-3).map((r) => r.c).join(' '), 4, excludeId);
  const epText = eps.length ? eps.map((e) => `· ${e.text}`).join('\n') : '';

  const people = [...new Set([...memberIds, ...rows.slice(-8).map((r) => r.u)])]
    .filter(Boolean)
    .slice(0, 4)
    .map((id) => '· ' + nameOf(id))
    .join('\n');

  return [
    `【当前会话（最近${rows.length}条）】\n${lines}`,
    epText ? `【可能相关的旧事】\n${epText}` : '',
    people ? `【在场的人】\n${people}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
