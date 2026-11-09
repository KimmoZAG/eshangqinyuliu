import path from 'node:path';
import { DIRS, log, num, sleep, appendLine, metric } from './core.mjs';
import { sendGroup, sendC2C } from './transport.mjs';

const GAP = num('SEND_GAP_MS', 1200); // 全局条间隔
const QPM = num('GROUP_QPM', 20); // 每群每分钟
const MAX_BURST = num('MAX_BURST', 5); // 每回合最多条数
const RETRY = num('SEND_RETRY', 3);

const queues = new Map(); // key -> [job]
const running = new Set();
const buckets = new Map(); // key -> [ts]
const turnCount = new Map(); // turnId -> count
let lastSend = 0;

const DEAD = path.join(DIRS.data, 'outbox', 'dead-letter.jsonl');

function bucketDelay(key) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < 60_000);
  buckets.set(key, arr);
  if (arr.length >= QPM) return 60_000 - (now - arr[0]) + 50;
  return 0;
}

function takeToken(key) {
  const arr = buckets.get(key) || [];
  arr.push(Date.now());
  buckets.set(key, arr);
}

/** 入队。返回 {ok, id, code} */
export function enqueue(job) {
  const key = job.scope === 'c2c' ? `c2c:${job.openid}` : job.group;

  if (job.turnId) {
    const used = turnCount.get(job.turnId) || 0;
    if (used >= MAX_BURST) {
      metric('burst_capped');
      return Promise.resolve({ ok: false, reason: 'burst_cap' });
    }
    turnCount.set(job.turnId, used + 1);
  }

  if (!queues.has(key)) queues.set(key, []);
  const q = queues.get(key);
  if (job.dedupeKey && q.some((j) => j.dedupeKey === job.dedupeKey)) {
    return Promise.resolve({ ok: false, reason: 'duplicate' });
  }

  q.push(job);
  return new Promise((resolve) => {
    job.resolve = resolve;
    kick(key);
  });
}

async function kick(key) {
  if (running.has(key)) return;
  running.add(key);
  try {
    await drain(key);
  } finally {
    running.delete(key);
  }
}

async function drain(key) {
  const q = queues.get(key);
  while (q && q.length) {
    const job = q[0];

    if (job.deadline && Date.now() > job.deadline) {
      q.shift();
      metric('send_expired');
      job.resolve({ ok: false, reason: 'expired' });
      continue;
    }

    const wait = bucketDelay(key);
    if (wait > 0) {
      await sleep(Math.min(wait, 3000));
      continue;
    }
    const gap = lastSend + GAP - Date.now();
    if (gap > 0) await sleep(gap);

    takeToken(key);
    lastSend = Date.now();

    let res;
    try {
      res = job.scope === 'c2c' ? await sendC2C(job.openid, job.body) : await sendGroup(job.group, job.body);
    } catch (e) {
      res = { status: 500, data: { err_code: -1, message: e.message } };
    }

    const code = res.data?.err_code;
    if (!code) {
      q.shift();
      job.resolve({ ok: true, id: res.data?.id });
      continue;
    }

    // 被动回复失败不重试（窗口/去重/内容违规重试也无用）
    if (job.kind === 'reply') {
      q.shift();
      metric(`send_fail_${code}`);
      job.resolve({ ok: false, code, message: res.data?.message });
      continue;
    }

    const retryable = res.status >= 500 || res.status === 429 || code === 50055001;
    job.attempt = (job.attempt || 0) + 1;
    if (retryable && job.attempt <= RETRY) {
      await sleep(1000 * 3 ** (job.attempt - 1));
      continue;
    }

    q.shift();
    metric(`send_fail_${code}`);
    appendLine(DEAD, { at: new Date().toISOString(), key, code, message: res.data?.message, body: job.body });
    log('outbox', `${key} 失败 code=${code} ${res.data?.message}`);
    job.resolve({ ok: false, code, message: res.data?.message });
  }
}

/** 一轮多条的便捷入口（自动 msg_seq 递增） */
export async function sendLines({ scope = 'group', group, openid, lines, msgId, turnId, kind = 'reply', deadlineMs }) {
  const results = [];
  let n = 0;
  for (const text of lines) {
    n += 1;
    const body = msgId
      ? { msg_type: 0, content: text, msg_id: msgId, msg_seq: n }
      : { msg_type: 0, content: text };
    const r = await enqueue({
      scope,
      group,
      openid,
      kind,
      body,
      turnId,
      dedupeKey: msgId ? `${msgId}:${n}` : undefined,
      deadline: deadlineMs ? Date.now() + deadlineMs : undefined,
    });
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}
