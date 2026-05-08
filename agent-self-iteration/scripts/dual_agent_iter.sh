#!/usr/bin/env bash
# Generic multi-agent (profiler + validator + executor + reviewer-council)
# iteration driver, with mechanical safeguards against runaway loops, vague
# tasks, large repos, brittle CLI parsing, and roleplay.
#
# Bash IS the orchestrator. Each role runs as a SEPARATE `claude -p` call.
# A single Claude session attempting to play multiple roles collapses into
# self-approval; the bash driver prevents that by construction.
#
# Pipeline:
#   iter 0:  profiler   → emits MANIFEST (project-specific audit dimensions)
#   iter 0:  validator  → second-opinion sanity check on the MANIFEST
#   iter N:  executor   → edits files
#   iter N:  signal     → runs SIGNAL_CMD (pytest / tsc / lint / custom)
#   iter N:  reviewer   → audits against MANIFEST, emits VERDICT
#   loop until reviewer says improvements_exhausted=true for QUIET_STREAK
#   consecutive iters, OR MAX_ITER hit, OR a mechanical safeguard fires.
#
# Mechanical safeguards (all configurable, all default ON or sensible):
#   - DIFF_BUDGET           (W1) — caps cumulative line changes across iters.
#   - REVIEWER_COUNCIL      (W1) — N parallel reviewers must agree to converge.
#   - STUCK_THRESHOLD       (W4) — bail when content unchanged for N iters.
#   - SAFETY_VALIDATE_MANIFEST (W3) — second-opinion on profiler output.
#   - Robust JSON parsing   (W6) — tolerate code fences, bad indentation.
#   - Roleplay detection    (W7) — claimed_changes vs. real workdir hash.
#   - changed_files threading (W5) — reviewer reads exactly what changed.
#
# Usage:
#   dual_agent_iter.sh <work_dir>
#
# Configuration via env vars:
#   TASK_FILE                 — TASK.md path. Default: <work_dir>/TASK.md.
#   SIGNAL_CMD                — shell command run from <work_dir>; exit 0 = green.
#                               Default: "python3 -m pytest -q".
#   MAX_ITER                  — hard cap on iterations. Default: 10.
#   QUIET_STREAK              — consecutive pass+exhausted needed to exit. Default: 2.
#   MODEL                     — claude model for executor/reviewer. Default: claude-sonnet-4-6.
#   PROFILE_MODEL             — model for profiler. Default: same as MODEL.
#   VALIDATOR_MODEL           — model for manifest validator. Default: claude-haiku-4-5-20251001.
#   SKIP_PROFILE              — "1" → use generic 3-dim manifest. Default: 0.
#   SAFETY_VALIDATE_MANIFEST  — "0" → skip the validator pass. Default: 1.
#   REVIEWER_COUNCIL          — N parallel reviewers; verdict requires unanimity. Default: 1.
#   MAX_DIFF_LINES            — cumulative line-change cap (0 = disabled). Default: 0.
#   STUCK_THRESHOLD           — bail when N iters in a row leave content unchanged. Default: 3.
#   MAX_SIGNAL_TAIL           — red signal output truncated to last N lines. Default: 80.
#   UI_RENDER                 — "1" → render screenshots before each reviewer call so
#                                multimodal reviewer can perform a visual audit.
#                                Default: 0. Requires `playwright` Python module + chromium.
#   UI_URL                    — URL to render (preferred over UI_FILE). Default: empty.
#   UI_FILE                   — local file path; rendered as file:// URI when UI_URL unset.
#                                Default: <work_dir>/index.html if it exists.
#   UI_VIEWPORTS              — comma-separated WxH list. Default: "1280x800,375x812".
#   UI_WAIT_MS                — ms to wait after load before screenshot. Default: 600.
#   UI_FULL_PAGE              — "1" → capture full scroll, not just viewport. Default: 0.
#   LOG_FILE                  — append per-iteration trace here. Default: stderr.
#   PROMPT_DIR                — where to drop prompt files. Default: a tmp dir.
#   PROJECT_ROOT              — where .claude/agents/ live. Default: this script's parent's parent.
#
# stdout: a single JSON summary line on completion:
#   {"status":"exhausted"|"max_iter_reached"|"stuck"|"diff_budget_exceeded",
#    "iterations":N,"final_signal_exit":N,"duration_s":N,"manifest_dims":N,
#    "manifest_validation":"ok|warn|skipped",
#    "diff_lines":N}
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
VALIDATOR_MODEL="${VALIDATOR_MODEL:-claude-haiku-4-5-20251001}"
SKIP_PROFILE="${SKIP_PROFILE:-0}"
SAFETY_VALIDATE_MANIFEST="${SAFETY_VALIDATE_MANIFEST:-1}"
REVIEWER_COUNCIL="${REVIEWER_COUNCIL:-1}"
MAX_DIFF_LINES="${MAX_DIFF_LINES:-0}"
STUCK_THRESHOLD="${STUCK_THRESHOLD:-3}"
MAX_SIGNAL_TAIL="${MAX_SIGNAL_TAIL:-80}"
UI_RENDER="${UI_RENDER:-0}"
UI_URL="${UI_URL:-}"
UI_FILE="${UI_FILE:-}"
UI_VIEWPORTS="${UI_VIEWPORTS:-1280x800,375x812}"
UI_WAIT_MS="${UI_WAIT_MS:-600}"
UI_FULL_PAGE="${UI_FULL_PAGE:-0}"
LOG_FILE="${LOG_FILE:-/dev/stderr}"
PROMPT_DIR="${PROMPT_DIR:-$(mktemp -d -t dual-agent.XXXXXX)}"

