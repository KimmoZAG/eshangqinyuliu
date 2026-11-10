/**
 * 绑定管理 CLI（本机执行，不走 QQ）
 *
 *   node --env-file=.env bind.mjs add 张睿诚 123456789     # 生成一次性码
 *   node --env-file=.env bind.mjs add kxl                 # 不给 QQ 号也行
 *   node --env-file=.env bind.mjs list                    # 未使用的码
 *   node --env-file=.env bind.mjs all                     # 含已使用
 *   node --env-file=.env bind.mjs revoke ZRC-ABCDE
 *   node --env-file=.env bind.mjs who                     # 已认出的人
 */
import { createCode, listCodes, revoke, boundPeople, unknownSpeakers } from './src/bindings.mjs';
import { readMembers, saveAlias } from './src/members.mjs';
import { ALIASES } from './persona.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function print(rows) {
  if (!rows.length) {
    console.log('（空）');
    return;
  }
  for (const r of rows) {
    const state = r.usedAt ? `已用 ${r.usedAt.slice(0, 16)}` : `有效期至 ${r.expireAt.slice(0, 16)}`;
    console.log(`${r.code.padEnd(10)} ${String(r.name).padEnd(8)} ${r.qq || '-'.padEnd(12)}  ${state}`);
  }
}

switch (cmd) {
  case 'add': {
    const name = rest[0];
    const qq = rest[1] || '';
    const r = createCode({ name, qq });
    console.log(`\n给「${r.name}」${r.qq ? `（QQ ${r.qq}）` : ''} 的绑定码：\n`);
    console.log(`    ${r.code}\n`);
    console.log(`让对方在群里 @我 说：绑定 ${r.code}`);
    console.log(`有效期 ${r.expireAt.slice(0, 16)}，一次性。\n`);
    break;
  }
  case 'list':
    print(listCodes());
    break;
  case 'all':
    print(listCodes({ includeUsed: true }));
    break;
  case 'revoke':
    console.log(revoke(rest[0]) ? '已删除' : '没这个码');
    break;
  case 'map': {
    const [prefix, name] = rest;
    if (!prefix || !name) {
      console.log('用法：node bind.mjs map <openid前缀> <名字>');
      break;
    }
    const hits = [...readMembers().keys()].filter((id) => id.startsWith(prefix));
    if (hits.length === 0 && prefix.length >= 8) {
      // 允许直接给完整 openid（比如从旧库里捞出来的，profiles 里还没记录）
      saveAlias(prefix, name);
      console.log(`已写入绑定表 ${prefix} -> ${name}（未在历史里出现过，按完整 openid 记录）`);
      break;
    }
    if (hits.length !== 1) {
      console.log(hits.length ? `前缀不唯一，命中 ${hits.length} 个：\n${hits.join('\n')}` : '没这个 openid');
      break;
    }
    saveAlias(hits[0], name);
    console.log(`已写入绑定表 ${hits[0]} -> ${name}`);
    break;
  }
  case 'unknown': {
    const rows = unknownSpeakers({ limit: 20 });
    if (!rows.length) {
      console.log('没有待认的人，都绑好了');
      break;
    }
    console.log('还没绑定的发言人（按最近发言排序）：\n');
    for (const r of rows) {
      const t = String(r.firstText).replace(/\s+/g, ' ').slice(0, 42);
      console.log(`${r.nick.padEnd(16)} ${r.openid.slice(0, 16)}  ${String(r.count).padStart(3)} 条  「${t}」`);
    }
    const boundNames = new Set(boundPeople().map((x) => x.name));
    const missing = [...new Set(Object.values(ALIASES))].filter((n) => !boundNames.has(n));
    if (missing.length) console.log(`\n名单里还没出现的：${missing.join('、')}`);
    console.log('\n绑定：node bind.mjs map <openid前16位> <名字>');
    break;
  }
  case 'who': {
    const rows = boundPeople();
    if (!rows.length) console.log('还没人绑定');
    for (const r of rows) console.log(`${r.name.padEnd(8)} ${r.openid}`);
    break;
  }
  default:
    console.log('用法：node bind.mjs add <名字> [QQ号] | list | all | revoke <码> | who');
}
