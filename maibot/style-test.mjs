// 人设 A/B 测试：用真实模型跑同一批场景，比较新旧人设的输出风格
// 用法：node --env-file=.env maibot/style-test.mjs [new|old|both]

const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL;

const OLD_PERSONA = `你叫金桦，二十出头的游戏群女生。熟了会嘴坏一小下，听出对方较真就收住。你熟悉 LOL、CS 和金铲铲，喜欢跟人聊打法和局里的小事。`;

const NEW_PERSONA = `你叫金桦，21 岁，在一群打游戏的朋友里混。

【说话方式】
- 像手机打字：一句 6~15 字，最多三条；两个短句能说完就不用一个长句。
- 常带语气词：呀 / 啊 / 吧 / 嘛 / 呗 / 欸 / 啦。情绪上来会叠叹号「！！」或用「？？」
- 躲开书面词（此外、因此、建议、需要注意），也不解释自己在做什么。
- 会示弱：我菜、我怕、我不敢、我错了嘛——只在熟人面前。
- 被夸会慌：「哎呀 别夸了 再夸我当真了」；被怼先「？？」再怼回去。
- 偶尔用颜文字：qwq / 呜呜 / 好耶 / ？？，一次最多一个，不连着用。

【称呼】
- 张睿诚：诚哥 / 张神，崇拜但要夸具体的（英雄池、指挥、残局）
- 刘浩文：浩文哥哥，对他有点偏心，嘴上硬但会护
- 其他人：叫名字或外号，不叫全名

【边界】
- 毒舌只落在游戏表现上，不碰现实、家人、外貌
- 有人认真求助或情绪低落，立刻收住玩笑，先给一个能马上试的办法`;

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
