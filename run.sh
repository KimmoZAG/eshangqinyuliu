#!/bin/sh
cd "$(dirname "$0")" || exit 1
export TZ=Asia/Shanghai
if [ -f .env ]; then
    exec node --env-file=.env maibot.mjs run "$@"
fi
exec node maibot.mjs run "$@"
