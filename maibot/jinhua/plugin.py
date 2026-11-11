from __future__ import annotations

import base64
import os
import re
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import ClassVar

from maibot_sdk import Command, Field, HookHandler, MaiBotPlugin, PluginConfigBase
from maibot_sdk.types import HookMode

from .state import State
from .turn import BUDGET_MS, MODE, MODES, Turn, compact, evidence_outputs, visible_text


COMMANDS = {
    "help": "帮助", "菜单": "帮助", "bind": "绑定", "认证": "绑定",
    "stats": "战绩", "战况": "战绩", "报名": "开黑报名", "开黑": "开黑报名",
    "安静": "闭嘴", "撩": "暧昧",
}
# 没点名但在跟机器人说话：第二人称 + 不回/说话/在吗，或直接骂机器人
ADDRESSED_HINT = re.compile(
    r"(?:你|妳)[^。！？!?]{0,20}(?:不回|没回|不说话|说话|在吗|在不在|闭嘴|装死|哑了|死了|欠|机器人|\bAI\b)"
)

PATTERN = (
    r"^/(?:帮助|help|菜单|绑定|bind|认证|战绩|stats|战况|开黑报名|报名|开黑|闭嘴|安静|"
    r"说话|暧昧|撩|话题|发图|表情|金桦)(?:\s|$)|^(?:闭嘴|说话)$"
)
LEADING_CALLOUT = re.compile(
    r"^(?:@金桦(?:（黄石版）)?|金桦(?:（黄石版）)?[啊呀哇欸诶]?(?=$|[\s，,：:！!？?、。/]))[\s，,：:]*"
)
RELATIONSHIP_CLAIM = re.compile(r"我(?:就是|是)\s*(?:诚哥|张睿诚|zrc|浩文|刘浩文|lhw)", re.I)


class PluginSettings(PluginConfigBase):
    enabled: bool = Field(default=True)
    config_version: str = Field(default="1.0.0")


class Settings(PluginConfigBase):
    plugin: PluginSettings = Field(default_factory=PluginSettings)
    legacy_data_dir: str = Field(default="")
    admin_openids: list[str] = Field(default_factory=list)
    deep_model_name: str = Field(default="")
    fast_model_name: str = Field(default="")


def abort(reason: str) -> dict:
    return {"action": "abort", "custom_result": {"reason": reason}}


def qq_identity(message: dict) -> tuple[str, str, str]:
    if message.get("platform") != "qq":
        return "", "", ""
    extra = message.get("message_info", {}).get("additional_config", {})
    return (
        str(extra.get("qq_official_user_openid") or ""),
        str(extra.get("qq_official_group_openid") or ""),
        str(extra.get("qq_official_member_role") or ""),
    )


def command_text(message: dict) -> str:
    text = "".join(str(seg["data"]) for seg in message.get("raw_message", [])
                   if seg.get("type") == "text" and isinstance(seg.get("data"), str))
    return LEADING_CALLOUT.sub("", (text or message.get("processed_plain_text") or "").strip(), count=1)


