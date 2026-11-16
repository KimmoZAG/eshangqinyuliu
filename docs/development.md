# 开发约定

## 1. 改哪里

| 需求 | 位置 |
|---|---|
| 说话风格、称呼、人设 | `maibot/jinhua/persona.json` |
| 判定逻辑、并发、输出协议、工具白名单 | `maibot/jinhua/plugin.py` |
| 回合数据结构、时间预算 | `maibot/jinhua/turn.py` |
| 群策略、绑定、词条持久化 | `maibot/jinhua/state.py` |
| 工具接入 | `config/mcp.json` + `src/tools*.mjs` |
| 宿主行为（不得已才改） | `maibot/upstream.patch` |

## 2. 三条硬规矩

**① 不要手改上游源码**

`data/maibot/node_modules/maibot-upstream/` 是构建产物，升级即丢。需要改宿主行为时：

```bash
# 1. 先在工作区直接改并验证
# 2. 生成完整 diff（覆盖所有改动文件，不是增量）
git -C data/maibot/node_modules/maibot-upstream diff > maibot/upstream.patch
# 3. 重启，确认标记文件更新
```

补丁必须**保持单一文件**。多补丁改同一文件的重叠区域会导致正反都打不上，启动直接退出（见 troubleshooting 第 1 条）。

**② 改了插件就要 restart**

运行时加载的是 `instance/plugins/jinhua/` 副本。`./start.sh` 会先 `configure` 同步，只改仓库不重启等于没改。

**③ 插件必须对测试桩容错**

单测用 `SimpleNamespace` 造插件，缺字段是常态：

```python
try:
    self.arm_watchdog(...)
except Exception:
    pass
```

不要因为“线上一定有”就省掉这层，否则每次加功能都会红一片。

## 3. 绝对不能做的事

| 反模式 | 后果 |
|---|---|
| 在 `before_send` 里 `abort()` 自己接管发送 | 上游判定“回复未生成”，无限重排，表现为卡死 |
| 用 `session` 当唯一键存回合状态 | 并发时被覆盖，锚点错位、消息丢失 |
| 让插件自己 `ctx.send.*` 却不传入站消息 | 适配器按主动消息处理，报“缺少入站锚点或额度” |
| 让模型直接输出 JSON | 聊天模型容易漏逗号括号，改用 `EMOJI/TEXT` 行协议 |
| 依赖 Unicode emoji | 客户端字体不全，会显示方块 |
| 全量暴露工具 schema | prompt 被撑爆，延迟暴涨 |

## 4. 测试

```bash
node --env-file=.env maibot.mjs test        # Python 插件 + 上游契约
node --test test/*.test.mjs                 # 旧版 Node 用例
node --env-file=.env maibot/style-test.mjs both   # 人设 A/B（走真实模型）
```

当前覆盖（19 个用例）：

| 用例类 | 覆盖点 |
|---|---|
| `MigrationTests` | 旧数据迁移、绑定一次性 |
| `InstalledUpstreamTests` | 上游契约、事件分类、点名判定、工具白名单 |
| `PlanDeliveryTests` | 计划改写不 abort、单行协议解析 |
| `FallbackGuardTests` | 三条 @ 只兜底一次、刚出站不补话 |
| `ConcurrencyStateTests` | 会话锁隔离 |
| `MergeWindowTests` | 2 秒内合并、超窗口不合并 |
| `ClicheGuardTests` | 同短语第三次被拦、非游戏语境禁“上号” |

新增功能时，**先加用例再改实现**，尤其是并发与兜底路径。

## 5. 提交流程

```bash
./stop.sh
node --env-file=.env maibot.mjs test        # 必须全绿
./start.sh
grep -E "插件已同步|已加载=1（jinhua" logs/maibot-live.log | tail -2
git add -A && git commit -m "type(scope): 说明"
git push origin main
```

`.env`、`data/`、`logs/` 已在 `.gitignore`，不要提交。

## 6. 目录速查

```
maibot.mjs              编排入口（install/configure/run/test/replay/doctor）
run.sh                  守护循环 + 依赖自检
start.sh / stop.sh      进程组启停
ensure-runtime.sh       node / uv / ssh 自愈
maibot/jinhua/          插件源码（改动需 configure）
maibot/upstream.patch   宿主补丁（唯一）
maibot/style-test.mjs   人设 A/B 测试
config/mcp.json         工具服务清单
src/                    旧版 Node 实现（回滚用）
```

## 7. 上线检查清单

- [ ] 单测全绿
- [ ] 启动日志里 `插件已同步` 的 sha1 变了（说明真的部署了）
- [ ] `已加载=1（jinhua.chat）` 且无异常
- [ ] 网关连接存在：`netstat -tnp | grep 111.31 | grep ESTABLISHED`
- [ ] 群里 @ 一次，确认能回
- [ ] 看 `health.json` 没有异常增长
