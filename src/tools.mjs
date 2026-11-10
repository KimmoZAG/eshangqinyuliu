import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addAbortListener } from 'node:events';
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

function matchesSchema(value, schema, strict = false) {
  if (schema === false) return false;
  if (!schema || schema === true) return true;
  if (schema.anyOf && !schema.anyOf.some((option) => matchesSchema(value, option, strict))) return false;
  if (schema.oneOf && schema.oneOf.filter((option) => matchesSchema(value, option, strict)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every((option) => matchesSchema(value, option, strict))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![schema.type].flat().some((expected) =>
    type === expected || expected === 'integer' && Number.isInteger(value))) return false;
  if (type === 'object') {
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, val] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) {
        if (!matchesSchema(val, schema.properties[key], strict)) return false;
      } else if (schema.additionalProperties !== undefined) {
        if (!matchesSchema(val, schema.additionalProperties, strict)) return false;
      } else if (strict && schema.properties) return false;
    }
  }
  if (type === 'array' && schema.items && !value.every((item) => matchesSchema(item, schema.items, strict))) return false;
  if (type === 'number' && (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum)) return false;
  if (type === 'string' && (value.length < schema.minLength || value.length > schema.maxLength)) return false;
  return true;
}

export async function callTool(name, args, { signal, allowed, key: conversation } = {}) {
  const t = registry.get(name);
  if (!t) return { ok: false, error: `没有工具 ${name}`, code: 'tool_not_found' };

  if (signal?.aborted) return { ok: false, code: 'timeout', error: '查询超时' };
  if (allowed && !allowed.has(name)) return { ok: false, code: 'tool_not_allowed', error: '当前问题不可用此工具' };
  if (allowed && (!args || typeof args !== 'object' || Array.isArray(args) || !matchesSchema(args, t.schema, true))) {
    return { ok: false, code: 'bad_args', error: '参数不符合工具 schema' };
  }
  const key = `${name}:${JSON.stringify(args || {})}`;
  if (t.ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < t.ttlMs) return { ok: true, result: hit.val, cached: true };
  }

  let listener;
  try {
    const pending = Promise.resolve(t.call(args || {}, { signal, key: conversation }));
    const abort = signal && new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    let out = await (abort ? Promise.race([pending, abort]) : pending);
    if (typeof out === 'string' && out.length > TRUNCATE) out = `${out.slice(0, TRUNCATE)}…[已截断]`;
    if (t.ttlMs > 0) cache.set(key, { at: Date.now(), val: out });
    return { ok: true, result: out };
  } catch (e) {
    return { ok: false, error: e.message, code: signal?.aborted ? 'timeout' : e.code || 'tool_error' };
  } finally {
    listener?.[Symbol.dispose]();
  }
}

/* ---------------- 内置工具 ---------------- */

import * as memory from './memory.mjs';
import { readMembers, usedAngles } from './members.mjs';

register('recall_memory', {
  domain: 'internal',
  description: '在群里的历史事件/梗/战绩里检索，返回最相关的几条',
  schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }, { key }) => memory.searchEpisodes(key, query, 5).map((e) => e.text),
});

register('member_profile', {
  domain: 'internal',
  description: '查询当前会话里某个群友的称呼和最近被锐评过的角度',
  schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  call: ({ name }, { key }) => {
    const member = key && [...readMembers(memory.memberIds(key)).values()].find((item) => item.name && item.name.includes(name));
    if (!member) return { found: false };
    return {
      found: true,
      name: member.name,
      usedAngles: usedAngles(key, member.openid),
    };
  },
});

/* ---------------- OP.GG（自带 HTTP 传输的适配器） ---------------- */

registerOpggTools(register);

/* ---------------- 配置驱动的 MCP（stdio） ---------------- */

async function loadAdapters(cfg, client) {
  let loaded = 0;
  for (const rel of cfg.adapters || []) {
    try {
      const mod = await import(pathToFileURL(path.resolve(rel)).href);
      const fn = mod.default || mod.registerAdapters;
      if (typeof fn !== 'function') throw new Error('没有注册函数');
      fn(register, client, cfg);
      loaded += 1;
    } catch (e) {
      log('mcp', cfg.name, '适配器加载失败', rel, e.message);
    }
  }
  return loaded;
}

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
    // transport=none：只有适配器，没有 MCP 子进程（比如直连 HTTP API 的搜索）
    if ((cfg.transport || 'stdio') === 'none') {
      if (await loadAdapters(cfg, null)) {
        okServers += 1;
        log('mcp', cfg.name, '无进程适配器已加载');
      }
      continue;
    }

    if ((cfg.transport || 'stdio') !== 'stdio') {
      log('mcp', `${cfg.name} 跳过：transport=${cfg.transport}`);
      continue;
    }

    let client;
    try {
      client = createStdioClient({
        name: cfg.name,
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        timeoutMs: cfg.timeoutMs || 20_000,
      });

      const info = await client.initialize({ timeout: cfg.initTimeoutMs || 60_000 });
      const all = await client.listTools({ timeout: cfg.listTimeoutMs || 30_000 });
      clients.set(cfg.name, client);

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
          call: async (args, { signal }) => {
            const r = await client.callTool(t.name, args, { timeout: cfg.toolTimeoutMs || 25_000, signal });
            // 很多服务用 isError 或"文本里写错误"来表示失败，统一收敛成异常
            const upstreamErr = /^(Failed to reach|Steam API request timed out|Unexpected response from|Error:|无法)/i.test(r.text);
            let result = r.raw?.structuredContent ?? r.text;
            if (typeof result === 'string') {
              try { result = JSON.parse(result); } catch {}
            }
            if (r.isError || upstreamErr || result?.error) {
              throw Object.assign(new Error(r.text.slice(0, 300)), { code: 'upstream_unavailable' });
            }
            return result;
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
      clients.delete(cfg.name);
      client?.close();
      client = null;
    }
    await loadAdapters(cfg, client);
  }

  return { servers: okServers, tools: registry.size };
}

export function clientOf(name) {
  return clients.get(name);
}

export function stopMcpServers() {
  for (const c of clients.values()) c.close();
}
