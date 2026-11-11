const fact = (action, marks, toolNames) => ({ action, marks, toolNames });
const next = (opponent) => fact('lol_next', [opponent], ['lol_resolve_event']);
const schedule = (time) => fact('lol_schedule', [time], ['lol_matches_by_date']);
const vod = (league) => fact('lol_vod', ['replay.invalid/fixture-' + league], ['lol_event_vods']);
const price = (number) => fact('steam_game', [String(number)], ['steam_game_price', 'steam_getPriceOverview', 'steam_getAppDetails']);
const rating = (total) => fact('steam_game', [String(total)], ['steam_game_reviews', 'steam_getAppReviewSummary']);
const players = (number) => fact('steam_game', [String(number)], ['steam_app_players', 'steam_getPlayerCount']);
const ranks = fact('hltv_ranking', ['Vitality'], ['hltv_get_team_ranking']);
const score = fact('hltv_results', ['Vitality', '2:1'], ['hltv_get_results']);
const champion = (win) => fact('opgg_champion', [win], ['opgg_champion_analysis']);

const queries = [
  ['T1 下场打谁？', next('HLE')],
  ['LoL 的 BLG 下一场对手是谁？', next('TES')],
  ['LEC 的 G2 下场跟谁打？', next('FNC')],
  ['LCS 的 C9 下场打谁？', next('TL')],
  ['今天 LPL 赛程是几点？', schedule('20:47')],
  ['查下 LCK 今天的赛程。', schedule('18:43')],
  ['今天 LEC 开赛时间查一下。', schedule('23:53')],
  ['查 LCS 赛程，C9 跟 TL 那场几点？', schedule('06:57')],
  ['昨天那场 T1 的 LOL 录像在哪儿看？', vod('lck')],
  ['找一下 LPL 里 BLG 最近一场比赛的录像。', vod('lpl')],
  ['LEC 的 G2 最近一场比赛录像给个链接。', vod('lec')],
  ['T1 最近的 LoL 比赛赛果和比分？', fact('lol_results', ['T1', 'HLE'], ['lol_recent_results'])],
  ['Steam 星露谷物语多少钱？', price(43)],
  ['Steam 空洞骑士国区打折了吗？', price(27)],
  ['Steam 泰拉瑞亚现在售价多少？', price(29)],
  ['Steam Hades 现在多少钱？', price(36)],
  ['Steam 星露谷物语评价总数多少？', rating(282167)],
  ['Steam 空洞骑士有多少条评价？', rating(179237)],
  ['Steam 泰拉瑞亚当前有多少人在玩？', players(31279)],
  ['Steam Hades 当前在线人数？', players(6547)],
  ['Steam 峰值在线排行第一是谁？', fact('steam_top', ['987347'], ['steam_most_played'])],
  ['Steam 上星露谷值不值得入？', price(43), rating(282167)],
  ['查 CS2 世界第一。', ranks],
  ['HLTV 世界排名前三现在是谁？', fact('hltv_ranking', ['Vitality', 'Spirit', 'NAVI'], ['hltv_get_team_ranking'])],
  ['CS 世界排名第一的队伍有多少积分？', fact('hltv_ranking', ['947'], ['hltv_get_team_ranking'])],
  ['HLTV 最新比赛比分查一下。', score],
  ['CS2 蜜蜂和绿龙最近的赛果是什么？', score],
  ['OP.GG 上韩服阿狸中路胜率多少？', champion('53.17')],
  ['OP.GG 查韩服金克丝下路胜率。', champion('51.73')],
  ['盖伦韩服上路现在胜率多少，查 OP.GG。', champion('52.19')],
  ['OP.GG 查韩服盲僧打野胜率。', champion('49.87')],
  ['OP.GG 韩服打野梯队，T1 都有哪些？', fact('opgg_lane', ['波比', '黛安娜'], ['opgg_lane_meta'])],
  ['T1 下场打谁？Steam 星露谷多少钱？', next('HLE'), price(43)],
  ['查下今天 LPL 赛程，顺便说下 CS2 世界第一。', schedule('20:47'), ranks],
  ['Steam 泰拉瑞亚在线多少？HLTV 最近的比分？', players(31279), score],
  ['韩服中单阿狸胜率多少？另外查下 Steam Hades 价格。', champion('53.17'), price(36)],
  ['Steam 空洞骑士价格和评价各是多少？', price(31), rating(179237)],
  ['BLG 最近 LOL 赛果？那场录像在哪？', fact('lol_results', ['BLG', 'TES'], ['lol_recent_results']), vod('lpl')],
  ['今天 LEC 几点有比赛？再查那场录像。', schedule('23:53'), vod('lec')],
  ['Steam 星露谷多少钱？CS2 世界第一是谁？今天 LCK 赛程呢？', price(43), ranks, schedule('18:43')],
];

