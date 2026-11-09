import { spawn } from 'node:child_process';
import { log } from '../core.mjs';

/**
 * 通用 stdio MCP 客户端（换行分隔 JSON-RPC 2.0）
 * 只负责协议，不认识任何厂商。厂商特有逻辑放 src/tools/adapters/。
 */
export function createStdioClient({ name, command, args = [], env = {}, timeoutMs = 20_000 }) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let buf = '';
  let seq = 0;
  const pending = new Map();
  const stderrTail = [];
  let exited = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 噪声
      }
      const entry = msg.id != null ? pending.get(msg.id) : null;
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });

  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (!s) return;
    stderrTail.push(s.slice(0, 300));
    if (stderrTail.length > 20) stderrTail.shift();
  });

  child.on('exit', (code, signal) => {
    exited = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP ${name} 进程退出 code=${code} signal=${signal}`));
    }
    pending.clear();
    log('mcp', `${name} 退出 code=${code}`);
  });

  function request(method, params, { timeout = timeoutMs } = {}) {
    if (exited) return Promise.reject(new Error(`MCP ${name} 已退出`));
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`MCP ${name} ${method} 超时 ${timeout}ms`), { code: 'timeout' }));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }

  async function initialize({ timeout = timeoutMs } = {}) {
    const res = await request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'jinha', version: '1.0.0' },
      },
      { timeout },
    );
    if (res.error) throw new Error(`initialize 失败：${res.error.message}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return res.result;
  }

  async function listTools({ timeout = timeoutMs } = {}) {
    const res = await request('tools/list', {}, { timeout });
    if (res.error) throw new Error(`tools/list 失败：${res.error.message}`);
    return res.result?.tools || [];
  }

  async function callTool(toolName, toolArgs, { timeout = timeoutMs } = {}) {
    const res = await request('tools/call', { name: toolName, arguments: toolArgs || {} }, { timeout });
    if (res.error) {
      const err = new Error(res.error.message || `JSON-RPC ${res.error.code}`);
      err.rpcCode = res.error.code;
      err.code = res.error.code === -32602 ? 'tool_not_found' : 'rpc_error';
      throw err;
    }
    const content = res.result?.content || [];
    const text = content
      .map((p) => (p.type === 'text' ? p.text : JSON.stringify(p)))
      .filter(Boolean)
      .join('\n');
    return { text, isError: !!res.result?.isError, raw: res.result };
  }

  return {
    name,
    request,
    initialize,
    listTools,
    callTool,
    stderr: () => stderrTail.slice(-5),
    close: () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    },
  };
}
