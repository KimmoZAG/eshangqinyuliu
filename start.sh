#!/bin/sh
# 后台启动守护（在线模式），并把日志续写到 logs/maibot-live.log
cd "$(dirname "$0")" || exit 1
if pgrep -f "maibot.mjs run" >/dev/null 2>&1; then
  echo "已在运行，先执行 ./stop.sh"
  exit 1
fi
setsid nohup sh run.sh >/dev/null 2>&1 &
echo "已启动，日志：logs/maibot-live.log"
