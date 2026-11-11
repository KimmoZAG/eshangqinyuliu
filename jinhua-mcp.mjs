import fs from 'node:fs';
import path from 'node:path';
import { addAbortListener } from 'node:events';
import { serveLookup } from './src/mcp/jinhua-stdio.mjs';

// stdout belongs to the MCP protocol, including during module initialization.
console.log = console.error.bind(console);
console.info = console.log;
if (process.env.JINHUA_TOOL_CWD) process.chdir(process.env.JINHUA_TOOL_CWD);
const { callTool, listTools, startMcpServers, stopMcpServers } = await import('./src/tools.mjs');
const { lookupSpec, runLookup } = await import('./src/mcp/jinhua-tools.mjs');

const search = process.env.SEARCH_ENABLED === '1';
const spec = lookupSpec(search);
const direct = [
  { name: 'lol-direct', transport: 'none', adapters: ['./src/tools/lol-adapters.mjs'] },
  { name: 'steam-direct', transport: 'none', adapters: ['./src/tools/steam-adapters.mjs'] },
  ...(search ? [{ name: 'search', transport: 'none', adapters: ['./src/tools/search-adapters.mjs'] }] : []),
];
await startMcpServers({ config: direct });

const configPath = process.env.JINHUA_MCP_CONFIG || path.resolve('config/mcp.local.json');
let configured = [];
try {
  configured = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(configured)) throw new TypeError('MCP config must be an array');
} catch (error) {
  if (error.code !== 'ENOENT') console.error('[jinhua-mcp] 无法读取本机 MCP 配置:', error.message);
  configured = [];
}
const backends = new Map([
  ['hltv', ['hltv_get_team_ranking', 'hltv_get_results']],
  ['lol', ['get-match-vods']],
]);
const starting = new Map();
for (const server of configured) {
  const domain = server?.domain || server?.name;
  const names = backends.get(domain);
  if (!names || starting.has(domain) || server.enabled === false || !server.command) continue;
  const promise = startMcpServers({ config: [{
    ...server, domain, transport: 'stdio',
    allow: names, adapters: domain === 'lol' ? ['./src/tools/lol-adapters.mjs'] : [],
  }], connectTimeoutMs: 4500 }).catch(() => null);
  starting.set(domain, promise);
}

async function invoke(name, args, options) {
  const pending = name.startsWith('hltv_') && starting.get('hltv');
  if (pending && !options.signal.aborted) {
    let listener;
    try {
      await Promise.race([pending, new Promise((resolve) => { listener = addAbortListener(options.signal, resolve); })]);
    } finally {
      listener?.[Symbol.dispose]();
    }
  }
  if (options.signal.aborted) return { ok: false, code: 'timeout' };
  return callTool(name, args, options);
}

serveLookup(spec, (args, signal) => {
  const names = listTools().map((tool) => tool.name);
  if (starting.has('hltv')) names.push(...backends.get('hltv'));
  return runLookup(args, { signal, search, mode: args?.mode, invoke, names });
}, async () => {
  await Promise.all(starting.values());
  stopMcpServers();
});
