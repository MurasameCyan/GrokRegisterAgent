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
    PIP_NO_CACHE_DIR=1 \
    DISPLAY=:99

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      ca-certificates \
      dumb-init \
      fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# 内置 Python 注册机及其依赖(DrissionPage / curl_cffi / requests)
COPY register /app/register
RUN python -m pip install --upgrade pip \
 && python -m pip install -r /app/register/requirements.txt

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

COPY --from=builder /app/out /app/out
COPY --from=builder /app/server/dist /app/server/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data /data/sso /app/register/sso /app/register/logs

EXPOSE 6657
VOLUME ["/data"]

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
