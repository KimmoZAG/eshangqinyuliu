#!/bin/sh
# 幂等准备运行期依赖：容器重建后 node/uv/ssh 权限常丢，这里每次启动都自检并修复。
# 只做“缺失则补齐”，已有则跳过，可重复执行。

set -u

ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  for candidate in /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    if [ -x "$candidate" ]; then
      echo "[runtime] 链接 node：$candidate"
      ln -sf "$candidate" /usr/local/bin/node 2>/dev/null
      command -v node >/dev/null 2>&1 && return 0
    fi
  done
  found=$(ls -d /root/.vscode-server/bin/*/node 2>/dev/null | head -1)
  if [ -n "$found" ] && [ -x "$found" ]; then
    echo "[runtime] 复用 VS Code 自带 node：$found"
    ln -sf "$found" /usr/local/bin/node
    command -v node >/dev/null 2>&1 && return 0
  fi
  echo "[runtime] 缺少 node（需要 20+），请先安装" >&2
  return 1
}

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then return 0; fi
  echo "[runtime] 未找到 uv，尝试 pip 安装"
  python3 -m pip install -q uv >/dev/null 2>&1 || true
  command -v uv >/dev/null 2>&1 && return 0
  echo "[runtime] 缺少 uv，请执行 python3 -m pip install uv" >&2
  return 1
}

ensure_ssh() {
  [ -d "$HOME/.ssh" ] || return 0
  chmod 700 "$HOME/.ssh" 2>/dev/null
  for f in "$HOME/.ssh/config" "$HOME"/.ssh/id_*; do
    [ -f "$f" ] && chmod 600 "$f" 2>/dev/null
  done
  return 0
}

ensure_node || exit 1
ensure_uv || exit 1
ensure_ssh
echo "[runtime] node $(node -v 2>/dev/null) / uv $(uv --version 2>/dev/null | awk '{print $2}')"
