#!/usr/bin/env bash
# Test harness for src/deploy.sh. Pure bash assertions; no external deps.
# Exits 0 if every test passes; non-zero with a description on the first
# failure.

set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT="src/deploy.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT does not exist"; exit 2
fi

fail() {
  echo "FAIL: $1"
  exit 1
}

# ---------- 1. Dedup + sort ----------
out=$(bash "$SCRIPT" "b a b c a")
expected=$'a\nb\nc'
[ "$out" = "$expected" ] || fail "dedup+sort: got $(printf '%q' "$out")"

# ---------- 2. Single word ----------
out=$(bash "$SCRIPT" "solo")
[ "$out" = "solo" ] || fail "single word: got $(printf '%q' "$out")"

# ---------- 3. Inputs starting with '-' ----------
# The bugged baseline uses `echo $input` which trims leading dashes on
# some platforms. Real implementations should use printf to preserve them.
out=$(bash "$SCRIPT" "-foo bar")
expected=$'-foo\nbar'
[ "$out" = "$expected" ] || fail "leading dash: got $(printf '%q' "$out")"

# ---------- 4. --help ----------
out=$(bash "$SCRIPT" --help)
echo "$out" | grep -q "Usage" || fail "--help: missing 'Usage' in output: $(printf '%q' "$out")"

# ---------- 5. Empty string is an error ----------
if bash "$SCRIPT" "" >/dev/null 2>&1; then
  fail "empty string should error, but script exited 0"
fi

# ---------- 6. No args at all is an error ----------
if bash "$SCRIPT" >/dev/null 2>&1; then
  fail "no-arg invocation should error, but script exited 0"
fi

echo "OK 6 tests passed"
