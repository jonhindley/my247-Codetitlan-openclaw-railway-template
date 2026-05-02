FROM node:22-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    python3 \
    build-essential \
    zip \
    chromium \
    xvfb \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libxss1 \
    libasound2 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw@2026.3.13 clawhub@latest

# Backward-compatibility shim for older OPENCLAW_ENTRY values.
RUN mkdir -p /openclaw \
  && ln -sfn /usr/local/lib/node_modules/openclaw/dist /openclaw/dist

RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -eu' \
  'echo "[my247-chromium] $(date -Iseconds) user=$(whoami) pwd=$(pwd) args=$*" >> /tmp/my247-chromium.log 2>&1 || true' \
  'export HOME="${HOME:-/home/openclaw}"' \
  'export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/.openclaw/chromium-config}"' \
  'export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/chromium-cache}"' \
  'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-openclaw}"' \
  'export CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR:-/data/.openclaw/chromium-profile}"' \
  'export CHROMIUM_CACHE_DIR="${CHROMIUM_CACHE_DIR:-/tmp/chromium-cache}"' \
  'mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$CHROMIUM_USER_DATA_DIR" "$CHROMIUM_CACHE_DIR" /tmp/chromium-work' \
  'chmod 700 "$XDG_RUNTIME_DIR" || true' \
  'unset DBUS_SESSION_BUS_ADDRESS || true' \
  'cd /tmp/chromium-work || cd /tmp' \
  'exec /usr/bin/chromium \' \
  '  --headless=new \' \
  '  --no-sandbox \' \
  '  --disable-dev-shm-usage \' \
  '  --disable-gpu \' \
  '  --disable-setuid-sandbox \' \
  '  --disable-software-rasterizer \' \
  '  --disable-crash-reporter \' \
  '  --disable-crashpad \' \
  '  --disable-extensions \' \
  '  --no-first-run \' \
  '  --no-default-browser-check \' \
  '  --user-data-dir="$CHROMIUM_USER_DATA_DIR" \' \
  '  --disk-cache-dir="$CHROMIUM_CACHE_DIR" \' \
  '  "$@"' \
  > /usr/local/bin/my247-chromium \
  && chmod +x /usr/local/bin/my247-chromium
  
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

USER openclaw
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER root
ENTRYPOINT ["./entrypoint.sh"]
