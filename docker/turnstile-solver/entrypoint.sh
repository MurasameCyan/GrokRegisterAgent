#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
# virtual display for headed-ish chromium if needed
if command -v Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.5
fi
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-5072}"
THREAD="${THREAD:-2}"
BROWSER_TYPE="${BROWSER_TYPE:-chromium}"
DEBUG_FLAG=""
if [ "${DEBUG:-0}" = "1" ] || [ "${DEBUG:-}" = "true" ]; then
  DEBUG_FLAG="--debug"
fi
PROXY_FLAG=""
if [ "${PROXY:-0}" = "1" ] || [ "${PROXY:-}" = "true" ]; then
  PROXY_FLAG="--proxy"
fi
exec python /app/api_solver.py \
  --host "$HOST" \
  --port "$PORT" \
  --thread "$THREAD" \
  --browser_type "$BROWSER_TYPE" \
  $DEBUG_FLAG \
  $PROXY_FLAG
