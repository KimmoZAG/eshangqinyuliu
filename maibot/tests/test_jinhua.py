import asyncio
import json
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jinhua.state import State
from jinhua.turn import Turn, evidence_outputs
from migrate import preview


class MigrationTests(unittest.TestCase):
    def test_only_scoped_sources_are_exported_for_review(self):
        with tempfile.TemporaryDirectory() as scratch:
            base = Path(scratch)
            source = base / "legacy"
            scoped = source / "working" / "group"
            scoped.mkdir(parents=True)
            (scoped / "day.jsonl").write_text('{"id":"s1"}\n', encoding="utf-8")
            episode = {"key": "group", "sourceId": "s1", "text": "游戏群约定", "type": "claim"}
            archive = source / "episodes.jsonl"
            payload = "\n".join(json.dumps(item) for item in [
                episode, episode, {**episode, "key": "other"}, {**episode, "sourceId": "missing"},
            ])
            archive.write_text(payload, encoding="utf-8")
            result = preview(source, base / "pilot")
            self.assertEqual(result["summary"]["scoped_records"], 1)
            self.assertEqual(result["summary"]["unresolved"], 2)
            self.assertIn("s1", (base / "pilot" / "memory-review" / "group-group.txt").read_text(encoding="utf-8"))
            self.assertEqual(archive.read_text(encoding="utf-8"), payload)

    def test_binding_is_persisted_and_one_time(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            state = State(directory, directory / "missing.json")
            state.value["codes"]["CODE"] = {"name": "张睿诚", "expireAt": "2099-11-01T12:00:00Z"}
            self.assertIn("张睿诚", state.redeem(" code ", "openid"))
            self.assertEqual(State(directory, directory / "missing.json").name("openid"), "张睿诚")
            self.assertIn("用过", state.redeem("code", "other"))

    def test_existing_instance_reads_legacy_alias_edits_by_openid(self):
        with tempfile.TemporaryDirectory() as scratch:
            base = Path(scratch)
            data = base / "data"
            data.mkdir()
            seed = base / "legacy.json"
            seed.write_text(json.dumps({"aliases": {"old": {"name": "安装时的别名"}}}), encoding="utf-8")
            directory = base / "plugin"
            previous = State(directory, seed)
            previous.value["aliases"]["native"] = {"name": "新版绑定"}
            previous.value["codes"]["CODE"] = {"name": "口令绑定", "expireAt": "2099-11-01T12:00:00Z"}
            previous.save()

            state = State(directory, seed, data)
            self.assertEqual(state.name("old"), "安装时的别名")
            aliases = data / "aliases.json"
            aliases.write_text(json.dumps({"old": {"name": "新别名"}, "native": {"name": "管理员称呼"}}),
                               encoding="utf-8-sig")
            (data / "profiles.json").write_text(json.dumps({
                "native": {"name": "旧画像", "verified": True},
                "verified": {"name": "已验证旧画像", "verified": True},
                "self-reported": {"name": "自报名片", "verified": False},
            }), encoding="utf-8")
            self.assertEqual(state.name("old"), "新别名")
            self.assertEqual(state.name("native"), "管理员称呼")
            self.assertEqual(state.name("verified"), "已验证旧画像")
            self.assertEqual(state.name("self-reported"), "")
            self.assertIn("管理员称呼", state.redeem("CODE", "native"))
            self.assertNotIn("usedAt", state.value["codes"]["CODE"])

            aliases.write_text("{}", encoding="utf-8")
            self.assertEqual(state.name("old"), "")
            self.assertEqual(state.name("native"), "新版绑定")
            self.assertIn("口令绑定", state.redeem("CODE", "native"))
            self.assertEqual(State(directory, seed, data).name("native"), "口令绑定")
            self.assertEqual(aliases.read_text(encoding="utf-8"), "{}")


class EvidenceTests(unittest.TestCase):
    def test_tool_outputs_have_scope_and_missing_question_keeps_a_status(self):
        turn = Turn("msg-1", "member", "group", "T1 下场打谁，Steam 星露谷多少钱", True, "auto", 0)
        output = {"jinhua_evidence": 1, "anchor": "msg-1", "questions": [
            {"id": "q1", "text": "T1 下场打谁", "status": "ok", "answer": "T1 vs HLE"},
        ]}
        items = [{"item_type": "UserMessageItem", "output": output}, {
            "item_type": "FunctionCallOutputItem", "tool_name": "jinhua_lookup", "output": json.dumps(output),
        }]
        results = list(evidence_outputs(items))
        self.assertEqual(len(results), 1)
        turn.evidence["T1 下场打谁"] = results[0]["questions"][0]
        self.assertIn("T1 vs HLE", turn.grounded_text())
        self.assertIn("星露谷多少钱」这块没查到", turn.grounded_text())

    def test_planner_rephrasing_does_not_duplicate_evidence_or_missing_status(self):
        turn = Turn("msg-1", "member", "group", "今天 LEC 有比赛吗？再查那场录像", True, "auto", 0)
        turn.evidence = {
            "schedule": {"text": "今天 LEC 有比赛吗", "status": "ok", "answer": "G2 vs FNC"},
            "vod": {"text": "查 G2 vs FNC 那场录像", "status": "ok", "answer": "https://example.test/vod"},
        }
        self.assertEqual(turn.grounded_text(), "G2 vs FNC\nhttps://example.test/vod")
        self.assertFalse(turn.needs_lookup)


class InstalledUpstreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_amemorix_sparse_read_keeps_reviewed_records_in_scope(self):
        from src.A_memorix.host_service import a_memorix_host_service
        from src.common.runtime_loop import set_main_loop
        from src.config.config import config_manager

        config = config_manager.get_global_config().a_memorix
        config.plugin.enabled = True
        config.global_memory_sharing_enabled = False
        config.shared_memory_groups = []
        config.episode.generation_enabled = False
        config.retrieval.sparse.tokenizer_mode = "mixed"
        set_main_loop(asyncio.get_running_loop())
        service = a_memorix_host_service
        try:
            await service.start()
            await asyncio.wait_for(asyncio.shield(service._startup_task), 20)
            record = {
                "external_id": "synthetic-source", "chat_id": "group-synthetic",
                "text": "青玉杯每周三晚上举行。", "metadata": {"trust": "manual_confirmed"},
            }
            stored = await service.invoke("ingest_summary", record)
            self.assertTrue(stored.get("stored_ids"), stored)
            group = await service.invoke("search_memory", {"query": "青玉杯", "chat_id": "group-synthetic"})
            private = await service.invoke("search_memory", {"query": "青玉杯", "chat_id": "private-synthetic"})
            self.assertIn("青玉杯", json.dumps(group.get("hits"), ensure_ascii=False), group)
            self.assertEqual(private.get("hits"), [], private)
        finally:
            await service.stop()
            set_main_loop(None)

    async def test_qq_text_callout_keeps_native_tool_and_command_available(self):
        from jinhua.plugin import JinhuaPlugin

        plugin = SimpleNamespace(
            state=SimpleNamespace(policy=lambda _: {}, name=lambda _: ""), turns={}, active_tools={}, started=time.time(),
        )
        plugin.remember = lambda session, turn: plugin.turns.update({session: turn})
        plugin.get_turn = lambda session: plugin.turns.get(session)
        plugin.planning_turn = lambda session: JinhuaPlugin.planning_turn(plugin, session)
        message = {
            "message_id": "callout", "session_id": "pilot", "platform": "qq", "is_at": False,
            "message_info": {"additional_config": {
                "qq_official_user_openid": "member", "qq_official_group_openid": "pilot",
            }},
            "processed_plain_text": "@金桦 Steam 星露谷物语多少钱？",
            "raw_message": [{"type": "text", "data": "@金桦 Steam 星露谷物语多少钱？"}],
        }
        plugin.registrations = {}
        await JinhuaPlugin.receive(plugin, message=message)
        turn = plugin.turns["pilot"]
        self.assertTrue(turn.explicit)
        self.assertTrue(message["is_mentioned"])
        self.assertFalse(message["is_at"])
        schema = {"properties": {name: {} for name in ("anchor", "deadline_ms", "mode")}, "required": []}
        plan = await JinhuaPlugin.planner(plugin, session_id="pilot", items=[], tool_definitions=[
            {"function": {"name": "jinhua_lookup", "parameters": schema}},
            {"function": {"name": "reply"}}, {"function": {"name": "set_mute"}},
        ])
        self.assertEqual([item["function"]["name"] for item in plan["modified_kwargs"]["tool_definitions"]],
                         ["jinhua_lookup", "reply"])
        self.assertEqual(schema["properties"]["anchor"]["enum"], ["callout"])

        message["processed_plain_text"] = message["raw_message"][0]["data"] = "@金桦 /发图 联调图"
        await JinhuaPlugin.receive(plugin, message=message)
        self.assertEqual(message["processed_plain_text"], "/发图 联调图")

    async def test_qq_context_uses_legacy_alias_without_replacing_user_id(self):
        from jinhua.plugin import JinhuaPlugin

        with tempfile.TemporaryDirectory() as scratch:
            base = Path(scratch)
            openid = "A" * 32
            (base / "aliases.json").write_text(json.dumps({openid: {"name": "绑定称呼"}}), encoding="utf-8")
            plugin = SimpleNamespace(
                state=State(base / "plugin", base / "missing.json", base),
                remember=lambda *_: None, registrations={},
            )
            message = {
                "message_id": "in", "session_id": "pilot", "platform": "qq", "is_at": True,
                "message_info": {
                    "additional_config": {"qq_official_user_openid": openid, "qq_official_group_openid": "pilot"},
                    "user_info": {"user_id": "unified-id", "user_nickname": "QQ昵称", "user_cardname": "群名片"},
                },
                "processed_plain_text": "晚上好", "raw_message": [{"type": "text", "data": "晚上好"}],
            }
            result = await JinhuaPlugin.receive(plugin, message=message)
            user = result["modified_kwargs"]["message"]["message_info"]["user_info"]
            self.assertEqual(user, {"user_id": "unified-id", "user_nickname": "绑定称呼", "user_cardname": "绑定称呼"})

    async def test_qq_adaptive_uses_planner_instead_of_frequency_gates(self):
        from jinhua.plugin import JinhuaPlugin
        from src.maisaka.scenes.group.mentions import detect_mentions
        from src.maisaka.scenes.group.scheduling import GroupTurnScheduler
        from src.plugin_runtime.hook_payloads import deserialize_session_message
        from src.plugins.built_in.qq_official_adapter.codec import GROUP_MESSAGE_EVENT, decode_message

        policy = {"quiet": [0, 0]}
        plugin = SimpleNamespace(
            state=SimpleNamespace(policy=lambda _: policy, name=lambda _: ""), active_tools={}, registrations={},
        )
        turns = {}
        plugin.remember = lambda session, turn: turns.update({(session, turn.anchor): turn})
        plugin.get_turn = lambda session, anchor: turns.get((session, anchor))
        plugin.planning_turn = lambda session: next(reversed(turns.values()))
        plugin.quiet = lambda group: JinhuaPlugin.quiet(plugin, group)
        plugin.adaptive = lambda group: JinhuaPlugin.adaptive(plugin, group)

        def incoming(anchor, text):
            message, _, _ = decode_message(GROUP_MESSAGE_EVENT, {
                "id": anchor, "group_openid": "pilot", "author": {"member_openid": "member"}, "content": text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }, account_id="bot")
            return message

        message = incoming("followup", "我不要记功，我要实在一点的东西")
        session = message["session_id"]
        result = await JinhuaPlugin.receive(plugin, message=message)
        candidate = deserialize_session_message(result["modified_kwargs"]["message"])
        self.assertFalse(candidate.is_at or candidate.is_mentioned)
        runtime = SimpleNamespace(
            _get_message_quiet_period_remaining_seconds=lambda: 0,
            _is_reply_frequency_silent=lambda: False,
            _agent_state="wait", _STATE_WAIT="wait", _pending_wait_started_at=time.time(),
            message_cache=[candidate], _last_processed_index=0,
        )
        scheduler = GroupTurnScheduler(runtime)
        self.assertTrue(scheduler._evaluate(1).should_trigger)
        self.assertEqual(scheduler.accepted_wait_started_at, runtime._pending_wait_started_at)

        async def plan():
            return (await JinhuaPlugin.planner(plugin, session_id=session, items=[
                {"item_type": "SystemMessageItem", "parts": []},
            ], tool_definitions=[{"function": {"name": name}} for name in ("reply", "wait", "stop")]))["modified_kwargs"]

        planned = await plan()
        self.assertIn("判断新消息是不是在对金桦说话", planned["items"][0]["parts"][0]["text"])
        self.assertEqual([tool["function"]["name"] for tool in planned["tool_definitions"]], ["reply", "stop"])
        outgoing = {"platform": "qq", "session_id": session, "reply_to": "followup",
                    "raw_message": [{"type": "text", "data": "行 你开个价"}]}
        self.assertEqual((await JinhuaPlugin.before_send(plugin, message=outgoing))["action"], "continue")

        about_bot = incoming("about", "金桦今天在群里回得挺快")
        await JinhuaPlugin.receive(plugin, message=about_bot)
        self.assertFalse(turns[(session, "about")].explicit)
        self.assertFalse(detect_mentions(deserialize_session_message(about_bot))[1])

        policy["interject"] = False
        blocked = incoming("blocked", "还有呢")
        await JinhuaPlugin.receive(plugin, message=blocked)
        self.assertNotIn("jinhua_adaptive", blocked["message_info"]["additional_config"])
        self.assertNotIn("reply", [tool["function"]["name"] for tool in (await plan())["tool_definitions"]])
        self.assertEqual((await JinhuaPlugin.before_send(plugin, message=outgoing))["action"], "abort")

    async def test_qq_partial_delivery_keeps_actual_fragment(self):
        from src.plugins.built_in.qq_official_adapter.plugin import QQOfficialAdapterPlugin
        from src.platform_io.types import DeliveryBatch, DeliveryReceipt, DeliveryStatus, RouteKey
        from src.plugin_runtime.hook_payloads import deserialize_session_message
        from src.services.send_service import _qq_delivered_fragments

        adapter = SimpleNamespace(
            _ready=True, _id_map={"user": {}, "group": {}}, _account_id="bot",
            _group_user_map=lambda _: {}, _build_message_reference=lambda _: {},
            _claim_passive_fields=AsyncMock(side_effect=[
                {"msg_id": "in", "msg_seq": 1}, {"msg_id": "in", "msg_seq": 2},
            ]),
            _api_post=AsyncMock(return_value={"id": "text-ack"}), _store_send_ref_idx=lambda *_a, **_k: None,
            _upload_media=AsyncMock(side_effect=RuntimeError("upload failed")),
            ctx=SimpleNamespace(logger=SimpleNamespace(warning=lambda *_: None)),
        )
        payload = {
            "message_id": "local-out", "platform": "qq", "account_id": "bot", "scope": "group:group",
            "timestamp": time.time(), "session_id": "session", "reply_to": "in",
            "message_info": {"user_info": {"user_id": "bot", "user_nickname": "金桦"},
                             "group_info": {"group_id": "group", "group_name": "测试群"}},
            "raw_message": [{"type": "text", "data": "  到了  "},
                            {"type": "image", "data": "[图片]", "binary_data_base64": "iVBORw0KGgo=", "format": "png"}],
        }
        result = await QQOfficialAdapterPlugin.handle_qq_official_gateway(adapter, payload)
        self.assertTrue(result["success"], result)
        self.assertEqual([part["status"] for part in result["metadata"]["qq_official_parts"]], ["sent", "failed"])
        self.assertEqual(adapter._api_post.await_args.args[1]["msg_id"], "in")
        route = RouteKey(platform="qq", account_id="bot", scope="group:group")
        batch = DeliveryBatch("local-out", route, [
            DeliveryReceipt("local-out", route, DeliveryStatus.SENT, driver_id="gateway:qq:qq_official_gateway",
                            external_message_id="text-ack", metadata=result["metadata"]),
        ])
        message = deserialize_session_message(payload)
        fragments = _qq_delivered_fragments(message, batch)
        self.assertEqual([(item.message_id, item.processed_plain_text) for item in fragments], [("text-ack", "到了")])
        self.assertFalse(fragments[0].is_picture)

        adapter._claim_passive_fields = AsyncMock(return_value={})
        adapter._api_post.reset_mock()
        expired = await QQOfficialAdapterPlugin.handle_qq_official_gateway(adapter, payload)
        self.assertFalse(expired["success"])
        adapter._api_post.assert_not_awaited()
