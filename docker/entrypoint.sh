#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data
mkdir -p "${SSO_DIR:-/data/sso}"
mkdir -p /app/register/sso
mkdir -p /app/register/logs
mkdir -p "${REGISTER_DIR:-/app/register}/sso"
mkdir -p "${REGISTER_DIR:-/app/register}/logs"

# Turnstile 需要“有头”Chrome + 可用 DISPLAY。分辨率与注册脚本窗口保持一致。
if command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY="${DISPLAY:-:99}"
  # 带 GLX/render，减少 WebGL/canvas 指纹残缺导致的 failure
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.5
  echo "[entrypoint] Xvfb ready DISPLAY=${DISPLAY}"
fi

exec node /app/server/dist/server/src/index.js
