#!/bin/sh
# 彻底停止：优先按进程组收，再兜底按名称收，最后校验没有残留
cd "$(dirname "$0")" || exit 1
PGID=$(cat data/run.pid 2>/dev/null)
if [ -n "$PGID" ] && kill -0 "-$PGID" 2>/dev/null; then
  kill -TERM "-$PGID" 2>/dev/null
fi
i=0
while [ $i -lt 15 ]; do
  if ! pgrep -f "maibot.mjs run|maibot-upstream/.venv/bin/python|uv run --no-sync" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  i=$((i + 1))
done
pkill -TERM -f "sh run.sh" 2>/dev/null
pkill -TERM -f "maibot.mjs run" 2>/dev/null
pkill -TERM -f "uv run --no-sync --project .*maibot-upstream" 2>/dev/null
pkill -TERM -f "maibot-upstream/.venv/bin/python" 2>/dev/null
sleep 2
if pgrep -f "maibot.mjs run|maibot-upstream/.venv/bin/python" >/dev/null 2>&1; then
  echo "仍有残留，强制结束"
  pkill -9 -f "maibot.mjs run" 2>/dev/null
  pkill -9 -f "maibot-upstream/.venv/bin/python" 2>/dev/null
  sleep 1
fi
rm -f data/run.pid
if pgrep -f "maibot.mjs run|maibot-upstream/.venv/bin/python" >/dev/null 2>&1; then
  echo "停止失败："
  pgrep -af "maibot.mjs run|maibot-upstream/.venv/bin/python"
  exit 1
fi
echo "已停止"
