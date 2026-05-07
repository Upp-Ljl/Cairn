#!/usr/bin/env bash
# Generic dual-agent (executor + reviewer) iteration driver, with a profiler
# warm-up step that derives a project-specific MANIFEST of audit dimensions.
#
# Bash IS the orchestrator. Each iteration runs SEPARATE `claude -p` calls —
# one as the executor (edits files), one as the reviewer (audits + emits
# VERDICT). A single one-shot `claude -p` call as the profiler runs once
# before the first iteration. No single Claude session plays both roles, so
# the mutual-supervision pattern is mechanically enforced.
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
#   PROFILE_MODEL — model for the one-shot profiler step. Default: same as MODEL.
#   SKIP_PROFILE  — set to "1" to skip profiler and use a generic 3-dim manifest.
#                   Useful for tiny projects where the profiler overhead isn't
#                   worth it (e.g. fixing a single file).
#   MAX_SIGNAL_TAIL — when sending signal output to the reviewer/executor, cap
#                     to this many lines. Default: 80.
#   MAX_ITER      — hard cap on iterations. Default: 10.
#   LOG_FILE      — append per-iteration trace here. Default: stderr.
#   PROMPT_DIR    — where to drop prompt files for debugging. Default: a tmp dir.
#   PROJECT_ROOT  — directory containing .claude/agents/{executor,reviewer,profiler}.md.
#                   Default: this script's parent's parent.
#
# stdout: a single JSON summary line on completion:
#   {"status":"exhausted"|"max_iter_reached","iterations":N,"final_signal_exit":N,"duration_s":N,"manifest_dims":N}
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
PROFILE_MODEL="${PROFILE_MODEL:-$MODEL}"
SKIP_PROFILE="${SKIP_PROFILE:-0}"
MAX_SIGNAL_TAIL="${MAX_SIGNAL_TAIL:-80}"
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
PROF_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/profiler.md"
if [ ! -f "$EXEC_PERSONA_FILE" ] || [ ! -f "$REV_PERSONA_FILE" ]; then
  echo "{\"error\":\"missing persona files at $EXEC_PERSONA_FILE / $REV_PERSONA_FILE\"}" >&2
  exit 2
fi
EXECUTOR_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$EXEC_PERSONA_FILE")
REVIEWER_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$REV_PERSONA_FILE")
PROFILER_PERSONA=""
if [ -f "$PROF_PERSONA_FILE" ]; then
  PROFILER_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$PROF_PERSONA_FILE")
fi

# Load TASK content
if [ -f "$TASK_FILE" ]; then
  TASK_CONTENT=$(cat "$TASK_FILE")
else
  TASK_CONTENT="(no TASK file provided; reviewer should infer from work_dir contents)"
fi

mkdir -p "$PROMPT_DIR"

START_TS=$(date +%s)

log() { printf '%s\n' "$*" >>"$LOG_FILE"; }

# Truncate text to a sensible window for downstream prompts.
# - When green (caller passes signal_exit=0), we replace the body with "EXIT=0".
# - When red, we keep the last MAX_SIGNAL_TAIL lines so the failing context is
#   visible without ballooning the prompt with megabytes of pytest verbose output.
truncate_signal() {
  local body="$1"
  local exit_code="$2"
  local total_lines
  total_lines=$(printf '%s' "$body" | wc -l | tr -d ' ')
  if [ "$exit_code" -eq 0 ]; then
    # On green, signal output is irrelevant for context. Save tokens.
    printf 'EXIT=0 (%d lines suppressed; signal is green)\n' "$total_lines"
    return
  fi
  if [ "$total_lines" -le "$MAX_SIGNAL_TAIL" ]; then
    printf '%s\nEXIT=%d\n' "$body" "$exit_code"
    return
  fi
  printf '...(omitted %d earlier lines)...\n' "$((total_lines - MAX_SIGNAL_TAIL))"
  printf '%s' "$body" | tail -n "$MAX_SIGNAL_TAIL"
  printf '\nEXIT=%d\n' "$exit_code"
}

# ---------- PROFILER (iteration 0) ----------
MANIFEST_FILE="$PROMPT_DIR/manifest.json"
MANIFEST_RAW="$PROMPT_DIR/manifest.raw"
PROFILE_DIMS=0

if [ "$SKIP_PROFILE" = "1" ] || [ -z "$PROFILER_PERSONA" ]; then
  log ""
  log "=== profile (skipped: SKIP_PROFILE=$SKIP_PROFILE, profiler_persona_present=$( [ -n "$PROFILER_PERSONA" ] && echo yes || echo no )) ==="
  cat > "$MANIFEST_FILE" <<'GENERIC_EOF'
{"domain":"generic","summary":"profiler skipped; using generic dimension set","dimensions":[{"name":"correctness","rationale":"default safety net","checks":["bugs / off-by-one / null paths","TASK requirements actually met","signal command exits 0"]},{"name":"test_coverage","rationale":"default safety net","checks":["asserted behaviors are exercised","no test was modified to make it pass"]},{"name":"maintainability","rationale":"default safety net","checks":["naming clarity","no dead code","no obvious duplication"]}]}
GENERIC_EOF
  PROFILE_DIMS=3
