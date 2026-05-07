#!/usr/bin/env bash
# Smoke test for dual_agent_iter.sh — uses a stub `claude` CLI so we can
# exercise all bash branches without burning API tokens.
#
# Verifies:
#   - script accepts SKIP_PROFILE=1 and writes a fallback manifest
#   - script accepts a profiler-mode invocation and parses MANIFEST line
#   - executor's EXECUTOR_SUMMARY line is captured
#   - reviewer's VERDICT line is captured and the loop terminates
#   - signal truncation handles red and green correctly
#   - issue history accumulates across iterations
#
# Usage:
#   bash scripts/smoke_test_driver.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP=$(mktemp -d -t asi-smoke.XXXXXX)
echo "[smoke] tmp=$TEST_TMP" >&2
# Don't rm — leave logs for debugging. The macOS tmpdir cleans itself.

# ---------- BUILD STUB CLAUDE ----------
# A stub that distinguishes profiler-mode (saw "MANIFEST:" instruction in the
# prompt) from executor (saw "EXECUTOR_SUMMARY:") from reviewer (saw "VERDICT:").
# Each role emits the expected sentinel line so the driver can parse it.
STUB_DIR="$TEST_TMP/stub"
mkdir -p "$STUB_DIR"

cat > "$STUB_DIR/claude" <<'STUB_EOF'
#!/usr/bin/env bash
# Stub claude CLI. Reads its prompt from -p arg (or first non-flag arg).
# The driver invokes it as: claude -p "<prompt>" [--add-dir ...] [--model ...]

# Find the prompt: argument after -p
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done

# Decide role by what sentinels the prompt asks for.
# Role detection MUST check the persona's *own* header line (which appears
# ONLY in that role's prompt), NOT sentinels like EXECUTOR_SUMMARY which the
# reviewer prompt re-embeds.
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi

if [ "$role" = "profiler" ]; then
  echo "profiler thinking..."
  echo "Read the project, derived 4 dimensions."
  echo 'MANIFEST: {"domain":"python_lib","summary":"Stub profiler","dimensions":[{"name":"correctness","rationale":"r","checks":["c1"]},{"name":"edge_cases","rationale":"r","checks":["c1"]},{"name":"test_coverage","rationale":"r","checks":["c1"]},{"name":"maintainability","rationale":"r","checks":["c1"]}]}'
  exit 0
fi

if [ "$role" = "validator" ]; then
  # Default stub: emit ok. Tests can override via STUB_VALIDATOR_VERDICT env.
  vv="${STUB_VALIDATOR_VERDICT:-ok}"
  if [ "$vv" = "warn" ]; then
    echo 'MANIFEST_VALIDATION: {"verdict":"warn","concerns":["dimension X looks like padding"],"advice_to_loop":"deprioritize dimension X; focus on the other dims"}'
  else
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
  fi
  exit 0
fi

if [ "$role" = "executor" ]; then
  echo "executor: read calc.py, made stubs..."
  if [ -d "${STUB_WORK_DIR:-/nonexistent}/src" ] && [ -f "${STUB_WORK_DIR}/src/calc.py" ]; then
    iter_marker="${STUB_WORK_DIR}/.stub_iter"
    n=0; [ -f "$iter_marker" ] && n=$(cat "$iter_marker")
    n=$((n+1))
    echo "$n" > "$iter_marker"
    if [ "$n" -ge 2 ]; then
      cat > "${STUB_WORK_DIR}/src/calc.py" <<'FIX_EOF'
def add(a, b):
    return a + b

def multiply(a, b):
    return a * b
FIX_EOF
      # Defeat 1-second mtime granularity that lets stale __pycache__ shadow the fix.
      find "${STUB_WORK_DIR}" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
      touch -d "2030-01-01" "${STUB_WORK_DIR}/src/calc.py" 2>/dev/null \
        || touch -t 203001010000 "${STUB_WORK_DIR}/src/calc.py" 2>/dev/null \
        || true
    fi
  fi
  echo 'EXECUTOR_SUMMARY: {"changed_files":["src/calc.py"],"commands_run":["python3 -m pytest -q"],"self_assessment":"made stub edits"}'
  exit 0
fi

