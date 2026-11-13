import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = 'v1.4.3';
const revision = 'e5391507531706a8bfce011d55ed94628039f2de';
const root = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.env.JINHUA_MAIBOT_DIR || 'data/maibot');
const upstream = path.join(directory, 'node_modules', 'maibot-upstream');
const instance = path.join(directory, 'instance');
const patchFile = 'upstream.patch';
const uv = process.env.JINHUA_UV || 'uv';
const [command = 'help', ...args] = process.argv.slice(2);

function exec(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(executable + ' 退出码 ' + result.status);
  }
  return result.stdout?.trim();
}

function configure(action) {
  const proxy = process.allowedNodeEnvironmentFlags.has('--use-env-proxy') &&
    (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) &&
    process.env.NODE_USE_ENV_PROXY !== '0';
  exec(uv, ['run', '--no-sync', '--project', upstream, 'python', path.join(root, 'maibot', 'configure.py'),
    action, '--root', root, '--instance', instance, '--node', process.execPath, ...(proxy ? ['--node-proxy'] : [])]);
}

function checkedUpstream() {
  const actual = exec('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
  if (actual !== revision) throw new Error('MaiBot 源码版本与固定版本不符 ' + revision);
}

function verifyPluginSync() {
  const source = path.join(root, 'maibot', 'jinhua');
  const target = path.join(instance, 'plugins', 'jinhua');
  const drift = [];
  for (const name of fs.readdirSync(source)) {
    if (!/\.(py|json)$/.test(name)) continue;
    const left = fs.readFileSync(path.join(source, name));
    const rightPath = path.join(target, name);
    if (!fs.existsSync(rightPath) || !left.equals(fs.readFileSync(rightPath))) drift.push(name);
  }
  if (drift.length) throw new Error('插件未同步到实例（先 configure）：' + drift.join(', '));
  const digest = crypto.createHash('sha1').update(fs.readFileSync(path.join(source, 'plugin.py'))).digest('hex').slice(0, 8);
  console.log('[金桦] 插件已同步，plugin.py sha1=' + digest);
}

// 幂等打补丁：标记文件记录「上游 commit + 补丁指纹」。
// 状态不符就整体回滚重打，失败也回滚，保证工作区永远是干净或完整应用二选一。
function applyPatches() {
  const patch = path.join(root, 'maibot', patchFile);
  const digest = crypto.createHash('sha1').update(fs.readFileSync(patch)).digest('hex').slice(0, 12);
  const head = exec('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
  const marker = path.join(upstream, '.jinhua-patch');
  const stamp = head + ':' + digest;
  const dirty = spawnSync('git', ['-C', upstream, 'diff', '--quiet']).status !== 0;

  if (dirty && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === stamp) {
    return; // 已是目标状态
  }

  exec('git', ['-C', upstream, 'checkout', '--', '.']);
  if (fs.existsSync(marker)) fs.rmSync(marker);
  try {
    exec('git', ['-C', upstream, 'apply', patch]);
    fs.writeFileSync(marker, stamp + '\n');
  } catch (error) {
    exec('git', ['-C', upstream, 'checkout', '--', '.']);
    throw new Error('上游补丁应用失败（已回滚）：' + error.message);
  }
}

try {
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(root)) throw new Error('请从鹅上青玉柳仓库根目录运行');
  if (command === 'install') {
    fs.mkdirSync(path.dirname(upstream), { recursive: true });
    if (!fs.existsSync(path.join(upstream, '.git'))) {
      exec('git', ['clone', '--depth', '1', '--branch', version, 'https://github.com/Mai-with-u/MaiBot.git', upstream]);
    }
    checkedUpstream();
    applyPatches();
    const locked = fs.existsSync(path.join(upstream, 'uv.lock'));
    exec(uv, ['sync', '--no-dev', '--python', '3.12', '--project', upstream, ...(locked ? ['--locked'] : [])]);
    exec(uv, ['run', '--no-sync', '--project', upstream, 'maibot', 'init', '--directory', instance]);
    configure('configure');
  } else if (['configure', 'run', 'memory-review', 'test', 'replay'].includes(command)) {
    checkedUpstream();
    applyPatches();
    if (command === 'replay') {
      exec(process.execPath, [path.join(root, 'maibot', 'replay.mjs'), uv, upstream, directory, ...args]);
    } else if (command === 'test') {
      const testDirectory = fs.mkdtempSync(path.join(fs.realpathSync(directory), 'test-'));
      try {
        exec(uv, ['run', '--no-sync', '--project', upstream, 'python', '-m', 'unittest', 'discover',
          '-s', path.join(root, 'maibot', 'tests')], { env: { ...process.env, MAIBOT_INSTANCE_DIR: testDirectory } });
      } finally {
        if (path.dirname(fs.realpathSync(testDirectory)) === fs.realpathSync(directory)) {
          fs.rmSync(testDirectory, { recursive: true, force: true, maxRetries: 3 });
        }
      }
    } else if (command === 'run') {
      if (!fs.existsSync(path.join(instance, 'plugins', 'jinhua', 'legacy.json'))) {
        throw new Error('请先运行 install');
      }
      configure('configure');
      configure(args.includes('--live-qq') ? 'live' : 'offline');
      verifyPluginSync();
      exec(uv, ['run', '--no-sync', '--project', upstream, 'maibot', 'run', '--directory', instance]);
    } else {
      configure(command);
    }
  } else if (command === 'doctor') {
    console.log('MaiBot', version, '实例', instance);
    console.log('Node', process.version, '环境模型', process.env.LLM_MODEL ? '已填写' : '未填写');
    console.log('QQ 环境凭证', process.env.QQ_APP_ID && process.env.QQ_APP_SECRET ? '已填写' : '未填写');
    console.log('本机 MCP', fs.existsSync(process.env.JINHUA_MCP_CONFIG || 'config/mcp.local.json') ? '已配置' : '使用直连工具');
    exec(uv, ['--version']);
    checkedUpstream();
  } else {
    console.log('node --env-file=.env maibot.mjs install|configure|doctor|memory-review|test|replay|run [--live-qq]');
  }
} catch (error) {
  console.error('[金桦]', error.message);
  process.exitCode = 1;
}
