# eshangqinyuliu

QQ 群聊与私聊机器人「金桦」，通过 MaiBot v1.4.3 接入 QQ 开放平台。

## MaiBot 运行方式

安装 Node.js 22+、Git 和 uv，从仓库根目录运行。把 `.env.example` 复制为 `.env`，填入模型配置。安装器校验 MaiBot 源码提交、应用 QQ 送达补丁，并用 uv 创建 Python 3.12 隔离环境。默认实例位于 `data/maibot/instance`。

```sh
node --env-file=.env maibot.mjs install
node --env-file=.env maibot.mjs doctor
node --env-file=.env maibot.mjs run
```

在本地 `.env` 填模型的 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。修改后停宿主并运行 `node --env-file=.env maibot.mjs configure`。默认启动 QQ 适配器关闭，可以先用终端或 WebUI 本地聊天测试 Planner 与查询。WebUI 的地址和本地登录方式由 MaiBot 在启动终端显示。

要接入测试 QQ，配置 `QQ_APP_ID`、`QQ_APP_SECRET`，以及以逗号分隔的 `JINHUA_QQ_GROUPS` 和 `JINHUA_QQ_USERS`，重新执行 `configure`，再启动：

```sh
node --env-file=.env maibot.mjs run --live-qq
```

同一 AppID 只运行一个 QQ 网关。验证时先试群 `@` 和私聊，再验证测试群可收全量消息并对普通消息做被动回复。通过后由群管理使用 `/说话` 开启自适应，`/闭嘴` 回到仅点名。`/金桦 状态` 查看开关，`/金桦 静默 2 8`、`/金桦 条数 2`、`/金桦 媒体 关` 和 `/金桦 工具 关` 按群配置。没有可信 QQ 角色时，可用 `JINHUA_ADMIN_OPENIDS` 授权。

Node 查询服务由 MaiBot MCP 启动。LoL 赛程和录像、Steam 商店与 OP.GG 支持直连。HLTV 和已有的 LoL stdio 服务可在 `config/mcp.local.json` 配置，参考 `config/mcp.maibot.example.json` 填本机可执行文件及参数。联网搜索按 `SEARCH_ENABLED` 配置。

管理员可在 WebUI 上切换金桦人设、上传并审核表情，以及查看或修正 A_Memorix 记忆。`/发图 名称` 和 `/表情 名称` 接受表情库中精确的描述名，或金桦插件数据目录 `images/` 中的同名 PNG／JPEG 文件。插件的绑定与群命令状态也在该插件数据目录。

旧版的 `data/aliases.json` 放在仓库根目录的 `data/` 下，可继续用 `node bind.mjs map <完整OpenID> <名字>` 管理。MaiBot 按 QQ 入站 OpenID 读取绑定，别名表里的记录优先生效，更新后下一条消息即可使用新称呼。已有 MaiBot 实例升级后，先运行 `node --env-file=.env maibot.mjs configure`。

`node --env-file=.env maibot.mjs memory-review` 在实例的 `memory-review/` 生成逐会话审核材料。核对 `index.json` 后，在 A_Memorix 导入页面选择对应的聊天流，再导入相应文本。首次安装导入旧口令，MaiBot 的 `/绑定` 记录保存在实例里。

### 验证和回滚

```sh
node --test
node maibot.mjs test
```

离线用例检查查询证据、MCP 协议、记忆迁移和真实适配器的部分送达。正式切换前，在测试群和私聊逐项对照 QQ 可见内容、回执及历史，再用同一模型比较查询正确率、接话准确度、人设和延迟。停 MaiBot 后可用 `node --env-file=.env bot.mjs` 运行旧版。

```sh
node --env-file=.env maibot.mjs replay
```

回放使用固定的模拟数据和配置的模型 API，QQ 发送由本地驱动接收。旧版、原版 MaiBot 与新版分别回放 40 条查询、60 条群聊和 20 条语气样本。运行目录有逐条结果、首条模拟送达耗时、模型调用数及 `blind.md` 盲评稿。盲评完成后用同目录的 `blind-key.json` 统计胜率。可用 `--kind query`、`--kind group` 或 `--kind voice` 单独复测。

## 旧版回滚实现

旧版直接接入 QQ 机器人开放平台 v2，带按天滑动的群记忆、命令插件、定时话题与工具调用。

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
  delivery.mjs         统一处理送达回执和记忆回写
  pipeline.mjs         去重 / 限流 / 会话 / 插话冷却
  memory.mjs           近期消息、事件卡与检索
  members.mjs          成员称呼、验证身份与互动状态
  context.mjs          按规划和成稿阶段组装上下文
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
node --env-file=.env bot.mjs
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

成员目录优先读取 `data/aliases.json` 的绑定结果，`data/profiles.json` 保存观察到的昵称与互动状态，并兼容旧的已验证记录。真实 @ 使用已验证且符合平台格式的 OpenID。记忆检索返回消息和事件记录，由回复阶段选择需要带进模型的内容。

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
