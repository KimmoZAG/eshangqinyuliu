# 人设与说话风格

## 1. 人设在哪

唯一真源：

```
maibot/jinhua/persona.json
```

字段与去向：

| 字段 | 写进哪里 | 作用 |
|---|---|---|
| `personality` | `bot_config [personality] personality` | 身份、语气、生活面 |
| `behavior_style` | `bot_config [personality] behavior_style` | 行为准则、情绪反应、敏感话题处理 |
| `reply_style` | `bot_config [personality] reply_style` | 句式、禁词、颜文字 |
| `group_chat_prompt` | `bot_config [chat.reply_style] group_chat_prompt` | 群聊节奏与称呼 |
| `private_chat_prompts` | `bot_config [chat.reply_style] private_chat_prompts` | 私聊策略 |
| `name` / `multiple_probability` | 人设库元数据 | WebUI 展示与风格轮换 |

同步机制：`configure.py` 计算 `persona.json` 的 sha1，与 `plugin config.toml` 里的 `persona_sha` 比对，不一致才写入。因此：

- 改 `persona.json` → 重启自动生效
- WebUI 手改人设 → 只要 `persona.json` 没变，不会被覆盖
- 想强制覆盖 → 删掉 `persona_sha` 字段再 configure

## 2. 当前风格定位

“二十一岁、游戏群里的女生”，三条硬约束：

```
句子短：一句 6~15 字，最多三条
有语气：呀 / 啊 / 吧 / 嘛 / 呗 / 欸 / 啦；情绪上来「！！」或「？？」
有生活：游戏之外还聊吃的、八卦、审美、感情、追剧
```

禁止项（写进 reply_style）：

```
书面词（此外、因此、建议、需要注意）
解释自己在做什么
复述对方原话
「上号/开黑」当口头禅
```

## 3. 与其他 prompt 的分工

人设**只管怎么说话**，不管事实。事实类约束在插件里：

| 关注点 | 归属 |
|---|---|
| 语气、称呼、情绪反应 | `persona.json` |
| 输出协议（EMOJI/TEXT） | `plugin.py` 的 replyer 提示词 |
| 证据规则（赛果/身份不许编） | `plugin.py` 的 planner 提示词 |
| 表情标签与概率 | `plugin.py` + `JINHUA_EMOJI_P` |
| 口癖抑制 | `plugin.py` 的 `tame_lines` |

改人设时不要把证据规则搬进去，否则会和工具提示打架。

## 4. 改人设的标准流程

```bash
# 1. 改 persona.json
# 2. 用真实模型跑 A/B，不急着上线
node --env-file=.env maibot/style-test.mjs both   # 新旧对比
node --env-file=.env maibot/style-test.mjs new    # 只看新版

# 3. 满意后重启
./stop.sh && ./start.sh

# 4. 确认已同步
grep "人设已同步" logs/maibot-live.log | tail -1
```

`style-test.mjs` 直接读 `persona.json`，场景定义在文件里的 `SCENARIOS`，加场景只要加对象。

## 5. 已知干扰源

MaiBot 有一个“表达方式学习”机制，会往 prompt 里注入学到的句式（历史上出现过 `yysy` / `快进到` / `没绷住` 这类偏贴吧的口吻）。它与萌妹风格冲突。

- 触发条件：本地表达库有候选时注入，日志会出现 `[表达方式选择]`
- 处理：优先关掉该机制，而不是在人设里对抗

## 6. 验收指标

抽 20 条真实回复人工检查：

| 指标 | 目标 |
|---|---|
| 「上号」出现率 | < 8% |
| 平均句长 | < 16 字 |
| 非游戏话题能给出观点 | ≥ 70% 场景 |
| 解释型句式（因为…所以…） | < 10% |

数据可从 `MaiBot.db` 的 `mai_messages` 表按 `user_id` 过滤机器人发言后统计。

## 7. 敏感话题

原则：**短表态、不展开、不辩护、转话题**。

```
违法 / 伤害他人：一句话否决，不描述细节
他人隐私：不猜、不传，直接说不知道
群友互骂：只评游戏表现，不上升人身
```

人设里已写入：「碰到违法或伤害别人的事，一句话表态就够，不展开细节，不替人辩护，然后转话题。」
