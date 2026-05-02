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

export DISPLAY="${DISPLAY:-:99}"
export CHROME_BIN="${CHROME_BIN:-/usr/bin/chromium}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-/usr/bin/chromium}"
export BROWSER_PATH="${BROWSER_PATH:-/usr/bin/chromium}"
export OPENCLAW_BROWSER_PATH="${OPENCLAW_BROWSER_PATH:-/usr/bin/chromium}"
export CHROME_FLAGS="${CHROME_FLAGS:---no-sandbox --disable-dev-shm-usage --disable-gpu --disable-setuid-sandbox}"

if command -v Xvfb >/dev/null 2>&1; then
  echo "[browser] Starting Xvfb on ${DISPLAY}..."
  Xvfb "${DISPLAY}" -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi

exec gosu openclaw node src/server.js
