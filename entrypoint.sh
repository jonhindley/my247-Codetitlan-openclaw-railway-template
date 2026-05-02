#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

if [ "$MY247_AUTO_CONFIG" = "true" ]; then
  echo "[my247] Auto-config enabled. Generating OpenClaw config..."
  gosu openclaw node src/my247-generate-config.cjs
fi

mkdir -p /data/.openclaw/chromium-profile /tmp/chromium-cache
chown -R openclaw:openclaw /data/.openclaw /tmp/chromium-cache

export DISPLAY="${DISPLAY:-:99}"
export CHROME_BIN="${CHROME_BIN:-/usr/local/bin/my247-chromium}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-/usr/local/bin/my247-chromium}"
export BROWSER_PATH="${BROWSER_PATH:-/usr/local/bin/my247-chromium}"
export OPENCLAW_BROWSER_PATH="${OPENCLAW_BROWSER_PATH:-/usr/local/bin/my247-chromium}"
export CHROMIUM_USER_DATA_DIR="${CHROMIUM_USER_DATA_DIR:-/data/.openclaw/chromium-profile}"
export CHROMIUM_CACHE_DIR="${CHROMIUM_CACHE_DIR:-/tmp/chromium-cache}"

if command -v Xvfb >/dev/null 2>&1; then
  echo "[browser] Starting Xvfb on ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi

exec gosu openclaw node src/server.js
