from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


OPENID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def read_member_records(path: Path, *, verified_only: bool = False) -> dict | None:
    try:
        records = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    if not isinstance(records, dict):
        return None
    return {
        openid: {**({} if verified_only else record), "name": record["name"].strip()}
        for openid, record in records.items()
        if OPENID.fullmatch(openid) and isinstance(record, dict)
        and isinstance(record.get("name"), str) and record["name"].strip()
        and (not verified_only or record.get("verified") is True)
    }


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temp_path = Path(handle.name)
        try:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.close()
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)


class State:
    def __init__(self, directory: Path, seed: Path, legacy_data: Path | None = None) -> None:
        self.path = directory / "state.json"
        self.legacy_data = legacy_data
        self.value = read_json(self.path, None)
        created = self.value is None
        initial = read_json(seed, {}) if created or legacy_data is not None else {}
        self.seed_aliases = dict(initial.get("aliases", {}))
        if created:
            self.value = initial
        self.value.setdefault("groups", {})
        self.value.setdefault("aliases", {})
        self.value.setdefault("codes", {})
        self.value.setdefault("claims", {})
        if created:
            self.save()

    def save(self) -> None:
        write_json(self.path, self.value)

    def policy(self, group: str) -> dict:
        return self.value["groups"].get(group, {})

    def update_group(self, group: str, **values) -> None:
        self.value["groups"].setdefault(group, {}).update(values)
        self.save()

    def manual_aliases(self) -> dict | None:
        if self.legacy_data is not None:
            return read_member_records(self.legacy_data / "aliases.json")
        return None

    def aliases(self) -> dict:
        saved = self.value["aliases"]
        if self.legacy_data is None:
            return saved
        manual = self.manual_aliases()
        profiles = read_member_records(self.legacy_data / "profiles.json", verified_only=True)
        if manual is None and profiles is None:
            return saved
        # Treat the live files as authoritative for records copied at install time.
        local = {openid: record for openid, record in saved.items() if self.seed_aliases.get(openid) != record}
        return {**(profiles or {}), **local, **(manual or {})}

    def name(self, openid: str) -> str:
        return self.aliases().get(openid, {}).get("name") or ""

    def redeem(self, raw_code: str, user: str) -> str:
        key = "".join(raw_code.upper().split())
        codes = self.value["codes"]
        item = codes.get(key)
        if not isinstance(item, dict) or not item.get("name"):
            return "这个码我没发过 找管理确认下"
        if item.get("usedAt"):
            if item.get("usedBy") != user:
                return "这码被人用过了"
            return "你早就是" + (self.name(user) or item["name"])
        now = datetime.now(timezone.utc)
        try:
            expired = now >= datetime.fromisoformat(item["expireAt"].replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            expired = True
        if expired:
            return "码过期了 找管理再拿一个"
        manual_name = (self.manual_aliases() or {}).get(user, {}).get("name")
        if manual_name and manual_name != item["name"]:
            return "管理已经把你绑定成" + manual_name + " 找管理确认下"
        item.update(usedAt=now.isoformat(), usedBy=user)
        self.value["aliases"][user] = {"name": item["name"], "at": now.isoformat()}
        self.save()
        return "行 记住你了 " + item["name"]
