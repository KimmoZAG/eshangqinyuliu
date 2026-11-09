/**
 * MCP 验收脚本（按服务跑用例，输出表格 + 原始报错）
 *
 *   node --env-file=.env smoke-mcp.mjs steam
 *   node --env-file=.env smoke-mcp.mjs hltv
 */
import { startMcpServers, listTools, callTool, domains } from './src/tools.mjs';

const server = process.argv[2] || 'steam';

const CASES = {
  steam: [
    ['steam_getAppDetails', { appid: 730 }],
    ['steam_searchApps', { query: 'ELDEN RING' }],
    ['steam_getPriceOverview', { appids: [730, 570] }],
    ['steam_getPlayerCount', { appid: 730 }],
    ['steam_getAppReviewSummary', { appid: 730 }],
  ],
  hltv: [
    ['hltv_backend_status', {}],
    ['hltv_get_team_ranking', {}],
    ['hltv_get_matches', {}],
    ['hltv_get_results', { count: 5 }],
    ['hltv_get_player', { name: 'ZywOo' }],
    ['hltv_get_team', { name: 'Vitality' }],
  ],
};

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const cut = (s, n = 260) => String(s).replace(/\s+/g, ' ').slice(0, n);

const boot = await startMcpServers();
console.log(`\n握手：${boot.servers} 个服务 | 注册表 ${boot.tools} 个工具 | 域：${domains().join(', ')}`);
const names = listTools().map((t) => t.name);
console.log(`已注入（${names.length}）：${names.join(', ')}\n`);

console.log('| 工具 | 结果 | 耗时 | 返回摘要 |');
console.log('|---|---|---|---|');

for (const [tool, args] of CASES[server] || []) {
  const t0 = Date.now();
  const r = await callTool(tool, args);
  const ms = Date.now() - t0;
  const ok = r.ok ? '✅' : '❌';
  const body = r.ok ? r.result : `ERROR(${r.code || 'n/a'}): ${r.error}`;
  console.log(`| ${tool} | ${ok} | ${ms}ms | ${cut(JSON.stringify(body))} |`);
  if (!r.ok) console.log(`\n> 原始报错 ${tool}: ${r.error}\n> code=${r.code}`);
}

console.log('\n完成。');
process.exit(0);
