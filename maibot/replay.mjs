import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { cases } from './replay-cases.mjs';

const [uv, upstream, data, ...args] = process.argv.slice(2);
const { values } = parseArgs({ args, options: {
  kind: { type: 'string', default: 'all' }, jobs: { type: 'string', default: '4' }, limit: { type: 'string' },
} });
if (!['all', 'query', 'group', 'voice'].includes(values.kind) || !/^[1-8]$/.test(values.jobs) ||
    values.limit && !/^[1-9]\d*$/.test(values.limit) || !process.env.LLM_MODEL || !process.env.LLM_BASE_URL) {
  throw new Error('回放需要模型配置。参数可用 --kind all|query|group|voice、--jobs 1–8、--limit 正整数');
}
fs.mkdirSync(data, { recursive: true });
const directory = fs.mkdtempSync(path.join(data, 'replay-'));
const selected = cases.filter((item) => values.kind === 'all' || item.kind === values.kind).slice(0, values.limit ? Number(values.limit) : undefined);
const caseFile = path.join(directory, 'cases.json');
fs.writeFileSync(caseFile, JSON.stringify(selected));
console.log('回放目录', directory, '每组样本', selected.length);

const prefix = ['run', '--no-sync', '--project', upstream];
const variants = ['legacy', 'stock', 'candidate'];
const children = new Set();
function run(executable, argv, logFile) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(logFile, 'a');
    const child = spawn(executable, argv, { stdio: ['ignore', output, output] });
    fs.closeSync(output);
    children.add(child);
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`回放退出码 ${code}，详见 ${logFile}`));
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { for (const child of children) child.kill(signal); });
}

const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[,，\s]/g, '').replace(/(\d)[-比](\d)/g, '$1:$2');
const covers = (text, marks) => marks.every((mark) => normalize(text).includes(normalize(mark)));
function queried(item, evidence) {
  return item.facts.every((fact) => evidence.tools.some((tool) => {
    if (tool.name === 'jinhua_lookup') {
      const actionById = new Map(tool.arguments?.questions?.map((question) => [question.id, question.action]));
      return tool.result?.questions?.some((question) => question.status === 'ok' && actionById.get(question.id) === fact.action &&
        covers(JSON.stringify(question.facts), fact.marks));
    }
    return fact.toolNames.includes(tool.name) && covers(JSON.stringify(tool.result), fact.marks);
  }));
}

function summarize(results) {
  const measured = new Map(results.map((result) => [result.id, result]));
  const queries = selected.filter((item) => item.kind === 'query');
  const appropriate = selected.filter((item) => item.kind === 'group' && item.expect_reply);
  const silence = selected.filter((item) => item.kind === 'group' && !item.expect_reply);
  const delays = results.map((result) => result.first_ms).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    query_calls: queries.filter((item) => queried(item, measured.get(item.id))).length,
    query_answers: queries.filter((item) => covers(measured.get(item.id).text.join('\n'), item.facts.flatMap((fact) => fact.marks))).length,
    query_total: queries.length,
    appropriate_replies: appropriate.filter((item) => measured.get(item.id).text.length).length, appropriate_total: appropriate.length,
    false_interjections: silence.filter((item) => measured.get(item.id).text.length).length, silence_total: silence.length,
    delivered: delays.length,
    first_p50_ms: delays.length ? delays[Math.floor((delays.length - 1) * 0.5)] : null,
    first_p95_ms: delays.length ? delays[Math.floor((delays.length - 1) * 0.95)] : null,
    model_calls: results.reduce((count, result) => count + result.model_calls, 0),
  };
}

const results = {};
for (const variant of variants) {
  const instance = path.join(directory, variant);
  const logFile = path.join(directory, variant + '.log');
  if (variant === 'legacy') {
    fs.mkdirSync(instance);
    await run(process.execPath, [path.resolve('maibot/replay-legacy.mjs'), caseFile, instance, values.jobs], logFile);
  } else {
    const initLog = fs.openSync(logFile, 'a');
    const init = spawnSync(uv, [...prefix, 'maibot', 'init', '--directory', instance], { stdio: ['ignore', initLog, initLog] });
    fs.closeSync(initLog);
    if (init.status !== 0) throw init.error || new Error(`回放实例初始化失败，详见 ${logFile}`);
    await run(uv, [...prefix, 'python', path.resolve('maibot/replay.py'), '--instance', instance,
      '--node', process.execPath, '--cases', caseFile, '--variant', variant, '--concurrency', values.jobs], logFile);
  }
  results[variant] = JSON.parse(fs.readFileSync(path.join(instance, 'replay.json'), 'utf8'));
  console.log(variant, summarize(results[variant]));
}

const summaries = Object.fromEntries(variants.map((variant) => [variant, summarize(results[variant])]));
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summaries, null, 2));
const blind = selected.filter((item) => item.kind === 'voice').map((item) => {
  const order = [...variants];
  for (let position = order.length - 1; position > 0; position--) {
    const target = randomInt(position + 1);
    [order[position], order[target]] = [order[target], order[position]];
  }
  return { id: item.id, text: item.text, verifiedName: item.verified_name, order, replies: order.map((variant) =>
    results[variant].find((result) => result.id === item.id).text.join('\n') || '（沉默）') };
});
if (blind.length) {
  const review = ['# 金桦语气与设定盲评', '', '每题从三条回复里选一条。考虑上下文、称呼、语气和分寸。', '',
    ...blind.flatMap((row) => [`## ${row.id}`, '', row.verifiedName ? `发言人已绑定为${row.verifiedName}` : '发言人没有绑定熟人身份', '',
      row.text, '', ...row.replies.map((reply, index) =>
      `- **${'ABC'[index]}** ${reply.replaceAll('\n', ' ')}`), '', '选择 ____', '']),
  ];
  fs.writeFileSync(path.join(directory, 'blind.md'), review.join('\n'));
  fs.writeFileSync(path.join(directory, 'blind-key.json'), JSON.stringify(blind.map(({ id, order }) => ({ id, order })), null, 2));
}