else
  log ""
  log "=== profile (profiler) ==="
  PROF_PROMPT_FILE="$PROMPT_DIR/iter0_profile.prompt"
  {
    printf '%s\n' "$PROFILER_PERSONA"
    cat <<PROF_EOF

=== Per-invocation context ===

WORK_DIR: $WORK_DIR
SIGNAL_CMD: $SIGNAL_CMD

TASK:
$TASK_CONTENT

Your output must end with a single line beginning with MANIFEST: containing
valid JSON per your spec above.
PROF_EOF
  } > "$PROF_PROMPT_FILE"
  log "--- profiler prompt: $PROF_PROMPT_FILE ---"
  log "--- profiler output ---"
  PROFILE_OUTPUT=$(claude -p "$(< "$PROF_PROMPT_FILE")" \
                          --add-dir "$WORK_DIR" \
                          --model "$PROFILE_MODEL" 2>&1)
  printf '%s\n' "$PROFILE_OUTPUT" >>"$LOG_FILE"
  printf '%s\n' "$PROFILE_OUTPUT" > "$MANIFEST_RAW"
  MANIFEST_LINE=$(printf '%s\n' "$PROFILE_OUTPUT" | grep -E '^MANIFEST:' | tail -1)
  if [ -n "$MANIFEST_LINE" ]; then
    # Strip the leading "MANIFEST: " prefix to get the JSON body.
    printf '%s\n' "$MANIFEST_LINE" | sed -E 's/^MANIFEST:[[:space:]]*//' > "$MANIFEST_FILE"
    # Lightweight dimension count via grep on the JSON. Falls back to 0 on parse trouble.
    PROFILE_DIMS=$(grep -oE '"name"[[:space:]]*:' "$MANIFEST_FILE" | wc -l | tr -d ' ')
    [ -z "$PROFILE_DIMS" ] && PROFILE_DIMS=0
    log "# profiler emitted manifest with $PROFILE_DIMS dimension(s)"
  else
    log "# profiler did not emit a MANIFEST line — falling back to generic 3-dim safety net"
    cat > "$MANIFEST_FILE" <<'GENERIC_EOF'
{"domain":"generic","summary":"profiler did not emit MANIFEST; using generic dimension set","dimensions":[{"name":"correctness","rationale":"default safety net","checks":["bugs / off-by-one / null paths","TASK requirements actually met","signal command exits 0"]},{"name":"test_coverage","rationale":"default safety net","checks":["asserted behaviors are exercised","no test was modified to make it pass"]},{"name":"maintainability","rationale":"default safety net","checks":["naming clarity","no dead code","no obvious duplication"]}]}
GENERIC_EOF
    PROFILE_DIMS=3
  fi
fi

MANIFEST_JSON=$(cat "$MANIFEST_FILE")

# ---------- ITERATION LOOP ----------
ITER=0
EXHAUSTION_STREAK=0
PREV_ISSUES="(none — first iteration)"
PREV_SIGNALS="(none — first iteration)"
LAST_SIGNAL_EXIT=1

# RECURRING_ISSUES tracking: a poor-man's count of how many consecutive
# iterations a (dimension, normalized fix_hint) pair has been flagged. We use
# a simple newline-delimited file: each line is "<count>\t<dim>\t<hint>".
ISSUE_HISTORY_FILE="$PROMPT_DIR/issue_history.tsv"
: > "$ISSUE_HISTORY_FILE"
RECURRING_ISSUES_TEXT="(none — first iteration)"

