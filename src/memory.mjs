import path from 'node:path';
import { DIRS, dayKey, appendLine, readLines, uid } from './core.mjs';
import { observeMember } from './members.mjs';

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
export function addSelf(key, text, { id, sourceId, turnId } = {}) {
  const row = {
    id: id || 'self:' + uid(),
    sourceId,
    turnId,
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
  if (row.u) observeMember(row.u, rec.rawName);
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

export function readContext(key, { limit = 40, query = '', excludeId } = {}) {
  const working = loadWorking(key);
  const current = excludeId ? working.findIndex((message) => message.id === excludeId) : -1;
  const before = current < 0 ? working : working.slice(0, current);
  const messages = before.slice(-limit);
  const episodes = searchEpisodes(key, query || messages.slice(-3).map((row) => row.c).join(' '), 4, excludeId);
  const participants = [...new Set(before.map((row) => row.u).filter(Boolean))];
  return { messages, episodes, participants };
}
