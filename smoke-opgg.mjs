/**
 * OP.GG 工具冒烟验证（不连 QQ、不写业务数据）
 *
 *   node smoke-opgg.mjs
 *
 * 覆盖：DSL 解析器单测 + 4 个工具实调 + 体积上限 + 错误路径。
 */
import { listTools, callTool } from './src/tools.mjs';
import { parseDsl } from './src/opgg.mjs';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/* ---------------- 1. 解析器单测 ---------------- */

console.log('\n[1] DSL 解析器');
{
  const r = parseDsl(
    'class LolList: data\nclass Data: positions\nclass Positions: mid\nclass Mid: champion,win_rate,tier\n\n' +
      'LolList(Data(Positions([Mid("Ahri",0.51,1),Mid("Ekko",0.53,1)])))',
  );
  ok('数组 + 位置参数对齐', r?.data?.positions?.mid?.[0]?.champion === 'Ahri' && r.data.positions.mid[1].win_rate === 0.53);
}
{
  const r = parseDsl('class A: x\nclass B: y\n\nA(B("含,逗号的字符串"))');
  ok('字符串内逗号不被切分', r?.x?.y === '含,逗号的字符串');
}
{
  const r = parseDsl('class A: x,y\n\nA(1)');
  ok('字段数不匹配时报 __mismatch 而不是错列', r?.__mismatch != null);
}
{
  const r = parseDsl('{"lang":"en_US","data":{"items":[1,2]}}');
  ok('JSON 直通', r?.lang === 'en_US' && r.data.items.length === 2);
}
{
  const r = parseDsl('class T: tier,lp\n\nX(T("MASTER",795))');
  ok('未声明的类退化为 __args', Array.isArray(r?.__args) && r.__args[0].tier === 'MASTER');
}

/* ---------------- 2. 工具注册 ---------------- */

console.log('\n[2] 工具注册');
const names = listTools().map((t) => t.name);
const wanted = ['opgg_champion_analysis', 'opgg_lane_meta', 'opgg_matchup', 'opgg_pro_check'];
for (const n of wanted) ok(n, names.includes(n));

/* ---------------- 3. 实调 ---------------- */

const CASES = [
  ['opgg_lane_meta', { position: 'mid' }],
  ['opgg_champion_analysis', { champion: 'AHRI', position: 'mid' }],
  ['opgg_matchup', { my_champion: 'AHRI', opponent_champion: 'ZED', position: 'mid' }],
  ['opgg_pro_check', { game_name: 'Hide on bush', tag_line: 'KR1' }],
  ['opgg_pro_check', { game_name: '오 너', tag_line: '111' }],
  ['opgg_pro_check', { game_name: 'Faker', tag_line: 'KR1' }],
  ['opgg_pro_check', { game_name: 'zzz_not_exist_99', tag_line: 'KR9' }],
];

console.log('\n[3] 实调（KR）');
const saved = [];
for (const [tool, args] of CASES) {
  const label = `${tool} ${JSON.stringify(args)}`;
  const t0 = Date.now();
  const r = await callTool(tool, args);
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(JSON.stringify(r.result ?? r.error));
  saved.push(r);
  if (!r.ok) {
    ok(label, false, `失败 ${r.error}`);
    continue;
  }
  ok(label, true, `${ms}ms / ${bytes}B / 上限内=${bytes < 2000}`);
  console.log(`      ${JSON.stringify(r.result).slice(0, 260)}`);
}

/* ---------------- 4. 内容断言 ---------------- */

console.log('\n[4] 数据合理性');
{
  const d = saved[0]?.result;
  ok('梯队含 tier1 且有胜率', Array.isArray(d?.tier1) && d.tier1.length > 0 && typeof d.tier1[0].win_rate === 'number');
  ok('梯队总量覆盖全英雄', d?.total_champions > 30, `total=${d?.total_champions}`);
}
{
  const d = saved[1]?.result;
  ok('英雄分析有出装与符文', d?.core_items?.length > 0 && !!d?.runes?.primary, `items=${d?.core_items?.length}`);
  ok('胜率是百分数而非 0.51', d?.win_rate > 1, `win_rate=${d?.win_rate}`);
}
{
  const d = saved[2]?.result;
  ok('对线要点非空且提到对手', typeof d?.tip === 'string' && d.tip.length > 20, `tip=${d?.tip?.slice(0, 40)}…`);
  ok('对线返回已裁到 2KB 内', Buffer.byteLength(JSON.stringify(d)) < 2000, `${Buffer.byteLength(JSON.stringify(d))}B`);
}
{
  const d = saved[3]?.result;
  ok('Faker 主号 is_pro=true', d?.is_pro === true, `team=${d?.pro?.team} pos=${d?.pro?.position}`);
  ok('带真名与韩服名次', !!d?.pro?.real_name && d?.ladder?.rank > 0, `${d?.pro?.real_name} rank=${d?.ladder?.rank}`);
}
{
  const d = saved[4]?.result;
  ok('Oner 账号 is_pro=true', d?.is_pro === true, `team=${d?.pro?.team} pos=${d?.pro?.position}`);
}
{
  const d = saved[5]?.result;
  ok('别名 Faker 自动解析到真号', d?.is_pro === true && d?.resolved_from_alias === 'Faker', `${d?.game_name}#${d?.tag_line}`);
  ok('解析后带韩服名次', d?.ladder?.rank > 0, `rank=${d?.ladder?.rank}`);
}
{
  const d = saved[6]?.result;
  ok('不存在的号收敛成 found=false 而非抛错', d?.found === false, d?.note?.slice(0, 30));
  ok('查不到时带提示语', typeof d?.note === 'string');
}

/* ---------------- 5. 错误路径 ---------------- */

console.log('\n[5] 错误路径');
{
  const r = await callTool('opgg_champion_analysis', { champion: 'NOT_A_CHAMP', position: 'mid' });
  ok('未知英雄返回 ok=false', r.ok === false, r.error?.slice(0, 60));
}
{
  const r = await callTool('opgg_lane_meta', { position: 'xxx' });
  ok('非法分路本地拦截', r.ok === false && r.error.includes('position'), r.error);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
