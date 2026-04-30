#!/usr/bin/env bash
# 仅更新后端：拉代码（可选）→ backend npm ci → build → pm2 restart
#
# 环境变量（可选）：
#   OPENNAV_ROOT     仓库根目录，默认为本脚本所在仓库根
#   PM2_APP_NAME     PM2 进程名，默认 opennav-api
#   SKIP_GIT=1       跳过 git pull
#
# 服务器快捷别名（~/.bashrc，路径按你实际改）：
#   alias @be='bash /var/www/opennav/scripts/deploy-backend.sh'

set -euo pipefail

ROOT="${OPENNAV_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP="${PM2_APP_NAME:-opennav-api}"

cd "$ROOT"

if [[ "${SKIP_GIT:-0}" != "1" ]]; then
  git pull
fi

cd "$ROOT/backend"
npm ci
npm run build
pm2 restart "$APP"

echo "[deploy-backend] OK (pm2: $APP)"
