#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
rm -f events.log
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

echo "--- customer before ---"
curl -s http://127.0.0.1:4105/v1/customers/cus_A

echo ""
echo "--- forward create subscription ---"
node cairn-proxy.js cus_A price_basic

echo "--- customer after forward ---"
curl -s http://127.0.0.1:4105/v1/customers/cus_A

LANE=$(ls -t lanes/*.json | head -1)
echo ""
echo "--- revert $LANE ---"
node revert.js "$LANE"

echo "--- customer after revert ---"
curl -s http://127.0.0.1:4105/v1/customers/cus_A

echo ""
echo "--- events.log (webhooks delivered) ---"
cat events.log
