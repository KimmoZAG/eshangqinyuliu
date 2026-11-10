import path from 'node:path';
import { DIRS, readJson, writeJson } from './core.mjs';

const ALIASES_FILE = path.join(DIRS.data, 'aliases.json');
const PROFILES_FILE = path.join(DIRS.data, 'profiles.json');
const PLATFORM_OPENID = /^[0-9A-F]{32}$/;
const profiles = Object.assign(Object.create(null), readJson(PROFILES_FILE, {}));

function profile(openid) {
  return profiles[openid] ??= { name: '', lastSeen: null };
}

export function readMembers(openids) {
  const aliases = readJson(ALIASES_FILE, {});
  const ids = openids ?? [...new Set([...Object.keys(profiles), ...Object.keys(aliases)])];
  const entries = new Map();
  for (const openid of ids) {
    if (!openid || entries.has(openid)) continue;
    const stored = profiles[openid];
    const alias = Object.hasOwn(aliases, openid) ? aliases[openid]?.name : '';
    const verified = Boolean(alias || stored?.name && stored.verified);
    const platformId = PLATFORM_OPENID.test(openid);
    entries.set(openid, {
      openid,
      name: alias || stored?.name || '',
      bound: verified || Boolean(stored?.bound),
      verified,
      platformId,
      canMention: verified && platformId,
    });
  }
  return entries;
}

export function nameOf(openid, fallback, members = readMembers([openid])) {
  return members.get(openid)?.name || fallback || '群友';
}

export function saveAlias(openid, name) {
  const aliases = readJson(ALIASES_FILE, {});
  const record = { name, at: new Date().toISOString() };
  writeJson(ALIASES_FILE, { ...aliases, [openid]: record });
  return record;
}

export function setNickname(openid, name) {
  const member = readMembers([openid]).get(openid);
  if (member?.verified) return member.name;
  const stored = profile(openid);
  stored.name = name;
  stored.bound = true;
  stored.verified = false;
  stored.boundAt = new Date().toISOString();
  writeJson(PROFILES_FILE, profiles);
  return name;
}

export function observeMember(openid, rawName) {
  const stored = profile(openid);
  const changedName = !stored.name && rawName;
  if (changedName) stored.name = rawName;
  if (!changedName && Date.now() - Date.parse(stored.lastSeen) < 5 * 60_000) return;
  stored.lastSeen = new Date().toISOString();
  writeJson(PROFILES_FILE, profiles);
}

export function markAngle(key, openid, angle) {
  const stored = profile(openid);
  const scopes = stored.angleByConversation || {};
  const angles = Object.hasOwn(scopes, key) ? scopes[key] : {};
  stored.angleByConversation = { ...scopes, [key]: { ...angles, [angle]: Date.now() } };
  writeJson(PROFILES_FILE, profiles);
}

export function usedAngles(key, openid, withinMs = 6 * 3600 * 1000) {
  const cutoff = Date.now() - withinMs;
  return Object.entries(profiles[openid]?.angleByConversation?.[key] || {})
    .filter(([, ts]) => ts > cutoff)
    .map(([angle]) => angle);
}
