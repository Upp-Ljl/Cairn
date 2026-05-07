---
description: Run a self-iterating Profiler + Executor + Reviewer loop on a target dir until the reviewer says improvements are exhausted (or max iterations).
argument-hint: <target-dir> | <task description...>
---

# Auto-iteration orchestrator (delegates to scripts/dual_agent_iter.sh)

The user invoked: `/auto-iter $ARGUMENTS`

You are the **thin orchestrator front-end** for the dual-agent loop with
profiler warm-up. **You do NOT play profiler, executor, or reviewer
yourself.** All three roles run as SEPARATE `claude -p` sub-sessions inside
`scripts/dual_agent_iter.sh` — that mechanical separation is the whole
premise of this project. A single Claude session attempting to play multiple
roles collapses into self-approval; the bash driver prevents that by
construction.

Your only jobs are: parse `$ARGUMENTS`, decide a signal command, invoke the
script via Bash, stream its log, and print a final markdown report.

## Hard prohibitions for YOU (the orchestrator)

- **DO NOT use `Read`, `Edit`, `Write`, `Grep`, or `Glob` against `TARGET_DIR`
  or any file inside it.** All inspection and modification of TARGET_DIR
  happens inside the dual-agent script's profiler / executor / reviewer
  sub-sessions. You touching those files would re-merge them into one
  session and defeat the supervision pattern.
- **DO NOT use the `Agent` / `Task` tool to dispatch subagents yourself.** The
  loop runs in `scripts/dual_agent_iter.sh`, which spawns `claude -p`
  processes. Do not try to simulate the loop with Agent calls.
- **DO NOT simulate the loop** by writing a plausible-sounding "iteration 1...
  iteration 2... EXHAUSTED" markdown summary. The only iteration evidence you
  may report is what the script actually wrote to the log file.
- **DO NOT ask the user any question.** Decide and proceed.

The tools you legitimately need are: `Bash` (to invoke the script and tail
the log), and reading the script's log file via `Read` (the log path is one
you created yourself, not inside TARGET_DIR).

## Parse arguments

`$ARGUMENTS` uses a `|` separator: `<target-dir> | <task description>`.

- Split on the first `|`. Trim whitespace.
- Left side = `TARGET_DIR` (relative to current cwd, or absolute). Resolve to
  an absolute path before passing to the script.
- Right side = `TASK` (free text — may be many lines).
- If `TASK` is empty or refers to a `TASK.md` file inside `TARGET_DIR` (e.g.
  user wrote `examples/buggy_calculator | use TASK.md`), let the script load
  `TARGET_DIR/TASK.md` directly via its `TASK_FILE` env var. Do NOT read the
  TASK.md yourself — that violates the "no Read on TARGET_DIR" prohibition.
  If the user provided inline TASK text, write it to a tempfile OUTSIDE
  TARGET_DIR and pass that path as `TASK_FILE`.

If parsing fails or `TARGET_DIR` does not exist, **abort with a one-line error
and stop**. Do NOT ask the user to retry.

**Existence check is empirical, not visual.** Verify `TARGET_DIR` by running
`Bash` with `test -d "$TARGET_DIR" && echo OK`. Do NOT reason about the path
string itself. Sequences like `XXXXXX`, long random suffixes, `tmp.*`,
`agent-iter-*`, paths under `/var/folders/...`, `/tmp/...`, `/private/var/...`
are valid real directories. Only abort if the empirical `test -d` check fails.

## Decide the signal command

The script needs a `SIGNAL_CMD` — the shell command, run from inside
`TARGET_DIR`, that exits 0 iff the work is green. Pick one based on the TASK
text and TARGET_DIR layout:

- Python project (presence of `tests/` + pytest hints in TASK, or default):
  `python3 -m pytest -q`
- Node/TypeScript (TARGET_DIR has `package.json` / `tsconfig.json` or TASK
  mentions `tsc` / `npm test` / `eslint`): use the matching command, e.g.
  `npx -y typescript@5 tsc --noEmit` or `npm test --silent`.
