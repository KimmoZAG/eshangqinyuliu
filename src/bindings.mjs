import fs from 'node:fs';
import path from 'node:path';
import { DIRS, readJson, writeJson, log } from './core.mjs';
import * as memory from './memory.mjs';

const FILE = path.join(DIRS.data, 'bind-codes.json');
const ALIAS_FILE = path.join(DIRS.data, 'aliases.json');

// 去掉容易看错的 0/O/1/I
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function load() {
  return readJson(FILE, {});
}

function save(db) {
  writeJson(FILE, db);
}

function genCode(prefix, len = 5) {
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  const p = String(prefix || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);
  return p ? `${p}-${s}` : s;
}

/* ---------------- 绑定结果（机器人只读，CLI 写） ---------------- */

export function loadAliases() {
  return readJson(ALIAS_FILE, {});
}

export function saveAlias(openid, name) {
  const a = loadAliases();
  a[openid] = { name, at: new Date().toISOString() };
  writeJson(ALIAS_FILE, a);
  return a[openid];
}

/** 管理员侧：为某个人生成一次性绑定码 */
export function createCode({ name, qq = '', ttlHours = 72, prefix = '' }) {
  if (!name) throw new Error('必须给名字');
  const db = load();

  // 同一个人只保留最新的一个有效码
  for (const [code, v] of Object.entries(db)) {
    if (v.name === name && !v.usedAt) delete db[code];
  }

  let code = genCode(prefix || name.slice(0, 2), 5);
  while (db[code]) code = genCode(prefix || name.slice(0, 2), 5);

  const now = Date.now();
  db[code] = {
    name,
    qq: String(qq || ''),
    createdAt: new Date(now).toISOString(),
    expireAt: new Date(now + ttlHours * 3600_000).toISOString(),
    usedAt: null,
    usedBy: null,
  };
  save(db);
  return { code, ...db[code] };
}

/** 群友侧：兑换绑定码 */
export function redeem(code, openid) {
  const db = load();
  const key = String(code || '').toUpperCase().trim().replace(/\s+/g, '');
  const item = db[key];

  if (!item) return { ok: false, reason: '这个码我没发过 别瞎试' };
  if (item.usedAt) {
    if (item.usedBy === openid) return { ok: true, name: item.name, repeat: true };
    return { ok: false, reason: '这码被人用过了' };
  }
  if (Date.parse(item.expireAt) < Date.now()) return { ok: false, reason: '码过期了 让管理重发' };

  item.usedAt = new Date().toISOString();
  item.usedBy = openid;
  save(db);

  saveAlias(openid, item.name);
  log('bind', `${openid.slice(0, 8)} -> ${item.name}（口令绑定）`);
  return { ok: true, name: item.name };
}

export function listCodes({ includeUsed = false } = {}) {
  const db = load();
  return Object.entries(db)
    .filter(([, v]) => includeUsed || !v.usedAt)
    .map(([code, v]) => ({ code, ...v }));
}

export function revoke(code) {
  const db = load();
  const key = String(code || '').toUpperCase().trim();
  if (!db[key]) return false;
  delete db[key];
  save(db);
  return true;
}

/** 当前已认出来的人（openid 是平台 id，无法反查 QQ 号） */
export function boundPeople() {
  const out = new Map();
  for (const [openid, p] of Object.entries(memory.profileTable())) {
    if (p.bound && p.name) out.set(openid, p.name);
  }
  for (const [openid, v] of Object.entries(loadAliases())) {
    if (v?.name) out.set(openid, v.name);
  }
  return [...out.entries()].map(([openid, name]) => ({ openid, name }));
}


/* ---------------- 尚未绑定的人 ---------------- */

function* allRecords() {
  const base = path.join(DIRS.working);
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    dirs = [];
  }
  for (const d of dirs) {
    const dir = path.join(base, d);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // ignore
        }
      }
    }
  }
  // 旧版消息库（新系统上线前的记录）
  try {
    for (const line of fs.readFileSync(path.join(DIRS.data, 'messages.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        yield { ts: r.ts, u: r.u, n: r.n, c: r.c };
      } catch {
        // ignore
      }
    }
  } catch {
    // 没有就算了
  }
}

/** 还没绑定的发言人，按最近发言排序，带第一句话方便认人 */
export function unknownSpeakers({ limit = 20 } = {}) {
  const bound = memory.profileTable();
  const aliases = loadAliases();
  const map = new Map();

  for (const r of allRecords()) {
    const uid = r.u;
    if (!uid || r.self) continue;
    if (bound[uid]?.bound || aliases[uid]) continue;

    const text = String(r.c || '').trim();
    const cur = map.get(uid);
    if (!cur) {
      map.set(uid, {
        openid: uid,
        nick: r.n || '',
        count: 1,
        firstTs: r.ts,
        firstText: text,
        lastTs: r.ts,
      });
    } else {
      cur.count += 1;
      cur.nick = r.n || cur.nick;
      if (r.ts && r.ts < cur.firstTs) {
        cur.firstTs = r.ts;
        cur.firstText = text;
      }
      if (r.ts && r.ts > (cur.lastTs || '')) cur.lastTs = r.ts;
    }
  }

  return [...map.values()]
    .filter((x) => x.firstText)
    .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)))
    .slice(0, limit);
}
