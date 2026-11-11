#!/bin/sh
# 守护启动：在线模式（--live-qq），进程退出 5 秒后自动拉起
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Shanghai
mkdir -p logs

while true; do
  if [ -f .env ]; then
    node --env-file=.env maibot.mjs run --live-qq >> logs/maibot-live.log 2>&1
  else
    node maibot.mjs run --live-qq >> logs/maibot-live.log 2>&1
  fi
  echo "$(date -Is) 金桦退出，5 秒后重启" >> logs/maibot-live.log
  sleep 5
done