- Bash project (TASK mentions a shell test runner): `bash tests/run_tests.sh`.
- If TARGET_DIR contains a `regression.cmd` file with a one-line command, use
  it verbatim.

Decide yourself. Do not ask the user. If you genuinely cannot tell, fall back
to `python3 -m pytest -q`.

You may peek at TARGET_DIR layout via `Bash ls "$TARGET_DIR"` — that's a
read-only listing, not a Read into source files, and is allowed for the sole
purpose of picking SIGNAL_CMD.

## Configuration (env vars passed to the script)

```
MAX_ITERATIONS           = 50    # safety cap. Normal exit is via improvements_exhausted=true.
QUIET_STREAK             = 2     # consecutive pass+exhausted before stopping.
MODEL                    = claude-sonnet-4-6   # executor + reviewer model.
PROFILE_MODEL            = (defaults to MODEL) # one-shot profiler at iter 0.
VALIDATOR_MODEL          = claude-haiku-4-5-20251001  # one-shot manifest validator.
SKIP_PROFILE             = 0     # 1 = use generic 3-dim safety net.
SAFETY_VALIDATE_MANIFEST = 1     # 1 = run Haiku second-opinion on manifest.
REVIEWER_COUNCIL         = 1     # N parallel reviewers; all must agree to converge.
MAX_DIFF_LINES           = 0     # 0 = disabled. >0 = cap cumulative diff lines.
STUCK_THRESHOLD          = 3     # bail if N iters in a row leave content unchanged.
MAX_SIGNAL_TAIL          = 80    # tail-truncate signal output passed to agents.
```

**When to bump these knobs from defaults:**
- Vague task / no real signal (e.g. "audit security") → set
  `MAX_DIFF_LINES=500` and `REVIEWER_COUNCIL=2` so a single confabulating
  reviewer can't declare premature exhaustion.
- Production-critical work → set `REVIEWER_COUNCIL=3` (3-of-3 unanimity).
- Tiny single-file fix → `SKIP_PROFILE=1` saves the iter-0 round-trip.
- Already exited as `stuck` once but you want more time → raise
  `STUCK_THRESHOLD` to 5.

The loop's goal is **"no fault remains"**, not "tests pass once". Tests-pass
is a prerequisite, not the exit condition. The exit condition is the Reviewer
affirmatively saying `improvements_exhausted: true` for two consecutive
iterations across the **project-specific MANIFEST dimensions** that the
profiler derived in iteration 0. The reviewer is empowered to flag ANYTHING
worth optimizing under those dimensions — this is not a bugs-only loop.

`MAX_ITERATIONS = 50` is a runaway safety net, not a target. If the script
exits with `status: max_iter_reached`, that's a real signal: the reviewer
kept finding work. Report it; do not raise this cap silently.

### Inline overrides

If `$ARGUMENTS` or the loaded TASK text contains parenthetical hints like
`(max-iter=3, quiet=1)`, override the corresponding env values for THIS
invocation. Recognized keys:
- `max-iter` -> `MAX_ITER`
- `quiet` -> `QUIET_STREAK`
- `model` -> `MODEL`
- `profile-model` -> `PROFILE_MODEL`
- `validator-model` -> `VALIDATOR_MODEL`
- `skip-profile` -> `SKIP_PROFILE`
- `validate-manifest` -> `SAFETY_VALIDATE_MANIFEST` (set to `0` to disable)
- `council` -> `REVIEWER_COUNCIL`
- `diff-budget` -> `MAX_DIFF_LINES`
- `stuck-threshold` -> `STUCK_THRESHOLD`
- `signal-tail` -> `MAX_SIGNAL_TAIL`

Example: `/auto-iter examples/foo | use TASK.md (max-iter=3, quiet=1, skip-profile=1)`

This is how `regression.sh` runs a tight measurement pass without editing
this file. Normal user invocations should NOT override these — let the loop
run to genuine exhaustion.

## Run the loop (delegate to the script)

The dual-agent driver lives at `scripts/dual_agent_iter.sh`.

