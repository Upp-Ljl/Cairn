#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

echo "--- before ---"
curl -s http://127.0.0.1:4101/repos/octo/demo/issues/1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(d))"

echo "--- forward (change title + close + relabel) ---"
node cairn-proxy.js octo demo 1 '{"title":"AGENT-CHANGED","state":"closed","labels":["wontfix"]}'

echo "--- after forward ---"
curl -s http://127.0.0.1:4101/repos/octo/demo/issues/1

LANE=$(ls -t lanes/*.json | head -1)
echo "--- revert using $LANE ---"
node revert.js "$LANE"

echo "--- after revert ---"
curl -s http://127.0.0.1:4101/repos/octo/demo/issues/1
