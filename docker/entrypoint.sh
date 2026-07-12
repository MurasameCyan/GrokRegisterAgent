#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data
mkdir -p "${SSO_DIR:-/data/sso}"
mkdir -p /app/register/sso
mkdir -p /app/register/logs
mkdir -p "${REGISTER_DIR:-/app/register}/sso"
mkdir -p "${REGISTER_DIR:-/app/register}/logs"

if command -v Xvfb >/dev/null 2>&1; then
  Xvfb "${DISPLAY:-:99}" -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 &
fi

exec node /app/server/dist/server/src/index.js
