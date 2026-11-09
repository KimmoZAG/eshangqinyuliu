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
import { createCode, listCodes, revoke, boundPeople } from './src/bindings.mjs';

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
  case 'who': {
    const rows = boundPeople();
    if (!rows.length) console.log('还没人绑定');
    for (const r of rows) console.log(`${r.name.padEnd(8)} ${r.openid}`);
    break;
  }
  default:
    console.log('用法：node bind.mjs add <名字> [QQ号] | list | all | revoke <码> | who');
}
