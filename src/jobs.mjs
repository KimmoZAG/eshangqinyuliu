import path from 'node:path';
import { DIRS, log, num, readJson, writeJson, trace, metric, groupConfig } from './core.mjs';
import { buildTopic } from './agent.mjs';
import { sendLines } from './outbox.mjs';

const CYCLE_H = num('TOPIC_CYCLE_H', 6);
const FILE = path.join(DIRS.data, 'jobs.json');
const GROUP_FILE = path.join(DIRS.data, 'groups.json');

const hourSH = (ts = Date.now()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(ts));

function isQuiet(cfg, h) {
  const [a, b] = cfg.quiet || [2, 8];
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

function nextAllowed(cfg) {
  const now = Date.now();
  for (let i = 0; i < 48; i += 1) {
    const ts = now + i * 3600e3;
    if (!isQuiet(cfg, hourSH(ts))) return ts + Math.floor(Math.random() * 30 * 60e3);
  }
  return now + 3600e3;
}

const randomOffset = () => Math.floor(Math.random() * CYCLE_H * 3600e3);

let jobs = readJson(FILE, {});

function save() {
  writeJson(FILE, jobs);
}

export function noteGroup(group) {
  const list = readJson(GROUP_FILE, { groups: [] });
  if (!list.groups.includes(group)) {
    list.groups.push(group);
    writeJson(GROUP_FILE, list);
  }
  ensure(group);
}

export function ensure(group) {
  if (jobs[group]) return jobs[group];
  jobs[group] = {
    cycleId: `${group}:${Date.now()}`,
    cycleStart: Date.now(),
    dueAt: Date.now() + randomOffset(),
    state: 'pending',
    attempt: 0,
  };
  save();
  log('job', `${group.slice(0, 8)} 新周期，due in ${Math.round((jobs[group].dueAt - Date.now()) / 60000)}min`);
  return jobs[group];
}

export function jobTable() {
  return jobs;
}

/** 执行一次话题（供定时与 /话题 命令共用） */
export async function runTopic(group, { manual = false } = {}) {
  const cfg = groupConfig(group);
  const job = ensure(group);

  if (job.state === 'running') return { ok: false, reason: 'running' };

  job.state = 'running';
  job.attempt = (job.attempt || 0) + 1;
  save();

  try {
    let lines = await buildTopic({ group, cfg });
    if (!lines.length) lines = ['今晚谁开黑？LOL还是CS，先说好谁菜。'];

    const r = await sendLines({
      scope: 'group',
      group,
      lines,
      kind: 'proactive',
      turnId: `topic:${job.cycleId}`,
    });

    const ok = r.some((x) => x.ok);
    trace({ kind: 'topic', group, manual, ok, lines: lines.length, cycle: job.cycleId });
    metric(ok ? 'topic_ok' : 'topic_fail');

    // 成功与否都进入下一周期，避免卡死在同一个 job 上
    jobs[group] = {
      cycleId: `${group}:${Date.now()}`,
      cycleStart: Date.now(),
      dueAt: Date.now() + randomOffset(),
      state: 'pending',
      attempt: 0,
    };
    save();
    return { ok, lines };
  } catch (e) {
    log('job', `话题失败 ${e.message}`);
    metric('topic_error');
    job.state = 'pending';
    job.dueAt = Date.now() + 10 * 60e3; // 10 分钟后重试，不丢周期
    save();
    return { ok: false, error: e.message };
  }
}

export function startJobs() {
  const boot = readJson(GROUP_FILE, { groups: [] });
  for (const g of boot.groups) ensure(g);

  setInterval(async () => {
    for (const [group, job] of Object.entries(jobs)) {
      const cfg = groupConfig(group);
      if (!cfg.features.topic) continue;

      // 落在静默时段 → 顺延到允许时段，仍算本周期
      if (job.state === 'pending' && isQuiet(cfg, hourSH(job.dueAt))) {
        const before = job.dueAt;
        job.dueAt = nextAllowed(cfg);
        save();
        log('job', `${group.slice(0, 8)} 静默顺延 ${new Date(before).toISOString()} -> ${new Date(job.dueAt).toISOString()}`);
        continue;
      }

      if (job.state === 'pending' && Date.now() >= job.dueAt) {
        log('job', `${group.slice(0, 8)} 到点执行话题`);
        await runTopic(group);
      }
    }
  }, 60_000);
}