if [ "$role" = "reviewer" ]; then
  echo "reviewer: inspecting..."
  # If signal is green per the prompt, claim exhaustion.
  if printf '%s' "$prompt" | grep -q 'EXIT=0'; then
    echo 'VERDICT: {"verdict":"pass","improvements_exhausted":true,"issues":[]}'
  else
    echo 'VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"blocker","dimension":"correctness","where":"src/calc.py","what":"multiply returns a+b","fix_hint":"change + to *"}]}'
  fi
  exit 0
fi

echo "stub-claude: unknown role, prompt head:"
printf '%s' "$prompt" | head -c 200
exit 1
STUB_EOF
chmod +x "$STUB_DIR/claude"

# ---------- BUILD A TEST PROJECT ----------
WORK_DIR="$TEST_TMP/project"
mkdir -p "$WORK_DIR/src" "$WORK_DIR/tests"
cat > "$WORK_DIR/TASK.md" <<'EOF'
Fix the multiply bug.
EOF
cat > "$WORK_DIR/src/calc.py" <<'EOF'
def add(a, b):
    return a + b

def multiply(a, b):
    return a + b
EOF
cat > "$WORK_DIR/tests/test_calc.py" <<'EOF'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from calc import add, multiply

def test_add():
    assert add(2, 3) == 5

def test_multiply():
    assert multiply(2, 3) == 6
EOF

# ---------- TEST 1: SKIP_PROFILE path ----------
echo "=== TEST 1: SKIP_PROFILE=1 path ==="
LOG1="$TEST_TMP/test1.log"
PROMPT_DIR1="$TEST_TMP/prompts1"
SUMMARY1=$(STUB_WORK_DIR="$WORK_DIR" \
           PATH="$STUB_DIR:$PATH" \
           SKIP_PROFILE=1 \
           MAX_ITER=3 \
           QUIET_STREAK=1 \
           SIGNAL_CMD="python3 -m pytest -q" \
           LOG_FILE="$LOG1" \
           PROMPT_DIR="$PROMPT_DIR1" \
           PROJECT_ROOT="$ROOT" \
           bash "$ROOT/scripts/dual_agent_iter.sh" "$WORK_DIR" 2>&1 | tail -1)
exit1=$?
echo "summary: $SUMMARY1"
echo "exit: $exit1"

# Validate
[ -f "$PROMPT_DIR1/manifest.json" ] || { echo "FAIL: manifest.json not written"; exit 1; }
grep -q '"domain":"generic"' "$PROMPT_DIR1/manifest.json" || { echo "FAIL: skipped manifest does not contain 'generic'"; exit 1; }
echo "  -> manifest.json: $(cat "$PROMPT_DIR1/manifest.json" | head -c 120)..."

# Reset state for test 2. Wipe pyc cache + bump mtime past 1s to defeat any
# Python bytecode-cache reuse from TEST 1's last fixed state.
rm -f "$WORK_DIR/.stub_iter"
find "$WORK_DIR" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
sleep 1
cat > "$WORK_DIR/src/calc.py" <<'EOF'
def add(a, b):
    return a + b

def multiply(a, b):
    return a + b
EOF
touch -m "$WORK_DIR/src/calc.py"

# ---------- TEST 2: profiler path ----------
echo ""
echo "=== TEST 2: profiler path ==="
LOG2="$TEST_TMP/test2.log"
PROMPT_DIR2="$TEST_TMP/prompts2"
SUMMARY2=$(STUB_WORK_DIR="$WORK_DIR" \
           PATH="$STUB_DIR:$PATH" \
           MAX_ITER=3 \
           QUIET_STREAK=1 \
           SIGNAL_CMD="python3 -m pytest -q" \
           LOG_FILE="$LOG2" \
           PROMPT_DIR="$PROMPT_DIR2" \
           PROJECT_ROOT="$ROOT" \
           bash "$ROOT/scripts/dual_agent_iter.sh" "$WORK_DIR" 2>&1 | tail -1)
exit2=$?
echo "summary: $SUMMARY2"
echo "exit: $exit2"

[ -f "$PROMPT_DIR2/manifest.json" ] || { echo "FAIL: profiler-path manifest.json not written"; exit 1; }
grep -q '"domain":"python_lib"' "$PROMPT_DIR2/manifest.json" || { echo "FAIL: profiler-path manifest missing expected domain"; cat "$PROMPT_DIR2/manifest.json"; exit 1; }
echo "  -> manifest.json: $(cat "$PROMPT_DIR2/manifest.json" | head -c 120)..."

