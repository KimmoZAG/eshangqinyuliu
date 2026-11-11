#!/bin/sh
# 停止整棵进程树（守护 + node 包装 + uv + venv python）
# 只杀 maibot.mjs 会留下 Python 子进程占着 host/run.lock，导致下次启动失败
cd "$(dirname "$0")" || exit 1

pkill -f "sh run.sh" 2>/dev/null
pkill -f "maibot.mjs run" 2>/dev/null
pkill -f "uv run --no-sync --project .*maibot-upstream" 2>/dev/null
pkill -f "maibot-upstream/.venv/bin/python" 2>/dev/null

sleep 3

if pgrep -af "maibot.mjs run|maibot-upstream/.venv/bin/python" >/dev/null 2>&1; then
  echo "仍有残留，强制结束"
  pkill -9 -f "maibot.mjs run" 2>/dev/null
  pkill -9 -f "maibot-upstream/.venv/bin/python" 2>/dev/null
  sleep 1
fi

if pgrep -af "maibot.mjs run|maibot-upstream/.venv/bin/python" >/dev/null 2>&1; then
  echo "停止失败："
  pgrep -af "maibot.mjs run|maibot-upstream/.venv/bin/python"
  exit 1
fi

echo "已停止"