# UI_FILE auto-detect: if UI_RENDER=1 but no URL/FILE provided, look for
# common static-site entrypoints in WORK_DIR.
if [ "$UI_RENDER" = "1" ] && [ -z "$UI_URL" ] && [ -z "$UI_FILE" ]; then
  for candidate in index.html public/index.html dist/index.html src/index.html; do
    if [ -f "$WORK_DIR/$candidate" ]; then
      UI_FILE="$WORK_DIR/$candidate"
      break
    fi
  done
fi

# Validate claude CLI
if ! command -v claude >/dev/null 2>&1; then
  echo '{"error":"claude CLI not found in PATH"}' >&2
  exit 2
fi

# Load persona bodies (skip frontmatter via awk)
EXEC_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/executor.md"
REV_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/reviewer.md"
PROF_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/profiler.md"
VALIDATOR_PERSONA_FILE="$PROJECT_ROOT/.claude/agents/validator.md"
if [ ! -f "$EXEC_PERSONA_FILE" ] || [ ! -f "$REV_PERSONA_FILE" ]; then
  echo "{\"error\":\"missing persona files at $EXEC_PERSONA_FILE / $REV_PERSONA_FILE\"}" >&2
  exit 2
fi
EXECUTOR_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$EXEC_PERSONA_FILE")
REVIEWER_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$REV_PERSONA_FILE")
PROFILER_PERSONA=""
[ -f "$PROF_PERSONA_FILE" ] && PROFILER_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$PROF_PERSONA_FILE")
VALIDATOR_PERSONA=""
[ -f "$VALIDATOR_PERSONA_FILE" ] && VALIDATOR_PERSONA=$(awk '/^---$/{n++; next} n>=2{print}' "$VALIDATOR_PERSONA_FILE")

# Load TASK content
if [ -f "$TASK_FILE" ]; then
  TASK_CONTENT=$(cat "$TASK_FILE")
else
  TASK_CONTENT="(no TASK file provided; reviewer should infer from work_dir contents)"
fi

mkdir -p "$PROMPT_DIR"

START_TS=$(date +%s)

log() { printf '%s\n' "$*" >>"$LOG_FILE"; }

# ============================================================================
# W6: Robust JSON extraction after a sentinel.
# Tolerates code fences, leading whitespace, and sentinel appearing inline.
# Args: $1 = output text, $2 = sentinel (e.g. "MANIFEST", "VERDICT")
# Prints the JSON body (after sentinel:) to stdout, or empty string if none.
# ============================================================================
extract_json_after_sentinel() {
  local body="$1"
  local sentinel="$2"
  # Strip code-fence markers that some models add around JSON.
  local cleaned
  cleaned=$(printf '%s\n' "$body" | sed -E 's/^```(json)?[[:space:]]*$//')
  # Find the LAST line containing "<sentinel>:" (anywhere on the line, not just ^).
  local line
  line=$(printf '%s\n' "$cleaned" | grep -E "(^|[[:space:]])${sentinel}:" | tail -1)
  if [ -z "$line" ]; then
    return 0
  fi
  # Take everything after the first occurrence of "<sentinel>:" on that line.
  printf '%s\n' "$line" | sed -E "s/^.*${sentinel}:[[:space:]]*//"
}

# ============================================================================
# W6: Validate that a JSON string has the keys we expect for a VERDICT.
# Returns 0 if shape looks ok, 1 if missing a required key.
# We use grep instead of a JSON parser to avoid a python dependency at runtime.
# ============================================================================
validate_verdict_shape() {
  local json="$1"
  printf '%s' "$json" | grep -qE '"verdict"[[:space:]]*:' || return 1
  printf '%s' "$json" | grep -qE '"improvements_exhausted"[[:space:]]*:' || return 1
  return 0
}