# Verify the loop converged. Stub fixes the bug at iter 2; with QUIET_STREAK=1
# the loop should exit on iter 2 with status=exhausted final_signal_exit=0.
echo "$SUMMARY2" | grep -q '"status":"exhausted"' || { echo "FAIL: expected exhausted status, got: $SUMMARY2"; exit 1; }
echo "$SUMMARY2" | grep -q '"final_signal_exit":0' || { echo "FAIL: expected final signal exit 0, got: $SUMMARY2"; exit 1; }
echo "$SUMMARY2" | grep -q '"manifest_dims":4' || { echo "FAIL: expected manifest_dims=4 (stub emits 4), got: $SUMMARY2"; exit 1; }

# ---------- TEST 3: signal-truncation helpers (in isolation) ----------
echo ""
echo "=== TEST 3: signal truncation behavior ==="
# Source the helpers via a wrapped invocation. The script bails before iteration
# loop only if WORK_DIR doesn't exist — so test by extracting truncate_signal.
# Simplest: re-implement the same logic here and verify against the script's
# behavior by checking log content from test 2 (which had a green run).

# In test 2, the second iteration's reviewer prompt should contain "EXIT=0"
# rather than the full pytest output (we collapsed green output to save tokens).
rev_prompt2="$PROMPT_DIR2/iter2_rev.prompt"
if [ -f "$rev_prompt2" ]; then
  if grep -q "EXIT=0 (.* lines suppressed; signal is green)" "$rev_prompt2"; then
    echo "  -> green-signal collapse works"
  else
    echo "FAIL: green-signal collapse not found in iter2 reviewer prompt"
    grep "EXIT=" "$rev_prompt2" || true
    exit 1
  fi
else
  echo "NOTE: iter2_rev.prompt not present; truncation check skipped"
fi

# In iter 1, signal was red — should see EXIT=1 (or whatever non-zero)
rev_prompt1="$PROMPT_DIR2/iter1_rev.prompt"
if [ -f "$rev_prompt1" ]; then
  if grep -q "EXIT=" "$rev_prompt1"; then
    echo "  -> red-signal output present"
  else
    echo "FAIL: red-signal EXIT= line not present in iter1 reviewer prompt"
    exit 1
  fi
fi

# ---------- TEST 4: issue history accumulation ----------
echo ""
echo "=== TEST 4: issue history file ==="
hist="$PROMPT_DIR2/issue_history.tsv"
if [ -f "$hist" ]; then
  echo "  -> issue history present ($(wc -l < "$hist") line(s))"
  cat "$hist"
else
  echo "NOTE: issue history file not present (could be expected if no recurring issues)"
fi

# ---------- TEST 5: persona files load (no frontmatter leak) ----------
echo ""
echo "=== TEST 5: persona prompts contain body, not frontmatter ==="
exec_prompt="$PROMPT_DIR2/iter1_exec.prompt"
if grep -q '^name: executor$' "$exec_prompt"; then
  echo "FAIL: executor frontmatter leaked into prompt"
  exit 1
fi
grep -q 'You are the \*\*Executor agent' "$exec_prompt" || { echo "FAIL: executor body missing"; exit 1; }
echo "  -> executor prompt contains body, no frontmatter leak"

prof_prompt="$PROMPT_DIR2/iter0_profile.prompt"
if [ -f "$prof_prompt" ]; then
  if grep -q '^name: profiler$' "$prof_prompt"; then
    echo "FAIL: profiler frontmatter leaked into prompt"
    exit 1
  fi
  grep -q 'You are the \*\*Profiler agent' "$prof_prompt" || { echo "FAIL: profiler body missing"; exit 1; }
  echo "  -> profiler prompt contains body, no frontmatter leak"
fi

echo ""

# ---------- TEST 6a: profiler emits no MANIFEST → fallback ----------
echo "=== TEST 6a: profiler emits no MANIFEST → fallback to 3-dim safety net ==="
T6A_TMP="$TEST_TMP/test6a"
mkdir -p "$T6A_TMP/src" "$T6A_TMP/tests"
echo "fix nothing" > "$T6A_TMP/TASK.md"
echo "def x(): return 1" > "$T6A_TMP/src/x.py"
cat > "$T6A_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x() == 1
EOF

