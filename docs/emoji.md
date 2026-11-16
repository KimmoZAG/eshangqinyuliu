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

## 8. 新机器如何重建素材（data/ 不入库）

表情素材放在 `data/` 下，被 `.gitignore` 忽略。**新 clone 的仓库里没有这些图**，需要按下面的方式重建。

### 8.1 24 个 Twemoji 素材

来自 npm 包 `emoji-datasource-twitter`（CC-BY 4.0）的 64px PNG：

```bash
cd /tmp && rm -rf emojipack && mkdir emojipack && cd emojipack
npm pack emoji-datasource-twitter --silent
tar xzf *.tgz
DEST=/path/to/repo/data/maibot/instance/data/plugins/jinhua.chat/images
mkdir -p "$DEST"

python3 - <<'EOF'
import shutil
src = '/tmp/emojipack/package/img/twitter/64'
dst = '/path/to/repo/data/maibot/instance/data/plugins/jinhua.chat/images'
mapping = {
  '笑':'1f602','微笑':'1f60a','赞':'1f44d','踩':'1f44e','哭':'1f62d','无语':'1f611',
  '白眼':'1f644','狗头':'1f436','ok':'1f44c','震惊':'1f631','火':'1f525','强':'1f4aa',
  '思考':'1f914','汗':'1f605','坏笑':'1f608','亲':'1f618','酷':'1f60e','睡':'1f634',
  '怒':'1f621','鼓掌':'1f44f','握手':'1f91d','加油':'1f64c','摊手':'1f937','委屈':'1f97a',
}
for name, code in mapping.items():
    shutil.copy(f'{src}/{code}.png', f'{dst}/{name}.png')
print('copied', len(mapping))
EOF
```

### 8.2 三个自定义素材

这三张来自群主提供的原始图片，仓库里没有副本，**必须单独保管**：

| 标签 | 原文件名 | 落库文件名 | 用途 |
|---|---|---|---|
| `眯眼笑` | `kim-smile.jpg`（实为 GIF） | `眯眼笑.gif` | 嘲讽群友 |
| `有意思` | `something-interesting.jpg`（实为 GIF） | `有意思.gif` | 有人发离谱内容 |
| `合适` | `very-suitable.jpg` | `合适.jpg` | 有人夸金桦 |

建议在私有存储（网盘/对象存储）留一份备份，这是仓库之外唯一的原件。

### 8.3 重建后自检

```bash
ls data/maibot/instance/data/plugins/jinhua.chat/images/ | wc -l   # 期望 27 个具名文件
./stop.sh && ./start.sh
grep "可用标签" -m1 <(sed 's/\x1b\[[0-9;]*m//g' logs/maibot-live.log) || true
```

标签列表是启动时扫描目录生成的，数量对不上说明文件没放对位置。

### 8.4 为什么不做入库

`data/` 包含消息库、绑定状态、日志和素材缓存，整体入库会带来无意义的冲突。如果将来要随仓库分发素材，正确做法是单开 `assets/emoji/` 目录并在启动时同步，而不是把 `data/` 部分放行。
