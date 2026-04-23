#!/usr/bin/env bash
# Reproducer script. Run from cairn-poc/.
# Requires: node 20+, python 3 with httpx and requests, curl.

set -e
cd "$(dirname "$0")"

unset HTTP_PROXY http_proxy HTTPS_PROXY https_proxy

# Start servers (if not already up).
if ! nc -z 127.0.0.1 18081 2>/dev/null; then
  node echo-server.js > echo.stdout.log 2>&1 &
  ECHO_PID=$!
  echo "Started echo server PID=$ECHO_PID"
  sleep 1
fi
if ! nc -z 127.0.0.1 18080 2>/dev/null; then
  node proxy.js > proxy.stdout.log 2>&1 &
  PROXY_PID=$!
  echo "Started proxy PID=$PROXY_PID"
  sleep 1
fi

> proxy.log

echo "=== CURL ==="
HTTP_PROXY=http://127.0.0.1:18080 curl -s --noproxy '' -H "x-cairn-lane-id: test-123" http://127.0.0.1:18081/c1 > /dev/null
curl -s --proxy http://127.0.0.1:18080 --noproxy '' -H "x-cairn-lane-id: test-123" http://127.0.0.1:18081/c2 > /dev/null
CAIRN_LANE_ID=lane-abc HTTP_PROXY=http://127.0.0.1:18080 curl -s --noproxy '' http://127.0.0.1:18081/c3 > /dev/null
curl -s -H "x-cairn-lane-id: test-123" http://127.0.0.1:18081/c4 > /dev/null

echo "=== NODE ==="
HTTP_PROXY=http://127.0.0.1:18080 CAIRN_LANE_ID=lane-node-1 node client-node.mjs envproxy-explicit-header
CAIRN_LANE_ID=lane-node-2 node client-node.mjs dispatcher-explicit-header
HTTP_PROXY=http://127.0.0.1:18080 CAIRN_LANE_ID=lane-node-3 node client-node.mjs envproxy-no-header
CAIRN_LANE_ID=lane-node-4 node client-node.mjs no-proxy-explicit-header

echo "=== PYTHON ==="
for lib in httpx requests; do
  HTTP_PROXY=http://127.0.0.1:18080 NO_PROXY= no_proxy= python client-python.py $lib envproxy-explicit-header
  python client-python.py $lib api-proxy-explicit-header
  HTTP_PROXY=http://127.0.0.1:18080 NO_PROXY= no_proxy= python client-python.py $lib envproxy-no-header
  python client-python.py $lib no-proxy-explicit-header
done

echo "=== proxy.log line count ==="
wc -l proxy.log
