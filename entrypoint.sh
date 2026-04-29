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

exec gosu openclaw node src/server.js
