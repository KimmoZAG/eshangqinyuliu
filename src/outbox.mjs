import path from 'node:path';
import { DIRS, MAX_BURST, log, num, appendLine, metric, trace } from './core.mjs';
import { sendGroup, sendC2C } from './transport.mjs';
import { prepareGroupLines } from './mentions.mjs';

const GAP = num('SEND_GAP_MS', 1200);
const QPM = Math.max(1, num('GROUP_QPM', 20));
const RETRY = num('SEND_RETRY', 3);
const PRIORITY = { reply: 0, command: 1, proactive: 2 };
const DEAD = path.join(DIRS.data, 'outbox', 'dead-letter.jsonl');
const queues = new Map();
const buckets = new Map();
const completed = new Map();
let lastSend = 0;

function takeSlot(key, now) {
  const recent = (buckets.get(key) || []).filter((ts) => now - ts < 60_000);
  const wait = Math.max(lastSend + GAP - now, recent.length >= QPM ? recent[0] + 60_000 - now : 0);
  if (wait > 0) return wait;
  recent.push(now);
  buckets.set(key, recent);
  lastSend = now;
  if (buckets.size > 2000) {
    for (const [id, stamps] of buckets) if (now - stamps.at(-1) >= 60_000) buckets.delete(id);
  }
  return 0;
}

function waitForWork(queue, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      queue.wake = null;
      resolve();
    }
    queue.wake = finish;
  });
}

function finish(queue, job) {
  queue.jobs.splice(queue.jobs.indexOf(job), 1);
  if (job.dedupeKey && job.results.some((result) => result.ok)) {
    completed.set(job.dedupeKey, job.deadline);
    if (completed.size > 5000) completed.delete(completed.keys().next().value);
  }
  job.resolve(job.results);
}

function fail(queue, job, result) {
  job.results.push({ ok: false, index: job.index, ...result });
  metric('send_fail');
  trace({ kind: 'send_failed', turnId: job.turnId, reason: result.reason, code: result.code, status: result.status });
  finish(queue, job);
}

async function drain(key, queue) {
  while (queue.jobs.length) {
    const job = queue.jobs.reduce((first, next) => PRIORITY[next.kind] < PRIORITY[first.kind] ? next : first);
    const now = Date.now();
    if (now >= job.deadline || job.shouldSend && !job.shouldSend()) {
      fail(queue, job, { reason: now >= job.deadline ? 'expired' : 'stale' });
      continue;
    }
    const wait = job.retryAt > now ? job.retryAt - now : takeSlot(key, now);
    if (wait > 0) {
      await waitForWork(queue, Math.min(wait, job.deadline - now));
      continue;
    }
    const { content, text } = job.lines[job.index];
    const body = job.msgId
      ? buildBody(content, job.msgId, job.index + 1)
      : buildBody(content);
    let response;
    try {
      const signal = AbortSignal.timeout(Math.min(8000, job.deadline - now));
      response = job.scope === 'c2c'
        ? await sendC2C(job.openid, body, signal)
        : await sendGroup(job.group, body, signal);
    } catch {
      response = { status: 503 };
    }
    const code = response.data?.err_code || response.data?.code;
    const status = response.status;
    if (status >= 200 && status < 300 && !code && response.data?.id) {
      job.results.push({ ok: true, id: response.data.id, text, content, sourceId: job.sourceId, turnId: job.turnId });
      metric('send_ok');
      if (job.index === 0 && job.receivedAt) {
        trace({ kind: 'first_reply_delivered', turnId: job.turnId, ms: Date.now() - job.receivedAt });
      }
      job.index += 1;
      job.attempt = 0;
      job.retryAt = 0;
      if (job.index === job.lines.length) finish(queue, job);
      continue;
    }
    const retryable = status >= 500 || status === 429 || code === 50055001;
    job.attempt += 1;
    if (job.kind === 'proactive' && retryable && job.attempt <= RETRY) {
      job.retryAt = Date.now() + 1000 * 3 ** (job.attempt - 1);
      continue;
    }
    if (job.kind === 'proactive') {
      appendLine(DEAD, { at: new Date().toISOString(), key, code, status, message: response.data?.message, body });
      log('outbox', key, '发送失败', status, code);
    }
    fail(queue, job, { reason: 'send_failed', code, status });
  }
}

async function runQueue(key, queue) {
  queue.running = true;
  try {
    await drain(key, queue);
  } catch (error) {
    log('outbox', '处理异常', error.message);
    for (const job of queue.jobs.splice(0)) job.resolve([...job.results, { ok: false, reason: 'queue_error' }]);
  } finally {
    queue.running = false;
    if (queue.jobs.length) void runQueue(key, queue);
    else queues.delete(key);
  }
}


/** 带 <qqbot-at-user> 的必须走 markdown（文本消息里的 @ 不生效） */
function buildBody(text, msgId, seq) {
  const mention = /<qqbot-at-(user|everyone)\b/.test(text);
  const base = mention
    ? { msg_type: 2, markdown: { content: text } }
    : { msg_type: 0, content: text };
  if (msgId) {
    base.msg_id = msgId;
    base.msg_seq = seq;
  }
  return base;
}

export function sendLines({
  scope = 'group', group, openid, lines, msgId, sourceId = msgId, turnId, kind = 'reply',
  deadline = Date.now() + 60_000, receivedAt, shouldSend,
}) {
  const key = scope === 'c2c' ? 'c2c:' + openid : group;
  // 群消息把 @名字 换成真实提及 <@openid>，否则只是纯文本
  const source = lines.filter((line) => typeof line === 'string' && line.trim());
  const messages = (scope === 'group' ? prepareGroupLines(source) : source.map((text) => ({ text, content: text })))
    .slice(0, MAX_BURST);
  if (!messages.length) return Promise.resolve([]);
  const dedupeKey = msgId ? key + ':' + msgId : turnId;
  const queue = queues.get(key) || { jobs: [], running: false, wake: null };
  if (dedupeKey && (completed.get(dedupeKey) > Date.now() || queue.jobs.some((job) => job.dedupeKey === dedupeKey))) {
    return Promise.resolve([{ ok: false, reason: 'duplicate' }]);
  }
  queues.set(key, queue);
  return new Promise((resolve) => {
    queue.jobs.push({
      scope, group, openid, lines: messages, msgId, sourceId, turnId, kind, deadline, receivedAt, shouldSend,
      dedupeKey, resolve, index: 0, results: [], attempt: 0, retryAt: 0,
    });
    queue.wake?.();
    if (!queue.running) void runQueue(key, queue);
  });
}
