#!/bin/sh
# 守护启动：在线模式（--live-qq），退出 5 秒后自动拉起
# 启动前先做依赖自检（node/uv/ssh），保证容器重建后也能直接起来
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Shanghai
mkdir -p logs data

sh ./ensure-runtime.sh >> logs/runtime.log 2>&1

while true; do
  if [ -f .env ]; then
    node --env-file=.env maibot.mjs run --live-qq >> logs/maibot-live.log 2>&1
  else
    node maibot.mjs run --live-qq >> logs/maibot-live.log 2>&1
  fi
  echo "$(date -Is) 金桦退出，5 秒后重启" >> logs/maibot-live.log
  sleep 5
done
