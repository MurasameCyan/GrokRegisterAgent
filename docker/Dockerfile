# syntax=docker/dockerfile:1.6

FROM node:20-bookworm AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run server:build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS node-runtime

FROM python:3.13-slim-bookworm AS runtime

ENV NODE_ENV=production \
    PORT=6657 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/data \
    STATIC_ROOT=/app/out/renderer \
    PYTHON_PATH=/usr/local/bin/python3 \
    REGISTER_DIR=/app/register \
    SSO_DIR=/data/sso \
    PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PIP_NO_CACHE_DIR=1 \
    DISPLAY=:99

WORKDIR /app

# chromium + xvfb：无 GUI 下用“有头 Chrome + 虚拟显示”过 Turnstile
# 附带字体/GL 相关库，减少 canvas/WebGL 指纹残缺
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      ca-certificates \
      dumb-init \
      fonts-noto-cjk \
      fonts-liberation \
      fonts-dejavu-core \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpangocairo-1.0-0 \
      libxshmfence1 \
 && rm -rf /var/lib/apt/lists/*

# 内置 Python 注册机及其依赖(DrissionPage / curl_cffi / requests)
# /app/register = 运行目录；/opt/register-seed = 启动时恢复用种子（防空挂载覆盖）
# CF：仓库内 register/bin/cfwp/linux-*；sing-box：构建时按 TARGETARCH 从 GitHub 下载（不入库）
ARG SING_BOX_VERSION=1.13.14
ARG TARGETARCH
COPY register /app/register
COPY register /opt/register-seed
# pip 依赖 + rsync/curl（entrypoint 热同步；构建期拉 sing-box）
# cfwp 可执行权限 + 下载当前架构的 sing-box
RUN python -m pip install --upgrade pip \
 && python -m pip install -r /app/register/requirements.txt \
 && apt-get update \
 && apt-get install -y --no-install-recommends rsync curl ca-certificates \
 && chmod +x /app/register/bin/cfwp/linux-amd64 /app/register/bin/cfwp/linux-arm64 2>/dev/null || true \
 && chmod +x /opt/register-seed/bin/cfwp/linux-amd64 /opt/register-seed/bin/cfwp/linux-arm64 2>/dev/null || true \
 && set -eux \
 && case "${TARGETARCH}" in \
      amd64) sb_arch=amd64 ;; \
      arm64) sb_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && sb_ver="${SING_BOX_VERSION}" \
 && sb_url="https://github.com/SagerNet/sing-box/releases/download/v${sb_ver}/sing-box-${sb_ver}-linux-${sb_arch}.tar.gz" \
 && tmp="$(mktemp -d)" \
 && curl -fsSL "${sb_url}" -o "${tmp}/sing-box.tgz" \
 && tar -xzf "${tmp}/sing-box.tgz" -C "${tmp}" \
 && bin="$(find "${tmp}" -type f -name sing-box | head -n1)" \
 && test -n "${bin}" \
 && mkdir -p /app/register/bin/sing-box /opt/register-seed/bin/sing-box \
 && install -m 755 "${bin}" "/app/register/bin/sing-box/linux-${sb_arch}" \
 && install -m 755 "${bin}" "/opt/register-seed/bin/sing-box/linux-${sb_arch}" \
 && rm -rf "${tmp}" \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

COPY --from=builder /app/out /app/out
COPY --from=builder /app/server/dist /app/server/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data /data/sso /app/register/sso /app/register/logs \
 && mkdir -p /opt/register-host /opt/register-seed

EXPOSE 6657
VOLUME ["/data"]

# 可选：把宿主 ./register 挂到 /opt/register-host，entrypoint 会自动同步到 /app/register
# 切勿把空目录直接挂到 /app/register

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
