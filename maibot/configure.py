"""Configure the pinned MaiBot instance. Run through the isolated environment."""

from __future__ import annotations

import argparse
import os
import re
import shutil
from pathlib import Path

import tomlkit

from jinhua.state import read_json, write_json
from migrate import preview


def load(file: Path):
    return tomlkit.parse(file.read_text(encoding="utf-8")) if file.is_file() else tomlkit.document()


def save(file: Path, document) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(".tmp")
    temporary.write_text(tomlkit.dumps(document), encoding="utf-8")
    temporary.replace(file)


def set_values(document, trail, values) -> None:
    section = document
    for key in trail:
        section = section.setdefault(key, tomlkit.table())
    for key, value in values.items():
        section[key] = value


def ids(env: str) -> list[str]:
    values = list(dict.fromkeys(item for item in re.split(r"[\s,]+", os.getenv(env, "")) if item))
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) for value in values):
        raise SystemExit(f"{env} 需要填写有效的 QQ OpenID，以逗号分隔")
    return values


def configure(root: Path, instance: Path, node: Path, node_proxy: bool, *, legacy_data: Path | None = None) -> None:
    legacy_data = legacy_data if legacy_data is not None else root / "data"
    plugin_source = root / "maibot" / "jinhua"
    plugin = instance / "plugins" / "jinhua"
    plugin.mkdir(parents=True, exist_ok=True)
    for path in plugin_source.iterdir():
        if path.is_file() and path.suffix in {".py", ".json"}:
            shutil.copyfile(path, plugin / path.name)
    first_run = not (plugin / "legacy.json").exists()
    if first_run:
        migration = preview(legacy_data, instance)
        write_json(plugin / "legacy.json", migration["seed"])
        print("旧数据预演", migration["summary"])

    plugin_config = load(plugin / "config.toml")
    set_values(plugin_config, ("plugin",), {"enabled": True, "config_version": "1.0.0"})
    plugin_config["legacy_data_dir"] = str(legacy_data.resolve())
    for setting, env in [
        ("admin_openids", "JINHUA_ADMIN_OPENIDS"), ("fast_model_name", "JINHUA_FAST_MODEL"),
        ("deep_model_name", "JINHUA_DEEP_MODEL"),
    ]:
        if env in os.environ:
            plugin_config[setting] = ids(env) if setting == "admin_openids" else os.environ[env].strip()
    save(plugin / "config.toml", plugin_config)

    bot_file = instance / "config" / "bot_config.toml"
    bot = load(bot_file)
    if first_run:
        profile = read_json(plugin / "persona.json", {})
        set_values(bot, ("bot",), {"nickname": "金桦", "alias_names": ["金桦", "金桦（黄石版）"]})
        set_values(bot, ("personality",), {
            **{key: profile[key] for key in ["personality", "behavior_style", "reply_style", "multiple_probability"]},
            "selected_profile": profile["name"], "profiles": [profile],
        })
        set_values(bot, ("chat", "reply_style"), {key: profile[key] for key in ("group_chat_prompt", "private_chat_prompts")})
        set_values(bot, ("chat", "reply_timing"), {
            "talk_value": 0.45, "message_debounce_mode": "fast", "private_message_debounce_mode": "fast",
            "inevitable_at_reply": True, "mentioned_bot_reply": True,
        })
        set_values(bot, ("response_splitter",), {"mode": "rule", "max_split_num": 2, "enable": True})
        set_values(bot, ("emoji",), {"steal_emoji": False, "do_replace": False})
        set_values(bot, ("telemetry",), {"enable": False})
        set_values(bot, ("capabilities",), {"tool_result_condense": False})
        set_values(bot, ("a_memorix",), {"global_memory_sharing_enabled": False, "shared_memory_groups": []})
        set_values(bot, ("a_memorix", "plugin"), {"enabled": True})
        set_values(bot, ("a_memorix", "retrieval", "sparse"), {"tokenizer_mode": "mixed"})
        set_values(bot, ("a_memorix", "integration"), {
            "person_fact_writeback_enabled": False, "chat_summary_writeback_enabled": False,
            "enable_person_profile_injection": False,
            "heuristic_memory_cross_chat_enabled": False, "heuristic_memory_recall_enabled": False,
            "fuzzy_modify_auto_execute_enabled": False,
        })
        set_values(bot, ("a_memorix", "episode"), {"generation_enabled": False})

    servers = list(bot.get("mcp", {}).get("servers", []))
    env = {"JINHUA_TOOL_CWD": str(root), "SEARCH_ENABLED": os.getenv("SEARCH_ENABLED", "0")}
    for name in ("JINHUA_MCP_CONFIG", "LOL_API_KEY", "LOL_API_BASE_URL", "OPGG_MCP_URL", "SEARCH_URL"):
        if os.getenv(name):
            env[name] = os.environ[name]
    if node_proxy:
        env["NODE_USE_ENV_PROXY"] = "1"
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"):
            if os.getenv(name):
                env[name] = os.environ[name]
    bridge = {
        "name": "jinhua-readonly", "enabled": True, "transport": "stdio", "command": str(node),
        "args": [str(root / "jinhua-mcp.mjs")], "env": env, "read_timeout_seconds": 25.0,
    }
    set_values(bot, ("mcp",), {"enable": True, "servers": [*filter(lambda item: item.get("name") != bridge["name"], servers), bridge]})
    save(bot_file, bot)

    model_file = instance / "config" / "model_config.toml"
    model_config = load(model_file)
    catalog_path = instance / "host" / "model_catalog.toml"
    model_catalog = load(catalog_path) if catalog_path.is_file() else model_config
    base = os.getenv("LLM_BASE_URL", "").strip().removesuffix("/").removesuffix("/chat/completions")
    model = os.getenv("LLM_MODEL", "").strip()
    if base and model:
        provider = "jinhua-local"
        providers = [item for item in model_catalog.get("api_providers", []) if item.get("name") != provider]
        key = os.getenv("LLM_API_KEY", "")
        providers.append({"name": provider, "base_url": base, "api_key": key,
                          "client_type": "openai", "auth_type": "bearer" if key else "none"})
        model_catalog["api_providers"] = providers
        models = [item for item in model_catalog.get("models", []) if item.get("api_provider") != provider]
        assignments = {
            "planner": os.getenv("JINHUA_PLANNER_MODEL") or model,
            "replyer": os.getenv("JINHUA_REPLY_MODEL") or model,
            "utils": model,
        }
        for task, identifier in assignments.items():
            name = "jinhua-" + task
            models.append({"name": name, "model_type": "llm", "model_identifier": identifier, "api_provider": provider})
            set_values(model_config, ("model_task_config", task), {
                "model_list": [name], "selection_strategy": "sequential",
                "hard_timeout": float(os.environ.get("JINHUA_TASK_TIMEOUT", "30")),
            })
        for env_var in ("JINHUA_FAST_MODEL", "JINHUA_DEEP_MODEL"):
            identifier = os.getenv(env_var)
            if identifier:
                name = "jinhua-" + ("fast" if env_var == "JINHUA_FAST_MODEL" else "deep")
                models.append({"name": name, "model_type": "llm", "model_identifier": identifier, "api_provider": provider})
                plugin_config["fast_model_name" if name.endswith("fast") else "deep_model_name"] = name
        if embed := os.getenv("JINHUA_EMBEDDING_MODEL"):
            models.append({"name": "jinhua-embedding", "model_type": "embedding", "model_identifier": embed, "api_provider": provider})
            set_values(model_config, ("model_task_config", "embedding"), {"model_list": ["jinhua-embedding"]})
        model_catalog["models"] = models
        if catalog_path.is_file():
            save(catalog_path, model_catalog)
        save(model_file, model_config)
        save(plugin / "config.toml", plugin_config)

    qq_file = instance / "config" / "builtin_plugins" / "qq_official_adapter" / "config.toml"
    qq = load(qq_file)
    set_values(qq, ("plugin",), {"enabled": False, "config_version": "0.4.15"})
    set_values(qq, ("mute",), {"enabled": False})
    set_values(qq, ("recall",), {"enabled": False})
    set_values(qq, ("qq_official",), {
        key: os.environ[env_key] for key, env_key in (("app_id", "QQ_APP_ID"), ("app_secret", "QQ_APP_SECRET"))
        if os.getenv(env_key)
    })
    save(qq_file, qq)

    allow_file = instance / "config" / "adapter_policy.toml"
    access = load(allow_file)
    for scope, name in (("group", "JINHUA_QQ_GROUPS"), ("private", "JINHUA_QQ_USERS")):
        if first_run or name in os.environ:
            set_values(access, ("defaults", scope), {"default_action": "block", "allow_ids": ids(name)})
    save(allow_file, access)


def set_qq(instance: Path, live: bool) -> None:
    path = instance / "config" / "builtin_plugins" / "qq_official_adapter" / "config.toml"
    adapter = load(path)
    if live:
        credentials = adapter.get("qq_official", {})
        if not credentials.get("app_id") or not credentials.get("app_secret"):
            raise SystemExit("缺少 QQ_APP_ID / QQ_APP_SECRET。填入本地配置后运行 configure")
        allowed = load(instance / "config" / "adapter_policy.toml").get("defaults", {})
        if not any(allowed.get(scope, {}).get("allow_ids") for scope in ("group", "private")):
            raise SystemExit("先通过 JINHUA_QQ_GROUPS 或 JINHUA_QQ_USERS 配置至少一个测试会话")
    set_values(adapter, ("plugin",), {"enabled": live})
    save(path, adapter)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["configure", "offline", "live", "memory-review"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--instance", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--node-proxy", action="store_true")
    args = parser.parse_args()
    if args.action == "configure":
        configure(args.root, args.instance, args.node, args.node_proxy)
    elif args.action == "memory-review":
        print(preview(args.root / "data", args.instance)["summary"])
    else:
        set_qq(args.instance, args.action == "live")
