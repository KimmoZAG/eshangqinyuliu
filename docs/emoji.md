# 表情（图片贴纸）

## 1. 为什么不用系统表情

| 尝试 | 结果 |
|---|---|
| `<emoji:id>` | 只存在于 QQ 频道接口，群/私聊不解析，原样显示 |
| CQ 码 `[CQ:face,id=4]` | OneBot 协议概念，官方 API 没有解析器 |
| `face` 消息段 | 官方接口没有该字段 |
| Unicode emoji | 客户端字体覆盖有限，新码位/变体符会变方块 |
| **富媒体图片（msg_type 7）** | **可用，已实测** |

结论：表情只能当图片发。

## 2. 素材目录

插件真实数据目录（`ctx.paths.data_dir`）是：

```
data/maibot/instance/data/plugins/jinhua.chat/images/
```

不是 `instance/data/images/`（后者是聊天图片缓存）。文件名即标签：

```
笑.png      → [[笑]] / EMOJI: 笑
狗头.png    → [[狗头]]
眯眼笑.gif  → [[眯眼笑]]
```

支持 `.png` `.jpg` `.jpeg` `.gif`。当前 24 个 Twemoji 素材 + 3 个自定义：

| 标签 | 使用场景 |
|---|---|
| `眯眼笑` | 嘲讽群友：吹牛、找借口、被拆穿 |
| `有意思` | 有人发了有意思/离谱的内容 |
| `合适` | 有人夸金桦，表示受用但不谦虚 |
| 其余 | 按情绪挑，别连着两条用同一个 |

这三个特殊标签的语义写在 `plugin.py` 的 `EMOJI_SEMANTICS`，会拼进 replyer 提示词。

## 3. 发送链路

```
replyer 输出 EMOJI: 标签
        ↓
before_send 解析计划
        ↓
概率闸门 JINHUA_EMOJI_P（默认 0.45）
        ↓
push_emoji：读文件 → base64 → ctx.send.image（失败退 ctx.send.emoji）
        ↓
适配器上传 /files 拿 file_info → 发 msg_type 7
        ↓
文字随后发送（图与文是两条独立消息）
```

设计要点：

- **先图后文**，且两者独立 try/except：图挂了不影响文字
- 图片消息的 `content` 必须为空，否则图片下方多一行空白（已在 `upstream.patch` 修正）
- 大 GIF（> 512KB）自动转首帧 PNG，避免渲染异常，计数 `gif_shrunk`

## 4. 概率控制

模型即使每条都想配图，最终也只按概率发：

```ini
JINHUA_EMOJI_P=0.45   # 默认
JINHUA_EMOJI_P=0.2    # 想更安静
JINHUA_EMOJI_P=1.0    # 调试用，强制配图
```

提示词里同时有软约束：「不要每条都配，平均三四条里一条」。

## 5. Unicode 过滤（文字里的 emoji）

出站文本会过一遍 `sanitize_emoji`：

| 模式 | 行为 |
|---|---|
| `safe`（默认） | 删 ZWJ 组合、变体符（FE0F）、肤色修饰、Unicode 12+ 码位；保留常见表情 |
| `strip` | 全部删除 |
| `all` | 不处理 |
| `EMOJI_EXTRA` | 指定字符强制放行，如 `EMOJI_EXTRA=🥹🫠` |

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `/表情 笑` 提示素材库没找到 | 文件放错目录 | 放到 `plugins/jinhua.chat/images/` |
| 图片下方有空行 | 适配器 `content: " "` | 确认 `upstream.patch` 已应用 |
| 图发出但群里没有 | 缺被动锚点 | 查是否 `QQ 被动回复缺少有效入站锚点` |
| GIF 不动 | 客户端当文件处理 | 转首帧 PNG，或改用 MP4（`file_type=2`） |
| 表情被压掉 | 口癖/概率闸门 | 看 `health.json` 的 `emoji_fail`、`cliche_dropped` |

## 7. 扩充素材

```bash
# 1. 放进目录（文件名即标签，建议 ≤ 200KB、正方形）
cp xxx.png data/maibot/instance/data/plugins/jinhua.chat/images/无语2.png

# 2. 重启（提示词里的标签列表是启动时读目录生成的）
./stop.sh && ./start.sh

# 3. 验证标签已出现在提示词
ls -t data/maibot/instance/logs/maisaka_prompt/replyer/qq_group_*/*.json | head -1
```
