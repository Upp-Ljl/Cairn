#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
rm -f events.log
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

echo "--- forward merge ---"
node cairn-proxy.js octo demo 42

# wait for CI + deploy cascade
sleep 0.5
echo "--- events after forward ---"
cat events.log

LANE=$(ls -t lanes/*.json | head -1)
echo ""
echo "--- revert $LANE ---"
node revert.js "$LANE"

sleep 0.5
echo "--- events after revert (see revert PR + new CI + new deploy) ---"
cat events.log