STUB6A="$TEST_TMP/stub6a"; mkdir -p "$STUB6A"
cat > "$STUB6A/claude" <<'STUB6A_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    # Deliberately broken: no MANIFEST: line, just prose.
    echo "I looked at the project and thought a lot but forgot to emit a manifest."
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    echo 'EXECUTOR_SUMMARY: {"changed_files":[],"commands_run":["pytest"],"self_assessment":"nothing to do"}'
    ;;
  reviewer)
    echo 'VERDICT: {"verdict":"pass","improvements_exhausted":true,"issues":[]}'
    ;;
esac
STUB6A_EOF
chmod +x "$STUB6A/claude"

LOG6A="$TEST_TMP/test6a.log"
PROMPT_DIR6A="$TEST_TMP/prompts6a"
SUMMARY6A=$(PATH="$STUB6A:$PATH" \
            MAX_ITER=2 QUIET_STREAK=1 \
            SIGNAL_CMD="python3 -m pytest -q" \
            LOG_FILE="$LOG6A" PROMPT_DIR="$PROMPT_DIR6A" PROJECT_ROOT="$ROOT" \
            bash "$ROOT/scripts/dual_agent_iter.sh" "$T6A_TMP" 2>&1 | tail -1)
echo "summary: $SUMMARY6A"
echo "$SUMMARY6A" | grep -q '"manifest_dims":3' || { echo "FAIL: expected 3-dim fallback, got: $SUMMARY6A"; exit 1; }
grep -q '"domain":"generic"' "$PROMPT_DIR6A/manifest.json" || { echo "FAIL: fallback manifest does not have generic domain"; cat "$PROMPT_DIR6A/manifest.json"; exit 1; }
grep -q "profiler did not emit MANIFEST" "$PROMPT_DIR6A/manifest.json" || { echo "FAIL: fallback manifest missing the 'did not emit' summary"; exit 1; }
echo "  -> profiler-malformed-output fallback works (manifest_dims=3, domain=generic)"

echo ""

# ---------- TEST 6: issue history dedupe ----------
# Build a tiny scenario where the reviewer keeps flagging the SAME issue
# 3 iterations in a row. Verify the issue_history.tsv reaches count=3 and
# the recurring summary is non-empty in iter 4's prompt.
echo "=== TEST 6: issue history accumulates recurring class ==="
T6_TMP="$TEST_TMP/test6"
mkdir -p "$T6_TMP/src" "$T6_TMP/tests"
cat > "$T6_TMP/TASK.md" <<'EOF'
recurring issue test
EOF
cat > "$T6_TMP/src/calc.py" <<'EOF'
def add(a, b): return a + b
EOF
cat > "$T6_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from calc import add
def test_add(): assert add(2,3)==5
EOF

# Build a stub that ALWAYS raises the same issue.
STUB6="$TEST_TMP/stub6"
mkdir -p "$STUB6"
cat > "$STUB6/claude" <<'STUB6_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    echo 'MANIFEST: {"domain":"x","summary":"x","dimensions":[{"name":"maintainability","rationale":"r","checks":["c"]}]}'
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    echo 'EXECUTOR_SUMMARY: {"changed_files":[],"commands_run":["pytest"],"self_assessment":"no edits"}'
    ;;
  reviewer)
    # Always raise the same minor issue (signal stays green so verdict isn't force-failed).
    echo 'VERDICT: {"verdict":"pass","improvements_exhausted":false,"issues":[{"severity":"minor","dimension":"maintainability","where":"src/calc.py","what":"naming","fix_hint":"rename a to addend"}]}'
    ;;
esac
STUB6_EOF
chmod +x "$STUB6/claude"

LOG6="$TEST_TMP/test6.log"
PROMPT_DIR6="$TEST_TMP/prompts6"
PATH="$STUB6:$PATH" \
  SKIP_PROFILE=0 \
  MAX_ITER=4 \
  QUIET_STREAK=99 \
  SIGNAL_CMD="python3 -m pytest -q" \
  LOG_FILE="$LOG6" \
  PROMPT_DIR="$PROMPT_DIR6" \
  PROJECT_ROOT="$ROOT" \
  bash "$ROOT/scripts/dual_agent_iter.sh" "$T6_TMP" 2>&1 | tail -1 >/dev/null || true