# Update issue history given the previous iteration's verdict line.
# Bumps counts for repeated (dim, hint) pairs, resets pairs not seen this round.
update_issue_history() {
  local verdict_json="$1"
  local seen_pairs_file
  seen_pairs_file=$(mktemp -t issue-seen.XXXXXX)

  # Extract (dimension, fix_hint) pairs via tolerant grep — these JSON shapes
  # come from a separate Claude process so we keep parsing forgiving.
  printf '%s\n' "$verdict_json" \
    | tr ',' '\n' \
    | awk '
        /"dimension"[[:space:]]*:[[:space:]]*"/ {
          match($0, /"dimension"[[:space:]]*:[[:space:]]*"[^"]*"/);
          dim = substr($0, RSTART, RLENGTH);
          gsub(/.*"dimension"[[:space:]]*:[[:space:]]*"/, "", dim);
          gsub(/"$/, "", dim);
        }
        /"fix_hint"[[:space:]]*:[[:space:]]*"/ {
          match($0, /"fix_hint"[[:space:]]*:[[:space:]]*"[^"]*"/);
          hint = substr($0, RSTART, RLENGTH);
          gsub(/.*"fix_hint"[[:space:]]*:[[:space:]]*"/, "", hint);
          gsub(/"$/, "", hint);
          # Normalize: lowercase, collapse whitespace, take first 80 chars.
          hint_norm = tolower(hint); gsub(/[ \t]+/, " ", hint_norm);
          if (length(hint_norm) > 80) hint_norm = substr(hint_norm, 1, 80);
          if (dim != "" && hint_norm != "") {
            print dim "\t" hint_norm;
          }
          dim = ""; hint = "";
        }
      ' | sort -u > "$seen_pairs_file"

  # Build new history file: bump count for pairs seen now AND in prior history;
  # carry forward (without bumping) is omitted — we only care about CONSECUTIVE
  # repetition, so unseen pairs reset.
  local new_history
  new_history=$(mktemp -t issue-history.XXXXXX)
  : > "$new_history"

  # For each pair seen this round, look up old count and increment.
  while IFS=$'\t' read -r dim hint; do
    [ -z "$dim" ] && continue
    local old_count
    old_count=$(awk -F'\t' -v d="$dim" -v h="$hint" '$2==d && $3==h {print $1}' "$ISSUE_HISTORY_FILE" | head -1)
    [ -z "$old_count" ] && old_count=0
    local new_count=$((old_count + 1))
    printf '%d\t%s\t%s\n' "$new_count" "$dim" "$hint" >> "$new_history"
  done < "$seen_pairs_file"

  mv "$new_history" "$ISSUE_HISTORY_FILE"
  rm -f "$seen_pairs_file"
}

# Build a short "RECURRING_ISSUES" summary string for prompts.
# Lists pairs that have been flagged 2+ consecutive iterations.
build_recurring_summary() {
  if [ ! -s "$ISSUE_HISTORY_FILE" ]; then
    printf '(none)'
    return
  fi
  local out
  out=$(awk -F'\t' '$1>=2 {printf("- [%dx] %s: %s\n", $1, $2, $3)}' "$ISSUE_HISTORY_FILE")
  if [ -z "$out" ]; then
    printf '(none)'
  else
    printf '%s' "$out"
  fi
}

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

MANIFEST (project-specific dimensions of quality the reviewer audits against):
$MANIFEST_JSON

Previous reviewer issues. Address these in priority order, blocker first then
major then minor:
$PREV_ISSUES

Previous signal output:
$PREV_SIGNALS

Recurring issue classes (flagged 2+ iterations in a row — if you've genuinely
addressed them and they keep coming back, push back in self_assessment rather
than re-applying the same fix):
$RECURRING_ISSUES_TEXT

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

  TRUNCATED_SIGNAL=$(truncate_signal "$SIGNAL_OUTPUT" "$SIGNAL_EXIT")

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

MANIFEST (audit against these dimensions; not a generic 9-dim list):
$MANIFEST_JSON

Executor's last summary. Distrust by default; verify with your own reads:
$EXEC_SUMMARY

Latest signal output:
$TRUNCATED_SIGNAL

Recurring issue classes (these have been flagged 2+ consecutive iterations.
Do NOT re-flag the same class without genuine new evidence — move on or
admit exhaustion):
$RECURRING_ISSUES_TEXT

Iteration: $ITER of $MAX_ITER

Inspection requirement: read at least one file under $WORK_DIR via Bash
cat or Read before issuing your verdict. Do NOT issue a verdict purely
from the executor's summary or the signal output.

Audit each manifest dimension's checks. Cite the dimension name in each
issue's "dimension" field.

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

  # ---------- UPDATE ISSUE HISTORY ----------
  update_issue_history "$VERDICT_LINE"
  RECURRING_ISSUES_TEXT=$(build_recurring_summary)

  # ---------- DECISION ----------
  if printf '%s\n' "$VERDICT_LINE" | grep -qE '"verdict"[[:space:]]*:[[:space:]]*"pass"' && \
     printf '%s\n' "$VERDICT_LINE" | grep -qE '"improvements_exhausted"[[:space:]]*:[[:space:]]*true'; then
    EXHAUSTION_STREAK=$((EXHAUSTION_STREAK + 1))
    if [ "$EXHAUSTION_STREAK" -ge "$QUIET_STREAK" ]; then
      log "# EXHAUSTED at iteration $ITER (streak=$EXHAUSTION_STREAK >= QUIET_STREAK=$QUIET_STREAK)"
      END_TS=$(date +%s)
      DURATION=$((END_TS - START_TS))
      printf '{"status":"exhausted","iterations":%d,"final_signal_exit":%d,"duration_s":%d,"manifest_dims":%d}\n' \
             "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION" "$PROFILE_DIMS"
      [ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
    fi
    PREV_ISSUES="(reviewer claimed exhausted; do one more skeptical pass across the manifest dimensions)"
  else
    EXHAUSTION_STREAK=0
    PREV_ISSUES=$(printf '%s\n' "$VERDICT_LINE" | sed -E 's/^VERDICT:[[:space:]]*//')
  fi
  PREV_SIGNALS="$TRUNCATED_SIGNAL"
done

log "# MAX_ITER_REACHED ($ITER iterations, last EXIT=$LAST_SIGNAL_EXIT)"
END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))
printf '{"status":"max_iter_reached","iterations":%d,"final_signal_exit":%d,"duration_s":%d,"manifest_dims":%d}\n' \
       "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION" "$PROFILE_DIMS"
[ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
