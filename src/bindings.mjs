import path from 'node:path';
import { DIRS, readJson, writeJson, log } from './core.mjs';
import * as memory from './memory.mjs';

const FILE = path.join(DIRS.data, 'bind-codes.json');

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

  memory.setAlias(openid, item.name);
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
  return Object.entries(memory.profileTable())
    .filter(([, p]) => p.name)
    .map(([openid, p]) => ({ openid, name: p.name }));
}
