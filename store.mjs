import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data');
fs.mkdirSync(DIR, { recursive: true });

const MSG_FILE = path.join(DIR, 'messages.jsonl');
const MEM_FILE = path.join(DIR, 'members.json');
const QUOTA_FILE = path.join(DIR, 'quota.json');

const MAX_PER_GROUP = 600;
const groups = new Map(); // group_openid -> [{...}]
const seen = new Set(); // 已处理的 message id，防重复推送
const seenOrder = [];

let members = {};
let quota = {};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadMessages() {
  let raw = '';
  try {
    raw = fs.readFileSync(MSG_FILE, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!groups.has(rec.g)) groups.set(rec.g, []);
      groups.get(rec.g).push(rec);
    } catch {
      // 跳过坏行
    }
  }
  for (const arr of groups.values()) {
    if (arr.length > MAX_PER_GROUP) arr.splice(0, arr.length - MAX_PER_GROUP);
  }
}

loadMessages();
members = loadJson(MEM_FILE, {});
quota = loadJson(QUOTA_FILE, {});

export function markSeen(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 3000) seen.delete(seenOrder.shift());
  return true;
}

export function addMessage({ group, id, authorOpenid, name, role, content, messageType, timestamp, attachments, aliases }) {
  const rec = {
    g: group,
    id,
    u: authorOpenid || '',
    n: aliases || name || '群友',
    role: role || 'member',
    c: (content || '').trim(),
    mt: messageType ?? 0,
    ts: timestamp || new Date().toISOString(),
    att: (attachments || []).map((a) => ({ t: a.content_type, n: a.filename, w: a.width, h: a.height, s: a.size, url: a.url })),
  };
  if (!groups.has(group)) groups.set(group, []);
  const arr = groups.get(group);
  arr.push(rec);
  if (arr.length > MAX_PER_GROUP) arr.splice(0, arr.length - MAX_PER_GROUP);
  try {
    fs.appendFileSync(MSG_FILE, JSON.stringify(rec) + '\n');
  } catch {
    // 落盘失败不影响回复
  }
  return rec;
}

export function recentMessages(group, limit = 18) {
  const arr = groups.get(group) || [];
  return arr.slice(-limit);
}

export function groupsWithActivity(sinceMs) {
  const cutoff = Date.now() - sinceMs;
  const out = [];
  for (const [g, arr] of groups) {
    const last = arr[arr.length - 1];
    if (last && new Date(last.ts).getTime() >= cutoff) out.push(g);
  }
  return out;
}

export function setAlias(openid, name) {
  members[openid] = name;
  saveJson(MEM_FILE, members);
}

export function getAlias(openid) {
  return members[openid];
}

export function memberTable() {
  return members;
}

export function bumpQuota(group) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${group}:${day}`;
  quota[key] = (quota[key] || 0) + 1;
  saveJson(QUOTA_FILE, quota);
  return quota[key];
}

export function quotaUsed(group) {
  const day = new Date().toISOString().slice(0, 10);
  return quota[`${group}:${day}`] || 0;
}
