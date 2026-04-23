#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.5

# 300 keys: PROJ-1..PROJ-300. Expected: 200 succeed, 100 fail.
KEYS=$(node -e "console.log(Array.from({length:300},(_,i)=>'PROJ-'+(i+1)).join(','))")

echo "--- forward bulk set priority=High ---"
node cairn-proxy.js "$KEYS" High

echo "--- sample after forward ---"
curl -s http://127.0.0.1:4104/rest/api/3/issue/PROJ-1
echo ""
curl -s http://127.0.0.1:4104/rest/api/3/issue/PROJ-250

LANE=$(ls -t lanes/*.json | head -1)
echo ""
echo "--- revert $LANE ---"
node revert.js "$LANE"

echo "--- sample after revert ---"
curl -s http://127.0.0.1:4104/rest/api/3/issue/PROJ-1
