import { createInterface } from 'node:readline';

const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

export function serveLookup(spec, lookup, onClose = () => {}) {
  const active = new Map();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n');
  const fail = (id, code, message) => write({ id, error: { code, message } });

  async function handle({ id, method, params, jsonrpc }) {
    if (jsonrpc !== '2.0') return fail(id ?? null, -32600, 'Invalid MCP request');
    if (method === 'notifications/cancelled') {
      active.get(params?.requestId)?.abort();
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') {
      write({ id, result: {
        protocolVersion: versions.has(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'jinhua-readonly', version: '1.0.0' },
      } });
      return;
    }
    if (method === 'ping' || method === 'tools/list') {
      write({ id, result: method === 'ping' ? {} : { tools: [spec] } });
      return;
    }
    if (method !== 'tools/call') return fail(id, -32601, 'Unknown MCP method');
    if (params?.name !== spec.name) return fail(id, -32602, 'Unknown tool');
    if (active.has(id)) return fail(id, -32602, 'Request id already in use');

    const controller = new AbortController();
    active.set(id, controller);
    try {
      const result = await lookup(params.arguments, controller.signal);
      if (!controller.signal.aborted) write({
        id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error.code === 'bad_args') fail(id, -32602, '查询参数有误');
        else fail(id, -32603, '查询执行失败');
      }
    } finally {
      active.delete(id);
    }
  }

  input.on('line', (line) => {
    try {
      const request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        fail(null, -32600, 'Invalid MCP request');
      } else void handle(request);
    } catch {
      fail(null, -32700, 'Invalid JSON');
    }
  });
  input.once('close', () => {
    for (const request of active.values()) request.abort();
    void onClose();
  });
  process.once('SIGTERM', () => { input.close(); process.stdin.pause(); });
}
