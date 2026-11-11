from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


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
    def __init__(self, directory: Path, seed: Path) -> None:
        self.path = directory / "state.json"
        self.value = read_json(self.path, None)
        if self.value is None:
            self.value = read_json(seed, {})
            self.save()
        self.value.setdefault("groups", {})
        self.value.setdefault("aliases", {})
        self.value.setdefault("codes", {})
        self.value.setdefault("claims", {})

    def save(self) -> None:
        write_json(self.path, self.value)

    def policy(self, group: str) -> dict:
        return self.value["groups"].get(group, {})

    def update_group(self, group: str, **values) -> None:
        self.value["groups"].setdefault(group, {}).update(values)
        self.save()

    def name(self, openid: str) -> str:
        return str(self.value["aliases"].get(openid, {}).get("name") or "")

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
        item.update(usedAt=now.isoformat(), usedBy=user)
        self.value["aliases"][user] = {"name": item["name"], "at": now.isoformat()}
        self.save()
        return "行 记住你了 " + item["name"]