class JinhuaPlugin(MaiBotPlugin):
    config_model: ClassVar[type[Settings]] = Settings

    async def on_load(self) -> None:
        legacy_data = Path(self.config.legacy_data_dir) if self.config.legacy_data_dir else None
        self.state = State(self.ctx.paths.data_dir, Path(__file__).with_name("legacy.json"), legacy_data)
        self.turns: OrderedDict[tuple[str, str], Turn] = OrderedDict()
        self.latest: dict[str, str] = {}
        self.active_tools: dict[str, tuple[str, set[str]]] = {}
        self.registrations: dict[tuple[str, str], int] = {}
        self.ctx.logger.info("金桦自适应接话已加载，可按 msg_id 追踪入站、判断和发送")

    async def on_unload(self) -> None:
        self.turns.clear()

    async def on_config_update(self, scope: str, config_data: dict, version: str) -> None:
        if scope == "self":
            self.set_plugin_config(config_data)

    def remember(self, session: str, turn: Turn) -> None:
        self.turns[(session, turn.anchor)] = turn
        self.latest[session] = turn.anchor
        if len(self.turns) > 1024:
            (old_session, anchor), _ = self.turns.popitem(last=False)
            if self.latest.get(old_session) == anchor:
                self.latest.pop(old_session, None)
            if self.active_tools.get(old_session, (None,))[0] == anchor:
                self.active_tools.pop(old_session, None)

    def get_turn(self, session: str, anchor: str | None = None) -> Turn | None:
        return self.turns.get((session, anchor or self.latest.get(session, "")))

    def planning_turn(self, session: str) -> Turn | None:
        current = self.get_turn(session)
        if current is None or current.explicit:
            return current
        now = int(time.time() * 1000)
        # A merged ordinary message must not hide a pending explicit callout in the same group.
        return next((turn for (scope, _), turn in reversed(self.turns.items())
                     if scope == session and turn.explicit and not turn.handled and turn.expires_ms > now), current)

    def admin(self, user: str, role: str) -> bool:
        return bool(user) and (role in {"admin", "owner"} or user in self.config.admin_openids)

    def quiet(self, group: str) -> bool:
        hours = self.state.policy(group).get("quiet", [2, 8])
        if not isinstance(hours, list) or len(hours) != 2 or any(not isinstance(hour, int) for hour in hours):
            hours = [2, 8]
        start, end = hours
        hour = datetime.now(timezone(timedelta(hours=8))).hour
        return start <= hour < end if start <= end else hour >= start or hour < end

    def adaptive(self, group: str) -> bool:
        return bool(self.state.policy(group).get("interject", True)) and not self.quiet(group)

    async def say(self, message: dict, text: str, *, history: bool = True) -> bool:
        result = await self.ctx.send.text(text, message["session_id"], reply_message=message,
                                          storage_message=history, sync_to_maisaka_history=history)
        return bool(result)

    async def asset(self, name: str) -> str:
        if not name or len(name) > 80 or "/" in name or "\\" in name or name.startswith("."):
            return ""
        root = (self.ctx.paths.data_dir / "images").resolve()
        for suffix in (".png", ".jpg", ".jpeg"):
            path = (root / (name + suffix)).resolve()
            if path.parent == root and path.is_file() and path.stat().st_size <= 5 * 1024 * 1024:
                data = path.read_bytes()
                if data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")):
                    return base64.b64encode(data).decode("ascii")
        result = await self.ctx.call_capability("emoji.get_by_description", description=name, limit=1, exact=True)
        item = result.get("emoji") if isinstance(result, dict) else None
        return item.get("base64", "") if isinstance(item, dict) else ""

    @HookHandler("chat.receive.after_process", mode=HookMode.BLOCKING)
    async def receive(self, **kwargs):
        message = kwargs["message"]
        user, group, role = qq_identity(message)
        if not user:
            return {"action": "continue"}
        alias = self.state.name(user)
        if alias:
            user_info = message["message_info"]["user_info"]
            user_info["user_nickname"] = alias
            if group:
                user_info["user_cardname"] = alias
        text = command_text(message)
        callout = bool(group and LEADING_CALLOUT.match((message.get("processed_plain_text") or "").strip()))
        if callout:
            message["is_mentioned"] = True
            if re.match(PATTERN, text):
                message["processed_plain_text"] = text
        mode_match = MODE.match(text)
        mode = MODES[mode_match[1]] if mode_match else self.state.policy(group).get("replyMode", "auto")
        if mode not in BUDGET_MS:
            mode = "auto"
        if mode_match:
            text = text[mode_match.end():].strip()
            message["is_at"] = True
            message["processed_plain_text"] = text or "请告诉我如何使用回复档位"
            for segment in message["raw_message"]:
                if segment.get("type") == "text":
                    body = LEADING_CALLOUT.sub("", segment["data"].lstrip(), count=1)
                    segment["data"] = MODE.sub("", body, count=1)
                    break
        if group and text == "/话题" and self.admin(user, role):
            message["is_at"] = True
        session = message["session_id"]
        hinted = bool(group and ADDRESSED_HINT.search(text))
        addressed = bool(not group or message.get("is_at") or callout or message.get("is_mentioned") or hinted)
        if group and not addressed:
            adaptive = self.adaptive(group)
            if adaptive:
                message["message_info"]["additional_config"]["jinhua_adaptive"] = True
            self.ctx.logger.info(
                "金桦群消息入站 msg_id=%s 自适应=%s 判定=%s",
                message["message_id"], adaptive, "点名/在叫我" if addressed else "旁观",
            )
        turn = Turn(message["message_id"], user, group, text, addressed, mode, int(time.time() * 1000))
        self.remember(session, turn)
        if text in {"闭嘴", "说话"} and not (self.admin(user, role) or alias == "张睿诚"):
            # Keep an ordinary sentence from being treated as a command.
            message["processed_plain_text"] = text + "。"
            for segment in message.get("raw_message", []):
                if segment.get("type") == "text" and segment.get("data", "").strip() == text:
                    segment["data"] = text + "。"
        key = (session, user)
        signup_until = self.registrations.get(key, 0)
        if signup_until and int(time.time()) <= signup_until and text and not text.startswith("/") and not turn.explicit:
            self.registrations.pop(key, None)
            turn.explicit = True
            self.state.update_group(group, signup={"when": text[:80], "members": [user]})
            # The session was created by the initiating command. The original message is the reply anchor.
            await self.say(message, "记下了 " + text[:80] + " 想来就 /报名")
            return abort("已处理开黑报名时间")
        return {"action": "continue", "modified_kwargs": kwargs}

    @Command("jinhua", description="金桦群聊与管理命令", pattern=PATTERN)
    async def command(self, message: dict, **kwargs):
        user, group, role = qq_identity(message)
        if not user:
            return False, "", True
        command, _, arg = command_text(message).partition(" ")
        if not arg:
            parts = command.split(maxsplit=1)
            command, arg = parts[0], parts[1] if len(parts) == 2 else ""
        name = COMMANDS.get(command.lstrip("/").lower(), command.lstrip("/"))
        arg = arg.strip()
        turn = self.get_turn(message["session_id"], message["message_id"])
        if turn:
            turn.explicit = True
        response = ""
        if name in {"闭嘴", "说话", "暧昧", "话题"} and not (
            group and (self.admin(user, role) or not command.startswith("/") and self.state.name(user) == "张睿诚")
        ):
            response = "这个得群管理来"
        elif name == "绑定":
            response = self.state.redeem(arg, user) if arg else "把管理发你的绑定码带上"
        elif name in {"闭嘴", "说话"}:
            self.state.update_group(group, interject=name == "说话")
            response = "行 @我再来" if name == "闭嘴" else "行 有话我就接"
        elif name == "暧昧":
            if arg not in {"开", "关", "on", "off"}:
                response = "用 /暧昧 开 或 /暧昧 关"
            else:
                enabled = arg in {"开", "on"}
                self.state.update_group(group, flirt=enabled)
                response = "行 我知道了" if enabled else "行 我收着点"
        elif name == "话题":
            if turn:
                turn.topic = True
            return True, "", False
        elif name == "战绩":
            group_claims = self.state.value["claims"].get(group, [])
            matches = [item["text"] for item in group_claims
                       if arg and any(arg in self.state.name(person) for person in item.get("about", []))]
            response = "\n".join(matches[-3:]) or "这个群还没记下可引用的战绩"
        elif name == "开黑报名" and group:
            signup = self.state.policy(group).get("signup")
            if command == "/报名" and not arg and signup:
                people = list(dict.fromkeys(signup["members"] + [user]))
                self.state.update_group(group, signup={**signup, "members": people})
                response = f"记上了 {signup['when']} 现在 {len(people)} 人"
            elif arg:
                self.state.update_group(group, signup={"when": arg[:80], "members": [user]})
                response = "记下了 " + arg[:80] + " 想来就 /报名"
            else:
                self.registrations[(message["session_id"], user)] = int(time.time()) + 600
                response = "几点开 LOL 还是 CS 直接说"
        elif name in {"发图", "表情"}:
            if not arg:
                response = "发图后面带上素材名"
            elif self.state.policy(group).get("media", True) is False:
                response = "这个群把图片关了"
            else:
                asset = await self.asset(arg)
                if asset:
                    send = self.ctx.send.emoji if name == "表情" else self.ctx.send.image
                    sent = await send(asset, message["session_id"], reply_message=message, sync_to_maisaka_history=True)
                    if sent:
                        return True, "", True
                    response = "图刚才没发出去"
                else:
                    response = "素材库没找到这个名字"
        elif name == "金桦":
            policy = self.state.policy(group)
            response = "接话：" + ("自适应" if policy.get("interject", True) else "仅点名")
            response += " ｜ 图片：" + ("开" if policy.get("media", True) else "关")
            if arg in {"媒体 开", "媒体 关"}:
                if group and self.admin(user, role):
                    self.state.update_group(group, media=arg.endswith("开"))
                    response = "行 图片" + arg[-1]
                else:
                    response = "这个得群管理来"
            elif arg.startswith(("静默 ", "条数 ", "工具 ")):
                if not (group and self.admin(user, role)):
                    response = "这个得群管理来"
                elif re.fullmatch(r"静默 (?:[01]?\d|2[0-3]) (?:[01]?\d|2[0-3])", arg):
                    self.state.update_group(group, quiet=[int(item) for item in arg.split()[1:]])
                    response = "行 按北京时间静默"
                elif re.fullmatch(r"条数 [1-5]", arg):
                    self.state.update_group(group, replyLimit=int(arg[-1]))
                    response = "行 每轮最多 " + arg[-1] + " 条"
                elif arg in {"工具 开", "工具 关"}:
                    self.state.update_group(group, tools=arg.endswith("开"))
                    response = "行 查询工具" + arg[-1]
                else:
                    response = "用 /金桦 静默 2 8、/金桦 条数 2 或 /金桦 工具 开"
        else:
            response = "/绑定 码 · /战绩 人 · /开黑报名 · /报名 · /发图 素材名 · /金桦 状态\n管理用 /闭嘴 /说话 /暧昧 /话题"
        await self.say(message, response, history=name != "绑定")
        return True, "", True

    @HookHandler("maisaka.planner.before_request", mode=HookMode.BLOCKING)
    async def planner(self, **kwargs):
        session = kwargs["session_id"]
        turn = self.planning_turn(session)
        if turn is None:
            return {"action": "continue"}
        for output in evidence_outputs(kwargs["items"]):
            anchored = self.get_turn(session, output["anchor"])
            if anchored and not anchored.handled:
                for row in output["questions"]:
                    if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("text"), str):
                        key = compact(row["text"])
                        if len(anchored.evidence) < 5 or key in anchored.evidence:
                            anchored.evidence[key] = row
        policy = self.state.policy(turn.group)
        ordinary = turn.group and not turn.explicit
        quiet = ordinary and not self.adaptive(turn.group)
        allowed = {"no_action", "stop", "wait"}
        if turn.explicit:
            # 被 @ 或叫到名字时必须回一句，不许选沉默
            allowed.discard("no_action")
        if ordinary and not quiet:
            allowed.discard("wait")
        lookup_items = turn.lookup_items
        if not quiet and not (ordinary and turn.handled):
            allowed.update({"reply", "read_tool_result", "query_memory", "query_person_profile"})
            if lookup_items and policy.get("tools", True) and turn.needs_lookup and int(time.time() * 1000) < turn.lookup_deadline_ms:
                allowed.add("jinhua_lookup")
        tools = []
        for tool in kwargs["tool_definitions"]:
            function = tool.get("function", {})
            name = function.get("name")
            if name not in allowed:
                continue
            if name == "jinhua_lookup":
                values = {"anchor": turn.anchor, "mode": turn.mode, "deadline_ms": turn.lookup_deadline_ms}
                schema = function["parameters"]
                for key, value in values.items():
                    schema["properties"][key]["enum"] = [value]
                    if key not in schema["required"]:
                        schema["required"].append(key)
            elif name == "reply":
                properties = function.get("parameters", {}).get("properties", {})
                properties.pop("attach_pic", None)
                try:
                    has_emoji = await self.emoji_ready()
                except Exception:
                    has_emoji = False
                if not has_emoji or not policy.get("media", True):
                    # 表情库空时上游解析会失败（只打 warning），没必要让模型去填
                    properties.pop("attach_emoji", None)
                elif "attach_emoji" in properties:
                    emoji = properties["attach_emoji"]
                    emoji["description"] = "按情绪或画面从已审核表情库选一张。只有表情能补充这句回复时才填写。" 
            tools.append(tool)
        kwargs["tool_definitions"] = tools
        self.active_tools[session] = (turn.anchor, {tool["function"]["name"] for tool in tools})
        if not quiet:
            hint = (
                "\n金桦规则：真实点名、回复档位与私聊优先回复。"
                "赛事、价格、排名等当下事实先调用 jinhua_lookup。多问一次逐题传入原问题，沿用原顺序。"
                "拿到查询状态后调用 reply，部分失败照常答已查到的题。"
                "短接话一条就够，真正有转折或第二个意思再分条。"
            )
            if ordinary:
                hint += (
                    "\n自适应接话：结合最近几轮，判断新消息是不是在对金桦说话。先看这句话当前在叫谁。"
                    "句首用其他人的称呼叫人，或明确 @、引用其他群友来对他说话，用 stop。"
                    "即使这个人刚刚还在和你聊天，或你刚问过他想试哪句，也别替被点到的人答或复述他的话。"
                    "如果上一句是你在回复这个人，对方接着用『你』『你的』回应、反驳、调侃或追问，"
                    "即使换了话题或没重复你的原话，也算在和你续聊。用 reply，msg_id 选这条新消息。"
                    "群友互聊、对全群广播，或只是在谈论金桦时，用 stop。先认清对象，再决定是否查工具或回复。"
                )
            if lookup_items and "jinhua_lookup" in allowed:
                hint += "\n下列查询项的 text 保留原句，别改写。" + " / ".join(lookup_items)
            if turn.topic:
                hint += " 当前是管理员请求话题，请对当前消息回一条自然的开黑话头。"
            for item in kwargs["items"]:
                if item.get("item_type") == "SystemMessageItem":
                    item["parts"].append({"type": "text", "text": hint})
                    break
        return {"action": "continue", "modified_kwargs": kwargs}

    @HookHandler("maisaka.planner.after_response", mode=HookMode.BLOCKING)
    async def planner_result(self, **kwargs):
        active = self.active_tools.get(kwargs["session_id"])
        if active is None:
            return {"action": "continue"}
        anchor, allowed = active
        turn = self.get_turn(kwargs["session_id"], anchor)
        if turn is None:
            return {"action": "continue"}
        items = kwargs["output_items"]
        checking = "jinhua_lookup" in allowed and any(
            item.get("tool_call", {}).get("func_name") == "jinhua_lookup" for item in items
        )
        accepted = []
        for item in items:
            if item.get("item_type") == "FunctionCallItem":
                call = item.get("tool_call", {})
                name = call.get("func_name")
                if name not in allowed or checking and name in {"reply", "send_emoji", "stop", "wait"}:
                    continue
                if name == "jinhua_lookup":
                    turn.lookup_attempts += 1
                    call["args"].update(anchor=anchor, mode=turn.mode, deadline_ms=turn.lookup_deadline_ms)
                elif name == "reply":
                    args = call["args"]
                    args.pop("attach_pic", None)
                    if not re.search(r"@\S|(?:请|帮我)\s*(?:提及|提醒|叫)(?:一下)?\s*\S", turn.text):
                        args.pop("attach_at", None)
                    args.pop("attach_emoji", None)
            accepted.append(item)
        kwargs["output_items"] = accepted
        if turn.group and not turn.explicit:
            actions = [item["tool_call"]["func_name"] for item in accepted if item.get("item_type") == "FunctionCallItem"]
            self.ctx.logger.info("金桦接话判断 msg_id=%s action=%s", anchor, ",".join(actions) or "none")
        return {"action": "continue", "modified_kwargs": kwargs}

    @HookHandler("maisaka.replyer.before_request", mode=HookMode.BLOCKING)
    async def replyer(self, **kwargs):
        turn = self.get_turn(kwargs["session_id"], kwargs.get("reply_message_id"))
        if not turn:
            return {"action": "continue"}
        aliases = self.state.aliases()
        name = aliases.get(turn.user, {}).get("name") or ""
        roster = sorted({record.get("name") for record in aliases.values() if record.get("name")})
        prompt = (
            "直接接对方这一句，找一个具体细节。普通接话一句就够，别把群友原句复述一遍。"
            "求助先接感受，再给一个办法；玩笑就顺着当下的梗接。"
            "例句只展示节奏。具体赛果、旧事、身份和完成过的动作以会话或工具证据为准。"
            "信息不够时直接问最相关的一个细节。"
        )
        if name == "张睿诚":
            prompt += (
                " 当前是已验证的诚哥。熟人之间他让你接什么就先接住，服软也俏皮一点。"
                "平时一句『行行行 听你的』的松弛劲就够，叫法看当前聊天，他要夸就认真夸。"
            )
        if self.state.policy(turn.group).get("flirt", True) and (
            name == "刘浩文" or any(record.get("name") == "刘浩文" for record in aliases.values())
            and re.search(r"刘浩文|lhw|浩文", turn.text, re.I)
        ):
            prompt += (
                " 对刘浩文嘴上可以轻轻顶一句，话里偏心他。用反问或半句话留个来回，他说想歇就顺着。"
                "别人拿他开涮时可以替他挡一句，轻损之后给他留台阶。"
            )
        if roster:
            prompt += (
                " 群里已经认出来的真人："
                + "、".join(roster)
                + "。被问到其中某个人时算认识，可以说对他的印象和你俩的关系；"
                "问到不在名单里的人，就直说不认识别编。"
            )
        if not name:
            prompt += " 对方的群名片可作称呼。自报认识的人时，熟人关系以绑定为准。"
            if RELATIONSHIP_CLAIM.search(turn.text):
                prompt += " 对方在声称一个熟人身份。提醒用 /绑定，当前按普通群友语气接话。"
        if turn.topic:
            prompt += " 有合适的群话题时用一个具体细节留个话口。"
        kwargs["extra_prompt"] = str(kwargs.get("extra_prompt") or "") + "\n" + prompt
        if turn.mode == "deep" and self.config.deep_model_name:
            kwargs["model_name"] = self.config.deep_model_name
        if turn.mode == "fast" and self.config.fast_model_name:
            kwargs["model_name"] = self.config.fast_model_name
        return {"action": "continue", "modified_kwargs": kwargs}

    @HookHandler("maisaka.reply.before_post_process", mode=HookMode.BLOCKING)
    async def compose(self, **kwargs):
        turn = self.get_turn(kwargs["session_id"], kwargs.get("reply_message_id"))
        if turn is None:
            return {"action": "continue"}
        answer = visible_text(kwargs["response"])
        if turn.evidence or turn.lookup_items:
            answer = turn.grounded_text() or "这题没查到"
            kwargs["skip_post_process"] = True
        elif not self.state.name(turn.user) and RELATIONSHIP_CLAIM.search(turn.text):
            answer = "想让我认出你，先用 /绑定 呗"
            kwargs["skip_post_process"] = True
        elif not answer:
            if not turn.explicit:
                return abort("回复没有可发送内容")
            answer = "刚才卡了一下 你再说一句"
        else:
            kwargs["enable_splitter"] = len(answer) >= 45
        kwargs["enable_chinese_typo"] = False
        kwargs["response"] = answer
        return {"action": "continue", "modified_kwargs": kwargs}

    async def emoji_ready(self) -> bool:
        """表情库是否有可用素材；结果缓存 5 分钟，避免每条消息都探测。"""
        now = time.time()
        cached = getattr(self, "_emoji_ready", None)
        if cached and now - cached[0] < 300:
            return cached[1]
        ready = False
        try:
            result = await self.ctx.call_capability("emoji.get_by_description", description="笑", limit=1)
            ready = bool(result.get("emoji")) if isinstance(result, dict) else False
        except Exception:
            ready = False
        self._emoji_ready = (now, ready)
        return ready

    @HookHandler("send_service.after_send", mode=HookMode.BLOCKING)
    async def after_send(self, **kwargs):
        message = kwargs.get("message") or {}
        if message.get("platform") != "qq":
            return {"action": "continue"}
        text = message.get("processed_plain_text") or ""
        self.ctx.logger.info(
            "金桦出站完成 session=%s target=%s len=%s ok=%s",
            str(message.get("session_id"))[:12], str(kwargs.get("target_id") or "")[:12], len(text), kwargs.get("success", "?"),
        )
        return {"action": "continue"}


    # QQ 客户端对 Unicode emoji 支持有限：新版、带 VS16 变体符、ZWJ 组合和肤色修饰
    # 都会显示成方块。这里在出站前按 EMOJI_MODE 处理。
    EMOJI_SAFE = set("\U0001F600\U0001F601\U0001F602\U0001F603\U0001F604\U0001F605\U0001F60A"
                     "\U0001F609\U0001F60E\U0001F62D\U0001F621\U0001F44D\U0001F44E"
                     "\U0001F64F\U0001F525\U0001F480\u2728\u2764")
    EMOJI_RANGES = ((0x1F000, 0x1FAFF), (0x2600, 0x27BF), (0x2B00, 0x2BFF),
                    (0xFE00, 0xFE0F), (0x200D, 0x200D), (0x1F3FB, 0x1F3FF))

    def sanitize_emoji(self, segments) -> int:
        mode = (os.environ.get("EMOJI_MODE") or "safe").strip().lower()
        if mode == "all":
            return 0
        dropped = [0]

        def clean(text: str) -> str:
            out = []
            for ch in text:
                code = ord(ch)
                if any(lo <= code <= hi for lo, hi in self.EMOJI_RANGES):
                    if mode == "strip" or ch not in self.EMOJI_SAFE:
                        dropped[0] += 1
                        continue
                out.append(ch)
            return "".join(out)

        for seg in segments:
            if seg.get("type") == "text" and isinstance(seg.get("data"), str):
                cleaned = clean(seg["data"])
                if cleaned != seg["data"]:
                    seg["data"] = re.sub(r"[ \t]{2,}", " ", cleaned).strip()
        return dropped[0]

    @HookHandler("send_service.before_send", mode=HookMode.BLOCKING)
    async def before_send(self, **kwargs):
        message = kwargs["message"]
        if message.get("platform") != "qq":
            return {"action": "continue"}
        anchor = message.get("reply_to") or kwargs.get("reply_message_id")
        turn = self.get_turn(message["session_id"], anchor) if anchor else None
        if not turn:
            return abort("金桦出站需要当前会话的入站锚点")
        now = int(time.time() * 1000)

        # 锚点可能指向一条更早的消息：若它已超时、而同一会话有更新的回合，改用最新回合
        newest = self.get_turn(message["session_id"], None)
        if newest and newest.anchor != turn.anchor and now >= turn.expires_ms and newest.expires_ms > now:
            self.ctx.logger.warning(
                "发送锚点过期，改用最新回合 anchor=%s -> %s（相差 %.1fs）",
                turn.anchor[:14], newest.anchor[:14], (newest.received_ms - turn.received_ms) / 1000,
            )
            turn = newest

        if now >= turn.expires_ms:
            self.ctx.logger.warning(
                "金桦出站已超时 msg_id=%s elapsed_ms=%s budget_ms=%s over_ms=%s",
                anchor, now - turn.received_ms, BUDGET_MS[turn.mode], now - turn.expires_ms,
            )
            return abort("当前回合已经超时")
        policy = self.state.policy(turn.group)
        if turn.group and not turn.explicit and not self.adaptive(turn.group):
            return abort("当前群处于仅点名或静默时段")
        segments = message.get("raw_message", [])
        try:
            dropped = self.sanitize_emoji(segments)
        except Exception:
            dropped = 0
        if dropped:
            try:
                self.ctx.logger.info("金桦出站清理不兼容表情 %d 个 mode=%s", dropped, os.environ.get("EMOJI_MODE") or "safe")
            except Exception:
                pass
        media = sum(seg.get("type") in {"image", "emoji"} for seg in segments)
        if media and (not policy.get("media", True) or turn.media + media > 1):
            return abort("媒体关闭或本轮已发过图片")
        parts = 0
        text_pending = False
        for seg in segments:
            if seg.get("type") in {"text", "at"}:
                text_pending = True
            elif seg.get("type") in {"image", "emoji", "file", "video", "voice"}:
                parts += int(text_pending) + 1
                text_pending = False
        parts += int(text_pending)
        hard_cap = 5 if turn.group else 4
        value = policy.get("replyLimit", hard_cap)
        limit = min(hard_cap, value) if type(value) is int and value > 0 else hard_cap
        if not turn.evidence and not turn.lookup_items:
            limit = min(limit, 2)
        if not parts or turn.lines + parts > limit:
            return abort("当前回合回复条数达到上限")
        try:
            self.ctx.logger.info(
                "金桦出站放行 anchor=%s parts=%s limit=%s elapsed_ms=%s",
                turn.anchor[:14], parts, limit, now - turn.received_ms,
            )
        except Exception:
            pass
        kwargs["typing"] = False
        return {"action": "continue", "modified_kwargs": kwargs}

    @HookHandler("send_service.after_send", mode=HookMode.BLOCKING)
    async def after_send(self, **kwargs):
        message = kwargs["message"]
        anchor = message.get("reply_to") or kwargs.get("reply_message_id")
        turn = self.get_turn(message["session_id"], anchor) if anchor else None
        if turn and message.get("platform") == "qq":
            sent = bool(kwargs.get("sent"))
            if turn.group and not turn.explicit:
                self.ctx.logger.info("金桦接话发送 msg_id=%s sent=%s", anchor, sent)
            if not sent:
                return {"action": "continue"}
            turn.lines += 1
            turn.media += int(any(seg.get("type") in {"image", "emoji"} for seg in message.get("raw_message", [])))
            turn.handled = True
        return {"action": "continue"}


def create_plugin() -> JinhuaPlugin:
    return JinhuaPlugin()
