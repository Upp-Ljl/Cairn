#!/usr/bin/env bash
# Regression harness for agent-self-iteration.
#
# Each target ships with a `.baseline-src/` holding the canonical *bugged*
# source. For every regression run we:
#   1. Copy the target into a fresh temp dir
#   2. Replace the temp dir's `src/` with `.baseline-src/`
#   3. Run `/auto-iter <abs-temp-path> | use TASK.md` via `claude -p`
#   4. Run pytest in the temp dir to score the result
#   5. Discard the temp dir
#
# The project's own `examples/<target>/src/` is NEVER modified by this script.
# That means /self-improve's "clean working tree" pre-flight check stays
# satisfied across regression runs, and each run starts from the same bugged
# baseline regardless of what previous runs produced.
#
# Usage:
#   ./scripts/regression.sh            # default targets
#   ./scripts/regression.sh foo bar    # only listed targets (relative to examples/)
#
# Cost: each target costs roughly $0.10–$1 in API usage. Set ANTHROPIC_API_KEY
# and a console spend limit before running.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v claude >/dev/null 2>&1; then
  echo '{"error":"claude CLI not found in PATH"}' >&2
  exit 2
fi
# Auth is intentionally NOT checked here. Pro/Max users on macOS store OAuth
# tokens in Keychain (no file we can stat); API users use ANTHROPIC_API_KEY.
# If `claude -p` below fails with an auth error, the per-target log will show it.

