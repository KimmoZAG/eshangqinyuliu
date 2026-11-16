# eshangqinyuliu

QQ 群聊机器人「金桦」。宿主是 **MaiBot v1.4.3**（固定 commit `e539150`），业务逻辑以 Python 插件 `jinhua.chat` 的形式挂在宿主上，数据查询走 Node 写的 MCP 工具桥。

```
QQ ⇄ qq_official_adapter ⇄ maisaka(planner/replyer) ⇄ jinhua 插件
                                        │
                                   stdio MCP
                                        ▼
                    lol / steam / hltv / search 工具
```

## 快速开始

依赖：Node 20+、Python 3.12、uv、Git。

```bash
cp .env.example .env          # 填 LLM 与 QQ 凭证
./start.sh                    # 依赖自检 → 幂等打补丁 → 同步插件 → 启动
tail -f logs/maibot-live.log
```

首次安装（只跑一次）：

```bash
node --env-file=.env maibot.mjs install
node --env-file=.env maibot.mjs doctor
```

停止 / 重启：

```bash
./stop.sh
./stop.sh && ./start.sh       # 改完代码的标准动作
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 分层、钩子、消息链路、并发模型、输出协议 |
| [docs/operations.md](docs/operations.md) | 启停、补丁幂等、依赖自愈、健康指标、灾难恢复 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 15 类真实故障的判定与修法 |
| [docs/configuration.md](docs/configuration.md) | `.env`、`config/mcp.json`、实例 TOML 全量说明 |
| [docs/persona.md](docs/persona.md) | 人设结构、同步机制、A/B 测试、验收指标 |
| [docs/emoji.md](docs/emoji.md) | 表情素材、标签语义、发送链路、GIF 约束 |
| [docs/development.md](docs/development.md) | 开发约定、反模式清单、测试与提交流程 |

## 五条最容易踩的坑

1. **改插件不重启等于没改**：运行时是 `instance/plugins/jinhua/` 副本，`./start.sh` 会自动 `configure` 同步，手动 `node maibot.mjs run` 不会。
2. **不要手改上游源码**：`data/maibot/node_modules/maibot-upstream/` 是构建产物，改动请落到 `maibot/upstream.patch`（必须保持单文件）。
3. **`before_send` 里不要 `abort()`**：上游会判定“回复未生成”而无限重排，表现为卡死。
4. **插件自己发消息必须带被动锚点**：用入站消息当 `reply_message`，否则报「缺少有效入站锚点或额度」。
5. **表情只能发图片**：`<emoji:id>`、CQ 码、`face` 段在群/私聊接口都不支持。

## 能力

- **被动应答**：被 @ 或被叫到名字时回复，走 planner → replyer 两次模型调用
- **主动接话**：普通消息按阈值判定是否插话（`interject` 开关 + 模型判定）
- **定时话题**：6 小时周期内必发一次信息型话题
- **表情**：图片贴纸，按情绪标签与概率发送（默认 45%）
- **工具**：LOL 赛程/VOD、CS 排名/赛果、Steam 价格/在线、联网搜索，按域注入
- **记忆**：A_Memorix 稀疏检索（无 embedding 环境），按天滑动
- **并发保护**：会话级发送锁、兜底抑制、2 秒合并窗口、口癖抑制

## 目录

```
maibot.mjs                编排入口：install / configure / doctor / run / test / replay
maibot/jinhua/            插件源码（plugin / state / turn / persona.json）
maibot/upstream.patch     宿主补丁（唯一，幂等应用）
maibot/style-test.mjs     人设 A/B 测试（走真实模型）
maibot/tests/             插件单测
config/mcp.json           工具服务清单
run.sh / start.sh / stop.sh / ensure-runtime.sh    启停与依赖自愈
src/                      旧版 Node 实现（回滚用，不参与线上）
bot.mjs                   旧版入口（回滚用）
data/                     运行期数据（不入库）
logs/                     运行日志（不入库）
```

## 平台限制（决定产品形态）

| 项 | 限制 |
|---|---|
| 群被动回复 | 5 分钟 / 5 次，超限 `40034128` |
| 私聊被动回复 | 60 分钟 / 4 次 |
| 主动消息 | 每群 20 qpm、每天 1000 条；需群开启主动推送 |
| 全量消息 | 需群管在机器人资料页开启「接收消息」 |
| 全量模式下的 @ | 走 `GROUP_MESSAGE_CREATE`，@ 信息在独立 `at` 段，正文里没有 |
| 富媒体 | 必须 `content: ""`，否则图片下多空行 |
| 系统表情 | 群/私聊接口不支持，只能用图片 |

## 测试

```bash
node --env-file=.env maibot.mjs test          # 19 个用例
node --env-file=.env maibot/style-test.mjs both   # 人设 A/B
node --test test/*.test.mjs                   # 旧版 Node 用例
```

## 回滚到旧版实现

```bash
./stop.sh
node --env-file=.env bot.mjs
```

旧版直接接 QQ OpenAPI，逻辑在 `src/`，功能与新版不完全对齐，仅作应急。
