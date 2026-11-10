# eshangqinyuliu

QQ 群聊机器人「金桦」：接入 QQ 机器人开放平台 v2（WebSocket 事件 + OpenAPI 发送），带人设、按天滑动的群记忆、命令插件、6 小时定时话题与工具调用。

## 特性

- **事件驱动**：WebSocket 长连接，事件归一化为 `message / notice / request / meta` 四类，断线自动 resume 补发
- **三条发声通道**：被动应答（@）、主动插话（三道闸门 + 概率采样）、定时话题（6h 周期必发，可接 MCP 检索）
- **记忆分层**：按会话隔离近期消息、带来源的事件卡和互动状态；发送确认后才记录机器人发言
- **命令插件**：`/帮助`、`/战绩`、`/开黑报名`、`/话题`、`/闭嘴`、`/说话`，带权限与冷却
- **发送队列**：每回合 ≤5 条、条间 1.2s、每群 20qpm；@ 和私聊优先，主动消息失败退避重试
- **零第三方依赖**：只用 Node 22 内置 `fetch` / `WebSocket` / `child_process`

## 目录

```
bot.mjs                入口（装配）
src/
  core.mjs             配置 / 日志 / trace / metrics
  transport.mjs        QQ 协议：WS 生命周期 + 事件归一化 + 发送
  outbox.mjs           发送队列与限流
  pipeline.mjs         去重 / 限流 / 会话 / 插话冷却
  memory.mjs           working + profiles + episodes + 检索
  plugins.mjs          命令插件
  tools.mjs            工具注册 + MCP 客户端
  opgg.mjs             OP.GG 数据工具
  agent.mjs            应答入口 / 定时话题
  questions.mjs        拆题 / 识别查询域与本轮模式
  research.mjs         逐题规划、取证与预算
  reply.mjs            场景选择 / 成稿 / 逐题覆盖检查
  jobs.mjs             6h 周期持久作业
  app.mjs              事件路由
probe.mjs / listen.mjs / send.mjs / smoke-opgg.mjs   调试与冒烟脚本
```

## 运行

```bash
cp .env.example .env     # 填 AppID / AppSecret / LLM 配置
sh run.sh                # 守护启动，崩溃 3 秒自动拉起
```

环境变量：

| 变量 | 说明 |
|---|---|
| `QQ_APP_ID` / `QQ_APP_SECRET` | 开放平台机器人凭证 |
| `QQ_INTENTS` | 事件订阅位，默认 `33554432`（`1<<25`） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口 |
| `DATA_TOOLS_ENABLED` / `SEARCH_ENABLED` | 专用数据工具 / 通用网页搜索。未设专用工具开关时兼容旧 `SEARCH_ENABLED`；两项均未设时只开专用工具 |
| `REPLY_MODE` | 默认 `auto`，可设 `fast` 或 `deep`，每群可通过 `replyMode` 覆盖 |
| `REPLY_FAST_MS` / `REPLY_AUTO_MS` / `REPLY_DEEP_MS` | 从收消息开始计的生成预算，默认分别为 7、15、25 秒 |
| `REPLY_MAX_QUESTIONS` / `TOOL_CONCURRENCY` | 单轮最多处理 5 题，默认最多 3 个独立查询并行 |
| `LLM_REASONING_STYLE` | 默认 `effort`；也可配置 `thinking` 或 `none`，按实际供应商支持选用 |
| `LLM_AUTO_EFFORT` / `LLM_DEEP_EFFORT` | 默认 `none` / `low`，可在验证供应商支持后将 `auto` 配成 `low` |
| `INTERJECT_P` | 插话概率，默认 `0.35` |
| `TOPIC_CYCLE_H` | 定时话题周期，默认 `6` 小时 |

群聊和私聊可在消息开头写 `/快答`、`/自动` 或 `/深想`，后面加空格和问题，只影响这一轮。能确定的数据查询直接取证，独立子题限并发执行，需要上一个结果的追问顺序执行。查询超时后会保留已经查到的子题，发送受群回复条数限制时会把几题放进同一条消息。

`config/mcp.json` 的 HLTV 和 LoL 进程路径来自原部署环境。换机器时需按本机安装位置调整。stdio 服务握手失败时，能直连的适配器仍可加载。

旧事件卡如果缺少会话或消息来源，会保留原文件并退出检索。群内专属语气使用口令或 CLI 确认的身份，自报昵称仍可用于称呼。

## 离线回放

```bash
node --test
```

回放使用临时数据目录和模拟响应，经过实际入站处理、规划、成稿和发送队列。运行 trace 可用同一 `turnId` 串起子题结果、工具耗时、首条送达耗时和发送失败。

上线前可用同一组脱敏群聊片段对比两版人设，分别看接话是否承接上文、互损是否有分寸、认真求助是否及时切语气。当前回放覆盖这些路径的输入与结果约束，线上语气和时延需要真实群聊验证。

## 平台注意事项

- 群需要由管理员在机器人资料页开启「接收消息」，否则收不到非 @ 消息（`bot_state.recv_msg_setting` 为 `all` 才生效）
- 全量模式下 @ 消息以 `GROUP_MESSAGE_CREATE` 推送，正文带 `<@机器人openid>`，不是 `GROUP_AT_MESSAGE_CREATE`
- 被动回复窗口：群 5 分钟 / 5 次，单聊 60 分钟 / 4 次；超限返回 `40034128`
- 主动消息需群开启主动推送，否则 `40034105`
