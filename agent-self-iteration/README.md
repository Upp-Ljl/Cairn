# agent-self-iteration

A multi-agent (profiler + executor + reviewer) iteration loop for Claude
Code. A profiler reads the project once and derives a project-specific
**MANIFEST** of audit dimensions; then an executor edits code and a separate
reviewer audits against the MANIFEST and decides whether more work remains.
The three roles run as **separate processes** so neither can rubber-stamp
the other — mutual supervision is mechanically enforced, not just instructed.

```
                    ┌──────────────────────────────┐
                    │ bash (orchestrator)          │
                    └──┬───────────┬───────────┬───┘
                       │           │           │
              ┌────────▼─┐  ┌──────▼─┐  ┌──────▼──┐
              │ claude -p│  │claude-p│  │claude -p│
              │ PROFILER │  │EXECUTOR│  │REVIEWER │
              │ (once)   │  │ edits  │ →│ audits  │
              └────┬─────┘  └────────┘  └─────────┘
                   │ emits MANIFEST: {dimensions: [...]}
                   ▼
              <PROMPT_DIR>/manifest.json — fed into every executor
                                          + reviewer prompt below

       per iteration:
         executor → signal command (pytest/tsc/...) → reviewer → VERDICT
       loop until reviewer says improvements_exhausted=true
       for QUIET_STREAK consecutive iterations, OR MAX_ITER hit
```

## What it does

