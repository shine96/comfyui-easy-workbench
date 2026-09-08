#!/usr/bin/env bash
# 把 ComfUI Workbench 软链到 ComfyUI 的 custom_nodes 目录。
#
# 用法：
#   ./install.sh /path/to/ComfyUI
#   ./install.sh                 # 自动在常见位置里找 ComfyUI
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="comfui-workbench"

find_comfyui() {
  local candidates=(
    "$HOME/ComfyUI"
    "$HOME/Documents/ComfyUI"
    "$HOME/comfy/ComfyUI"
    "/Applications/ComfyUI"
    "/opt/ComfyUI"
  )
  for path in "${candidates[@]}"; do
    if [ -d "$path/custom_nodes" ]; then
      echo "$path"
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" != "" ]; then
  COMFY="$1"
elif ! COMFY="$(find_comfyui)"; then
  echo "❌ 没找到 ComfyUI 目录，请显式传入：./install.sh /path/to/ComfyUI" >&2
  exit 1
fi

if [ ! -d "$COMFY/custom_nodes" ]; then
  echo "❌ $COMFY 下面没有 custom_nodes 目录，确认路径是否正确" >&2
  exit 1
fi

TARGET="$COMFY/custom_nodes/$NAME"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ -L "$TARGET" ]; then
    echo "ℹ️  已存在软链，先移除：$TARGET"
    rm -f "$TARGET"
  else
    echo "❌ $TARGET 已存在（不是软链），请先手动处理" >&2
    exit 1
  fi
fi

ln -s "$SRC" "$TARGET"
echo "✅ 已安装：$TARGET -> $SRC"
echo
echo "接下来："
echo "  1. 重启 ComfyUI"
echo "  2. 浏览器刷新页面（建议强制刷新 Cmd/Ctrl + Shift + R）"
echo "  3. 可选：给 ComfyUI 的 python 环境装 psutil，资源读数更准"
echo "     $COMFY/venv/bin/pip install psutil"
