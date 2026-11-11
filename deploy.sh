#!/bin/sh
# 改完 maibot/ 下的插件代码后必须走这里：
# configure 会把源码同步到 instance/plugins，否则运行的是旧副本
cd "$(dirname "$0")" || exit 1
./stop.sh >/dev/null 2>&1
node --env-file=.env maibot.mjs configure || exit 1
./start.sh
sleep 3
grep -a "金桦自适应接话已加载" logs/maibot-live.log | tail -1
