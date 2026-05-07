---
description: Meta-loop that uses this project to optimize itself. Runs regression suite, proposes prompt edits, validates, and either commits or reverts.
argument-hint: [max-cycles]
---

# Self-improvement meta-loop

The user invoked: `/self-improve $ARGUMENTS`

You are the **Meta-Orchestrator**. You drive a loop that uses this project's
own machinery (`/auto-iter` + executor + reviewer subagents) to improve the
project's own prompts, scored against a regression suite.

## Parse arguments

`$ARGUMENTS` is optional and contains a single integer = `MAX_META_CYCLES`.
Default: `3`. If parsing fails, use the default — do NOT ask the user.

## Pre-flight checks (abort with one-line errors, do not ask)

1. `git status` must work — this project must be a git repo. If not, abort:
   `pre-flight: not a git repo. run \`git init && git add -A && git commit -m baseline\` first.`
2. Working tree must be clean. If `git status --porcelain` is non-empty, abort:
   `pre-flight: working tree dirty. commit or stash first.`
3. Authentication is NOT pre-checked here. The fact that this slash command is
   running means the parent `claude` session is authenticated; `claude -p`
   subprocesses inside `regression.sh` inherit the same auth (API key env var,
   or OAuth credentials from Keychain on macOS / `~/.claude/.credentials.json`
   on Linux). If a subprocess auth fails, the per-target regression log will
   show it and the cycle will be marked as a failure.

## Configuration

```
MAX_META_CYCLES = parsed-arg or 3
```

## Main loop

Initialize: `cycle = 0`, `cycles_log = []`, `current_score = null`.

### Step A — Baseline regression (run in background, then poll)

`scripts/regression.sh` runs `/auto-iter` once per target via `claude -p`. Each
target takes 2–6 minutes with Haiku, so the full run can exceed Bash's 10-minute
hard timeout. Run it in the background and poll its log instead of blocking.

1. Generate a unique log path: `LOG=/tmp/asi-regress-$(date +%s).log`
2. Run `bash scripts/regression.sh > $LOG 2>&1` with `run_in_background: true`.
   Capture the returned task_id.
3. Poll loop, every 30 seconds:
   - Use the Read tool on `$LOG` to fetch the last ~100 lines.
   - If a line matching `{"summary":` is present → done, parse it.
   - If 25 minutes have elapsed without a summary line → abort the cycle, mark
     as `regression-timeout`, continue.
4. Parse the summary line's `score_pct`. Store as `baseline_score`.
5. Also note `report_dir` from the summary — used to read per-target failure
   logs in step 3 below.

If `baseline_score == 100`, print "Already at 100% — no improvement to make."
and STOP. Do not loop forever on a passing baseline.

### Loop while `cycle < MAX_META_CYCLES`:

1. `cycle += 1`. Print: `=== meta-cycle N ===`

2. **Snapshot state.** Run `git rev-parse HEAD` and remember as `pre_cycle_sha`.

3. **Dispatch self-improver.** Use the `Agent` tool with `subagent_type: self-improver`.
   Pass it:
   - The current contents of `.claude/agents/executor.md`,
     `.claude/agents/reviewer.md`, `.claude/commands/auto-iter.md`
   - The regression summary from baseline (or previous cycle's post-validation run)
   - Per-target log excerpts: for each FAILED target, read `.regression-runs/<latest>/<target>.log`
     and pass the last ~120 lines so the self-improver can see what went wrong
   - The full contents of `docs/INVARIANTS.md`
   - Instruction: end with `SELF_IMPROVE_SUMMARY:` JSON line.

4. **Parse self-improver output.** Look for `SELF_IMPROVE_SUMMARY:` JSON. If
   missing or malformed, treat as `{"edits":[], "invariants_checked": false, "expected_effect": "parse failure"}`.
   If `edits == []`, log "self-improver declined to edit" and break the loop —
   no more cycles will help.

5. **Invariant audit (mechanical).** Run `git diff $pre_cycle_sha -- examples/ scripts/regression.sh`.
   If non-empty, the self-improver touched files it must not. Revert and abort cycle:
   `git checkout $pre_cycle_sha -- .` then continue to next cycle (mark as failed-audit).

6. **Reviewer audit (semantic).** Use the `Agent` tool with `subagent_type: reviewer`.
   Pass it:
   - The diff: output of `git diff $pre_cycle_sha`
   - The contents of `docs/INVARIANTS.md`
   - Instruction: "Verify no invariant in INVARIANTS.md is violated. Output
     the standard `VERDICT:` line. `pass` = invariants intact. `fail` = some
     invariant is violated, list which."
7. If reviewer verdict is `fail`: revert with `git checkout $pre_cycle_sha -- .`,
   log the cycle as `reviewer-rejected`, continue to next cycle.

8. **Validation regression.** Same pattern as Step A — `run_in_background: true`,
   poll a fresh `/tmp/asi-regress-<ts>.log` every 30s for up to 25 minutes,
   parse the `{"summary":` line. Store the new `score_pct` as `post_cycle_score`.

9. **Decision.**
   - If `post_cycle_score > current_score_or_baseline`:
     - Commit: `git add -A && git commit -m "self-improve cycle N: score X→Y"`
     - Update `current_score = post_cycle_score`
     - Log `accepted`
   - Else (`<=`):
     - Revert: `git checkout $pre_cycle_sha -- . && git clean -fd`
     - Log `rejected (score did not improve)`

10. Append `{cycle, baseline_or_prev: X, post: Y, decision: ...}` to `cycles_log`.

11. If `current_score == 100`: break (perfect score).

After loop ends (cycles exhausted or break):

## Final report

Markdown summary:

- **Baseline score:** X%
- **Final score:** Y%
- **Cycles run:** N
- Table: `cycle | pre-score | post-score | decision | edits-made`
- If improvements were committed, list each commit's SHA + message.

## Autonomy rules — apply to YOU

- Never ask the user any question. Never pause for confirmation between cycles.
- If a subagent dispatch fails, log the failure as a synthetic `rejected` cycle
  (revert any partial edits) and continue.
- Each cycle is atomic: either it commits or it reverts. Never leave a half-applied
  edit on disk.
- Cost & time discipline: regression.sh now uses Haiku with 3-iter caps —
  one regression run is roughly 4–10 minutes and ~$0.10–$0.50 of API cost.
  Each cycle runs regression twice (baseline + validation), so a cycle is
  roughly 10–25 min and $0.30–$1.50. Default 3 cycles ≈ 30–75 min and
  $1–$5. If the user passed a higher MAX_META_CYCLES, trust their choice
  but do not exceed it.
- The regression must always run in the background with log polling — never
  invoke `bash scripts/regression.sh` synchronously from the Bash tool, the
  10-minute Bash timeout will cut it off mid-target.
