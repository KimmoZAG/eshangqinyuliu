# 故障排查

每条都是**真实踩过的坑**，按「现象 → 日志关键字 → 判定 → 修法」组织。

## 1. 启动反复退出：`git 退出码 1`

**现象**：`run.sh` 每 5 秒拉起一次，日志刷屏后退出。

**关键字**

```
error: patch failed: src/.../plugin.py:1519
error: src/.../plugin.py: patch does not apply
[金桦] git 退出码 1
```

**判定**：补丁与当前工作区状态不匹配。常见原因是**多个补丁改同一文件的重叠区域**，正向打不上、反向也打不上。

**修法**

```bash
git -C data/maibot/node_modules/maibot-upstream checkout -- .
rm -f data/maibot/node_modules/maibot-upstream/.jinhua-patch
./start.sh
```

若反复出现，说明补丁需要合并成一个（当前只有 `maibot/upstream.patch` 一个，不要再拆）。

## 2. `spawnSync uv ENOENT` / `node: command not found`

**现象**：容器重启后无法启动，或 `git push` 报 SSH 权限错误。

**判定**：运行时依赖没有持久化，镜像重建后丢失。

**修法**

```bash
sh ensure-runtime.sh     # 自动找回 node / 安装 uv / 修 ssh 权限
./start.sh
```

若 `ensure-runtime.sh` 也找不到 node，需要人工安装 Node 20+。

## 3. 改了代码但线上没变化

**判定**：运行时加载的是 `instance/plugins/jinhua/` 副本，仓库里的 `maibot/jinhua/` 只是源。

**验证**

```bash
diff maibot/jinhua/plugin.py data/maibot/instance/plugins/jinhua/plugin.py
```

**修法**

```bash
./stop.sh && ./start.sh     # 启动时自动 configure 同步
```

启动日志会打印指纹：`[金桦] 插件已同步，plugin.py sha1=xxxxxxxx`，与预期不一致就说明没生效。

## 4. 群里 @ 了但不回复

按顺序看三行日志：

```
金桦入站 判定=点名/旁观 explicit=… at段=… is_at=… is_men=… 文本=…
金桦接话判断 … action=… explicit=…
金桦出站放行 anchor=… parts=… elapsed_ms=…
```

| 现象 | 判定 | 修法 |
|---|---|---|
| `判定=旁观` 但确实是 @ | at 段/`<@id>`/名字都没识别到 | 检查 `receive` 的判定分支，补正则 |
| `action=none` 且 `explicit=True` | 模型仍选择沉默 | 确认 planner 里被点名时已 `discard("no_action")` |
| 有 `放行` 但群里没有 | 适配器发送失败 | 查 `instance/logs/*.jsonl` 里 `Platform IO 发送失败` |

## 5. 卡死：日志反复 `继续下一轮循环`

**关键字**

```
[推理中工具调用] Planner 1/1: 工具=reply
回复工具未生成可见消息，将继续下一轮循环
开始思考 轮次=2 …
```

**判定**：`before_send` 里用了 `abort()`。上游把 abort 理解为「回复未生成」，于是重新排一轮，无限循环。

**修法**：不要 abort。把出站消息改写成第一条内容后 `continue`，其余内容通过 `after_send` + `flush_lines` 补发。

## 6. `QQ 被动回复缺少有效入站锚点或额度`

**判定**：插件自己调 `ctx.send.*` 时没带 `msg_id`，适配器按主动消息处理，而群没有主动额度。

**修法**：补发时用入站消息当 `reply_message`（`_inbound[anchor]`）；`before_send` 缺 `reply_to` 时自动补 `turn.anchor`。

## 7. 图片下方多一行空行

**判定**：适配器发富媒体时把 `content` 填成了空格。

```python
body = {"msg_type": 7, "content": " ", "media": {...}}   # 错
body = {"msg_type": 7, "content": "",  "media": {...}}   # 对
```

**修法**：该修正在 `maibot/upstream.patch` 里，确认补丁已应用：

```bash
grep -n '"content": ""' data/maibot/node_modules/maibot-upstream/src/plugins/built_in/qq_official_adapter/plugin.py
```

## 8. `/表情 笑` 提示「素材库没找到这个名字」

**判定**：素材目录不对。插件真实数据目录是：

```
instance/data/plugins/jinhua.chat/images/
```

不是 `instance/data/images/`（后者是聊天图片缓存）。

**修法**：把 PNG/JPG/GIF 放进正确目录，文件名即标签，重启生效。

## 9. 模型硬超时 `硬超时 12.0s`

**关键字**

```
LLMTaskTimeoutError: 任务 'maisaka.planner' 模型 'jinhua-planner' 触发硬超时 12.0s
```

**判定**：`model_config.toml` 的任务 `hard_timeout` 太小，而 planner 输入约 9000 token。

**修法**：`configure.py` 已改为默认 30 秒（`JINHUA_TASK_TIMEOUT` 可调）。确认实例配置：

```bash
grep hard_timeout data/maibot/instance/config/model_config.toml
```

## 10. 表情显示成方块

**判定**：QQ 客户端字体不支持该 Unicode emoji（新版码位、变体符、ZWJ 组合、肤色修饰）。

**修法**：`EMOJI_MODE` 控制出站过滤：

| 值 | 行为 |
|---|---|
| `safe`（默认） | 删 ZWJ、变体符、Unicode 12+ 码位，保留常见表情 |
| `strip` | 全部删除 |
| `all` | 不过滤 |

真要发表情请用图片素材，不要依赖 Unicode。

## 11. 私聊发 Markdown 图片不显示

**判定**：群/私聊接口不渲染 markdown 内联图；`<emoji:id>` 只存在于频道接口；CQ 码是 OneBot 概念，官方 API 没有解析器。

**唯一可行路径**：`msg_type: 7` 富媒体（先 `/files` 上传拿 `file_info`）。

## 12. 输出被切成「发」这种碎片

**判定**：上游的 `enable_splitter` 按长度切分长回复，把 `TEXT: 发 science 是吧…` 从「发」后面切断。

**修法**：`compose` 钩子里设置 `enable_splitter = False`，由插件按 `TEXT:` 行自行切分。

## 13. 同一句话连发两次（重复兜底）

**判定**：早期实现里每个被点名的回合各起一个 20 秒定时器。

**修法**：看门狗已改为会话级，`can_fallback` 有四条抑制。若仍复现，看 `health.json` 的 `fallback_sent` 增长速率。

## 14. 全量模式下 @ 收不到 `GROUP_AT_MESSAGE_CREATE`

**判定**：群开启「接收所有消息」后，@ 改走 `GROUP_MESSAGE_CREATE`，@ 信息以**独立 `at` 消息段**存在，正文里只剩「你人呢」。

**修法**：判定要看 `raw_message` 里是否有 `type == "at"`，不能只看正文。

## 15. 排障通用入口

```bash
# 主日志（INFO）
tail -f logs/maibot-live.log

# DEBUG 结构化日志（含 HTTP 发送、模型调用）
ls -t data/maibot/instance/logs/*.jsonl | head -1

# 最近一次请求的完整 prompt
ls -t data/maibot/instance/logs/maisaka_prompt/replyer/qq_group_*/*.json | head -1
ls -t data/maibot/instance/logs/maisaka_prompt/planner/qq_group_*/*.json | head -1

# 计数器
cat data/maibot/instance/data/plugins/jinhua.chat/health.json
```
