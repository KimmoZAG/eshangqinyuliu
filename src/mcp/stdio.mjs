import { spawn } from 'node:child_process';
import { addAbortListener } from 'node:events';
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

  function settle(id) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.listener?.[Symbol.dispose]();
    return entry;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
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
      settle(msg.id)?.resolve(msg);
    }
  });

  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (!s) return;
    stderrTail.push(s.slice(0, 300));
    if (stderrTail.length > 20) stderrTail.shift();
  });

  function stop(error) {
    exited = true;
    for (const id of pending.keys()) settle(id).reject(error);
  }
  child.on('error', stop);
  child.stdin.on('error', stop);
  child.on('exit', (code, signal) => {
    stop(new Error(`MCP ${name} 进程退出 code=${code} signal=${signal}`));
    log('mcp', `${name} 退出 code=${code}`);
  });

  function request(method, params, { timeout = timeoutMs, signal } = {}) {
    if (exited) return Promise.reject(new Error(`MCP ${name} 已退出`));
    if (signal?.aborted) return Promise.reject(signal.reason);
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(id)?.reject(Object.assign(new Error(`MCP ${name} ${method} 超时 ${timeout}ms`), { code: 'timeout' }));
      }, timeout);
      const listener = signal && addAbortListener(signal, () => {
        settle(id)?.reject(signal.reason);
        if (!exited) child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id },
        }) + '\n');
      });
      pending.set(id, { resolve, reject, timer, listener });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        settle(id)?.reject(e);
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

  async function callTool(toolName, toolArgs, { timeout = timeoutMs, signal } = {}) {
    const res = await request('tools/call', { name: toolName, arguments: toolArgs || {} }, { timeout, signal });
    if (res.error) {
      const err = new Error(res.error.message || `JSON-RPC ${res.error.code}`);
      err.rpcCode = res.error.code;
      err.code = res.error.code === -32602 ? 'bad_args' : 'rpc_error';
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
