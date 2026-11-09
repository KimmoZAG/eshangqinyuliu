# eshangqinyuliu

QQ 群聊机器人「金桦」：接入 QQ 机器人开放平台 v2（WebSocket 事件 + OpenAPI 发送），带人设、按天滑动的群记忆、命令插件、6 小时定时话题与工具调用。

## 特性

- **事件驱动**：WebSocket 长连接，事件归一化为 `message / notice / request / meta` 四类，断线自动 resume 补发
- **三条发声通道**：被动应答（@）、主动插话（三道闸门 + 概率采样）、定时话题（6h 周期必发，可接 MCP 检索）
- **记忆分层**：按天滑动的原文窗口 + 日结 + 事件卡 + 人物画像（锐评角度是硬状态，用过进冷却）
- **命令插件**：`/帮助`、`/战绩`、`/开黑报名`、`/话题`、`/闭嘴`、`/说话`，带权限与冷却
- **发送队列**：每回合 ≤5 条、条间 1.2s、每群 20qpm、失败退避重试与死信
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
  agent.mjs            应答 / 插话判定 / 工具循环 / 话题
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
| `INTERJECT_P` | 插话概率，默认 `0.35` |
| `TOPIC_CYCLE_H` | 定时话题周期，默认 `6` 小时 |

## 平台注意事项

- 群需要由管理员在机器人资料页开启「接收消息」，否则收不到非 @ 消息（`bot_state.recv_msg_setting` 为 `all` 才生效）
- 全量模式下 @ 消息以 `GROUP_MESSAGE_CREATE` 推送，正文带 `<@机器人openid>`，不是 `GROUP_AT_MESSAGE_CREATE`
- 被动回复窗口：群 5 分钟 / 5 次，单聊 60 分钟 / 4 次；超限返回 `40034128`
- 主动消息需群开启主动推送，否则 `40034105`