if [ -f "$PROMPT_DIR6/issue_history.tsv" ]; then
  count=$(awk -F'\t' '{print $1}' "$PROMPT_DIR6/issue_history.tsv" | sort -n | tail -1)
  [ -z "$count" ] && count=0
  if [ "$count" -ge 3 ]; then
    echo "  -> issue history reached count=$count (recurring issue tracked across iterations)"
  else
    echo "FAIL: issue history did not reach 3 (got count=$count)"
    cat "$PROMPT_DIR6/issue_history.tsv"
    exit 1
  fi
else
  echo "FAIL: issue_history.tsv not created"
  exit 1
fi

# The iter4 prompts should reference the recurring class.
if [ -f "$PROMPT_DIR6/iter4_exec.prompt" ]; then
  if grep -q "Recurring issue classes" "$PROMPT_DIR6/iter4_exec.prompt" && \
     grep -q "maintainability" "$PROMPT_DIR6/iter4_exec.prompt"; then
    echo "  -> iter4 executor prompt references recurring class"
  else
    echo "FAIL: iter4 executor prompt missing recurring-issue context"
    exit 1
  fi
fi

echo ""

# ---------- TEST 7: validator emits ok → no MANIFEST_WARNING in prompts ----------
echo "=== TEST 7: validator ok path → no warning block injected ==="
exec_p="$PROMPT_DIR2/iter1_exec.prompt"
if grep -q "MANIFEST_WARNING" "$exec_p" 2>/dev/null; then
  echo "FAIL: validator returned ok but MANIFEST_WARNING block leaked into executor prompt"
  exit 1
fi
echo "  -> ok-validator path produces no warning block"

# ---------- TEST 7b: validator emits warn → MANIFEST_WARNING shows up ----------
echo ""
echo "=== TEST 7b: validator warn path injects MANIFEST_WARNING into prompts ==="
T7B_TMP="$TEST_TMP/test7b"
mkdir -p "$T7B_TMP/src" "$T7B_TMP/tests"
echo "warn-test" > "$T7B_TMP/TASK.md"
echo "def x(): return 1" > "$T7B_TMP/src/x.py"
cat > "$T7B_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF
LOG7B="$TEST_TMP/test7b.log"
PROMPT_DIR7B="$TEST_TMP/prompts7b"
SUMMARY7B=$(STUB_VALIDATOR_VERDICT=warn \
            PATH="$STUB_DIR:$PATH" \
            MAX_ITER=1 QUIET_STREAK=1 \
            SIGNAL_CMD="python3 -m pytest -q" \
            LOG_FILE="$LOG7B" PROMPT_DIR="$PROMPT_DIR7B" PROJECT_ROOT="$ROOT" \
            bash "$ROOT/scripts/dual_agent_iter.sh" "$T7B_TMP" 2>&1 | tail -1)
echo "  summary: $SUMMARY7B"
echo "$SUMMARY7B" | grep -q '"manifest_validation":"warn"' || { echo "FAIL: expected validator warn flag in summary, got: $SUMMARY7B"; exit 1; }
grep -q "MANIFEST_WARNING" "$PROMPT_DIR7B/iter1_exec.prompt" || { echo "FAIL: validator warn did not inject MANIFEST_WARNING into executor prompt"; exit 1; }
grep -q "MANIFEST_WARNING" "$PROMPT_DIR7B/iter1_rev.prompt" || { echo "FAIL: validator warn did not inject MANIFEST_WARNING into reviewer prompt"; exit 1; }
echo "  -> warn-validator path correctly threads MANIFEST_WARNING into both executor and reviewer"

# ---------- TEST 8: REVIEWER_COUNCIL=2 — both reviewers' verdicts are recorded ----------
echo ""
echo "=== TEST 8: REVIEWER_COUNCIL=2 dispatches 2 parallel reviewers ==="
T8_TMP="$TEST_TMP/test8"
mkdir -p "$T8_TMP/src" "$T8_TMP/tests"
echo "council test" > "$T8_TMP/TASK.md"
echo "def x(): return 1" > "$T8_TMP/src/x.py"
cat > "$T8_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF
LOG8="$TEST_TMP/test8.log"
PROMPT_DIR8="$TEST_TMP/prompts8"
SUMMARY8=$(PATH="$STUB_DIR:$PATH" \
           SKIP_PROFILE=1 \
           REVIEWER_COUNCIL=2 \
           MAX_ITER=1 QUIET_STREAK=1 \
           SIGNAL_CMD="python3 -m pytest -q" \
           LOG_FILE="$LOG8" PROMPT_DIR="$PROMPT_DIR8" PROJECT_ROOT="$ROOT" \
           bash "$ROOT/scripts/dual_agent_iter.sh" "$T8_TMP" 2>&1 | tail -1)