1. Pick a log file path under a temp dir, e.g. `/tmp/auto-iter-<timestamp>.log`.
   This is YOUR log, not in TARGET_DIR.
2. Invoke the script via `Bash` with the env vars described above. Use
   `run_in_background: true` so you can stream the log while it runs.
3. While the script runs, periodically `Read` the log file (or `Bash tail
   -n 50` it) and print profile/iteration banners + verdict lines back to
   the user. Do NOT fabricate progress — report only what's in the log.
4. When the script completes, capture its final stdout JSON line:
   `{"status":"exhausted"|"max_iter_reached","iterations":N,"final_signal_exit":N,"duration_s":N,"manifest_dims":N}`
   and its exit code (0 if signals green, 1 otherwise).

Concrete invocation (Bash tool):

```bash
TASK_FILE="<path-outside-TARGET_DIR>" \
SIGNAL_CMD="<your chosen command>" \
MAX_ITER=<config> \
QUIET_STREAK=<config> \
MODEL="<config>" \
LOG_FILE="/tmp/auto-iter-<timestamp>.log" \
bash scripts/dual_agent_iter.sh "<absolute TARGET_DIR>"
```

The script handles: dispatching profiler once at iter 0 (writes manifest.json
into PROMPT_DIR), dispatching executor and reviewer as separate `claude -p`
calls per iteration, running the signal command between them, force-failing
on red signals (so the reviewer cannot rubber-stamp red tests), parsing the
VERDICT line, advancing the exhaustion streak, tracking recurring issues
across iterations, and exiting on either `status: exhausted` or
`status: max_iter_reached`.

## Force-fail on red signals (invariant I3)

The script enforces this mechanically: after each iteration, if the signal
command's exit code is non-zero, the recorded VERDICT is overridden to
`fail` regardless of what the reviewer said. You do NOT need to re-implement
this in your front-end logic — but you MUST NOT defeat it by, for example,
reporting the run as "passed" when `final_signal_exit != 0`.

## Final report

After the script returns, parse the final JSON line and print a markdown
summary:

- **Status:** EXHAUSTED (script status `exhausted`, exit 0) /
  MAX_ITER_REACHED (script status `max_iter_reached`) /
  DIFF_BUDGET_EXCEEDED (script status `diff_budget_exceeded` — cumulative
    diff exceeded `MAX_DIFF_LINES`; surface the cap and the actual count) /
  STUCK (script status `stuck` — `STUCK_THRESHOLD` consecutive iters left
    content unchanged) /
  RED_AT_EXIT (script exit 1 — signals never went green) /
  ERROR (script returned a top-level `{"error":...}`)
- **Manifest dims:** from `manifest_dims` in the summary JSON. Optionally
  read `<PROMPT_DIR>/manifest.json` and print the dimension names so the user
  knows what was being audited.
- **Iterations:** from `iterations`.
- **Duration:** from `duration_s`.
- **Final signal exit:** from `final_signal_exit` (0 = green).
- A markdown table summarizing each iteration: `iter | verdict | exhausted |
  issues by severity | signals`. Derive these from `=== iteration N ===`
  blocks and VERDICT lines in the log file.
- If status is `MAX_ITER_REACHED` or `RED_AT_EXIT`, list the last reviewer's
  `issues` array verbatim — those are the things still on the table.
- If status is `EXHAUSTED`, optionally print a one-paragraph "what changed
  across the run" summary derived from the log.

The user is reading your final message to learn what the loop did. Your
report must be faithful to the log; do not embellish.

## Autonomy rules — applies to YOU, the orchestrator

- Never ask the user for clarification, confirmation, or which signal commands
  to use. Decide and proceed.
- Never stop the loop early to "check in". The script runs to its own
  termination — your job is to stream and report, not to interrupt.
- If the script returns a top-level `{"error":...}` (work_dir missing, claude
  CLI not found, persona files missing), report the error verbatim and stop.
  Do not retry silently.
- If a single iteration's `claude -p` invocation inside the script fails, the
  script handles the fallback (synthetic VERDICT, continue loop). You don't
  need to intervene.
