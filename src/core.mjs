import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
export const DIRS = {
  data: path.join(ROOT, 'data'),
  working: path.join(ROOT, 'data', 'working'),
  trace: path.join(ROOT, 'data', 'trace'),
  metrics: path.join(ROOT, 'data', 'metrics'),
  groups: path.join(ROOT, 'data', 'groups'),
  logs: path.join(ROOT, 'logs'),
  config: path.join(ROOT, 'config'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

export const TZ = 'Asia/Shanghai';
export const env = (k, d) => process.env[k] ?? d;
export const num = (k, d) => Number(process.env[k] ?? d);

export const shanghai = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ }));
export const dayKey = (d = new Date()) => {
  const s = shanghai(d);
  return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
};
export const hhmm = (ts) => {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--:--';
  }
};
export const nowText = () => new Date().toLocaleString('zh-CN', { timeZone: TZ });
export const uid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(scope, ...args) {
  console.log(new Date().toISOString(), `[${scope}]`, ...args);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ---------------- trace / metrics ---------------- */

export function trace(obj) {
  appendLine(path.join(DIRS.trace, `${dayKey()}.jsonl`), { at: new Date().toISOString(), ...obj });
}

export function metric(name, value = 1, extra) {
  const file = path.join(DIRS.metrics, `${dayKey()}.json`);
  const m = readJson(file, {});
  m[name] = (m[name] || 0) + value;
  if (extra) m[`${name}__last`] = extra;
  writeJson(file, m);
}

/* ---------------- 每群配置 ---------------- */

const DEFAULTS = {
  features: { reply: true, interject: true, topic: true, search: num('SEARCH_ENABLED', 0) === 1 },
  interjectP: num('INTERJECT_P', 0.35),
  quiet: [num('QUIET_START', 2), num('QUIET_END', 8)],
  persona: 'default',
  disabledUsers: [],
  replyLimit: num('MAX_BURST', 5),
};

export function groupConfig(group) {
  const cfg = readJson(path.join(DIRS.groups, `${group}.json`), {});
  return {
    ...DEFAULTS,
    ...cfg,
    features: { ...DEFAULTS.features, ...(cfg.features || {}) },
    quiet: cfg.quiet || DEFAULTS.quiet,
  };
}

export function patchGroupConfig(group, patch) {
  const cur = groupConfig(group);
  const next = { ...cur, ...patch, features: { ...cur.features, ...(patch.features || {}) } };
  writeJson(path.join(DIRS.groups, `${group}.json`), next);
  return next;
}

export function quietNow(cfg) {
  const [a, b] = cfg.quiet || [2, 8];
  const h = shanghai().getHours();
  return a <= b ? h >= a && h < b : h >= a || h < b;
}
