# 配置参考

配置分三类：`.env`（进程环境）、`config/mcp.json`（工具）、实例内 TOML（宿主与插件）。

## 1. `.env`

密钥不要提交。仓库只保留 `.env.example`。

### QQ 开放平台

| 变量 | 说明 |
|---|---|
| `QQ_APP_ID` / `QQ_APP_SECRET` | 机器人凭证，在开放平台申请 |
| `QQ_INTENTS` | 事件订阅位，群/私聊机器人只需 `33554432`（`1<<25`） |

### 模型

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容接口 |
| `JINHUA_TASK_TIMEOUT` | 模型任务硬超时（秒），默认 30 |
| `JINHUA_FAST_MODEL` / `JINHUA_DEEP_MODEL` | 可选，按档位覆盖模型名 |

### 试点白名单

| 变量 | 说明 |
|---|---|
| `JINHUA_QQ_GROUPS` | 允许响应的群，逗号分隔 `group_openid` |
| `JINHUA_QQ_USERS` | 允许响应的私聊用户 `user_openid` |
| `JINHUA_ADMIN_OPENIDS` | 插件管理员，可用 `/金桦 …` 管理命令 |

白名单会写入 `instance/config/adapter_policy.toml` 的 `allow_ids`，未列出的会话直接被丢弃。

### 能力开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEARCH_ENABLED` | `0` | `1` 时挂载联网搜索工具 |
| `EMOJI_MODE` | `safe` | `safe` / `strip` / `all`，见 [emoji.md](emoji.md) |
| `JINHUA_EMOJI_P` | `0.45` | 带图概率闸门 |
| `JINHUA_HISTORY_LIMIT` | `50` | 送进 planner 的历史消息条数上限 |
| `JINHUA_TOOL_BUDGET_MS` | `8000` | 工具调用预算，超出不再给查询工具 |
| `JINHUA_MERGE_WINDOW_MS` | `2000` | 多条 @ 合并窗口 |
| `JINHUA_FALLBACK_MS` | `20000` | 兜底延迟 |
| `EMOJI_EXTRA` | 空 | 强制放行的危险字符，如 `🥹🫠` |

## 2. `config/mcp.json`

工具服务清单，启动时逐个握手。

```json
[
  {
    "name": "steam",
    "domain": "steam",
    "enabled": true,
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@tmhs/steam-mcp"],
    "env": { "NODE_OPTIONS": "--dns-result-order=ipv4first" },
    "toolTimeoutMs": 25000,
    "allow": ["steam_getAppDetails", "steam_searchApps"],
    "deny": ["steam_setAchievement"],
    "ttlMs": { "steam_getAppDetails": 600000 }
  }
]
```

| 字段 | 作用 |
|---|---|
| `domain` | 与消息内容匹配的域，决定何时注入这批工具 |
| `allow` / `deny` | 白名单优先；`deny` 的工具永不暴露给模型 |
| `heavy` | 标记重工具，按意图挂载 |
| `ttlMs` | 单工具结果缓存时间 |
| `adapters` | 可选，厂商适配层，补参数链路与错误归一 |

当前四个域：`search` / `steam` / `hltv` / `lol`；OP.GG 走直连适配器，不走 MCP。

工具目录不要全量暴露：模型每条消息都会带 schema，64 个工具会把 prompt 撑爆。域路由 + 按需注入是刻意设计。

## 3. 实例内配置

`data/maibot/instance/config/`

| 文件 | 管什么 |
|---|---|
| `bot_config.toml` | 人设、昵称、聊天节奏、回复风格、创意模式 |
| `model_config.toml` | 各任务用哪个模型、`max_tokens`、`hard_timeout` |
| `adapter_policy.toml` | 群/私聊准入白名单 |
| `builtin_plugins/qq_official_adapter/config.toml` | QQ 凭证与启用开关 |

**不要直接手改 `bot_config.toml` 的人设字段**：`configure` 会按 `persona.json` 的指纹覆盖。要改就改 `maibot/jinhua/persona.json`。

`model_config.toml` 的 `hard_timeout` 由 `configure.py` 写入（默认 30 秒），手改会在下次 configure 被重置。

## 4. 插件配置

`instance/plugins/jinhua/config.toml`：

```toml
legacy_data_dir = "/path/to/repo/data"
admin_openids = ["..."]
[plugin]
enabled = true
config_version = "1.0.0"
```

`persona_sha` 也记在这里，用于判断人设是否需要同步。

## 5. 群级策略

`instance/data/plugins/jinhua.chat/state.json` 的 `groups` 字段：

```json
{
  "groups": {
    "<group_openid>": {
      "interject": true,
      "flirt": true,
      "tools": true,
      "media": true,
      "replyMode": "auto"
    }
  }
}
```

也可以群里发命令：`/说话`、`/闭嘴`、`/金桦 状态`、`/金桦 媒体 关`、`/金桦 条数 2`。

## 6. 改完必须重启的清单

- `maibot/jinhua/*.py`
- `maibot/jinhua/persona.json`
- `.env`
- `config/mcp.json`
- `maibot/upstream.patch`

统一用 `./stop.sh && ./start.sh`。
