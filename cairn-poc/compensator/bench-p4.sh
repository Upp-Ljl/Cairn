#!/usr/bin/env bash
# Run each P4 POC 10 times and collect recordMs numbers for p50.
set -e
cd "$(dirname "$0")"

measure() {
  local dir=$1
  local forward=$2
  cd "$dir"
  # start mock
  local MOCK
  node mock-server.js &
  MOCK=$!
  sleep 0.4
  local out=""
  for i in $(seq 1 10); do
    rm -rf lanes && mkdir -p lanes
    local r=$(node cairn-proxy.js $forward 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=d.match(/\"recordMs\":\s*(\d+)/);console.log(m?m[1]:'X')})")
    out="$out $r"
  done
  kill $MOCK 2>/dev/null || true
  wait 2>/dev/null || true
  echo "$dir:$out"
  cd ..
}

measure 01-github-issue 'octo demo 1 {"title":"X"}'
measure 02-notion-page 'p-123 {"archived":true}'
measure 03-postgres-update 'users {"name":"X"} {"id":1}'
