import path from 'node:path';
import { DIRS, log, readJson } from './core.mjs';
import { createStdioClient } from './mcp/stdio.mjs';
import { registerOpggTools } from './opgg.mjs';

const registry = new Map();
const clients = new Map();
const cache = new Map();

const TRUNCATE = Number(process.env.TOOL_OUTPUT_MAX || 4000);

function inferDomain(name) {
  if (name.startsWith('opgg_')) return 'opgg';
  if (name.startsWith('steam_')) return 'steam';
  if (name.startsWith('hltv_')) return 'hltv';
  if (/^(get-schedule|get-live|get-leagues|get-event|get-match|get-upcoming)/.test(name)) return 'lol';
  return 'internal';
}

export function register(name, { description, schema, call, domain, heavy = false, ttlMs = 0 }) {
  registry.set(name, {
    name,
    domain: domain || inferDomain(name),
    description: description || name,
    schema: schema || { type: 'object', properties: {} },
    call,
    heavy,
    ttlMs,
  });
}

export function listTools() {
  return [...registry.values()].map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}

/** 域路由：只返回该域的工具（含完整 schema），用于"按需注入" */
export function toolsByDomain(domain) {
  return [...registry.values()]
    .filter((t) => t.domain === domain)
    .map((t) => ({ name: t.name, description: t.description, schema: t.schema, heavy: t.heavy }));
}

export function domains() {
  return [...new Set([...registry.values()].map((t) => t.domain))];
}

export function toolMeta(name) {
  const t = registry.get(name);
  return t ? { name: t.name, domain: t.domain, heavy: t.heavy } : null;
}

export async function callTool(name, args) {
  const t = registry.get(name);
  if (!t) return { ok: false, error: `没有工具 ${name}`, code: 'tool_not_found' };

  const key = `${name}:${JSON.stringify(args || {})}`;
  if (t.ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < t.ttlMs) return { ok: true, result: hit.val, cached: true };
  }

  try {
    let out = await t.call(args || {});
    if (typeof out === 'string' && out.length > TRUNCATE) out = `${out.slice(0, TRUNCATE)}…[已截断]`;
    if (t.ttlMs > 0) cache.set(key, { at: Date.now(), val: out });
    return { ok: true, result: out };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'tool_error' };
  }
}

/* ---------------- 内置工具 ---------------- */

import * as memory from './memory.mjs';

register('recall_memory', {
  domain: 'internal',
  description: '在群里的历史事件/梗/战绩里检索，返回最相关的几条',
  schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }) => memory.searchEpisodes(query, 5).map((e) => e.text),
});

register('member_profile', {
  domain: 'internal',
  description: '查询某个群友的画像：短板、梗、最近被锐评过的角度',
  schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  call: ({ name }) => {
    const p = memory.profileTable();
    const hit = Object.entries(p).find(([, v]) => v.name && v.name.includes(name));
    if (!hit) return { found: false };
    const [id, v] = hit;
    return {
      found: true,
      name: v.name,
      weaknesses: v.weaknesses || [],
      bits: v.bits || [],
      usedAngles: Object.keys(memory.usedAngles(id)),
    };
  },
});

/* ---------------- OP.GG（自带 HTTP 传输的适配器） ---------------- */

registerOpggTools(register);

/* ---------------- 配置驱动的 MCP（stdio） ---------------- */

export async function startMcpServers() {
  const cfgFile = path.join(DIRS.config, 'mcp.json');
  const servers = readJson(cfgFile, []);
  if (!Array.isArray(servers) || !servers.length) {
    log('mcp', 'config/mcp.json 为空，只加载内置与 OP.GG 工具');
    return { servers: 0, tools: registry.size };
  }

  let okServers = 0;
  for (const cfg of servers) {
    if (cfg.enabled === false) continue;
    if ((cfg.transport || 'stdio') !== 'stdio') {
      log('mcp', `${cfg.name} 跳过：transport=${cfg.transport}（目前只支持 stdio）`);
      continue;
    }

    try {
      const client = createStdioClient({
        name: cfg.name,
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        timeoutMs: cfg.timeoutMs || 20_000,
      });
      clients.set(cfg.name, client);

      const info = await client.initialize({ timeout: cfg.initTimeoutMs || 60_000 });
      const all = await client.listTools({ timeout: cfg.listTimeoutMs || 30_000 });

      const allow = cfg.allow || null;
      const deny = cfg.deny || [];
      let injected = 0;

      for (const t of all) {
        if (deny.includes(t.name)) continue;
        if (allow && !allow.includes(t.name)) continue;
        register(t.name, {
          domain: cfg.domain || cfg.name,
          description: t.description,
          schema: t.inputSchema,
          heavy: (cfg.heavy || []).includes(t.name),
          ttlMs: (cfg.ttlMs || {})[t.name] || 0,
          call: async (args) => {
            const r = await client.callTool(t.name, args, { timeout: cfg.toolTimeoutMs || 25_000 });
            // 很多服务用 isError 或"文本里写错误"来表示失败，统一收敛成异常
            const upstreamErr = /^(Failed to reach|Steam API request timed out|Unexpected response from|Error:|无法)/i.test(r.text);
            let jsonErr = false;
            try {
              const j = JSON.parse(r.text);
              if (j && typeof j === 'object' && j.error) jsonErr = true;
            } catch {}
            if (r.isError || upstreamErr || jsonErr) {
              throw Object.assign(new Error(r.text.slice(0, 300)), { code: 'upstream_unavailable' });
            }
            return r.text;
          },
        });
        injected += 1;
      }

      log(
        'mcp',
        `${cfg.name} 握手 ok：${info?.serverInfo?.name || '?'} v${info?.serverInfo?.version || '?'} | 声明 ${all.length} 工具，注入 ${injected}`,
      );
      okServers += 1;
    } catch (e) {
      log('mcp', `${cfg.name} 接入失败：${e.message}`);
    }
  }

  return { servers: okServers, tools: registry.size };
}

export function stopMcpServers() {
  for (const c of clients.values()) c.close();
}
