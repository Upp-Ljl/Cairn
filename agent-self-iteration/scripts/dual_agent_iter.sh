#!/usr/bin/env bash
# Generic dual-agent (executor + reviewer) iteration driver.
#
# Bash IS the orchestrator. Each iteration runs two SEPARATE `claude -p`
# calls — one as the executor (edits files), one as the reviewer (audits +
# emits VERDICT). No single Claude session plays both roles, so the
# mutual-supervision pattern is mechanically enforced.
#
# Usage:
#   dual_agent_iter.sh <work_dir>
#
# Configuration via env vars:
#   TASK_FILE     — path to TASK.md describing the task. Default: <work_dir>/TASK.md.
#   SIGNAL_CMD    — shell command run from inside <work_dir> as the objective
#                   signal (pytest, npm test, tsc --noEmit, custom). Must
#                   exit 0 on green. Default: "python3 -m pytest -q".
#   MAX_ITER      — hard cap on iterations. Default: 10.
#   QUIET_STREAK  — consecutive (verdict=pass AND improvements_exhausted=true)
#                   verdicts required to exit. Default: 2.
#   MODEL         — claude model. Default: claude-sonnet-4-6.
#   LOG_FILE      — append per-iteration trace here. Default: stderr.
#   PROMPT_DIR    — where to drop iter executor/reviewer prompt files for
#                   debugging. Default: a tmp dir under TMPDIR.
#   PROJECT_ROOT  — directory containing .claude/agents/{executor,reviewer}.md
#                   for persona loading. Default: this script's parent's parent.
#
# stdout: a single JSON summary line on completion:
#   {"status":"exhausted"|"max_iter_reached","iterations":N,"final_signal_exit":N,"duration_s":N}
# Exit code: 0 if final_signal_exit == 0, else 1.

set -uo pipefail

WORK_DIR="${1:?usage: dual_agent_iter.sh <work_dir>}"
if [ ! -d "$WORK_DIR" ]; then
  echo "{\"error\":\"work_dir does not exist: $WORK_DIR\"}" >&2
  exit 2
fi
WORK_DIR="$(cd "$WORK_DIR" && pwd)"

# Defaults
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TASK_FILE="${TASK_FILE:-$WORK_DIR/TASK.md}"
SIGNAL_CMD="${SIGNAL_CMD:-python3 -m pytest -q}"
MAX_ITER="${MAX_ITER:-10}"
QUIET_STREAK="${QUIET_STREAK:-2}"
MODEL="${MODEL:-claude-sonnet-4-6}"
LOG_FILE="${LOG_FILE:-/dev/stderr}"
PROMPT_DIR="${PROMPT_DIR:-$(mktemp -d -t dual-agent.XXXXXX)}"

# Validate claude CLI
if ! command -v claude >/dev/null 2>&1; then
  echo '{"error":"claude CLI not found in PATH"}' >&2
  exit 2
fi

# Load persona bodies (skip frontmatter via awk)
EXEC_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/executor.md"
REV_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/reviewer.md"
if [ ! -f "$EXEC_PERSONA_FILE" ] || [ ! -f "$REV_PERSONA_FILE" ]; then
  echo "{\"error\":\"missing persona files at $EXEC_PERSONA_FILE / $REV_PERSONA_FILE\"}" >&2
  exit 2
fi
EXECUTOR_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$EXEC_PERSONA_FILE")
REVIEWER_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$REV_PERSONA_FILE")

# Load TASK content
if [ -f "$TASK_FILE" ]; then
  TASK_CONTENT=$(cat "$TASK_FILE")
else
  TASK_CONTENT="(no TASK file provided; reviewer should infer from work_dir contents)"
fi

mkdir -p "$PROMPT_DIR"

START_TS=$(date +%s)
ITER=0
EXHAUSTION_STREAK=0
PREV_ISSUES="(none — first iteration)"
PREV_SIGNALS="(none — first iteration)"
LAST_SIGNAL_EXIT=1

log() { printf '%s\n' "$*" >>"$LOG_FILE"; }

