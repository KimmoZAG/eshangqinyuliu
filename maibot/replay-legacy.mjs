import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerFixtures } from './replay-data.mjs';

const [caseFile, instance, concurrency] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(caseFile, 'utf8'));
const modelOrigin = new URL(process.env.LLM_BASE_URL).origin;
process.chdir(instance);
Object.assign(process.env, { QQ_APP_ID: 'replay', QQ_APP_SECRET: 'replay', BOT_NAME: '金桦', DATA_TOOLS_ENABLED: '1',
  USER_QPM: '1000', SEARCH_ENABLED: '0' });
const { handleEvent } = await import('../src/app.mjs');
const { normalize } = await import('../src/transport.mjs');
const { patchGroupConfig } = await import('../src/core.mjs');
const { saveAlias } = await import('../src/members.mjs');
const { addMessage } = await import('../src/memory.mjs');
const { register } = await import('../src/tools.mjs');
const context = new AsyncLocalStorage();
registerFixtures(register, (call) => context.getStore()?.tools.push(call));
const fetchModel = globalThis.fetch;
globalThis.fetch = async (target, options) => {
  const url = new URL(target);
  if (url.origin === modelOrigin && url.pathname.endsWith('/chat/completions')) {
    const active = context.getStore();
    if (active) active.model_calls++;
    return fetchModel(target, options);
  }
  if (url.origin === 'https://api.bot.qq.com') {
    if (url.pathname.endsWith('/getAppAccessToken')) return Response.json({ access_token: 'replay', expires_in: 7200 });
    if (url.pathname.endsWith('/messages')) {
      const active = context.getStore();
      if (!active) throw new Error('回放发送缺少会话');
      active.first_ms ??= Math.round(performance.now() - active.started);
      active.text.push(JSON.parse(options.body).content);
      return Response.json({ id: `${active.id}-out-${active.text.length}` });
    }
  }
  throw new Error('回放仅访问已配置的模型');
};

async function play(caseData) {
  const { id, context: previous = [], text, at = true, name = '队友', user = 'fixture', verified_name } = caseData;
  patchGroupConfig(id, { features: { tools: true, search: false, interject: !!caseData.interject }, quiet: [0, 0] });
  if (verified_name) saveAlias(user, verified_name);
  previous.forEach((content, index) => addMessage(id, { id: id + '-' + index, c: content, n: '小鱼', u: 'previous-speaker' }));
  const result = { id, text: [], tools: [], model_calls: 0, first_ms: null, started: performance.now() };
  const submit = (content, index, explicit) => handleEvent(normalize({
    t: explicit ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
    d: { id: id + '-' + index, group_openid: id, content, timestamp: new Date().toISOString(),
      author: { member_openid: user, username: name } },
  }));
  await context.run(result, () => submit(text, 'prompt', at));
  delete result.started;
  return result;
}

const results = new Array(cases.length);
let index = 0;
await Promise.all(Array.from({ length: Math.min(Number(concurrency), cases.length) }, async () => {
  while (index < cases.length) {
    const current = index++;
    results[current] = await play(cases[current]);
  }
}));
writeFileSync(path.join(instance, 'replay.json'), JSON.stringify(results, null, 2));