DEFAULT_TARGETS=(buggy_calculator string_utils)
if [ $# -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

REPORT_DIR="$ROOT/.regression-runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REPORT_DIR"

PASSED=0
FAILED=0

run_target() {
  local name="$1"
  local target_path="$ROOT/examples/$name"
  local log="$REPORT_DIR/$name.log"

  if [ ! -d "$target_path" ]; then
    echo "{\"target\":\"$name\",\"status\":\"missing\"}"
    FAILED=$((FAILED+1))
    return
  fi
  if [ ! -d "$target_path/.baseline-src" ]; then
    echo "{\"target\":\"$name\",\"status\":\"missing-baseline-src\"}"
    FAILED=$((FAILED+1))
    return
  fi

  # Build a fresh temp copy with bugged baseline as src/.
  local tmp
  tmp=$(mktemp -d -t "agent-iter-regress-${name}.XXXXXX")
  trap "rm -rf '$tmp'" RETURN
  # Copy task + tests but NOT .baseline-src nor existing src.
  if [ -f "$target_path/TASK.md" ]; then
    cp "$target_path/TASK.md" "$tmp/"
  fi
  if [ -d "$target_path/tests" ]; then
    cp -R "$target_path/tests" "$tmp/"
  fi
  # Seed src/ from baseline.
  mkdir -p "$tmp/src"
  cp -R "$target_path/.baseline-src/." "$tmp/src/"

  # Per-target signal command. Default is python pytest, but a target can
  # declare its own (e.g. `npx -y typescript@5 tsc --noEmit src/*.ts`,
  # `bash tests/run_tests.sh`, `node tests/check.mjs`) by dropping a one-line
  # `regression.cmd` file in its dir. The command runs from inside $tmp.
  local signal_cmd
  if [ -f "$target_path/regression.cmd" ]; then
    signal_cmd=$(head -1 "$target_path/regression.cmd")
    cp "$target_path/regression.cmd" "$tmp/regression.cmd" 2>/dev/null || true
  else
    signal_cmd="python3 -m pytest -q"
  fi

  echo "# regression target $name -> $tmp" >>"$log"
  echo "# signal command: $signal_cmd" >>"$log"
  echo "# baseline signals BEFORE /auto-iter:" >>"$log"
  (cd "$tmp" && bash -c "$signal_cmd" >>"$log" 2>&1) || true

  # Delegate the actual dual-agent loop to scripts/dual_agent_iter.sh — the
  # canonical generic driver. regression.sh is now just the "wrap N targets,
  # use bugged baseline-src as starting state, score with tight caps" shell.
  # Anyone running /auto-iter on a real project hits the same dual_agent_iter.sh,
  # so what we test in regression IS what consumers run.
  local model="${REGRESSION_MODEL:-claude-sonnet-4-6}"
  local start_ts=$(date +%s)
  local dual_summary
  dual_summary=$(TASK_FILE="$tmp/TASK.md" \
                 SIGNAL_CMD="$signal_cmd" \
                 MAX_ITER=3 \
                 QUIET_STREAK=1 \
                 MODEL="$model" \
                 LOG_FILE="$log" \
                 PROMPT_DIR="$REPORT_DIR/${name}_prompts" \
                 PROJECT_ROOT="$ROOT" \
                 "$ROOT/scripts/dual_agent_iter.sh" "$tmp" 2>>"$log" | tail -1)
  local claude_exit=$?
  local end_ts=$(date +%s)
  local duration=$((end_ts - start_ts))

  # iteration count comes from dual_agent_iter.sh's JSON; fall back to the
  # awk-counted banner number further below if parsing fails.
  local _from_summary
  _from_summary=$(printf '%s' "$dual_summary" | sed -nE 's/.*"iterations":[[:space:]]*([0-9]+).*/\1/p')
  [ -z "$_from_summary" ] && _from_summary=0
  echo "# dual_agent_iter summary: $dual_summary" >>"$log"

  echo "# signals AFTER dual-agent loop ($signal_cmd):" >>"$log"
  local pytest_exit
  (cd "$tmp" && bash -c "$signal_cmd" >>"$log" 2>&1)
  pytest_exit=$?

  # Roleplay detector: if the inner orchestrator's text claims success
  # (EXHAUSTED / pass / "all tests pass" / similar) but pytest is still red
  # AND the source files were never touched, the model produced a plausible
  # report without actually using its tools. This is a real failure mode we
  # observed with smaller models. Flag it as 'roleplayed' so the meta-loop
  # treats it as failed regression even if the inner exit code was 0.
  local roleplayed=0
  if [ "$pytest_exit" -ne 0 ]; then
    if grep -qE "EXHAUSTED|improvements_exhausted.*true|all .*tests? (now )?pass" "$log" 2>/dev/null; then
      # Compare temp src to baseline-src: if they're byte-identical, no edits happened.
      if diff -rq "$target_path/.baseline-src" "$tmp/src" >/dev/null 2>&1; then
        roleplayed=1
        echo "# ROLEPLAY DETECTED: orchestrator reported success but source unchanged" >>"$log"
      fi
    fi
  fi

  local status
  if [ "$pytest_exit" -eq 0 ]; then
    status="passed"
    PASSED=$((PASSED+1))
  elif [ "$roleplayed" -eq 1 ]; then
    status="roleplayed"
    FAILED=$((FAILED+1))
  else
    status="failed"
    FAILED=$((FAILED+1))
  fi

  # Iteration count: count "=== iteration N ===" markers in log.
  # `grep -c` exits 1 on zero matches AND emits "0" on stdout — combining with
  # `|| echo 0` would yield "0\n0" and break printf. Use awk for a clean integer.
  local iters
  iters=$(awk '/^=== iteration [0-9]+ ===/{n++} END{print n+0}' "$log" 2>/dev/null)
  [ -z "$iters" ] && iters=0

  printf '{"target":"%s","status":"%s","claude_exit":%d,"pytest_exit":%d,"iterations":%d,"duration_s":%d,"log":"%s"}\n' \
      "$name" "$status" "$claude_exit" "$pytest_exit" "$iters" "$duration" "$log"

  # tmp gets cleaned up by the RETURN trap.
}

echo "# regression run: $REPORT_DIR" >&2
for t in "${TARGETS[@]}"; do
  run_target "$t"
done

TOTAL=$((PASSED+FAILED))
SCORE=0
if [ "$TOTAL" -gt 0 ]; then
  SCORE=$(( (PASSED * 100) / TOTAL ))
fi

printf '{"summary":{"passed":%d,"failed":%d,"total":%d,"score_pct":%d,"report_dir":"%s"}}\n' \
    "$PASSED" "$FAILED" "$TOTAL" "$SCORE" "$REPORT_DIR"

# Exit non-zero if anything failed (so meta-loop can detect regression).
[ "$FAILED" -eq 0 ] || exit 1
