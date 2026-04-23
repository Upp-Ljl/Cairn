#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
rm -f test.db
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.5

echo "--- before ---"
curl -s -X POST http://127.0.0.1:4103/query -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM users WHERE id=1"}'

echo ""
echo "--- forward UPDATE email for id=1 ---"
node cairn-proxy.js users '{"email":"alice-NEW@x.com","name":"Alice2"}' '{"id":1}'

echo "--- after forward ---"
curl -s -X POST http://127.0.0.1:4103/query -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM users WHERE id=1"}'

LANE=$(ls -t lanes/*.json | head -1)
echo ""
echo "--- revert $LANE ---"
node revert.js "$LANE"

echo "--- after revert ---"
curl -s -X POST http://127.0.0.1:4103/query -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM users WHERE id=1"}'
