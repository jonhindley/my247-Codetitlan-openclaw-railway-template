#!/bin/bash
set -e

# Ensure all persistent OpenClaw state is readable/writable by the runtime user.
# This is required for WhatsApp credentials, cron jobs, memory, sessions, and workspace files
# to survive redeploys and be loaded by the gateway.
chown -R openclaw:openclaw /data
chmod 700 /data
chmod 700 /data/.openclaw 2>/dev/null || true
chmod 700 /data/.openclaw/credentials 2>/dev/null || true
chmod 700 /data/.openclaw/credentials/whatsapp 2>/dev/null || true
chmod 700 /data/.openclaw/credentials/whatsapp/default 2>/dev/null || true

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

if [ "$MY247_AUTO_CONFIG" = "true" ]; then
  echo "[my247] Auto-config enabled. Generating OpenClaw config..."
  gosu openclaw node src/my247-generate-config.cjs
fi

mkdir -p \
  /data/.openclaw/chromium-profile \
  /data/.openclaw/chromium-config \
  /tmp/chromium-cache \
  /tmp/chromium-work \
  /tmp/runtime-openclaw

chown -R openclaw:openclaw \
  /data/.openclaw \
  /tmp/chromium-cache \
  /tmp/chromium-work \
  /tmp/runtime-openclaw

chmod 700 /tmp/runtime-openclaw

export DISPLAY="${DISPLAY:-:99}"
export CHROME_BIN="${CHROME_BIN:-/usr/local/bin/my247-chromium}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-/usr/local/bin/my247-chromium}"
export BROWSER_PATH="${BROWSER_PATH:-/usr/local/bin/my247-chromium}"
export OPENCLAW_BROWSER_PATH="${OPENCLAW_BROWSER_PATH:-/usr/local/bin/my247-chromium}"
export CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR:-/data/.openclaw/chromium-profile}"
export CHROMIUM_CACHE_DIR="${CHROMIUM_CACHE_DIR:-/tmp/chromium-cache}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/.openclaw/chromium-config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/chromium-cache}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-openclaw}"

if command -v Xvfb >/dev/null 2>&1; then
  echo "[browser] Starting Xvfb on ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi

exec gosu openclaw node src/server.js
