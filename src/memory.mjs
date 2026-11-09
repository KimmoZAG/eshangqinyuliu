import fs from 'node:fs';
import path from 'node:path';
import { DIRS, dayKey, hhmm, readJson, writeJson, appendLine, readLines, uid } from './core.mjs';

const MAX_WORKING = 300;

/* ---------------- working：按天滑动的原文 ---------------- */

const working = new Map(); // key -> [{id, ts, u, n, c, att}]

const safeName = (key) => key.replace(/[^a-zA-Z0-9_-]/g, '_');
const wfile = (key, day = dayKey()) => path.join(DIRS.working, safeName(key), `${day}.jsonl`);

export function loadWorking(key) {
  if (working.has(key)) return working.get(key);
  const arr = readLines(wfile(key));
  working.set(key, arr);
  return arr;
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

export function dayMessages(key, day) {
  return readLines(wfile(key, day));
}

/* ---------------- profiles：人物画像 ---------------- */

const PROFILES_FILE = path.join(DIRS.data, 'profiles.json');
let profiles = readJson(PROFILES_FILE, {});

const saveProfiles = () => writeJson(PROFILES_FILE, profiles);

function touchProfile(id, rawName) {
  const p = profile(id);
  if (!p.name && rawName) p.name = rawName;
  p.lastSeen = new Date().toISOString();
  saveProfiles();
}

export function profile(id) {
  if (!profiles[id]) {
    profiles[id] = { name: '', angles: {}, bits: [], weaknesses: [], lastSeen: null };
  }
  return profiles[id];
}

export function setAlias(id, name) {
  const p = profile(id);
  p.name = name;
  saveProfiles();
}

export function nameOf(id, fallback) {
  return profiles[id]?.name || fallback || '群友';
}

export function markAngle(id, angle) {
  const p = profile(id);
  p.angles[angle] = Date.now();
  saveProfiles();
}

export function usedAngles(id, withinMs = 6 * 3600 * 1000) {
  const p = profile(id);
  const cutoff = Date.now() - withinMs;
  return Object.entries(p.angles || {})
    .filter(([, ts]) => ts > cutoff)
    .map(([a]) => a);
}

export function addBit(id, bit) {
  const p = profile(id);
  const text = String(bit).slice(0, 60);
  if (!text) return;
  p.bits = [...new Set([...(p.bits || []), text])].slice(-20);
  saveProfiles();
}

export function addWeakness(id, tag) {
  const p = profile(id);
  p.weaknesses = [...new Set([...(p.weaknesses || []), String(tag).slice(0, 20)])].slice(-10);
  saveProfiles();
}

export function profileTable() {
  return profiles;
}

/* ---------------- episodes：事件卡 ---------------- */

const EP_FILE = path.join(DIRS.data, 'episodes.jsonl');
let episodes = readLines(EP_FILE).slice(-2000);

export function addEpisode({ about = [], text, type = 'memo', weight = 1 }) {
  const rec = { id: uid(), ts: Date.now(), type, about, text: String(text).slice(0, 200), weight };
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

export function searchEpisodes(query, limit = 5) {
  const q = tokens(query);
  if (!q.size) return [];
  const scored = [];
  for (const ep of episodes.slice(-800)) {
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

/* ---------------- 上下文组装 ---------------- */

export function buildContext(key, { limit = 40, query = '', memberIds = [], anglesFor = [] } = {}) {
  const rows = recent(key, limit);
  const lines = rows.length
    ? rows.map((m) => `${hhmm(m.ts)} ${m.n}：${m.c || '（发了东西）'}${m.att?.length ? ` [${m.att.map((a) => a.t).join(',')}]` : ''}`).join('\n')
    : '（今天还没有聊天记录）';

  const eps = searchEpisodes(query || rows.slice(-3).map((r) => r.c).join(' '), 5);
  const epText = eps.length ? eps.map((e) => `· ${e.text}`).join('\n') : '';

  const people = [...new Set([...memberIds, ...rows.slice(-8).map((r) => r.u)])]
    .filter(Boolean)
    .slice(0, 4)
    .map((id) => {
      const p = profile(id);
      const bits = (p.bits || []).slice(-3).join('；');
      const weak = (p.weaknesses || []).slice(-3).join('、');
      const used = usedAngles(id);
      const ang = anglesFor.length ? anglesFor.find((a) => used.includes(a)) : null;
      return `· ${p.name || id.slice(0, 8)}${weak ? `｜短板：${weak}` : ''}${bits ? `｜梗：${bits}` : ''}${ang ? `｜刚说过「${ang}」别重复` : ''}`;
    })
    .join('\n');

  return [
    `【今天群聊（最近${rows.length}条）】\n${lines}`,
    epText ? `【可能相关的旧事】\n${epText}` : '',
    people ? `【在场的人】\n${people}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
