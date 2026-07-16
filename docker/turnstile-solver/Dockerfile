# syntax=docker/dockerfile:1.6
# Optional Turnstile local solver (compose profile: solver)
# Multi-arch: linux/amd64 + linux/arm64 (default browser_type=chromium via patchright).
# Camoufox is optional and not installed in this image (ARM-friendlier).
# Note: Turnstile pass rate on ARM may still be lower than x86 (WebGL/fingerprint).

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=5072 \
    HOST=0.0.0.0 \
    THREAD=2 \
    BROWSER_TYPE=chromium \
    DISPLAY=:99

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      chromium-driver \
      xvfb \
      ca-certificates \
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
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip \
 && python -m pip install -r /app/requirements.txt \
 && python -m patchright install --with-deps chromium \
 || python -m patchright install chromium \
 || true

COPY app/ /app/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5072
ENTRYPOINT ["dumb-init", "--", "/entrypoint.sh"]
