#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

echo "--- before ---"
curl -s http://127.0.0.1:4102/v1/pages/p-123

PATCH='{"archived":true,"icon":{"type":"emoji","emoji":"CHANGED"},"properties":{"Name":{"title":[{"type":"text","text":{"content":"NewTitle"},"plain_text":"NewTitle"}]},"Status":{"select":{"id":"s2","name":"Done","color":"green"}},"Tags":{"multi_select":[{"id":"t2","name":"bar","color":"red"}]},"Priority":{"number":9}}}'
echo "--- forward ---"
node cairn-proxy.js p-123 "$PATCH"

echo "--- after forward ---"
curl -s http://127.0.0.1:4102/v1/pages/p-123

LANE=$(ls -t lanes/*.json | head -1)
echo "--- revert $LANE ---"
node revert.js "$LANE"

echo "--- after revert ---"
curl -s http://127.0.0.1:4102/v1/pages/p-123
