"""Preview legacy Jinhua data without changing the source directory."""

from __future__ import annotations

from pathlib import Path

from jinhua.state import OPENID, read_json, read_member_records, write_json


def rows(path: Path):
    import json

    if not path.is_file():
        return
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                yield value


def preview(data: Path, output: Path) -> dict:
    groups = {}
    for file in sorted((data / "groups").glob("*.json")):
        if not OPENID.fullmatch(file.stem):
            continue
        legacy = read_json(file, {})
        features = legacy.get("features", {})
        # Every imported group needs a fresh full-message and passive-reply smoke.
        groups[file.stem] = {
            "interject": False, "flirt": features.get("flirt", True),
            "tools": features.get("tools", features.get("search", True)),
            "search": features.get("search", False), "topic": features.get("topic", True),
            "replyMode": legacy.get("replyMode", "auto"), "replyLimit": legacy.get("replyLimit", 5),
            "quiet": legacy.get("quiet", [2, 8]), "media": True,
        }
    aliases = {
        **(read_member_records(data / "profiles.json", verified_only=True) or {}),
        **(read_member_records(data / "aliases.json") or {}),
    }

    grouped = {}
    orphaned = []
    sources = {}
    seen = set()
    for episode in rows(data / "episodes.jsonl"):
        key = str(episode.get("key") or "")
        source = str(episode.get("sourceId") or "")
        private = key.startswith("c2c:")
        target = key[4:] if private else key
        if not target or not OPENID.fullmatch(target) or not source or not episode.get("text"):
            orphaned.append(episode)
            continue
        storage = ("c2c_" + target) if private else target
        # The old layout replaced ':' with '_'. A group with that prefix is ambiguous.
        if not private and storage.startswith("c2c_"):
            orphaned.append(episode)
            continue
        if storage not in sources:
            sources[storage] = {
                str(row["id"]) for path in (data / "working" / storage).glob("*.jsonl")
                for row in rows(path) if row.get("id")
            }
        identity = (key, source, episode.get("type", "memo"))
        if identity in seen:
            continue
        if source not in sources[storage]:
            orphaned.append(episode)
            continue
        seen.add(identity)
        grouped.setdefault(key, []).append(episode)

    review_dir = output / "memory-review"
    review_dir.mkdir(parents=True, exist_ok=True)
    index = []
    for key, items in grouped.items():
        scope, target = ("private", key[4:]) if key.startswith("c2c:") else ("group", key)
        path = review_dir / f"{scope}-{target}.txt"
        path.write_text("\n\n".join(
            f"来源消息 {row['sourceId']}\n{row['text']}" for row in items
        ) + "\n", encoding="utf-8")
        index.append({"file": path.name, "scope": scope, "target_openid": target, "count": len(items)})

    write_json(review_dir / "index.json", index)
    write_json(review_dir / "unresolved.json", orphaned)
    seed = {
        "aliases": aliases, "codes": read_json(data / "bind-codes.json", {}), "groups": groups,
        "claims": {key: [row for row in items if row.get("type") == "claim"] for key, items in grouped.items()},
    }
    summary = {"aliases": len(aliases), "groups": len(groups), "scoped_records": len(seen), "unresolved": len(orphaned)}
    return {"seed": seed, "summary": summary}
