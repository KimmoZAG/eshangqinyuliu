import { groupConfig, patchGroupConfig, log } from './core.mjs';
import * as memory from './memory.mjs';
import { nameOf, readMembers } from './members.mjs';
import { redeem } from './bindings.mjs';
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
    lines: ['能用的：绑定 码、/战绩 人、/开黑报名、/话题（管理）、/暧昧 开或关（管理）、/闭嘴 和 /说话（管理）'],
  }),
});

define('绑定', {
  aliases: ['bind', '认证'],
  handler: ({ uid, arg }) => {
    if (!arg) return { lines: ['码呢 管理给你那个码 发我'] };
    const r = redeem(arg, uid);
    if (!r.ok) return { lines: [r.reason] };
    if (r.repeat) return { lines: [`你早就是${r.name}了`] };
    return { lines: [`行 ${r.name} 记下了 以后别装别人`] };
  },
});

define('战绩', {
  aliases: ['stats', '战况'],
  handler: ({ arg, group }) => {
    const people = memory.memberIds(group);
    const members = readMembers(people);
    const target = people.find((id) => arg && members.get(id)?.name.includes(arg));
    if (target) {
      const claims = memory.memberClaims(group, target).map((claim) => claim.text);
      return { lines: claims.length ? claims : [nameOf(target, '', members) + ' 在这个群没留过能引用的战绩'] };
    }
    const list = people.slice(-6).map((id) => nameOf(id, '', members)).join('、');
    return { lines: [list ? `现在认得的：${list}。要查谁？` : '我还没认人，先@我说“我是zrc”这种。'] };
  },
});

define('开黑报名', {
  aliases: ['报名', '开黑'],
  handler: ({ sessionKey }) => {
    setSession(sessionKey, { plugin: '开黑报名', step: 1, data: {} });
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

define('暧昧', {
  aliases: ['撩'],
  perm: 'admin',
  handler: ({ group, arg }) => {
    const off = /关|off|0|停|别/.test(String(arg || ''));
    patchGroupConfig(group, { features: { flirt: !off } });
    return { lines: [off ? '行 我收着点 不撩了' : '行 那我可就不客气了'] };
  },
});

define('话题', {
  perm: 'admin',
  handler: () => ({ lines: null, triggerTopic: true }),
});

/* ---------------- 会话处理（多轮） ---------------- */

const sessions = {
  开黑报名: ({ sessionKey }, session, text) => {
    if (session.step === 1) {
      const data = { ...session.data, when: text.slice(0, 40) };
      setSession(sessionKey, { plugin: '开黑报名', step: 2, data });
      return { lines: [`记下了：${data.when}。谁跟？让他们@我报名。`] };
    }
    clearSession(sessionKey);
    return { lines: ['报名完了，别放鸽子。'] };
  },
};

export function runSession(ctx, text) {
  const s = getSession(ctx.sessionKey);
  if (!s) return null;
  const fn = sessions[s.plugin];
  if (!fn) {
    clearSession(ctx.sessionKey);
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
