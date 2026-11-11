from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


MODE = re.compile(r"^/(快答|自动|深想)(?:[\s：:]|$)\s*")
MODES = {"快答": "fast", "自动": "auto", "深想": "deep"}
BUDGET_MS = {"fast": 7000, "auto": 15000, "deep": 25000}
QUESTIONS = re.compile(
    r"查(?:下|一下)|搜(?:下|一下)|(?:下场|下一场).{0,14}(?:谁|什么时候|几点)|赛程|赛果|比分|几比几|谁赢|录像|"
    r"世界第一|世界排名|排行榜|在线(?:人数|多少|排行)|多少人.{0,5}在玩|"
    r"(?:Steam|星露谷).{0,28}(?:值不值|评价|多少钱|折扣|入手)|"
    r"多少钱|价格|售价|打折|折扣|胜率|出装|符文|梯队|职业选手|开赛时间|"
    r"(?:今天|明天|昨天).{0,16}(?:打比赛|有比赛|开赛)|(?:LPL|LCK|LEC|LCS|MSI|世界赛).{0,12}决赛",
    re.I,
)
SPLIT = re.compile(r"[\n。；;！？?，,]+|顺便|另外|以及")
QUERY_PREFIX = re.compile(r"^(?:(?:请|再|顺便|帮我|我想)?(?:查一下|查下|查询|查|搜一下|找一下|说一下|说下|告诉我|看看))+\s*")
PRIVATE_TAGS = re.compile(r"<(think|analysis|tool_call)\b[^>]*>[\s\S]*?</\1\s*>", re.I)
REMAINING_TAG = re.compile(r"</?(?:think|analysis|tool_call)\b|<qqbot-at-(?:user|everyone)\b", re.I)


def visible_text(value: str) -> str:
    value = PRIVATE_TAGS.sub("", value).strip()
    return "" if REMAINING_TAG.search(value) else value


def compact(text: str) -> str:
    text = QUERY_PREFIX.sub("", text.strip())
    return re.sub(r"[\W_]+", "", text, flags=re.U).casefold()


def covers_question(left: str, right: str) -> bool:
    a, b = compact(left), compact(right)
    return bool(a and b and (a in b or b in a))


@dataclass
class Turn:
    anchor: str
    user: str
    group: str
    text: str
    explicit: bool
    mode: str
    received_ms: int
    evidence: dict[str, dict] = field(default_factory=dict)
    lookup_attempts: int = 0
    lines: int = 0
    media: int = 0
    handled: bool = False
    topic: bool = False

    @property
    def expires_ms(self) -> int:
        return self.received_ms + BUDGET_MS[self.mode]

    @property
    def lookup_deadline_ms(self) -> int:
        return self.expires_ms - max(3000, int(BUDGET_MS[self.mode] * 0.35))

    @property
    def lookup_items(self) -> list[str]:
        return [part.strip() for part in SPLIT.split(self.text) if QUESTIONS.search(part)][:5]

    @property
    def needs_lookup(self) -> bool:
        if self.lookup_attempts >= 2:
            return False
        rows = list(self.evidence.values())
        expected = self.lookup_items
        if len(expected) <= 1:
            return not rows
        return any(not any(covers_question(question, row["text"]) for row in rows) for question in expected)

    def grounded_text(self) -> str:
        expected = self.lookup_items
        rows = list(self.evidence.values())
        if not expected:
            return "\n".join(render_evidence(row) for row in rows)

        if len(expected) == 1 and rows:
            return "\n".join(render_evidence(row) for row in rows)

        rendered = []
        used = set()
        for question in expected:
            found = next((row for row in rows if id(row) not in used and covers_question(question, row["text"])), None)
            if found is None:
                rendered.append(f"「{question[:35]}」这块没查到")
            else:
                used.add(id(found))
                rendered.append(render_evidence(found))
        rendered.extend(render_evidence(row) for row in rows if id(row) not in used)
        return "\n".join(rendered)


def render_evidence(row: dict) -> str:
    answer = visible_text(str(row.get("answer") or ""))
    if row.get("status") == "clarify" and row.get("candidates"):
        candidates = " / ".join(str(item)[:60] for item in row["candidates"][:4])
        answer += " " + candidates
    return answer or f"「{str(row.get('text') or '')[:35]}」这块还没确认"


def evidence_outputs(items: list[dict[str, Any]]):
    for item in items:
        if item.get("item_type") != "FunctionCallOutputItem" or item.get("tool_name") != "jinhua_lookup":
            continue
        output = item.get("output")
        if isinstance(output, str):
            try:
                output = json.loads(output)
            except ValueError:
                continue
        if not isinstance(output, dict) or output.get("jinhua_evidence") != 1:
            continue
        if isinstance(output.get("anchor"), str) and isinstance(output.get("questions"), list):
            yield output
