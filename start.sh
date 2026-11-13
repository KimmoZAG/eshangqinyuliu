#!/bin/sh
# 后台启动守护（在线模式）。记录进程组号，stop.sh 按组一次性收掉整棵树
cd "$(dirname "$0")" || exit 1
mkdir -p data logs
if pgrep -f "maibot.mjs run" >/dev/null 2>&1; then
  echo "已在运行，先执行 ./stop.sh"
  exit 1
fi
setsid sh -c 'echo $$ > data/run.pid; exec sh run.sh' >> logs/supervisor.log 2>&1 &
sleep 1
echo "已启动 pgid=$(cat data/run.pid 2>/dev/null)  日志=logs/maibot-live.log"
