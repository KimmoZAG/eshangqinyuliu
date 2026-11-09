#!/bin/sh
# 守护启动：进程挂了 3 秒后自动拉起
cd "$(dirname "$0")" || exit 1
mkdir -p logs
while true; do
  TZ=Asia/Shanghai NODE_OPTIONS="--dns-result-order=ipv4first" node --env-file=.env bot.mjs >> logs/bot.log 2>&1
  echo "$(date -Is) bot 退出，3 秒后重启" >> logs/bot.log
  sleep 3
done
