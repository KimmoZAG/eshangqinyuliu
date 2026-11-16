# 运维手册

面向「机器上把它跑起来、出事能修」的场景。开发约定见 [development.md](development.md)。

## 1. 启动链路

```
./start.sh
  └ setsid sh run.sh                    # 记录 pgid 到 data/run.pid
      ├ sh ensure-runtime.sh            # node / uv / ssh 权限自愈
      └ node maibot.mjs run --live-qq
          ├ checkedUpstream()           # 校验上游 commit 固定为 e539150
          ├ applyPatches()              # 幂等打补丁（见第 3 节）
          ├ configure('configure')      # 同步插件源码 + 人设 + 群准入
          ├ configure('live')           # 打开 QQ 适配器
          ├ verifyPluginSync()          # sha1 校验，不一致拒绝启动
          └ uv run maibot run --directory instance
```

## 2. 日常命令

| 目的 | 命令 |
|---|---|
| 启动 | `./start.sh` |
| 停止（含子进程） | `./stop.sh` |
| 改代码后上线 | `./stop.sh && ./start.sh` |
| 只同步配置不重启 | `node --env-file=.env maibot.mjs configure` |
| 看日志 | `tail -f logs/maibot-live.log` |
| 看 DEBUG 结构化日志 | `ls -t data/maibot/instance/logs/*.jsonl \| head -1` |
| 自检 | `node --env-file=.env maibot.mjs doctor` |
| 单元测试 | `node --env-file=.env maibot.mjs test` |

`start.sh` 已在运行时会被拒绝（避免双实例抢锁）；`stop.sh` 按进程组收，收不干净会自动 `-9` 并校验。

## 3. 补丁机制（幂等）

宿主 MaiBot 的少量行为需要改，但**不能手改上游**（下次升级会丢）。仓库用单一补丁文件：

```
maibot/upstream.patch        # 8 个文件，覆盖富媒体 content、事件分类等
data/.../maibot-upstream/.jinhua-patch   # 标记：commit:补丁 sha1
```

`applyPatches()` 逻辑：

```
标记匹配且工作区已脏  → 跳过（什么都不做）
否则                 → git checkout -- . 回滚 → apply → 写标记
apply 失败            → 再 checkout 回滚 → 抛错退出（不留半成品）
```

**为什么必须是单个补丁**：多个补丁改同一文件的重叠区域时，正向/反向都无法应用，启动会陷入「打不上补丁 → 退出 → 重启」的循环。历史教训见 [troubleshooting.md](troubleshooting.md#1-启动反复退出git-退出码-1)。

修改宿主行为的正确姿势：

```bash
# 1. 先在实例里手工验证改动
# 2. 生成完整 diff（不是增量 diff）
git -C data/maibot/node_modules/maibot-upstream diff > maibot/upstream.patch
# 3. 重新启动，验证标记更新
```

## 4. 依赖自愈

容器重建后常见丢失项，`ensure-runtime.sh` 每次启动都会检查：

| 依赖 | 策略 |
|---|---|
| `node` | PATH → `/usr/local/bin` → `/usr/bin` → VS Code 自带 node，找到就 symlink |
| `uv` | 没有就 `pip install uv` |
| ssh | `chmod 700 ~/.ssh`，`600` config 与私钥（否则 `git push` 报 `Bad owner or permissions`） |

日志在 `logs/runtime.log`。

## 5. 配置同步规则

| 改动 | 是否重启 | 说明 |
|---|---|---|
| `maibot/jinhua/*.py` | **必须** | 运行的是 `instance/plugins/jinhua/` 副本 |
| `maibot/jinhua/persona.json` | **必须** | configure 按 sha1 同步到 `bot_config` |
| `.env` | **必须** | 进程启动时读取 |
| `config/mcp.json` | **必须** | MCP 子进程启动参数 |
| `data/` 下的状态文件 | 不需要 | 插件运行时读写 |
| `instance/config/bot_config.toml` 手改 | 不需要，但会被下次 configure 覆盖人设字段 |

> 只改仓库、不跑 `configure`，线上不会有任何变化——这是本项目最容易踩的坑。

## 6. 健康指标

`instance/data/plugins/jinhua.chat/health.json`：

| 键 | 含义 |
|---|---|
| `fallback_sent` | 兜底补话次数 |
| `slow_send` | 超预算但仍发送 |
| `send_dropped` | 超过 120 秒硬上限被丢弃 |
| `plan_parse_fail` | 输出协议解析失败 |
| `merged_turns` | 合并窗口生效次数 |
| `cliche_dropped` | 口癖被抑制次数 |
| `gif_shrunk` | 大 GIF 转静态首帧 |
| `emoji_fail` | 发表情失败 |

## 7. 灾难恢复顺序

```
1. ./stop.sh
2. 看 logs/runtime.log 是否有 node/uv 报错 → 跑 sh ensure-runtime.sh
3. 看 logs/maibot-live.log 末尾：
     git 退出码 1        → 补丁问题，见 troubleshooting
     绑定/配置类报错      → 跑 configure
4. ./start.sh
5. 验证：grep "已加载=1（jinhua" logs/maibot-live.log | tail -1
6. 验证连接：netstat -tnp | grep 111.31 | grep ESTABLISHED
7. 新机器还要重建表情素材（`data/` 不入库），见 [emoji.md](emoji.md#8-新机器如何重建素材data-不入库)
```

如果上游目录被改坏（例如手工改过），直接重置再启动：

```bash
git -C data/maibot/node_modules/maibot-upstream checkout -- .
./start.sh
```