while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  log ""
  log "=== iteration $ITER ==="

  # ---------- EXECUTOR ----------
  EXEC_PROMPT_FILE="$PROMPT_DIR/iter${ITER}_exec.prompt"
  {
    printf '%s\n' "$EXECUTOR_PERSONA"
    cat <<EXEC_EOF

=== Per-iteration context ===

WORK_DIR: $WORK_DIR

TASK:
$TASK_CONTENT

Previous reviewer issues. Address these in priority order, blocker first then
major then minor:
$PREV_ISSUES

Previous signal output:
$PREV_SIGNALS

Iteration: $ITER of $MAX_ITER. Loop exits as soon as the reviewer says
improvements_exhausted with verdict pass for $QUIET_STREAK consecutive
iteration(s).

Path discipline: all file edits MUST be inside $WORK_DIR.

End your final message with the EXECUTOR_SUMMARY JSON line per the spec
above (changed_files, commands_run, self_assessment).
EXEC_EOF
  } > "$EXEC_PROMPT_FILE"
  log "--- executor prompt: $EXEC_PROMPT_FILE ---"
  log "--- executor output ---"
  EXEC_OUTPUT=$(claude -p "$(< "$EXEC_PROMPT_FILE")" \
                       --permission-mode acceptEdits \
                       --add-dir "$WORK_DIR" \
                       --model "$MODEL" 2>&1)
  printf '%s\n' "$EXEC_OUTPUT" >>"$LOG_FILE"

  # ---------- SIGNALS ----------
  log "--- signals after iteration $ITER ($SIGNAL_CMD) ---"
  SIGNAL_OUTPUT=$(cd "$WORK_DIR" && bash -c "$SIGNAL_CMD" 2>&1)
  SIGNAL_EXIT=$?
  printf '%s\n' "$SIGNAL_OUTPUT" >>"$LOG_FILE"
  log "EXIT=$SIGNAL_EXIT"
  LAST_SIGNAL_EXIT=$SIGNAL_EXIT

  # ---------- REVIEWER ----------
  EXEC_SUMMARY=$(printf '%s\n' "$EXEC_OUTPUT" | grep -E '^EXECUTOR_SUMMARY:' | tail -1)
  [ -z "$EXEC_SUMMARY" ] && EXEC_SUMMARY='EXECUTOR_SUMMARY: {} (executor did not emit a summary line — distrust)'

  REV_PROMPT_FILE="$PROMPT_DIR/iter${ITER}_rev.prompt"
  {
    printf '%s\n' "$REVIEWER_PERSONA"
    cat <<REV_EOF

=== Per-iteration context ===

WORK_DIR: $WORK_DIR

TASK:
$TASK_CONTENT

Executor's last summary. Distrust by default; verify with your own reads:
$EXEC_SUMMARY

Latest signal output:
$SIGNAL_OUTPUT
EXIT=$SIGNAL_EXIT

Iteration: $ITER of $MAX_ITER

Inspection requirement: read at least one file under $WORK_DIR via Bash
cat or Read before issuing your verdict. Do NOT issue a verdict purely
from the executor's summary or the signal output.

Your verdict's improvements_exhausted=true claim should reflect a search
across all nine inspection dimensions (correctness, test quality,
performance, security, reliability, maintainability, UX/UI, documentation,
project hygiene). The loop is meant to keep iterating until you genuinely
cannot find anything else worth changing — not just until tests pass.

End your final message with the VERDICT JSON line per the spec above.
REV_EOF
  } > "$REV_PROMPT_FILE"
  log "--- reviewer prompt: $REV_PROMPT_FILE ---"
  log "--- reviewer output ---"
  REV_OUTPUT=$(claude -p "$(< "$REV_PROMPT_FILE")" \
                      --add-dir "$WORK_DIR" \
                      --model "$MODEL" 2>&1)
  printf '%s\n' "$REV_OUTPUT" >>"$LOG_FILE"

  # ---------- PARSE VERDICT ----------
  VERDICT_LINE=$(printf '%s\n' "$REV_OUTPUT" | grep -E '^VERDICT:' | tail -1)
  if [ -z "$VERDICT_LINE" ]; then
    VERDICT_LINE='VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","what":"reviewer did not emit a VERDICT line"}]}'
  fi
  # Force-fail on red signals (mechanical, not advisory)
  if [ "$SIGNAL_EXIT" -ne 0 ]; then
    VERDICT_LINE='VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","dimension":"correctness","what":"signals red EXIT='$SIGNAL_EXIT'","fix_hint":"see signal output"}]}'
  fi
  log "--- final verdict for iteration $ITER ---"
  log "$VERDICT_LINE"

  # ---------- DECISION ----------
  if printf '%s\n' "$VERDICT_LINE" | grep -qE '"verdict"[[:space:]]*:[[:space:]]*"pass"' && \
     printf '%s\n' "$VERDICT_LINE" | grep -qE '"improvements_exhausted"[[:space:]]*:[[:space:]]*true'; then
    EXHAUSTION_STREAK=$((EXHAUSTION_STREAK + 1))
    if [ "$EXHAUSTION_STREAK" -ge "$QUIET_STREAK" ]; then
      log "# EXHAUSTED at iteration $ITER (streak=$EXHAUSTION_STREAK >= QUIET_STREAK=$QUIET_STREAK)"
      END_TS=$(date +%s)
      DURATION=$((END_TS - START_TS))
      printf '{"status":"exhausted","iterations":%d,"final_signal_exit":%d,"duration_s":%d}\n' \
             "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION"
      [ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
    fi
    PREV_ISSUES="(reviewer claimed exhausted; do one more skeptical pass across all nine dimensions)"
  else
    EXHAUSTION_STREAK=0
    PREV_ISSUES=$(printf '%s\n' "$VERDICT_LINE" | sed -E 's/^VERDICT:[[:space:]]*//')
  fi
  PREV_SIGNALS="$SIGNAL_OUTPUT"$'\n'"EXIT=$SIGNAL_EXIT"
done

log "# MAX_ITER_REACHED ($ITER iterations, last EXIT=$LAST_SIGNAL_EXIT)"
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))
printf '{"status":"max_iter_reached","iterations":%d,"final_signal_exit":%d,"duration_s":%d}\n' \
       "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION"
[ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
