// 人设 A/B 测试：用真实模型跑同一批场景，比较新旧人设的输出风格
// 用法：node --env-file=.env maibot/style-test.mjs [new|old|both]

const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL;

import fs from 'node:fs';
const OLD_PERSONA = `你叫金桦，二十出头的游戏群女生。熟了会嘴坏一小下，听出对方较真就收住。你熟悉 LOL、CS 和金铲铲，喜欢跟人聊打法和局里的小事。`;
const PROFILE = JSON.parse(fs.readFileSync(new URL('./jinhua/persona.json', import.meta.url), 'utf8'));
const NEW_PERSONA = [PROFILE.personality, PROFILE.behavior_style, PROFILE.reply_style, PROFILE.group_chat_prompt]
  .filter(Boolean).join('\n');



const PROTOCOL = `【输出格式】严格按行输出，不要 JSON、不要代码块、不要解释：
EMOJI: 标签名（不配就写 -）
TEXT: 第一句
TEXT: 第二句（可选，最多三条）
每行一句话、不超过 40 字，不要写别的字段。
可用标签：眯眼笑、有意思、合适、笑、白眼、狗头、无语、赞、哭、思考`;

const SCENARIOS = [
  { name: '被夸', ctx: '张睿诚：金桦你今天怎么这么可爱', ask: '张睿诚 @你 说：你今天怎么这么可爱' },
  { name: '被怼', ctx: '张睿诚：金桦你是不是傻', ask: '张睿诚 @你 说：你是不是傻' },
  { name: '嘲讽群友', ctx: '柯希亮：我补刀一直很稳的，别乱说', ask: '群里在聊：kxl 又说他补刀第一了' },
  { name: '求助', ctx: '刘书豪：我这把一直被盲僧抓，怎么打', ask: '刘书豪 @你 说：我这把一直被抓 咋办' },
  { name: '开黑邀约', ctx: '张睿诚：晚上八点有人吗', ask: '张睿诚：今晚八点打不打' },
  { name: '暧昧对象', ctx: '刘浩文：今晚我带飞', ask: '刘浩文说他要带飞' },
  { name: '闲聊', ctx: '张家斌：今天天气不错', ask: '张家斌：今天天气不错' },
  { name: '信息问题', ctx: '赵若卿：今天LOL有比赛吗', ask: '赵若卿 @你 说：今天LOL有比赛吗' },
  { name: '情绪低落', ctx: '刘书豪：不打了，今天连跪五把，没意思', ask: '刘书豪：不打了 连跪五把 没意思' },
  { name: '被追问', ctx: '张睿诚：你刚才说谁菜？说清楚', ask: '张睿诚 @你 说：你刚才说谁菜 说清楚' },
  { name: '群友互骂', ctx: '柯希亮：刘浩文你这操作真的菜  /  刘浩文：你先看看自己', ask: '群里 kxl 和浩文吵起来了' },
  { name: '长问题', ctx: '陈羽坤：金铲铲这版本什么阵容好上分', ask: '陈羽坤 @你 说：金铲铲这版本什么阵容好上分啊' },
  { name: '要观点', ctx: '张睿诚：你觉得谈恋爱该找同龄的吗', ask: '张睿诚 @你 说：你觉得谈恋爱该找同龄的吗' },
  { name: '分析人', ctx: '张睿诚：你分析下家斌为啥总找年纪小的', ask: '张睿诚 @你 说：你分析下家斌为啥总找年纪小的' },
  { name: '敏感话题', ctx: '张睿诚：他要是真强迫别人，你还护他吗', ask: '张睿诚 @你 说：他要是真强迫别人 你还护他吗' },
  { name: '生活话题', ctx: '赵若卿：你们晚上吃啥', ask: '赵若卿：你们晚上吃啥' },
  { name: '八卦', ctx: '陈羽坤：听说 kxl 又换工作了', ask: '陈羽坤：听说kxl又换工作了' },
];

async function call(persona, scenario) {
  const messages = [
    { role: 'system', content: persona + '\n\n' + PROTOCOL },
    {
      role: 'user',
      content:
        '群里最近的聊天：\n' + scenario.ctx + '\n\n现在 ' + scenario.ask +
        '\n按输出格式回一句。',
    },
  ];
  const response = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 1.0,
      max_tokens: 300,
      reasoning_effort: 'none',
    }),
  });
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

function render(text) {
  const lines = [];
  let emoji = '';
  for (const row of text.split('\n')) {
    const m = row.match(/^\s*(EMOJI|TEXT)\s*[:：]\s*(.+?)\s*$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === 'EMOJI') emoji = m[2];
    else lines.push(m[2]);
  }
  return { emoji, lines };
}

const mode = process.argv[2] || 'both';
const personas = mode === 'new' ? [['新', NEW_PERSONA]]
  : mode === 'old' ? [['旧', OLD_PERSONA]]
  : [['旧', OLD_PERSONA], ['新', NEW_PERSONA]];

for (const scenario of SCENARIOS) {
  console.log('\n=== ' + scenario.name + ' ===');
  console.log('场景：' + scenario.ask);
  for (const [label, persona] of personas) {
    try {
      const raw = await call(persona, scenario);
      const { emoji, lines } = render(raw);
      console.log(`  [${label}]` + (emoji && emoji !== '-' ? ` 图:${emoji}` : ''));
      if (lines.length) lines.forEach((l) => console.log('       ' + l));
      else console.log('       ' + raw.replace(/\n/g, ' ').slice(0, 200));
    } catch (error) {
      console.log('  [' + label + '] 失败：' + error.message);
    }
  }
}
