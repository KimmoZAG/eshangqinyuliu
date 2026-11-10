import { log, num, quietNow, trace } from './core.mjs';

/* ---------------- 1. 去重 ---------------- */

const seen = new Set();
const seenOrder = [];

export function dedupe(id) {
  if (!id) return true;
  if (seen.has(id)) {
    trace({ kind: 'dedupe_hit', id });
    return false;
  }
  seen.add(id);
  seenOrder.push(id);
  if (seenOrder.length > 5000) seen.delete(seenOrder.shift());
  return true;
}

/* ---------------- 2. 用户级限流 ---------------- */

const hits = new Map(); // uid -> [ts]

export function rateOk(uid, limit = num('USER_QPM', 8)) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(uid, arr);
  if (hits.size > 2000) hits.clear();
  return arr.length <= limit;
}

/* ---------------- 3. 会话状态机 ---------------- */

const sessions = new Map(); // key -> {plugin, step, data, expire}

export function getSession(key) {
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expire) {
    sessions.delete(key);
    return null;
  }
  return s;
}

export function setSession(key, session, ttlMs = 10 * 60 * 1000) {
  sessions.set(key, { ...session, expire: Date.now() + ttlMs });
}

export function clearSession(key) {
  sessions.delete(key);
}

export function sessionCount() {
  return sessions.size;
}

/* ---------------- 4. 插话冷却 ---------------- */

const interjectAt = new Map();

export function canInterject(key) {
  const last = interjectAt.get(key) || 0;
  return Date.now() - last > num('INTERJECT_COOLDOWN_MS', 10 * 60 * 1000);
}

export function markInterject(key) {
  interjectAt.set(key, Date.now());
}

/* ---------------- 5. 入站闸门 ---------------- */

export function guardIn(cfg, evt) {
  if (evt.type !== 'message') return { ok: true };
  if (!cfg.features.reply) return { ok: false, reason: 'feature_off' };

  const uid = evt.data?.author?.member_openid || evt.data?.author?.user_openid || evt.data?.author?.id;
  if (uid && (cfg.disabledUsers || []).includes(uid)) return { ok: false, reason: 'user_blocked' };
  if (!rateOk(uid)) {
    trace({ kind: 'rate_limited', uid });
    return { ok: false, reason: 'rate_limited' };
  }
  return { ok: true };
}

/* ---------------- 6. 插话判定（规则层） ---------------- */

export function interjectRules(cfg, text, isAt, selfJustSpoke) {
  if (!cfg.features.interject || isAt) return { ok: false, reason: 'not_candidate' };
  if (quietNow(cfg)) return { ok: false, reason: 'quiet' };
  if (selfJustSpoke) return { ok: false, reason: 'self_spoke' };
  if (!text || text.length < 4) return { ok: false, reason: 'too_short' };
  if (/^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(text)) return { ok: false, reason: 'emoji_only' };
  return { ok: true };
}

export function logStep(turnId, step, data) {
  log('pipe', turnId.slice(0, 8), step, typeof data === 'string' ? data : JSON.stringify(data).slice(0, 160));
}