# ============================================================================
# W1/W4/W7: Compute a content hash of all source-like files in WORK_DIR.
# Excludes noise (caches, lockfiles, build outputs). Used for stuck-detection,
# diff-budget tracking, and roleplay detection (claimed-vs-actual change).
# ============================================================================
compute_workdir_hash() {
  local dir="$1"
  ( cd "$dir" 2>/dev/null && \
    find . -type f \
      ! -path '*/.git/*' \
      ! -path '*/__pycache__/*' \
      ! -path '*/.pytest_cache/*' \
      ! -path '*/node_modules/*' \
      ! -path '*/.regression-runs/*' \
      ! -path '*/.iter-runs/*' \
      ! -name '.DS_Store' \
      ! -name '*.pyc' \
      -print0 2>/dev/null \
    | LC_ALL=C sort -z \
    | xargs -0 shasum 2>/dev/null \
    | shasum \
    | awk '{print $1}' )
}

# ============================================================================
# W1: Snapshot WORK_DIR to a side directory (for diff-budget computation).
# Excludes the same noise as compute_workdir_hash.
# ============================================================================
snapshot_workdir() {
  local src="$1"
  local dst="$2"
  rm -rf "$dst"
  mkdir -p "$dst"
  ( cd "$src" 2>/dev/null && \
    find . -type f \
      ! -path '*/.git/*' \
      ! -path '*/__pycache__/*' \
      ! -path '*/.pytest_cache/*' \
      ! -path '*/node_modules/*' \
      ! -path '*/.regression-runs/*' \
      ! -path '*/.iter-runs/*' \
      ! -name '.DS_Store' \
      ! -name '*.pyc' \
      -print0 2>/dev/null \
    | LC_ALL=C sort -z \
    | tar --null -cf - --files-from=- 2>/dev/null \
    | tar -xf - -C "$dst" 2>/dev/null )
}

# ============================================================================
# W1: Compute total diff line count between baseline snapshot and current state.
# Returns the count on stdout. Used to enforce MAX_DIFF_LINES.
# ============================================================================
compute_diff_lines() {
  local baseline="$1"
  local current="$2"
  diff -ruN --new-file "$baseline" "$current" 2>/dev/null \
    | grep -E '^[+-]' \
    | grep -vE '^(\+\+\+|---) ' \
    | wc -l \
    | tr -d ' '
}