You point it at a working directory + a task ("make these tests pass", "fix
the bugs in src/", "audit for performance and security"). It runs a tight
loop:

0. **Profiler** runs ONCE before the iteration loop. It reads the README,
   TASK, and a few central source files, then emits a MANIFEST — a list of
   4–7 **project-specific** dimensions worth auditing (e.g. `role_leakage`
   and `vote_correctness` for a werewolf game; `responsive_breakpoints` and
   `keyboard_nav` for a CSS page; `correctness` and `edge_cases` for a tiny
   bug-fix script). The manifest replaces the legacy fixed nine-dim lens.
1. **Executor** reads the code, edits files, runs the signal command (tests/
   typecheck/lint). It receives the manifest so it knows what "done" means.
2. **Signal command** runs (e.g. `pytest -q`, `npm test`, `tsc --noEmit`)
   and bash captures the exit code.
3. **Reviewer** reads the *current* state of the code (it has no shared
   memory with the executor) plus the signal output. It judges against the
   manifest's dimensions — not a fixed checklist.
4. Reviewer emits `VERDICT: { verdict: pass|fail, improvements_exhausted: bool, issues: [...] }`.
5. If signals are red, bash mechanically force-fails the verdict (the
   reviewer cannot rubber-stamp red tests).
6. The bash driver tracks **recurring issue classes** (same dimension +
   normalized fix_hint flagged 2+ iterations in a row) so the loop doesn't
   keep re-finding the same nit.
7. If verdict is `pass` AND `improvements_exhausted: true` for `QUIET_STREAK`
   consecutive iterations → exit. Otherwise feed the issues back to executor
   and iterate.

## Why separate processes?

Earlier versions ran the loop inside a single Claude session that was told
to dispatch subagents via the Agent tool. Empirically, on trivial tasks, that
session would short-circuit — do the executor + reviewer + decision work
itself in one turn and produce a plausible "EXHAUSTED" markdown summary
without ever exercising the dual-agent pattern. The mutual-supervision
premise was not actually being tested.

The structural fix: bash IS the orchestrator. Each iteration runs **two
separate `claude -p` calls** — one with the executor persona, one with the
reviewer persona. Each call is a fresh single-role session with no memory of
the other. There is no possibility of one Claude session collapsing both
roles. The cost is ~5–10s of process startup overhead per call, paid for the
mechanism integrity.

## Requirements

- macOS or Linux (uses `mktemp`, `bash`, standard POSIX tools)
- `claude` CLI installed and authenticated
  - Pro/Max users: OAuth via Keychain (macOS) / `~/.claude/.credentials.json` (Linux)
  - API users: `ANTHROPIC_API_KEY` env var
- Recommended model: `claude-sonnet-4-6` (smaller models tend to roleplay
  the loop without actually using tools — see comments in `scripts/regression.sh`)
- Per-target tooling for each signal command (e.g. `pytest`, `node`, `npx`,
  `tsc`, `bash` — install only what your project needs)

## Install

Drop the project into a directory and ensure scripts are executable:

```bash
git clone <repo-url> agent-self-iteration
cd agent-self-iteration
chmod +x scripts/*.sh
```

The `.claude/` directory contains slash commands (`/auto-iter`,
`/self-improve`) and agent personas (`executor`, `reviewer`,
`self-improver`). When you launch Claude Code with this directory as cwd
(or any project that contains it), the slash commands and agents are picked
up automatically.

## Usage — `scripts/dual_agent_iter.sh` (the primary tool)

The canonical entry point. Usable from any shell, CI pipeline, or wrapping
script:

```bash
bash scripts/dual_agent_iter.sh <work_dir>
```

`<work_dir>` is the directory the loop will operate on. The script reads/
edits files inside it and runs the signal command from inside it.

### Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TASK_FILE` | `<work_dir>/TASK.md` | Path to a TASK description. If absent, profiler infers from project; reviewer audits whatever manifest the profiler emits. |
| `SIGNAL_CMD` | `python3 -m pytest -q` | Shell command run from `<work_dir>` after each iteration. Must exit 0 on green. |
| `MAX_ITER` | `10` | Hard cap on iterations (safety net). |
| `QUIET_STREAK` | `2` | Consecutive `pass + improvements_exhausted=true` verdicts required to exit. Lower = more aggressive exit, higher = more skeptical. |
| `MODEL` | `claude-sonnet-4-6` | Claude model for executor and reviewer. |
| `PROFILE_MODEL` | (same as `MODEL`) | Model for the one-shot profiler. Cheaper Haiku is usually fine. |
| `VALIDATOR_MODEL` | `claude-haiku-4-5-20251001` | Model for the manifest second-opinion validator (one-shot, cheap). |
| `SKIP_PROFILE` | `0` | Set to `1` to skip the profiler and use a generic 3-dim safety-net manifest. |
| `SAFETY_VALIDATE_MANIFEST` | `1` | If `1`, run a Haiku second-opinion on the profiler's manifest. If validator says `warn`, a `MANIFEST_WARNING` block is threaded into every executor and reviewer prompt thereafter. |
| `REVIEWER_COUNCIL` | `1` | Number of parallel reviewers. With `N>1`, all N must independently agree on `verdict=pass` AND `improvements_exhausted=true` before the loop exits. Useful on no-signal projects where one reviewer can confabulate exhaustion. |
| `MAX_DIFF_LINES` | `0` | Cumulative line-change cap across all iterations. `0` = disabled. When set (e.g. `500`), the loop force-terminates with `status: diff_budget_exceeded` once exceeded — protects against runaway "let me rewrite the whole codebase" behavior. |
| `STUCK_THRESHOLD` | `3` | Bail out with `status: stuck` after this many consecutive iterations leave WORK_DIR content unchanged. Prevents reviewer-keeps-finding-nits-but-executor-can't-or-won't loops. |
| `MAX_SIGNAL_TAIL` | `80` | Truncate red signal output to the last N lines. Green signals collapse to `EXIT=0`. |
| `LOG_FILE` | stderr | Append per-iteration trace here. |
| `PROMPT_DIR` | tmp dir | Where to drop prompt files (and `manifest.json`, `baseline/` snapshot, council verdicts) for debugging. |
| `PROJECT_ROOT` | script's parent's parent | Where `.claude/agents/{profiler,validator,executor,reviewer}.md` live. |

### Output

stdout: a single JSON summary line on completion:

```json
{"status":"exhausted","iterations":3,"final_signal_exit":0,"duration_s":487,"manifest_dims":5,"manifest_validation":"ok","diff_lines":47}
```

Status values:
- `exhausted` — reviewer (council) said `improvements_exhausted: true` for `QUIET_STREAK` consecutive iters.
- `max_iter_reached` — hit `MAX_ITER` without converging.
- `diff_budget_exceeded` — `MAX_DIFF_LINES` exceeded; loop force-terminated.
- `stuck` — `STUCK_THRESHOLD` consecutive iters left WORK_DIR content unchanged; loop force-terminated.

`manifest_dims` is how many audit dimensions the profiler derived (or `3`
when `SKIP_PROFILE=1`). `manifest_validation` is `ok`/`warn`/`skipped`
from the validator second-opinion. `diff_lines` is the cumulative
line-change count vs. iteration-0 baseline. Inspect the actual dimensions
in `<PROMPT_DIR>/manifest.json` and council verdicts in
`<PROMPT_DIR>/iter<N>_council/`.

Exit code: 0 if `final_signal_exit == 0`, else 1.

### Examples

**Make a test suite pass (default — pytest):**

```bash
bash scripts/dual_agent_iter.sh ~/myproj
```

If `~/myproj/TASK.md` describes the goal and `pytest -q` is the signal,
nothing else is needed.

**Custom signal — TypeScript strict typecheck:**

```bash
SIGNAL_CMD='cd src && npx -y -p typescript@5 tsc --noEmit' \
bash scripts/dual_agent_iter.sh ~/my-ts-proj
```

**Custom signal — npm test:**

```bash
SIGNAL_CMD='npm test' \
MAX_ITER=20 \
QUIET_STREAK=3 \
bash scripts/dual_agent_iter.sh ~/my-react-app
```

**No TASK file — let the profiler derive what to audit from the code itself:**

```bash
SIGNAL_CMD='npm run lint' \
bash scripts/dual_agent_iter.sh ~/legacy-codebase
```

The profiler will inspect the project, decide what kind of project it is,
and emit a manifest of dimensions appropriate for it. The reviewer will then
audit against those dimensions and the executor will fix issues until the
reviewer says exhausted twice in a row.

**Skip the profiler for tiny one-file projects:**

```bash
SKIP_PROFILE=1 \
bash scripts/dual_agent_iter.sh ~/tiny-script
```

Falls back to a generic `correctness / test_coverage / maintainability`
3-dim safety net.

**Save the per-iteration trace for debugging:**

```bash
LOG_FILE=/tmp/iter.log \
PROMPT_DIR=/tmp/iter-prompts \
bash scripts/dual_agent_iter.sh ~/myproj
tail -100 /tmp/iter.log
ls /tmp/iter-prompts/  # one .prompt file per iteration per role
```

## Usage — `/auto-iter` slash command (interactive Claude Code)

When you're already in an interactive Claude Code session, type:

```
/auto-iter <target_dir> | <task description>
```

For example:

```
/auto-iter ~/myproj | make every test in tests/ pass

/auto-iter ./src | audit for security and fix any issues you find

/auto-iter /Users/me/legacy | use TASK.md
```

If the task text is `use TASK.md`, the slash command reads the TASK from
`<target_dir>/TASK.md`.

The slash command's orchestrator is forbidden from running the loop itself
or directly editing files in the target dir. Its only job is to invoke
`bash scripts/dual_agent_iter.sh` and stream the trace back to you.

## Inline overrides

Inside the task text (or in the slash-command argument), you can pass
parenthetical overrides:

```
/auto-iter ~/myproj | use TASK.md (max-iter=5, quiet=3)

/auto-iter ./src | fix bugs (model=claude-haiku-4-5)
```

Recognized keys: `max-iter`, `quiet` (= `QUIET_STREAK`), `model`.

## The agent personas

The personas are kept in `.claude/agents/`:

- **`profiler.md`** — runs ONCE before iteration 1. Reads README/TASK/source
  layout and emits a `MANIFEST: {...}` JSON line listing the dimensions of
  quality that genuinely matter for THIS project (4–7 axes is the target).
- **`executor.md`** — autonomy contract (no asking questions, no waiting for
  confirmation), operating rules ("treat TASK as contract", "verify
  empirically not by inspection"), and the `EXECUTOR_SUMMARY` output format.
- **`reviewer.md`** — separate-context audit against the manifest's
  dimensions, severity ladder (blocker/major/minor), the honesty clause
  ("don't invent trivial issues; admit exhaustion when warranted"), and
  the `VERDICT` output format.

`dual_agent_iter.sh` reads all three files at runtime, strips the YAML
frontmatter, and prepends the body as the persona for the respective
`claude -p` invocation. Editing these files changes the loop's behavior
without touching code.

## Regression suite (`scripts/regression.sh`)

For developers maintaining this project, `scripts/regression.sh` runs the
loop against a set of bugged test fixtures (under `examples/`) to measure
the loop's quality:

```bash
bash scripts/regression.sh                       # default targets
bash scripts/regression.sh buggy_calculator      # one specific target
bash scripts/regression.sh foo bar baz           # subset
```

Each `examples/<name>/` contains:
- `TASK.md` — the task description
- `.baseline-src/` — the canonical *bugged* source. Each regression run
  copies this into a fresh tmp dir as the starting state, so previous runs
  don't pollute baselines.
- `tests/` — the spec
- `regression.cmd` (optional) — the signal command for this target.
  Default is `python3 -m pytest -q`. Use this to wire up non-pytest
  targets (e.g. `bash tests/run_tests.sh`, `npx tsc --noEmit`,
  `node tests/check_a11y.mjs`).

regression.sh delegates to `dual_agent_iter.sh` with tight caps
(`MAX_ITER=3, QUIET_STREAK=1`) — the regression is a measurement tool, not
a production fix-it run. Real `/auto-iter` use defaults to looser caps
(`MAX_ITER=10, QUIET_STREAK=2`).

Each run produces a `.regression-runs/<timestamp>/` directory with one log
file per target.

## Mechanical safeguards (W1–W7 hardenings)

The loop ships with seven independent guardrails so it stays predictable
even on vague tasks, large repos, or projects without a strong test signal:

| Safeguard | Knob | What it catches |
|---|---|---|
| **Diff budget** | `MAX_DIFF_LINES` | runaway "let me rewrite everything" — caps cumulative diff lines and bails with `status: diff_budget_exceeded` |
| **Reviewer council** | `REVIEWER_COUNCIL` | single-reviewer confabulation — N parallel reviewers must independently agree before declaring exhaustion |
| **Manifest validator** | `SAFETY_VALIDATE_MANIFEST` | bad iter-0 manifest poisoning the entire run — Haiku second-opinion threads `MANIFEST_WARNING` into later prompts when concerns surface |
| **Stuck detector** | `STUCK_THRESHOLD` | reviewer-keeps-finding-nits-but-executor-stuck — bails with `status: stuck` when WORK_DIR content unchanged for N consecutive iters |
| **Changed-files threading** | (always on) | reviewer ignoring scope on big repos — executor's `changed_files` list is now explicitly passed in the reviewer prompt with "read AT LEAST these" |
| **Robust JSON parsing** | (always on) | code-fenced or indented sentinels — `extract_json_after_sentinel` tolerates fences and inline placement; `validate_verdict_shape` falls back gracefully |
| **Roleplay detection** | (always on) | claimed_changes ≠ reality — pre/post executor hash of WORK_DIR; logs `# ROLEPLAY:` when claim diverges from actual edits |

For a vague-scope or no-signal run, the recommended combination is:

```bash
MAX_DIFF_LINES=500 \
REVIEWER_COUNCIL=2 \
SIGNAL_CMD=':' \
bash scripts/dual_agent_iter.sh ~/some-project
```

This gives you a hard ceiling on edits, a 2-of-2 reviewer agreement
requirement before exit, and a no-op signal that lets the reviewer drive
the loop entirely (with the budget + council preventing collapse).

## Self-improvement (`/self-improve` meta-loop)

`/self-improve` is a meta-loop: it runs the regression suite, dispatches
the `self-improver` agent to propose edits to the loop's own prompts/specs,
runs the regression again to measure, and either commits or reverts the
edit based on whether the score improved. It can also add new regression
targets to the suite when the existing ones plateau.

Invoke it from interactive Claude Code:

```
/self-improve
```

The meta-loop is bound by `docs/INVARIANTS.md` — a list of properties that
self-improvement must not violate (autonomy contract, output sentinels,
force-fail-on-red rule, termination rails, reviewer's no-edit constraint,
honesty clause). The reviewer agent audits each proposed self-improvement
against this list before validation.

This is mostly useful for the project's own developers; downstream users
running `/auto-iter` on their own codebase won't usually need it.

## Project layout

```
agent-self-iteration/
├── README.md                     ← you are here
├── scripts/
│   ├── dual_agent_iter.sh        ← the primary tool. Profiler + executor + reviewer driver.
│   └── regression.sh             ← scoring harness (uses dual_agent_iter.sh per-target)
├── .claude/
│   ├── agents/
│   │   ├── profiler.md           ← profiler persona (runs once at iter 0)
│   │   ├── executor.md           ← executor persona body
│   │   ├── reviewer.md           ← reviewer persona body
│   │   └── self-improver.md      ← meta-loop persona body
│   └── commands/
│       ├── auto-iter.md          ← /auto-iter slash command (delegates to dual_agent_iter.sh)
│       └── self-improve.md       ← /self-improve meta-loop slash command
├── docs/
│   └── INVARIANTS.md             ← properties /self-improve must not violate
└── examples/                     ← regression targets (bugged source + tests + TASK.md)
    ├── buggy_calculator/         ← Python arithmetic bugs
    ├── string_utils/             ← Python string ops
    ├── csv_reader/               ← Python CSV state machine
    ├── task_scheduler/           ← Python graph algorithms
    ├── shell_script_bugs/        ← bash script bugs (custom shell test harness)
    ├── broken_html_a11y/         ← HTML accessibility violations (vanilla node static checker)
    └── typescript_types/         ← TypeScript strict-mode type errors (tsc --noEmit)
```

## Costs

Each run does:
- ONE `claude -p` profiler call at iter 0 (typically 5–10k tokens)
- TWO `claude -p` calls per iteration (executor + reviewer)

Token-saving measures applied by the new driver:
- The MANIFEST replaces the legacy nine-dim boilerplate in every reviewer
  prompt (–500 to –1500 tokens per reviewer call depending on persona slim)
- Signal output is truncated: red output keeps only the last
  `MAX_SIGNAL_TAIL` lines (default 80); green output collapses to `EXIT=0`
  (saves the full pytest/typecheck dump on every passing iteration)
- Personas were slimmed (executor 41→47 lines, reviewer 93→90 lines, with
  cuts to redundant exposition; the contracts are unchanged)
- Recurring-issue tracking discourages the reviewer from re-flagging the
  same class repeatedly, which shortens the loop

A typical "fix the bugs in this small Python file" run on Sonnet 4.6 is on
the order of \$0.30–\$1 per target per run; the manifest-driven loop tends
to cut a 5-iteration loop to 3 by giving both agents a sharper "what
matters" signal. A 7-target regression of this project's own suite is
roughly \$2–\$5.

## Common failure modes

- **"reviewer says exhausted after 1 trivial change"**: increase
  `QUIET_STREAK` (e.g. to 3 or 4) for more skeptical exit.
- **"loop runs forever finding nitpicks"**: this is the failure mode the
  reviewer's honesty clause is supposed to prevent. Check that the personas
  haven't been edited away from "don't invent trivial issues; if you
  wouldn't bother changing it on someone else's PR, don't list it." If the
  task is too vague, narrow it.
- **"executor wrote to the wrong path"**: the executor inside
  `dual_agent_iter.sh` runs with `--add-dir <work_dir>` so it has access to
  the work dir, and is told all edits MUST stay inside that dir. If you see
  edits leaking outside, the work dir was likely set to a parent path that
  contains both intended and unintended files.
- **"loop short-circuits / no `=== iteration ===` banners"**: shouldn't
  happen with `dual_agent_iter.sh` (bash drives the loop, not the model).
  If it does, you're probably running an older version that still tried to
  drive the loop from inside a single `claude -p` session.

## License & contributions

Internal Hosico project. Contributions to the personas, slash commands,
or new regression targets via PRs / new branches.