echo "  summary: $SUMMARY8"
[ -d "$PROMPT_DIR8/iter1_council" ] || { echo "FAIL: council dir not created"; exit 1; }
n_verdicts=$(ls "$PROMPT_DIR8/iter1_council"/reviewer_*.verdict 2>/dev/null | wc -l | tr -d ' ')
[ "$n_verdicts" = "2" ] || { echo "FAIL: expected 2 verdict files, got $n_verdicts"; exit 1; }
echo "  -> council dispatched 2 parallel reviewers, both verdicts captured"

# ---------- TEST 9: MAX_DIFF_LINES exceeded → status=diff_budget_exceeded ----------
echo ""
echo "=== TEST 9: diff-budget cap force-terminates the loop ==="
T9_TMP="$TEST_TMP/test9"
mkdir -p "$T9_TMP/src" "$T9_TMP/tests"
echo "diff-budget test" > "$T9_TMP/TASK.md"
echo "def x(): return 1" > "$T9_TMP/src/x.py"
cat > "$T9_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF

# Stub that intentionally writes a huge bloat file each iter to blow the budget.
STUB9="$TEST_TMP/stub9"; mkdir -p "$STUB9"
cat > "$STUB9/claude" <<'STUB9_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    echo 'MANIFEST: {"domain":"x","summary":"x","dimensions":[{"name":"correctness","rationale":"r","checks":["c"]}]}'
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    if [ -d "${STUB9_WORK_DIR:-/nonexistent}/src" ]; then
      # Generate 100 new lines per iter to overflow MAX_DIFF_LINES=50.
      iter_marker="${STUB9_WORK_DIR}/.stub_n"
      n=0; [ -f "$iter_marker" ] && n=$(cat "$iter_marker")
      n=$((n+1)); echo "$n" > "$iter_marker"
      seq 1 100 | sed "s/^/# bloat-iter${n}-/" >> "${STUB9_WORK_DIR}/src/x.py"
    fi
    echo 'EXECUTOR_SUMMARY: {"changed_files":["src/x.py"],"commands_run":["pytest"],"self_assessment":"made bloat"}'
    ;;
  reviewer)
    echo 'VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"minor","dimension":"correctness","where":"x","what":"y","fix_hint":"z"}]}'
    ;;
esac
STUB9_EOF
chmod +x "$STUB9/claude"

LOG9="$TEST_TMP/test9.log"
PROMPT_DIR9="$TEST_TMP/prompts9"
SUMMARY9=$(STUB9_WORK_DIR="$T9_TMP" \
           PATH="$STUB9:$PATH" \
           MAX_ITER=10 QUIET_STREAK=99 \
           MAX_DIFF_LINES=50 \
           SIGNAL_CMD="python3 -m pytest -q" \
           LOG_FILE="$LOG9" PROMPT_DIR="$PROMPT_DIR9" PROJECT_ROOT="$ROOT" \
           bash "$ROOT/scripts/dual_agent_iter.sh" "$T9_TMP" 2>&1 | tail -1)
echo "  summary: $SUMMARY9"
echo "$SUMMARY9" | grep -q '"status":"diff_budget_exceeded"' || { echo "FAIL: expected diff_budget_exceeded, got: $SUMMARY9"; exit 1; }
echo "  -> diff-budget mechanical cap fired correctly"

# ---------- TEST 10: STUCK_THRESHOLD — loop exits when content stops changing ----------
echo ""
echo "=== TEST 10: stuck-detector terminates loop after N idle iterations ==="
T10_TMP="$TEST_TMP/test10"
mkdir -p "$T10_TMP/src" "$T10_TMP/tests"
echo "stuck test" > "$T10_TMP/TASK.md"
echo "def x(): return 1" > "$T10_TMP/src/x.py"
cat > "$T10_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF

