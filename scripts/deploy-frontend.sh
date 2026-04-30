#!/usr/bin/env bash
# 仅更新前端：拉代码（可选）→ npm ci → build → rsync 到静态目录
#
# 环境变量（可选）：
#   OPENNAV_ROOT   仓库根目录，默认为本脚本所在仓库根
#   OPENNAV_HTML   Nginx root，默认 $OPENNAV_ROOT/html
#   SKIP_GIT=1     跳过 git pull（只本地构建同步）
#
# 服务器快捷别名（~/.bashrc，路径按你实际改）：
#   alias @fe='bash /var/www/opennav/scripts/deploy-frontend.sh'

set -euo pipefail

ROOT="${OPENNAV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HTML="${OPENNAV_HTML:-$ROOT/html}"

cd "$ROOT"

if [[ "${SKIP_GIT:-0}" != "1" ]]; then
  git pull
fi

npm ci
npm run build

mkdir -p "$HTML"
rsync -a --delete dist/ "$HTML/"

echo "[deploy-frontend] OK -> $HTML"
