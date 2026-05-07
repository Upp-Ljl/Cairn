#!/usr/bin/env bash
# Bugged baseline. Tests in ../tests/run_tests.sh exercise the real spec.

process() {
  local input=$1
  echo $input | tr ' ' '\n' | sort
}

if [ "$1" = "--help" ]; then
  echo "Usage: deploy.sh STRING"
  exit 0
fi

process "$1"