# Stub: executor never edits anything; reviewer keeps complaining.
STUB10="$TEST_TMP/stub10"; mkdir -p "$STUB10"
cat > "$STUB10/claude" <<'STUB10_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    echo 'MANIFEST: {"domain":"x","summary":"x","dimensions":[{"name":"correctness","rationale":"r","checks":["c"]}]}'
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    # Deliberately do NOTHING.
    echo 'EXECUTOR_SUMMARY: {"changed_files":[],"commands_run":["pytest"],"self_assessment":"no change made"}'
    ;;
  reviewer)
    echo 'VERDICT: {"verdict":"fail","improvements_exhausted":false,"issues":[{"severity":"minor","dimension":"correctness","where":"x","what":"y","fix_hint":"z"}]}'
    ;;
esac
STUB10_EOF
chmod +x "$STUB10/claude"

LOG10="$TEST_TMP/test10.log"
PROMPT_DIR10="$TEST_TMP/prompts10"
SUMMARY10=$(PATH="$STUB10:$PATH" \
            MAX_ITER=20 QUIET_STREAK=99 \
            STUCK_THRESHOLD=3 \
            SIGNAL_CMD="python3 -m pytest -q" \
            LOG_FILE="$LOG10" PROMPT_DIR="$PROMPT_DIR10" PROJECT_ROOT="$ROOT" \
            bash "$ROOT/scripts/dual_agent_iter.sh" "$T10_TMP" 2>&1 | tail -1)
echo "  summary: $SUMMARY10"
echo "$SUMMARY10" | grep -q '"status":"stuck"' || { echo "FAIL: expected stuck status, got: $SUMMARY10"; exit 1; }
# Should have exited at iter 4 (1 first iter + 3 stuck iters); MAX_ITER=20 not reached.
iters=$(echo "$SUMMARY10" | sed -E 's/.*"iterations":([0-9]+).*/\1/')
[ "$iters" -lt 20 ] || { echo "FAIL: stuck detector did not terminate early (ran $iters iters)"; exit 1; }
echo "  -> stuck-detector terminated at iter $iters (well under MAX_ITER=20)"

# ---------- TEST 11: changed_files threading — reviewer prompt contains the list ----------
echo ""
echo "=== TEST 11: executor's changed_files list is threaded into reviewer prompt ==="
# Use prompts2 from TEST 2 — its iter1 executor reported src/calc.py.
rev_p="$PROMPT_DIR2/iter1_rev.prompt"
if grep -qE "Files the executor reports changing this iteration.*\\n.*src/calc\\.py" "$rev_p" 2>/dev/null; then
  echo "  -> changed_files threaded (multi-line match)"
else
  # Single-line check too — file list might be on its own line right after the header.
  if grep -A 3 "Files the executor reports changing" "$rev_p" 2>/dev/null | grep -q "src/calc.py"; then
    echo "  -> changed_files threaded into reviewer prompt"
  else
    echo "FAIL: reviewer prompt does not contain changed_files list"
    grep -A 3 "Files the executor reports" "$rev_p" || true
    exit 1
  fi
fi

# ---------- TEST 12: roleplay detection — log has ROLEPLAY when claim != reality ----------
echo ""
echo "=== TEST 12: roleplay detection — claim of changed_files but no actual change ==="
T12_TMP="$TEST_TMP/test12"
mkdir -p "$T12_TMP/src" "$T12_TMP/tests"
echo "roleplay test" > "$T12_TMP/TASK.md"
echo "def x(): return 1" > "$T12_TMP/src/x.py"
cat > "$T12_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF

# Stub: executor LIES — claims to have changed src/x.py but writes nothing.
STUB12="$TEST_TMP/stub12"; mkdir -p "$STUB12"
cat > "$STUB12/claude" <<'STUB12_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    echo 'MANIFEST: {"domain":"x","summary":"x","dimensions":[{"name":"correctness","rationale":"r","checks":["c"]}]}'
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    # LIE: claim a change but make no actual edit.
    echo 'EXECUTOR_SUMMARY: {"changed_files":["src/x.py"],"commands_run":["pytest"],"self_assessment":"claimed edits"}'
    ;;
  reviewer)
    echo 'VERDICT: {"verdict":"pass","improvements_exhausted":true,"issues":[]}'
    ;;
