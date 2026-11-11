"""Replay synthetic QQ events through the installed MaiBot without connecting to QQ."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from configure import configure, load, save, set_values
from jinhua.state import write_json


ROOT = Path(__file__).resolve().parents[1]
BOT_ID = "F0" * 16


def prepare(instance: Path, node: Path, variant: str, cases: list[dict]) -> None:
    os.environ["MAIBOT_INSTANCE_DIR"] = str(instance)
    os.environ["MAIBOT_RUNTIME_CONTEXT"] = json.dumps({
        "bot_id": BOT_ID.lower(), "http_endpoint": "127.0.0.1:0", "public_base_url": "http://127.0.0.1",
        "status_path": str(instance / "worker-status.json"),
    })
    for name in ("QQ_APP_ID", "QQ_APP_SECRET", "JINHUA_ADMIN_OPENIDS", "JINHUA_PLANNER_MODEL", "JINHUA_REPLY_MODEL",
                 "JINHUA_FAST_MODEL", "JINHUA_DEEP_MODEL", "JINHUA_EMBEDDING_MODEL"):
        os.environ.pop(name, None)

    plugin = instance / "plugins" / "jinhua"
    bot_file = instance / "config" / "bot_config.toml"
    stock = load(bot_file)
    configure(ROOT, instance, node, variant == "smoke" and os.getenv("NODE_USE_ENV_PROXY") == "1",
              legacy_data=instance / "empty-legacy")
    write_json(plugin / "legacy.json", {
        "aliases": {case["user"]: {"name": case["verified_name"], "verified": True}
                    for case in cases if case.get("verified_name")},
        "groups": {case["id"]: {"interject": True, "quiet": [0, 0]} for case in cases if case.get("interject")},
    })
    bot = load(bot_file)
    if variant == "stock":
        stock["mcp"] = bot["mcp"]
        bot = stock
        plugin_file = plugin / "config.toml"
        config = load(plugin_file)
        set_values(config, ("plugin",), {"enabled": False})
        save(plugin_file, config)
    set_values(bot, ("telemetry",), {"enable": False})
    set_values(bot, ("bot",), {"nickname": "金桦"})
    set_values(bot, ("maim_message",), {"enabled": False})
    set_values(bot, ("webui",), {"enabled": False})
    set_values(bot, ("a_memorix", "plugin"), {"enabled": False})
    set_values(bot, ("chat", "reply_timing"), {
        "message_debounce_mode": "fast", "inevitable_at_reply": True, "mentioned_bot_reply": True,
    })
    access_file = instance / "config" / "adapter_policy.toml"
    access = load(access_file)
    set_values(access, ("defaults", "group"), {"default_action": "block", "allow_ids": [case["id"] for case in cases]})
    save(access_file, access)
    for server in bot["mcp"]["servers"]:
        if server["name"] == "jinhua-readonly" and variant != "smoke":
            server["args"] = [str(ROOT / "maibot" / "replay-tools.mjs")]
    save(bot_file, bot)


async def run(instance: Path, cases: list[dict], concurrency: int, wait_seconds: int) -> list[dict]:
    from src.common.utils.utils_message import MessageUtils
    from src.common.utils.utils_session import SessionUtils
    from src.main import MainSystem, main
    from src.platform_io.drivers.base import PlatformIODriver
    from src.platform_io.manager import get_platform_io_manager
    from src.platform_io.types import (
        DeliveryReceipt, DeliveryStatus, DriverDescriptor, DriverKind, InboundMessageEnvelope, RouteBinding,
    )
    from src.plugin_runtime.hook_payloads import deserialize_session_message
    from src.plugins.built_in.qq_official_adapter.codec import GROUP_EVENT, GROUP_MESSAGE_EVENT, decode_message

    class ReplayDriver(PlatformIODriver):
        def __init__(self):
            super().__init__(DriverDescriptor("qq-replay", DriverKind.LOCAL, "qq", account_id=BOT_ID))
            self.deliveries: dict[str, list[tuple[float, str]]] = {}

        async def send_message(self, message, route_key, metadata=None):
            group = message.message_info.group_info.group_id
            items = self.deliveries.setdefault(group, [])
            text = message.processed_plain_text or "".join(
                item["data"] if item["type"] == "text" else "[" + item["type"] + "]"
                for item in message.raw_message.to_dict()
            )
            items.append((time.monotonic(), text))
            return DeliveryReceipt(message.message_id, route_key, DeliveryStatus.SENT, driver_id=self.driver_id,
                                   external_message_id=f"out-{group}-{len(items)}")

        def message(self, case, number, text, *, at):
            event = GROUP_EVENT if at else GROUP_MESSAGE_EVENT
            speaker = {"member_openid": case.get("user", "fixture"), "username": case.get("name", "队友"),
                       "member_role": case.get("role", "member")} if number == "prompt" else {
                           "member_openid": "previous-speaker", "username": "小鱼"}
            message, _, _ = decode_message(event, {
                "id": f"{case['id']}-{number}", "group_openid": case["id"], "content": text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "author": speaker,
            }, BOT_ID, bot_name="金桦", group_name="开黑小群")
            return message

        async def submit(self, case, text, *, at):
            message = self.message(case, "prompt", text, at=at)
            manager = get_platform_io_manager()
            key = manager.build_route_key_from_message_dict(message)
            if not await self.emit_inbound(InboundMessageEnvelope(key, self.driver_id, DriverKind.LOCAL,
                                                                   external_message_id=message["message_id"], payload=message)):
                raise RuntimeError(f"回放事件未被接收 {case['id']}")

    # Use the upstream startup and shutdown. Replace the network listener and recurring scheduler for the replay.
    MainSystem._start_http_server = lambda _: None
    results = []

    async def replay(_):
        driver = ReplayDriver()
        manager = get_platform_io_manager()
        await manager.add_driver(driver)
        binding = RouteBinding(driver.descriptor.route_key, driver.driver_id, DriverKind.LOCAL)
        manager.bind_receive_route(binding)
        manager.bind_send_route(binding)
        semaphore = asyncio.Semaphore(concurrency)

        async def one(case):
            async with semaphore:
                session = SessionUtils.calculate_session_id("qq", user_id=case.get("user", "fixture"),
                                                            group_id=case["id"], account_id=BOT_ID)
                for index, text in enumerate(case.get("context", [])):
                    saved = driver.message(case, index, text, at=False)
                    saved["session_id"] = session
                    await MessageUtils.store_message_to_db_async(deserialize_session_message(saved))
                started = time.monotonic()
                await driver.submit(case, case["text"], at=case.get("at", True))
                end = started + wait_seconds
                while time.monotonic() < end:
                    await asyncio.sleep(0.2)
                    deliveries = driver.deliveries.get(case["id"], [])
                    if deliveries and time.monotonic() - deliveries[-1][0] >= 0.9:
                        break
                deliveries = driver.deliveries.get(case["id"], [])
                with sqlite3.connect(instance / "data" / "MaiBot.db") as database:
                    tool_rows = database.execute("SELECT tool_name, tool_data FROM tool_records WHERE session_id = ?", (session,)).fetchall()
                    calls = database.execute("SELECT count(*) FROM llm_usage WHERE session_id = ?", (session,)).fetchone()[0]
                tools = []
                for name, raw in tool_rows:
                    data = json.loads(raw) if raw else {}
                    tool = {"name": name, "arguments": data.get("arguments", {}), "success": data.get("success")}
                    if name == "jinhua_lookup" and data.get("success"):
                        try:
                            tool["result"] = json.loads(data["content"])
                        except (KeyError, ValueError, TypeError):
                            pass
                    tools.append(tool)
                return {"id": case["id"], "text": [text for _, text in deliveries], "model_calls": calls,
                        "first_ms": int(1000 * (deliveries[0][0] - started)) if deliveries else None,
                        "tools": tools}

        results.extend(await asyncio.gather(*(one(case) for case in cases)))

    MainSystem.schedule_tasks = replay
    await main()
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--variant", choices=("candidate", "stock", "smoke"), default="candidate")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--wait", type=int, default=20)
    args = parser.parse_args()
    if not os.getenv("LLM_BASE_URL") or not os.getenv("LLM_MODEL") or args.concurrency < 1 or args.wait < 1:
        sys.exit("需要配置 LLM_BASE_URL 和 LLM_MODEL，并提供正数的并发及等待时间")
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    instance = args.instance.resolve()
    prepare(instance, args.node, args.variant, cases)
    report = asyncio.run(run(instance, cases, args.concurrency, args.wait))
    write_json(instance / "replay.json", report)
