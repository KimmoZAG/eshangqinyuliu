const QUESTION = /[?？]|吗|么$|呢$|没$|多少|几比几|几(?:点|场|号|名|个|天|月)|谁|哪|什么|怎么|为何|为啥|多久|有没有|是不是|能不能|可不可以|查一下|查下|帮我查|搜一下/;
const CONTINUATION = /^(?:然后呢|还有呢|那场|那把|这场|这把|这个|那个|比分呢|录像呢|赛果呢|多少钱|谁赢了|几比几|几点开|哪里看)/;
const LOOKUP = /谁赢|几比几|比分|赛果|赛程|直播|决赛|录像|门票|开场演出|折扣|打折|多少钱|价格|在线(?:人数|多少|最多)|排行榜|世界第[一\d]|世界排名|胜率|出场率|出装|符文|梯队|上架|发售|版本更新|最新|官宣|数据|新闻|真的假的|查(?:一下|下)|搜(?:一下|下)|(?:今天|明天|昨天|现在|最近).{0,10}(?:比赛|开赛)|比赛.{0,8}(?:几|哪|打不打)/;
const RULES = {
  hltv: [
    [/\b(?:cs2?|csgo|hltv|iem|blast)\b|反恐精英/i, 7],
    [/major|rating|卡托维兹/i, 3],
  ],
  lol: [
    [/\b(?:lol|lpl|lck|lec|lcs|msi|worlds)\b|英雄联盟|s赛|世界赛|季中赛/i, 7],
    [/赛程|赛果|小组赛|季后赛|决赛|比分|录像|vod/i, 2],
  ],
  steam: [
    [/\bsteam\b|蒸汽平台/i, 7],
    [/打折|折扣|价格|在线人数|发售|入库/, 2],
  ],
  opgg: [
    [/韩服|op\.?gg/i, 7],
    [/胜率|出场率|ban率|出装|符文|梯队/i, 2],
  ],
  search: [
    [/开场演出|转播平台|门票|新闻|热搜|最新消息|传闻|官宣|真的假的|版本更新/, 8],
    [/销量|同比|环比|产量|统计局/, 3],
  ],
};

export function splitQuestions(text) {
  const questions = [];
  const clauses = String(text || '').match(/[^。！？!?；;\r\n]+[？?]?/g) || [];
  for (const clause of clauses) {
    const parts = clause.split(/[，,、]|(?:顺便|另外|再问(?:一句)?|以及|同时|还有(?=.{2})|和(?=(?:现在|当前|今天|明天|昨天|多少钱|多少人|哪里|几比几|谁)))/);
    let pending = '';
    for (const part of parts) {
      if (!part.trim()) continue;
      if (QUESTION.test(pending) || LOOKUP.test(pending) && LOOKUP.test(part)) {
        questions.push(pending);
        pending = '';
      }
      pending += (pending ? '，' : '') + part.trim();
    }
    if (QUESTION.test(pending) || LOOKUP.test(pending)) questions.push(pending);
  }
  return questions.map((q) => q.replace(/[？?]+$/, '').trim()).filter(Boolean);
}

export function inferDomain(text) {
  const scores = Object.entries(RULES)
    .map(([domain, rules]) => ({ domain, score: rules.reduce((sum, [re, weight]) => sum + (re.test(text) ? weight : 0), 0) }))
    .filter((route) => route.score > 0)
    .sort((a, b) => b.score - a.score);
  return scores[0]?.score === scores[1]?.score ? null : scores[0] || null;
}

export function needsSemanticSplit(text, questions) {
  if (questions.length !== 1 || !questions[0].lookup) return false;
  const strongDomains = Object.values(RULES).filter((rules) => rules.some(([pattern, score]) => score >= 7 && pattern.test(text)));
  return strongDomains.length > 1 && /(?:吗|没|谁|哪|多少|有没有|打不打).+(?:吗|没|谁|哪|多少|有没有|打不打)/.test(text);
}

export function questionsOf(text, parts = splitQuestions(text)) {
  let previousDomain = null;
  return (parts.length ? parts : [text]).map((question, index) => {
    const route = inferDomain(question);
    const dependsOn = index > 0 && /^(?:它|他(?:们)?的|胜者|赢家|赢的那(?:队|个)|这场|那场|几比几|比分呢|录像呢|哪里看|几点开)/.test(question)
      ? 'q' + index : null;
    const lookup = LOOKUP.test(question) || !!dependsOn && QUESTION.test(question)
      || !!route && /(?:有|打|播|赛|赢|排名|哪队|哪支|哪一队|多少|最低|最便宜|最热|最受欢迎|评价|好评|哪天|在哪|何时|第几|第[一二三]|何人|职业|版本|赛区)/.test(question);
    const related = CONTINUATION.test(question) || !route && lookup && index > 0;
    const domain = route?.score >= 7 ? route.domain : (related && previousDomain) || route?.domain || null;
    previousDomain = lookup ? domain : previousDomain;
    return {
      id: 'q' + (index + 1),
      text: question,
      domain: lookup ? domain : null,
      lookup,
      resolve: related && (!route || route.score < 7),
      dependsOn,
    };
  });
}

export function parseReplyMode(text, fallback = 'auto') {
  const match = String(text || '').match(/^\/(深想|快答|自动)(?=\s|[：:]|$)[\s：:]*/u);
  return {
    mode: match ? { 深想: 'deep', 快答: 'fast', 自动: 'auto' }[match[1]]
      : ['auto', 'fast', 'deep'].includes(fallback) ? fallback : 'auto',
    text: match ? text.slice(match[0].length).trim() : String(text || '').trim(),
    explicit: !!match,
  };
}
