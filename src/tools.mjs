import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS, log, readJson } from './core.mjs';
import * as memory from './memory.mjs';
import { registerOpggTools } from './opgg.mjs';

const registry = new Map();

export function register(name, { description, schema, call }) {
  registry.set(name, { name, description, schema, call });
}

export function listTools() {
  return [...registry.values()].map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}

export async function callTool(name, args) {
  const t = registry.get(name);
  if (!t) return { ok: false, error: `没有工具 ${name}` };
  try {
    const out = await t.call(args || {});
    return { ok: true, result: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- 内置工具 ---------------- */

register('recall_memory', {
  description: '在群里的历史事件/梗/战绩里检索，返回最相关的几条',
  schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  call: ({ query }) => memory.searchEpisodes(query, 5).map((e) => e.text),
});

register('member_profile', {
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

/* ---------------- OP.GG（Streamable HTTP，无需 config/mcp.json） ---------------- */

registerOpggTools(register);

/* ---------------- MCP 客户端（stdio, JSON-RPC 2.0 换行分隔） ---------------- */

const clients = [];

function mcpClient({ name, command, args = [], env = {}, timeoutMs = 25000 }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = '';
  let id = 0;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // 忽略非 JSON 输出
      }
    }
  });

  child.stderr.on('data', (d) => log('mcp', name, d.toString().trim().slice(0, 200)));
  child.on('exit', (code) => log('mcp', `${name} 退出 code=${code}`));

  function request(method, params) {
    id += 1;
    const msgId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`MCP ${name} ${method} 超时`));
      }, timeoutMs);

      pending.set(msgId, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });

      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params }) + '\n');
    });
  }

  return { name, child, request };
}

export async function startMcp() {
  const cfgFile = path.join(DIRS.config, 'mcp.json');
  const servers = readJson(cfgFile, []);
  if (!Array.isArray(servers) || !servers.length) {
    log('mcp', '未配置 MCP（config/mcp.json），只用内置工具');
    return 0;
  }

  let count = 0;
  for (const cfg of servers) {
    try {
      const c = mcpClient(cfg);
      clients.push(c);

      const init = await c.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'jinha', version: '1.0.0' },
      });
      if (init.error) throw new Error(init.error.message);

      const list = await c.request('tools/list', {});
      for (const t of list.result?.tools || []) {
        register(t.name, {
          description: t.description || t.name,
          schema: t.inputSchema || { type: 'object', properties: {} },
          call: async (args) => {
            const r = await c.request('tools/call', { name: t.name, arguments: args });
            if (r.error) throw new Error(r.error.message);
            const content = r.result?.content || [];
            return content.map((p) => p.text).filter(Boolean).join('\n').slice(0, 3000);
          },
        });
        count += 1;
      }
      log('mcp', `${cfg.name} 已接入，工具 ${(list.result?.tools || []).length} 个`);
    } catch (e) {
      log('mcp', `${cfg.name} 接入失败：${e.message}`);
    }
  }
  return count;
}

export function stopMcp() {
  for (const c of clients) {
    try {
      c.child.kill();
    } catch {
      // ignore
    }
  }
}
