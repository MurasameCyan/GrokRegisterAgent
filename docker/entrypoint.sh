#!/usr/bin/env bash
set -euo pipefail

REGISTER_DIR="${REGISTER_DIR:-/app/register}"
# 宿主机挂载的热更新源（不要直接挂到 REGISTER_DIR，避免空目录盖掉镜像脚本）
REGISTER_HOST_SRC="${REGISTER_HOST_SRC:-/opt/register-host}"
# 镜像构建时内置的种子副本，用于 REGISTER_DIR 被空挂载覆盖后恢复
REGISTER_SEED="${REGISTER_SEED:-/opt/register-seed}"

mkdir -p /data
mkdir -p "${SSO_DIR:-/data/sso}"
mkdir -p "${REGISTER_DIR}/sso" "${REGISTER_DIR}/logs"
mkdir -p /app/register/sso /app/register/logs

register_is_complete() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -f "$dir/runner.py" || -f "$dir/DrissionPage_example.py" ]]
}

# 同步脚本到运行目录：保留 logs/sso/config.json，避免冲掉运行时配置与产出
sync_register_from() {
  local src="$1"
  local dst="$2"
  local label="$3"

  if ! register_is_complete "$src"; then
    echo "[entrypoint] skip sync from ${label}: incomplete (need runner.py or DrissionPage_example.py)"
    return 1
  fi

  mkdir -p "$dst"
  echo "[entrypoint] syncing register from ${label} -> ${dst}"

  # 优先 rsync；无 rsync 时用 tar 管道（排除运行时目录）
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'logs/' \
      --exclude 'sso/' \
      --exclude 'config.json' \
      --exclude '__pycache__/' \
      --exclude '*.pyc' \
      --exclude '.pytest_cache/' \
      "${src}/" "${dst}/"
  else
    # 清空目标中除 logs/sso/config.json 外的旧脚本，再拷入新文件
    find "$dst" -mindepth 1 -maxdepth 1 \
      ! -name 'logs' ! -name 'sso' ! -name 'config.json' \
      -exec rm -rf {} + 2>/dev/null || true
    # shellcheck disable=SC2035
    tar -C "$src" \
      --exclude='logs' \
      --exclude='sso' \
      --exclude='config.json' \
      --exclude='__pycache__' \
      --exclude='*.pyc' \
      -cf - . | tar -C "$dst" -xf -
  fi

  mkdir -p "${dst}/logs" "${dst}/sso"
  echo "[entrypoint] register sync done from ${label}"
  return 0
}

# 1) 宿主机完整源码优先（开发热更新）
if register_is_complete "$REGISTER_HOST_SRC"; then
  sync_register_from "$REGISTER_HOST_SRC" "$REGISTER_DIR" "host:${REGISTER_HOST_SRC}" || true
# 2) 运行目录被空卷盖掉时，从镜像种子恢复
elif ! register_is_complete "$REGISTER_DIR"; then
  echo "[entrypoint] WARN: ${REGISTER_DIR} incomplete"
  if register_is_complete "$REGISTER_SEED"; then
    sync_register_from "$REGISTER_SEED" "$REGISTER_DIR" "seed:${REGISTER_SEED}" || true
  else
    echo "[entrypoint] ERROR: no complete register seed at ${REGISTER_SEED}"
  fi
else
  echo "[entrypoint] using image register at ${REGISTER_DIR} (no host override)"
fi

if register_is_complete "$REGISTER_DIR"; then
  echo "[entrypoint] register ready: $(ls -1 "${REGISTER_DIR}" | tr '\n' ' ')"
  # 检查热修文件是否在（便于确认宿主机同步）
  for f in proxy_auth_ext.py proxy_local_forward.py pools.py; do
    if [[ -f "${REGISTER_DIR}/${f}" ]]; then
      echo "[entrypoint] OK ${f}"
    else
      echo "[entrypoint] MISSING ${f} — 带密码代理/池轮换可能失效，请检查 ./register 挂载"
    fi
  done
else
  echo "[entrypoint] ERROR: ${REGISTER_DIR} still incomplete — registration will fail"
fi

# Turnstile 需要“有头”Chrome + 可用 DISPLAY。分辨率与注册脚本窗口保持一致。
if command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY="${DISPLAY:-:99}"
  # 带 GLX/render，减少 WebGL/canvas 指纹残缺导致的 failure
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.5
  echo "[entrypoint] Xvfb ready DISPLAY=${DISPLAY}"
fi

exec node /app/server/dist/server/src/index.js
