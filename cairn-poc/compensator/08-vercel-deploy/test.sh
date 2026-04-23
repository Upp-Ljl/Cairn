#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
rm -f events.log
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

# seed: deploy v1 first so there IS a previous production alias
echo "--- seed deploy v1 ---"
curl -s -X POST http://127.0.0.1:4108/v13/deployments -H "Content-Type: application/json" -d '{"name":"myapp","target":"production","gitSource":{"sha":"sha-v1"}}'
sleep 0.3
echo "--- project after v1 ---"
curl -s http://127.0.0.1:4108/v1/projects/myapp

echo ""
echo "--- forward deploy v2 (agent change) ---"
node cairn-proxy.js myapp sha-v2
echo "--- project after v2 ---"
curl -s http://127.0.0.1:4108/v1/projects/myapp

LANE=$(ls -t lanes/*.json | head -1)
echo ""
echo "--- revert $LANE (promote v1 back) ---"
node revert.js "$LANE"
echo "--- project after revert ---"
curl -s http://127.0.0.1:4108/v1/projects/myapp

echo ""
echo "--- events.log ---"
cat events.log
