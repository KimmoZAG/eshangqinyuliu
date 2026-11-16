# 架构说明

本文描述**当前线上真实运行**的架构。仓库里还保留着旧的 Node 实现（`bot.mjs` + `src/`），它现在只作为回滚路径存在，不参与线上。

## 1. 总览

```
QQ 群 / 私聊
   │  WebSocket（收） / HTTPS OpenAPI（发）
   ▼
┌─ MaiBot v1.4.3（Python 3.12，uv 隔离环境）────────────────┐
│  qq_official_adapter   协议、鉴权、事件解码、富媒体上传    │
│  maisaka               planner（决策）/ replyer（成稿）   │
│  A_Memorix             记忆存储与稀疏检索（fts5）          │
│                                                           │
│  ┌─ jinhua.chat 插件（业务核心，maibot/jinhua/）───────┐  │
│  │  身份判定 / 点名识别 / 群策略 / 输出协议 / 表情 / 命令 │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────┬────────────────────────────────┘
                            │ stdio MCP
                            ▼
                 jinhua-mcp.mjs（Node 工具桥）
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   lol / steam 适配器    hltv（Python MCP）   search（HTTP）
```

## 2. 分层职责

| 层 | 代码位置 | 职责 |
|---|---|---|
| 编排 | `maibot.mjs` | 校验上游 commit、幂等打补丁、同步插件、启动宿主 |
| 协议 | `data/maibot/node_modules/maibot-upstream/src/plugins/built_in/qq_official_adapter/` | WS 生命周期、事件解码、发送、富媒体上传 |
| 对话引擎 | 同上 `src/maisaka/` | planner 决策、replyer 成稿、上下文拼装 |
| 业务插件 | `maibot/jinhua/{plugin,state,turn}.py` | 全部业务策略 |
| 工具 | `jinhua-mcp.mjs` + `src/tools*.mjs` | 数据查询，按域注入 |
| 旧版 | `bot.mjs` + `src/` | 回滚用，不参与线上 |

## 3. 插件挂载的钩子

| 钩子 | 作用 |
|---|---|
| `chat.receive.after_process` | 解析身份、判定「是否在叫我」、登记回合、启动兜底计时 |
| `maisaka.planner.before_request` | 按域放行工具、注入判定提示、被点名时禁止沉默 |
| `maisaka.planner.after_response` | 过滤工具调用、剥离表情附件、记录决策 |
| `maisaka.replyer.before_request` | 注入人设补充、成员名单、输出协议、表情标签 |
| `maisaka.reply.before_post_process` | 成稿前兜底文案、关闭上游自动分条 |
| `send_service.before_send` | 超时判定、条数上限、emoji 清洗、计划解析、口癖抑制 |
| `send_service.after_send` | 记录回执、补发计划里剩余的句子 |

每个钩子都必须对测试桩容错（`getattr`/`try`），否则单测会直接红。

## 4. 一条 @ 消息的完整链路

```
1. WS 事件 → adapter 解码，@ 变成独立 at 段，正文只剩「你人呢」
2. plugin.receive
     · 判定点名（at 段 / <@openid> / 正文以金桦开头 / 第二人称抱怨 / is_mentioned）
     · 登记 Turn（anchor=消息ID，received_ms，explicit）
     · 2 秒内有更新的 @ → 旧回合标 handled（合并窗口）
     · 被点名 → arm_watchdog(20s)
3. maisaka.planner（第一次模型调用：要不要回、要不要查工具）
     · 我们按 domain 注入工具白名单
     · 被点名时从 allowed 里删掉 no_action，逼迫回复
4. maisaka.replyer（第二次模型调用：只输出计划）
     · 输出协议：EMOJI / TEXT 行
5. plugin.before_send
     · 解析计划（容错：JSON、多行、压成一行、全角冒号都能解）
     · 口癖抑制（同短语 20 分钟内最多 2 次；非游戏语境禁「上号」）
     · 概率闸门决定是否配图（JINHUA_EMOJI_P，默认 0.45）
     · 第一条 TEXT 改写成当前消息本体，其余进 _pending_lines
6. adapter 发送（msg_type 0/2/7）
7. plugin.after_send
     · 标记 handled、记录最近出站时间
     · 用会话锁逐条补发剩余句子
```

**关键约束**：`before_send` 里**绝不能 abort**。abort 会让上游认为「reply 未生成可见消息」而重新排一轮，表现为无限循环、看起来像卡死。

## 5. 并发模型

四个状态全部按**消息锚点**或**会话**隔离，不再有单槽覆盖：

| 状态 | 键 | 作用 |
|---|---|---|
| `_inbound` | anchor | 补发时作为被动回复锚点 |
| `_pending_lines` | anchor | 计划里剩余的句子 |
| `_send_locks` | session | 保证同一回合的图 + 多句成组发出 |
| `_phrase_hits` | session | 口癖计数窗口 |

兜底（`can_fallback`）四条抑制条件，任一命中就不补话：

```
turn 已 handled / 已兜过
5 秒内该会话有出站
不是该会话最新回合
60 秒内兜过底
```

合并窗口 `JINHUA_MERGE_WINDOW_MS`（默认 2000）：短时间多条 @ 由最后一条统一回答。

## 6. 输出协议

replyer 只输出：

```
EMOJI: 标签名（不配就写 -）
TEXT: 第一句
TEXT: 第二句（可选）
```

解析规则（`parse_plan`）：

- 优先按 `EMOJI:` / `TEXT:` 标记切分，不依赖换行（上游会把换行压成空格）
- 兼容全角冒号、代码块包裹、以及模型偶发的 JSON
- 最多取 3 条，每条压成单行
- 解析失败时抽取 `TEXT:` 行或引号内短句，仍失败则回一句固定话术，**绝不把原始结构发给用户**

## 7. 数据与存储

| 路径 | 内容 |
|---|---|
| `instance/data/plugins/jinhua.chat/state.json` | 群策略、绑定、词条 |
| `instance/data/plugins/jinhua.chat/images/` | 表情素材（文件名即标签） |
| `instance/data/plugins/jinhua.chat/health.json` | 兜底/超时/口癖等计数器 |
| `instance/data/MaiBot.db` | 消息库、LLM 用量、统计 |
| `instance/logs/*.jsonl` | DEBUG 级结构化日志（排障主入口） |
| `instance/logs/maisaka_prompt/` | 每次请求的 prompt 快照（排查注入问题） |

## 8. 与平台的关系

- 群/私聊的被动回复窗口：群 5 分钟 / 5 次，私聊 60 分钟 / 4 次
- 主动消息：每群 20 qpm、每天 1000 条
- **富媒体消息的 `content` 必须为空字符串**，否则图片下方会出现空行（已在 `maibot/upstream.patch` 里修正）
- 系统表情（`<emoji:id>`、CQ 码、face 段）在群/私聊接口**不存在**，表情只能发图片