esac
STUB12_EOF
chmod +x "$STUB12/claude"

LOG12="$TEST_TMP/test12.log"
PROMPT_DIR12="$TEST_TMP/prompts12"
SUMMARY12=$(PATH="$STUB12:$PATH" \
            MAX_ITER=1 QUIET_STREAK=1 \
            SIGNAL_CMD="python3 -m pytest -q" \
            LOG_FILE="$LOG12" PROMPT_DIR="$PROMPT_DIR12" PROJECT_ROOT="$ROOT" \
            bash "$ROOT/scripts/dual_agent_iter.sh" "$T12_TMP" 2>&1 | tail -1)
grep -q "ROLEPLAY:" "$LOG12" || { echo "FAIL: ROLEPLAY warning not logged when claim/reality diverged"; tail -10 "$LOG12"; exit 1; }
echo "  -> ROLEPLAY warning correctly logged"

# ---------- TEST 13: JSON extraction tolerates code fences ----------
echo ""
echo "=== TEST 13: extract_json_after_sentinel tolerates code fences ==="
# We can't easily unit-test the bash function from outside without sourcing,
# so verify integration: have a stub wrap MANIFEST in a code fence and
# confirm the driver parses it correctly.
T13_TMP="$TEST_TMP/test13"
mkdir -p "$T13_TMP/src" "$T13_TMP/tests"
echo "fence test" > "$T13_TMP/TASK.md"
echo "def x(): return 1" > "$T13_TMP/src/x.py"
cat > "$T13_TMP/tests/test_x.py" <<'EOF'
import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from x import x
def test_x(): assert x()==1
EOF

STUB13="$TEST_TMP/stub13"; mkdir -p "$STUB13"
cat > "$STUB13/claude" <<'STUB13_EOF'
#!/usr/bin/env bash
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --permission-mode|--add-dir|--model) shift 2 ;;
    --version) echo "stub-claude 1.0"; exit 0 ;;
    *) shift ;;
  esac
done
role=""
if   printf '%s' "$prompt" | grep -q 'You are the \*\*Profiler agent';  then role=profiler
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Validator agent'; then role=validator
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Reviewer agent';  then role=reviewer
elif printf '%s' "$prompt" | grep -q 'You are the \*\*Executor agent';  then role=executor
fi
case "$role" in
  profiler)
    # Wrap the MANIFEST in a code fence, and put it after some prose.
    echo "Here is my manifest:"
    echo '```json'
    echo 'MANIFEST: {"domain":"fenced","summary":"x","dimensions":[{"name":"a","rationale":"r","checks":["c"]},{"name":"b","rationale":"r","checks":["c"]},{"name":"c","rationale":"r","checks":["c"]}]}'
    echo '```'
    ;;
  validator)
    echo 'MANIFEST_VALIDATION: {"verdict":"ok","concerns":[],"advice_to_loop":""}'
    ;;
  executor)
    echo 'EXECUTOR_SUMMARY: {"changed_files":[],"commands_run":["pytest"],"self_assessment":"x"}'
    ;;
  reviewer)
    echo 'VERDICT: {"verdict":"pass","improvements_exhausted":true,"issues":[]}'
    ;;
esac
STUB13_EOF
chmod +x "$STUB13/claude"

LOG13="$TEST_TMP/test13.log"
PROMPT_DIR13="$TEST_TMP/prompts13"
SUMMARY13=$(PATH="$STUB13:$PATH" \
            MAX_ITER=1 QUIET_STREAK=1 \
            SIGNAL_CMD="python3 -m pytest -q" \
            LOG_FILE="$LOG13" PROMPT_DIR="$PROMPT_DIR13" PROJECT_ROOT="$ROOT" \
            bash "$ROOT/scripts/dual_agent_iter.sh" "$T13_TMP" 2>&1 | tail -1)
grep -q '"domain":"fenced"' "$PROMPT_DIR13/manifest.json" || { echo "FAIL: code-fenced MANIFEST not parsed"; cat "$PROMPT_DIR13/manifest.json"; exit 1; }
echo "  -> JSON extractor tolerated code fences and pulled out manifest"

echo ""
echo "ALL SMOKE TESTS PASSED"
echo "Logs at: $TEST_TMP"
