#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
rm -rf lanes && mkdir -p lanes
node mock-server.js &
MOCK=$!
trap "kill $MOCK 2>/dev/null || true" EXIT
sleep 0.4

echo "=== Case A: upload to NEW key, then revert ==="
node cairn-proxy.js mybucket newkey.bin 3
LANE_A=$(ls -t lanes/*.json | head -1)
echo "--- object after forward ---"
curl -s http://127.0.0.1:4106/mybucket/newkey.bin
echo ""
node revert.js "$LANE_A"
echo "--- object after revert (want 404) ---"
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4106/mybucket/newkey.bin
echo ""

echo ""
echo "=== Case B: crash AFTER part 2 (mid-upload) ==="
rm -rf lanes && mkdir -p lanes
CRASH_AFTER_PART=2 node cairn-proxy.js mybucket crashkey.bin 4
LANE_B=$(ls -t lanes/*.json | head -1)
echo "--- list in-progress uploads ---"
curl -s "http://127.0.0.1:4106/mybucket/crashkey.bin?uploads"
echo ""
node revert.js "$LANE_B"
echo "--- list in-progress uploads after revert (want empty) ---"
curl -s "http://127.0.0.1:4106/mybucket/crashkey.bin?uploads"

echo ""
echo "=== Case C: overwrite EXISTING key, then revert (versioned bucket simulation) ==="
rm -rf lanes && mkdir -p lanes
# first, seed an existing object
curl -s -X PUT http://127.0.0.1:4106/mybucket/existing.bin -H "Content-Type: application/json" -d '{"size":500,"etag":"etag-OLD","versionId":"v-OLD"}'
echo ""
echo "--- object before ---"
curl -s http://127.0.0.1:4106/mybucket/existing.bin
echo ""
node cairn-proxy.js mybucket existing.bin 2
LANE_C=$(ls -t lanes/*.json | head -1)
echo "--- object after forward ---"
curl -s http://127.0.0.1:4106/mybucket/existing.bin
echo ""
node revert.js "$LANE_C"
echo "--- object after revert ---"
curl -s http://127.0.0.1:4106/mybucket/existing.bin