# ============================================================================
# Truncate signal output for prompt budget (existing W2-style optimization).
# Green → single "EXIT=0" line. Red → tail of output + EXIT code.
# ============================================================================
truncate_signal() {
  local body="$1"
  local exit_code="$2"
  local total_lines
  total_lines=$(printf '%s' "$body" | wc -l | tr -d ' ')
  if [ "$exit_code" -eq 0 ]; then
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

# ============================================================================
# W2: Compress prev_issues to JUST the issues array (drop verdict wrapper).
# Reduces per-iter prompt size; the executor only acts on the issues anyway.
# ============================================================================
compress_issues_for_executor() {
  local verdict_json="$1"
  # Extract the "issues" array verbatim. Tolerant grep: find the issues:[...] block.
  local extracted
  extracted=$(printf '%s' "$verdict_json" \
    | grep -oE '"issues"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
    | head -1)
  if [ -z "$extracted" ]; then
    # Fallback: pass the whole verdict (might be malformed; still useful).
    printf '%s' "$verdict_json"
  else
    printf '%s' "$extracted"
  fi
}

# ============================================================================
# W5: Extract changed_files array from EXECUTOR_SUMMARY for reviewer threading.
# Returns a comma-separated list, or "(none reported)" on parse fail.
# ============================================================================
extract_changed_files() {
  local exec_summary="$1"
  local list
  list=$(printf '%s' "$exec_summary" \
    | grep -oE '"changed_files"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
    | head -1 \
    | grep -oE '"[^"]+"' \
    | grep -v '^"changed_files"$' \
    | tr -d '"' \
    | tr '\n' ',' \
    | sed 's/,$//')
  if [ -z "$list" ]; then
    printf '(none reported)'
  else
    printf '%s' "$list"
  fi
}

# ============================================================================
# W7: Check whether executor's claimed changes match real workdir state.
# Emits a "ROLEPLAY" warning to log when claim/reality diverge.
# Args: $1 = exec_summary, $2 = hash_before, $3 = hash_after.
# ============================================================================
detect_roleplay() {
  local exec_summary="$1"
  local hash_before="$2"
  local hash_after="$3"
  local claimed
  claimed=$(extract_changed_files "$exec_summary")
  if [ "$claimed" != "(none reported)" ] && [ "$hash_before" = "$hash_after" ]; then
    log "# ROLEPLAY: executor claimed changed_files=[$claimed] but workdir hash is unchanged"
    return 1
  fi
  if [ "$claimed" = "(none reported)" ] && [ "$hash_before" != "$hash_after" ]; then
    log "# DRIFT: executor reported no changes but workdir hash changed"
  fi
  return 0
}

# ============================================================================
# W7: Check that executor's commands_run includes the signal command (or close).
# Logs a warning when the executor skipped local verification.
# ============================================================================
verify_signal_was_run() {
  local exec_summary="$1"
  local signal_head
  signal_head=$(printf '%s' "$SIGNAL_CMD" | awk '{print $1}')
  if ! printf '%s' "$exec_summary" | grep -q "$signal_head"; then
    log "# WARNING: executor's commands_run does not mention '$signal_head' (signal may not have been verified locally)"
  fi
}

# ============================================================================
# Visual rendering: render screenshots for the reviewer's multimodal audit.
# Returns the screenshot directory path on success, or empty string on
# soft-fail (driver continues without screenshots).
# Args: $1 = iteration number (used to namespace the output dir)
# ============================================================================
render_ui_for_iteration() {
  local iter="$1"
  if [ "$UI_RENDER" != "1" ]; then
    printf ''
    return 0
  fi
  if [ -z "$UI_URL" ] && [ -z "$UI_FILE" ]; then
    log "# UI_RENDER=1 but neither UI_URL nor UI_FILE resolved — skipping render"
    printf ''
    return 0
  fi
  local shots_dir="$PROMPT_DIR/iter${iter}_shots"
  local render_args=()
  if [ -n "$UI_URL" ]; then
    render_args+=(--url "$UI_URL")
  else
    render_args+=(--file "$UI_FILE")
  fi
  render_args+=(--out "$shots_dir" --viewports "$UI_VIEWPORTS" --wait "$UI_WAIT_MS")
  [ "$UI_FULL_PAGE" = "1" ] && render_args+=(--full-page)

  log "--- rendering UI screenshots → $shots_dir ---"
  local render_log="$shots_dir/render.log"
  mkdir -p "$shots_dir"
  python3 "$PROJECT_ROOT/scripts/render_ui.py" "${render_args[@]}" \
    >>"$render_log" 2>&1
  local rc=$?
  cat "$render_log" >>"$LOG_FILE" 2>/dev/null || true
  if [ "$rc" = "0" ]; then
    log "# UI screenshots written to $shots_dir"
    printf '%s' "$shots_dir"
  elif [ "$rc" = "2" ]; then
    log "# UI render skipped (playwright not installed)"
    printf ''
  else
    log "# UI render failed (rc=$rc); reviewer will run text-only"
    printf ''
  fi
}

# ============================================================================
# W1: Multi-reviewer council aggregation.
# Given N reviewer outputs, returns a single VERDICT line where:
#   verdict = "pass" iff ALL reviewers said pass
#   improvements_exhausted = true iff ALL reviewers said true
#   issues = union of all reviewers' issues (with reviewer prefix on `where`)
# ============================================================================
aggregate_council_verdicts() {
  local council_dir="$1"
  local n_reviewers
  n_reviewers=$(ls "$council_dir"/reviewer_*.verdict 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n_reviewers" = "0" ]; then
    printf 'VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","what":"council produced no verdicts"}]}'
    return
  fi

  local all_pass=1
  local all_exhausted=1
  local merged_issues=""
  local r
  for r in "$council_dir"/reviewer_*.verdict; do
    local body
    body=$(cat "$r")
    if ! printf '%s' "$body" | grep -qE '"verdict"[[:space:]]*:[[:space:]]*"pass"'; then
      all_pass=0
    fi
    if ! printf '%s' "$body" | grep -qE '"improvements_exhausted"[[:space:]]*:[[:space:]]*true'; then
      all_exhausted=0
    fi
    # Extract issues array body (everything between the first matching brackets).
    local issues
    issues=$(printf '%s' "$body" | grep -oE '"issues"[[:space:]]*:[[:space:]]*\[[^]]*\]' | head -1 | sed -E 's/^"issues"[[:space:]]*:[[:space:]]*\[//; s/\]$//')
    if [ -n "$issues" ]; then
      [ -n "$merged_issues" ] && merged_issues="${merged_issues},"
      merged_issues="${merged_issues}${issues}"
    fi
  done

  local verdict_str="fail"
  [ "$all_pass" = "1" ] && verdict_str="pass"
  local exhausted_str="false"
  [ "$all_exhausted" = "1" ] && exhausted_str="true"

  printf 'VERDICT: {"verdict":"%s","improvements_exhausted":%s,"issues":[%s],"notes":"council of %d reviewers"}' \
    "$verdict_str" "$exhausted_str" "$merged_issues" "$n_reviewers"
}

# ============================================================================
# Issue history tracking (recurring-issue dedupe; existing logic).
# ============================================================================
ISSUE_HISTORY_FILE="$PROMPT_DIR/issue_history.tsv"
: > "$ISSUE_HISTORY_FILE"
RECURRING_ISSUES_TEXT="(none — first iteration)"

update_issue_history() {
  local verdict_json="$1"
  local seen_pairs_file
  seen_pairs_file=$(mktemp -t issue-seen.XXXXXX)

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
          hint_norm = tolower(hint); gsub(/[ \t]+/, " ", hint_norm);
          if (length(hint_norm) > 80) hint_norm = substr(hint_norm, 1, 80);
          if (dim != "" && hint_norm != "") {
            print dim "\t" hint_norm;
          }
          dim = ""; hint = "";
        }
      ' | sort -u > "$seen_pairs_file"

  local new_history
  new_history=$(mktemp -t issue-history.XXXXXX)
  : > "$new_history"
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

# ============================================================================
# PROFILER (iteration 0): emit MANIFEST.
# ============================================================================
MANIFEST_FILE="$PROMPT_DIR/manifest.json"
MANIFEST_RAW="$PROMPT_DIR/manifest.raw"
PROFILE_DIMS=0

if [ "$SKIP_PROFILE" = "1" ] || [ -z "$PROFILER_PERSONA" ]; then
  log ""
  log "=== profile (skipped: SKIP_PROFILE=$SKIP_PROFILE) ==="
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
  MANIFEST_BODY=$(extract_json_after_sentinel "$PROFILE_OUTPUT" "MANIFEST")
  if [ -n "$MANIFEST_BODY" ]; then
    printf '%s\n' "$MANIFEST_BODY" > "$MANIFEST_FILE"
    PROFILE_DIMS=$(grep -oE '"name"[[:space:]]*:' "$MANIFEST_FILE" | wc -l | tr -d ' ')
    [ -z "$PROFILE_DIMS" ] && PROFILE_DIMS=0
    log "# profiler emitted manifest with $PROFILE_DIMS dimension(s)"
  else
    log "# profiler did not emit a parseable MANIFEST line — falling back to generic 3-dim safety net"
    cat > "$MANIFEST_FILE" <<'GENERIC_EOF'
{"domain":"generic","summary":"profiler did not emit MANIFEST; using generic dimension set","dimensions":[{"name":"correctness","rationale":"default safety net","checks":["bugs / off-by-one / null paths","TASK requirements actually met","signal command exits 0"]},{"name":"test_coverage","rationale":"default safety net","checks":["asserted behaviors are exercised","no test was modified to make it pass"]},{"name":"maintainability","rationale":"default safety net","checks":["naming clarity","no dead code","no obvious duplication"]}]}
GENERIC_EOF
    PROFILE_DIMS=3
  fi
fi

MANIFEST_JSON=$(cat "$MANIFEST_FILE")

# ============================================================================
# W3: VALIDATOR — second-opinion sanity check on the MANIFEST.
# Cheap Haiku call. Emits an advisory note (never blocks).
# ============================================================================
MANIFEST_VALIDATION="skipped"
MANIFEST_WARNING_BLOCK=""
if [ "$SAFETY_VALIDATE_MANIFEST" = "1" ] && [ -n "$VALIDATOR_PERSONA" ]; then
  log ""
  log "=== manifest validator (Haiku second-opinion) ==="
  VAL_PROMPT_FILE="$PROMPT_DIR/iter0_validator.prompt"
  {
    printf '%s\n' "$VALIDATOR_PERSONA"
    cat <<VAL_EOF

=== Per-invocation context ===

WORK_DIR: $WORK_DIR
SIGNAL_CMD: $SIGNAL_CMD

TASK:
$TASK_CONTENT

MANIFEST emitted by the profiler:
$MANIFEST_JSON

Your output must end with a single line beginning with MANIFEST_VALIDATION:
containing valid JSON per your spec.
VAL_EOF
  } > "$VAL_PROMPT_FILE"
  VAL_OUTPUT=$(claude -p "$(< "$VAL_PROMPT_FILE")" \
                     --add-dir "$WORK_DIR" \
                     --model "$VALIDATOR_MODEL" 2>&1)
  printf '%s\n' "$VAL_OUTPUT" >>"$LOG_FILE"
  VAL_BODY=$(extract_json_after_sentinel "$VAL_OUTPUT" "MANIFEST_VALIDATION")
  if [ -n "$VAL_BODY" ]; then
    if printf '%s' "$VAL_BODY" | grep -qE '"verdict"[[:space:]]*:[[:space:]]*"warn"'; then
      MANIFEST_VALIDATION="warn"
      ADVICE=$(printf '%s' "$VAL_BODY" | grep -oE '"advice_to_loop"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^"advice_to_loop"[[:space:]]*:[[:space:]]*"//; s/"$//')
      [ -z "$ADVICE" ] && ADVICE="(validator flagged warn but provided no advice)"
      MANIFEST_WARNING_BLOCK="MANIFEST_WARNING (from second-opinion validator):
$ADVICE
"
      log "# manifest validator flagged warn: $ADVICE"
    else
      MANIFEST_VALIDATION="ok"
      log "# manifest validator: ok"
    fi
  else
    MANIFEST_VALIDATION="ok"
    log "# manifest validator: no parseable response — treating as ok"
  fi
fi

# ============================================================================
# Baseline snapshot for diff-budget tracking (W1) and stuck detection (W4).
# ============================================================================
BASELINE_DIR="$PROMPT_DIR/baseline"
snapshot_workdir "$WORK_DIR" "$BASELINE_DIR"
log "# baseline snapshot at $BASELINE_DIR (used for diff-budget + stuck detection)"
LAST_HASH=$(compute_workdir_hash "$WORK_DIR")
STUCK_COUNT=0
TERMINATION_REASON=""

# ============================================================================
# ITERATION LOOP
# ============================================================================
ITER=0
EXHAUSTION_STREAK=0
PREV_ISSUES="(none — first iteration)"
PREV_SIGNALS="(none — first iteration)"
LAST_SIGNAL_EXIT=1
DIFF_LINES=0

while [ "$ITER" -lt "$MAX_ITER" ]; do
  ITER=$((ITER + 1))
  log ""
  log "=== iteration $ITER ==="

  # Workdir hash before executor (for W7 roleplay detection).
  HASH_BEFORE=$(compute_workdir_hash "$WORK_DIR")

  # ----- EXECUTOR -----
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
${MANIFEST_WARNING_BLOCK:+
$MANIFEST_WARNING_BLOCK}
Previous reviewer issues (just the issues array, in priority order
blocker → major → minor):
$PREV_ISSUES

Previous signal output:
$PREV_SIGNALS

Recurring issue classes (flagged 2+ iterations in a row — if you've genuinely
addressed them and they keep coming back, push back in self_assessment rather
than re-applying the same fix):
$RECURRING_ISSUES_TEXT

Iteration: $ITER of $MAX_ITER. Loop exits as soon as the reviewer (or council
of $REVIEWER_COUNCIL reviewers) says improvements_exhausted with verdict pass
for $QUIET_STREAK consecutive iteration(s).

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

  # Workdir hash AFTER executor (for W7).
  HASH_AFTER_EXEC=$(compute_workdir_hash "$WORK_DIR")

  EXEC_SUMMARY=$(printf '%s\n' "$EXEC_OUTPUT" | grep -E '(^|[[:space:]])EXECUTOR_SUMMARY:' | tail -1)
  [ -z "$EXEC_SUMMARY" ] && EXEC_SUMMARY='EXECUTOR_SUMMARY: {} (executor did not emit a summary line — distrust)'

  # W7: roleplay + signal-was-run sanity checks (advisory; logs only).
  detect_roleplay "$EXEC_SUMMARY" "$HASH_BEFORE" "$HASH_AFTER_EXEC" || true
  verify_signal_was_run "$EXEC_SUMMARY"

  # W5: extract changed_files for reviewer threading.
  CHANGED_FILES=$(extract_changed_files "$EXEC_SUMMARY")

  # ----- SIGNALS -----
  log "--- signals after iteration $ITER ($SIGNAL_CMD) ---"
  SIGNAL_OUTPUT=$(cd "$WORK_DIR" && bash -c "$SIGNAL_CMD" 2>&1)
  SIGNAL_EXIT=$?
  printf '%s\n' "$SIGNAL_OUTPUT" >>"$LOG_FILE"
  log "EXIT=$SIGNAL_EXIT"
  LAST_SIGNAL_EXIT=$SIGNAL_EXIT
  TRUNCATED_SIGNAL=$(truncate_signal "$SIGNAL_OUTPUT" "$SIGNAL_EXIT")

  # W1: cumulative diff-budget check.
  DIFF_LINES=$(compute_diff_lines "$BASELINE_DIR" "$WORK_DIR")
  log "# cumulative diff lines so far: $DIFF_LINES (cap: $MAX_DIFF_LINES, 0=disabled)"
  if [ "$MAX_DIFF_LINES" -gt 0 ] && [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
    TERMINATION_REASON="diff_budget_exceeded"
    log "# DIFF BUDGET EXCEEDED: $DIFF_LINES > $MAX_DIFF_LINES — bailing out"
    break
  fi

  # Visual: render the UI to PNG screenshots before the reviewer runs so
  # the multimodal reviewer can perform a visual audit. Soft-fails when
  # playwright isn't installed — loop continues with text-only review.
  SHOTS_DIR=$(render_ui_for_iteration "$ITER")
  SCREENSHOTS_BLOCK=""
  if [ -n "$SHOTS_DIR" ] && [ -d "$SHOTS_DIR" ]; then
    # List PNGs the renderer produced so the reviewer knows what to read.
    SHOT_LIST=$(find "$SHOTS_DIR" -maxdepth 1 -name '*.png' -type f | sort | tr '\n' ' ')
    if [ -n "$SHOT_LIST" ]; then
      SCREENSHOTS_BLOCK="
SCREENSHOTS (rendered for visual audit; use the Read tool on each PNG —
Claude Code's Read tool returns image content directly to you):
$(printf '%s\n' "$SHOT_LIST" | tr ' ' '\n' | sed '/^$/d' | sed 's/^/  - /')

For each screenshot, evaluate the visual dimensions in the MANIFEST
(visual hierarchy, spacing rhythm, typography, color, alignment,
responsive polish, interaction affordance — whichever the profiler named).
When you raise an issue grounded in a screenshot, cite the file basename
in 'where' (e.g., 'desktop_1280x800.png:hero section').
"
    fi
  fi

  # ----- REVIEWER (single or council) -----
  COUNCIL_DIR="$PROMPT_DIR/iter${ITER}_council"
  mkdir -p "$COUNCIL_DIR"
  REV_PROMPT_FILE="$PROMPT_DIR/iter${ITER}_rev.prompt"
  {
    printf '%s\n' "$REVIEWER_PERSONA"
    cat <<REV_EOF

=== Per-iteration context ===

WORK_DIR: $WORK_DIR

TASK:
$TASK_CONTENT

MANIFEST (audit against these dimensions, not a generic checklist):
$MANIFEST_JSON
${MANIFEST_WARNING_BLOCK:+
$MANIFEST_WARNING_BLOCK}
Executor's last summary. Distrust by default; verify with your own reads:
$EXEC_SUMMARY

Files the executor reports changing this iteration. **Read at least these
files** before issuing your verdict — they are the surface where new bugs
would appear:
$CHANGED_FILES

Latest signal output:
$TRUNCATED_SIGNAL
${SCREENSHOTS_BLOCK}
Recurring issue classes (these have been flagged 2+ consecutive iterations.
Do NOT re-flag the same class without genuine new evidence — move on or
admit exhaustion):
$RECURRING_ISSUES_TEXT

Iteration: $ITER of $MAX_ITER

Audit each manifest dimension's checks. Cite the dimension name in each
issue's "dimension" field.

End your final message with the VERDICT JSON line per the spec above.
REV_EOF
  } > "$REV_PROMPT_FILE"
  log "--- reviewer prompt: $REV_PROMPT_FILE ---"

  # Build the reviewer's --add-dir args. Always include WORK_DIR; if we
  # rendered screenshots, also grant access to that dir so the reviewer's
  # Read tool can open the PNGs.
  REV_ADD_DIRS=(--add-dir "$WORK_DIR")
  if [ -n "$SHOTS_DIR" ] && [ -d "$SHOTS_DIR" ]; then
    REV_ADD_DIRS+=(--add-dir "$SHOTS_DIR")
  fi

  # Dispatch N reviewers in parallel.
  COUNCIL_PIDS=()
  i=1
  while [ "$i" -le "$REVIEWER_COUNCIL" ]; do
    (
      claude -p "$(< "$REV_PROMPT_FILE")" \
        "${REV_ADD_DIRS[@]}" \
        --model "$MODEL" \
        > "$COUNCIL_DIR/reviewer_${i}.raw" 2>&1
      # Extract verdict.
      verdict_body=$(extract_json_after_sentinel "$(cat "$COUNCIL_DIR/reviewer_${i}.raw")" "VERDICT")
      if [ -z "$verdict_body" ] || ! validate_verdict_shape "$verdict_body"; then
        echo '{"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","what":"reviewer #'"$i"' did not emit a parseable VERDICT line"}]}' > "$COUNCIL_DIR/reviewer_${i}.verdict"
      else
        printf '%s' "$verdict_body" > "$COUNCIL_DIR/reviewer_${i}.verdict"
      fi
    ) &
    COUNCIL_PIDS+=($!)
    i=$((i + 1))
  done
  for pid in "${COUNCIL_PIDS[@]}"; do
    wait "$pid"
  done
  log "--- reviewer council ($REVIEWER_COUNCIL reviewer(s)) finished ---"
  for r in "$COUNCIL_DIR"/reviewer_*.verdict; do
    log "# $(basename "$r"): $(cat "$r")"
  done
  printf '%s\n' "$(cat "$COUNCIL_DIR"/reviewer_*.raw 2>/dev/null)" >>"$LOG_FILE"

  # Aggregate council into a single VERDICT line.
  if [ "$REVIEWER_COUNCIL" = "1" ]; then
    VERDICT_BODY=$(cat "$COUNCIL_DIR"/reviewer_1.verdict 2>/dev/null)
    VERDICT_LINE="VERDICT: $VERDICT_BODY"
  else
    VERDICT_LINE=$(aggregate_council_verdicts "$COUNCIL_DIR")
  fi

  # Force-fail on red signals (mechanical, overrides reviewer).
  if [ "$SIGNAL_EXIT" -ne 0 ]; then
    VERDICT_LINE='VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","dimension":"correctness","what":"signals red EXIT='$SIGNAL_EXIT'","fix_hint":"see signal output"}]}'
  fi
  log "--- final verdict for iteration $ITER ---"
  log "$VERDICT_LINE"

  update_issue_history "$VERDICT_LINE"
  RECURRING_ISSUES_TEXT=$(build_recurring_summary)

  # W4: stuck detector — compare current hash to last iter's.
  HASH_NOW=$(compute_workdir_hash "$WORK_DIR")
  if [ "$HASH_NOW" = "$LAST_HASH" ] && [ "$ITER" -gt 1 ]; then
    STUCK_COUNT=$((STUCK_COUNT + 1))
    log "# STUCK COUNT: $STUCK_COUNT/$STUCK_THRESHOLD (workdir content unchanged this iter)"
    if [ "$STUCK_COUNT" -ge "$STUCK_THRESHOLD" ]; then
      TERMINATION_REASON="stuck"
      log "# STUCK: $STUCK_COUNT consecutive iterations with no content change — bailing out"
      break
    fi
  else
    STUCK_COUNT=0
  fi
  LAST_HASH="$HASH_NOW"

  # Decision (existing convergence logic).
  if printf '%s\n' "$VERDICT_LINE" | grep -qE '"verdict"[[:space:]]*:[[:space:]]*"pass"' && \
     printf '%s\n' "$VERDICT_LINE" | grep -qE '"improvements_exhausted"[[:space:]]*:[[:space:]]*true'; then
    EXHAUSTION_STREAK=$((EXHAUSTION_STREAK + 1))
    if [ "$EXHAUSTION_STREAK" -ge "$QUIET_STREAK" ]; then
      log "# EXHAUSTED at iteration $ITER (streak=$EXHAUSTION_STREAK >= QUIET_STREAK=$QUIET_STREAK)"
      END_TS=$(date +%s)
      DURATION=$((END_TS - START_TS))
      printf '{"status":"exhausted","iterations":%d,"final_signal_exit":%d,"duration_s":%d,"manifest_dims":%d,"manifest_validation":"%s","diff_lines":%d}\n' \
             "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION" "$PROFILE_DIMS" "$MANIFEST_VALIDATION" "$DIFF_LINES"
      [ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
    fi
    PREV_ISSUES="(reviewer council claimed exhausted; do one more skeptical pass across the manifest dimensions)"
  else
    EXHAUSTION_STREAK=0
    PREV_ISSUES=$(compress_issues_for_executor "$VERDICT_LINE")
  fi
  PREV_SIGNALS="$TRUNCATED_SIGNAL"
done

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

if [ -n "$TERMINATION_REASON" ]; then
  log "# TERMINATED: $TERMINATION_REASON at iteration $ITER (last EXIT=$LAST_SIGNAL_EXIT)"
  printf '{"status":"%s","iterations":%d,"final_signal_exit":%d,"duration_s":%d,"manifest_dims":%d,"manifest_validation":"%s","diff_lines":%d}\n' \
         "$TERMINATION_REASON" "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION" "$PROFILE_DIMS" "$MANIFEST_VALIDATION" "$DIFF_LINES"
else
  log "# MAX_ITER_REACHED ($ITER iterations, last EXIT=$LAST_SIGNAL_EXIT)"
  printf '{"status":"max_iter_reached","iterations":%d,"final_signal_exit":%d,"duration_s":%d,"manifest_dims":%d,"manifest_validation":"%s","diff_lines":%d}\n' \
         "$ITER" "$LAST_SIGNAL_EXIT" "$DURATION" "$PROFILE_DIMS" "$MANIFEST_VALIDATION" "$DIFF_LINES"
fi
[ "$LAST_SIGNAL_EXIT" -eq 0 ] && exit 0 || exit 1