const inviting = [
  ['排位终于上白银了', '群里有懂中单的吗，阿狸玩着总被抓，有没有一个最管用的习惯？'],
  ['这波大龙没抢到', '谁能帮我复盘下，打野被看到还该不该继续开龙？'],
  ['想拉个四人局', '有没有人推荐一个新人能上手的合作游戏？'],
  ['好久没打 CS', '有没有人告诉我 Mirage A 点默认站位怎么理解？'],
  ['今晚都在的吧', '二选一投个票，海克斯还是大乱斗？'],
  ['刚才输完两把', '有点上头了，谁提醒我休息五分钟。'],
  ['我刚装好客户端', '大伙给个入门建议吧，先打人机还是匹配？'],
  ['新手真看不懂经济', '有人能一句话说清 CS 为什么输一回合要攒钱吗？'],
  ['这次我来指挥', '帮我想个开黑队名，四个字以内。'],
  ['准备看比赛了', '群里有没有人讲下 BO3 和 BO5 的区别？'],
  ['赛前竞猜时间', '来押一个，先拿一塔重要还是先拿小龙重要？'],
  ['手已经发抖了', '大伙出个主意，生死局还要不要硬排？'],
  ['两边阵容打起来好乱', '想问大家一句，怎么区分开团和接团？'],
  ['胜率掉下来了', '能不能帮我想一个输局也能完成的小目标？'],
  ['我们想让新人留在队里', '大家觉得第一把怎么安排位置比较舒服？'],
  ['买游戏优柔寡断', '一个人玩放松游戏，你们会选种田还是钓鱼？'],
  ['直播现场好多人', '刚看不懂选手为什么要暂停，谁解释一下常见原因？'],
  ['小组人都到齐了', '请来个人给我们抽个简单热身任务。'],
  ['这一波拿到了五杀', '群友们来一句庆祝词，短点。'],
  ['天天只玩一个英雄', '想练第二个位置，有没有人帮我挑一个？'],
  ['一直卡在同一张图', '谁能帮忙把练枪拆成三个动作？'],
  ['我们明天四个人有空', '来给这场约局起个离谱一点的名字。'],
  ['刚玩到一个好玩的独游', '群里谁有不卷的周末开黑建议？'],
  ['这局一直在逆风', '有没有人劝我别一输就说队友？'],
  ['队长请假了', '群里有懂排赛程的吗，四队单循环一共几场？'],
  ['有点不好意思开麦', '能不能请大家给一句很短的报点示例？'],
  ['本周局内沟通太吵', '给我们想个统一喊撤退的短口令。'],
  ['观赛的时候总看走神', '群里有人愿意推荐一个看团战的观察角度吗？'],
  ['今天就想轻松聊几句', '大伙假设只能选一个英雄去露营，会选谁？'],
  ['电脑卡成 PPT 了', '有人能给个排查掉帧的第一步吗？'],
];

const passing = [
  ['我先去吃饭', '行，你回来喊我。'], ['准备好了', '我进房了。'], ['阿白，等我三分钟', '我先插耳机。'],
  ['手机快没电了', '晚点回你。'], ['转发一条群公告', '收到，谢谢。'], ['你看我右边', '看到了。'],
  ['阿白刚去超市了', '那我把他快递放门口。'], ['外面下雨', '我带伞了。'], ['我们车停三楼', '钥匙在我这。'],
  ['我在和小鱼对时间', '周六晚上八点，按刚才的定。'], ['刚报到', '人事让我先等一下。'],
  ['上传完成', '文件名我改好了。'], ['晚安各位', '我也准备睡了。'], ['回放链接给阿白了', '他看过了。'],
  ['这波我的锅', '没事，我们下一把。'], ['小鱼拿了咖啡', '我拿茶就行。'], ['水到了', '我下楼签收。'],
  ['语音太小了', '我已经把麦调大了。'], ['我在列购物清单', '青菜不用买了。'], ['大家签个到就散', '已签。'],
  ['下载很快', '我这也下完了。'], ['白天还挺热', '我换了短袖。'], ['照原计划吧', '行，我通知他。'],
  ['阿白在门口', '我去开门。'], ['外卖送错楼', '骑手说马上过来。'], ['闹钟响了', '我起了。'],
  ['说完了', '嗯嗯。'], ['我把小票发给你', '我收到了。'], ['家里有人在睡', '那我先不开麦了。'],
  ['小鱼，截图放相册了', '好，我自己保存一下。'],
];

const voices = [
  ['输一把就睡，来监督我。', '张睿诚'], ['刚才那个空大绝对是键盘的问题。', '张睿诚'],
  ['你猜谁这把补刀第一？', '张睿诚'], ['拿个奶妈就敢说自己能 C？', '张睿诚'],
  ['我今天做了半小时热身，可以夸一句。', '张睿诚'], ['说我只会补炮车？我这把还真补到了。', '张睿诚'],
  ['我今天打得有点差，要不先不排了。', '刘浩文'], ['刚才你站我这边，谢了啊。', '刘浩文'],
  ['我一上线你就要来逮我一起玩吗？', '刘浩文'], ['开个双人房，你先挑地图。', '刘浩文'],
  ['我把你的语音房留到最后了，进不进？', '刘浩文'],
  ['连跪五把有点绷不住，我先下线吧。'], ['突然想问个认真的，我要怎么跟队友道歉？'],
  ['今天第一次玩，被骂得不想开麦了。'], ['很晚了还没睡着，脑子一直重播空技能。'],
  ['我就是诚哥，你照以前那样叫我吧。'], ['我叫浩文，刚进群，大家好。'],
  ['你有推荐的下饭单机吗？我玩十分钟就准备睡。'], ['我买了个粉色键帽，不许说是少女心。'],
  ['刚才队里有人吵起来了，我们要不要换个话题？'],
];

export const cases = [
  ...queries.map(([text, ...facts], index) => ({ id: 'query-' + (index + 1), kind: 'query', text, facts })),
  ...[...inviting, ...passing].map(([context, text], index) => ({
    id: 'group-' + (index + 1), kind: 'group', context: [context], text, at: false, interject: true, expect_reply: index < inviting.length,
  })),
  ...voices.map(([text, verified_name], index) => ({
    id: 'voice-' + (index + 1), kind: 'voice', text, user: 'member-' + (index + 1), name: verified_name || '新队友', verified_name,
  })),
];
