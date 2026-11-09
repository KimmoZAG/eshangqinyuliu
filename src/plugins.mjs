import { groupConfig, patchGroupConfig, log } from './core.mjs';
import * as memory from './memory.mjs';
import { getSession, setSession, clearSession } from './pipeline.mjs';

const cooldown = new Map(); // `${plugin}:${uid}` -> ts

const registry = [];

function define(name, { aliases = [], perm = 'all', cd = 0, handler }) {
  registry.push({ name, aliases, perm, cd, handler });
}

function allowed(perm, role) {
  if (perm === 'all') return true;
  if (perm === 'admin') return role === 'admin' || role === 'owner';
  return role === 'owner';
}

export function commandOf(text) {
  const m = String(text || '').trim().match(/^\/([^\s]+)\s*(.*)$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}

/* ---------------- 插件定义 ---------------- */

define('help', {
  aliases: ['帮助', '菜单'],
  handler: () => ({
    lines: ['能用的：/战绩 人、/开黑报名、/话题（管理）、/闭嘴 和 /说话（管理）'],
  }),
});

define('战绩', {
  aliases: ['stats', '战况'],
  handler: ({ arg }) => {
    const p = memory.profileTable();
    const target = Object.entries(p).find(([, v]) => arg && v.name && v.name.includes(arg));
    if (target) {
      const [, v] = target;
      const bits = (v.bits || []).slice(-3).join('；') || '暂无可引用战绩';
      return { lines: [`${v.name}：${bits}`] };
    }
    const list = Object.values(p)
      .filter((v) => v.name)
      .slice(-6)
      .map((v) => v.name)
      .join('、');
    return { lines: [list ? `现在认得的：${list}。要查谁？` : '我还没认人，先@我说“我是zrc”这种。'] };
  },
});

define('开黑报名', {
  aliases: ['报名', '开黑'],
  handler: ({ uid }) => {
    setSession(uid, { plugin: '开黑报名', step: 1, data: {} });
    return { lines: ['几点开，LOL还是CS？直接说，我给你记着。'] };
  },
});

define('闭嘴', {
  aliases: ['安静'],
  perm: 'admin',
  handler: ({ group }) => {
    patchGroupConfig(group, { features: { interject: false } });
    return { lines: ['行，我不插嘴了，@我还是会回。'] };
  },
});

define('说话', {
  perm: 'admin',
  handler: ({ group }) => {
    patchGroupConfig(group, { features: { interject: true } });
    return { lines: ['那我可就不客气了。'] };
  },
});

define('话题', {
  perm: 'admin',
  handler: () => ({ lines: null, triggerTopic: true }),
});

/* ---------------- 会话处理（多轮） ---------------- */

const sessions = {
  开黑报名: ({ uid }, session, text) => {
    if (session.step === 1) {
      const data = { ...session.data, when: text.slice(0, 40) };
      setSession(uid, { plugin: '开黑报名', step: 2, data });
      return { lines: [`记下了：${data.when}。谁跟？让他们@我报名。`] };
    }
    clearSession(uid);
    return { lines: ['报名完了，别放鸽子。'] };
  },
};

export function runSession(ctx, text) {
  const s = getSession(ctx.uid);
  if (!s) return null;
  const fn = sessions[s.plugin];
  if (!fn) {
    clearSession(ctx.uid);
    return null;
  }
  return fn(ctx, s, text);
}

/* ---------------- 执行 ---------------- */

export function runPlugin(ctx, text) {
  const parsed = commandOf(text);
  if (!parsed) return null;

  const plugin = registry.find((p) => p.name === parsed.cmd || p.aliases.includes(parsed.cmd));
  if (!plugin) return { lines: ['没这命令，/帮助 看看。'] };

  if (!allowed(plugin.perm, ctx.role)) {
    return { lines: ['这命令你使不动，找管理员。'] };
  }

  const key = `${plugin.name}:${ctx.uid}`;
  if (plugin.cd && Date.now() - (cooldown.get(key) || 0) < plugin.cd) {
    return { lines: ['急啥，等会儿。'] };
  }
  cooldown.set(key, Date.now());

  const out = plugin.handler({ ...ctx, arg: parsed.arg });
  log('plugin', `${plugin.name} by ${ctx.uid.slice(0, 8)}`);
  return out;
}

export function pluginList() {
  return registry.map((p) => ({ name: p.name, perm: p.perm }));
}
