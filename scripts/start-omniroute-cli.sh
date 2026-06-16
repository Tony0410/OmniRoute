#!/bin/sh
set -eu

# Start the local Qoder CLI proxy when qodercli is available. OmniRoute provider
# records can point Qoder PAT traffic at http://127.0.0.1:20129.
if command -v qodercli >/dev/null 2>&1 && [ -f /app/qoder_proxy_v2.mjs ]; then
  QODER_PROXY_PORT="${QODER_PROXY_PORT:-20129}" \
  QODER_BIN="${QODER_BIN:-qodercli}" \
  node /app/qoder_proxy_v2.mjs > /tmp/qoder_proxy_v2.log 2>&1 &
fi

exec node dev/run-standalone.mjs
