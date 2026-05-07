# Project Invariants

These properties **must hold** after every self-improvement edit. The self-improver
subagent is forbidden from violating them. The reviewer agent is required to flag
any edit that breaks them — that flag forces the meta-loop to revert.

If you (a human) are editing prompts manually, treat these the same way.

---

## I1 — Autonomy contract is preserved

`.claude/agents/executor.md` and `.claude/agents/reviewer.md` MUST contain rules
that prohibit:
- Asking the user clarifying or multiple-choice questions
- Pausing to wait for confirmation between steps
- Producing verdicts like "needs human review" / "ambiguous, please clarify"

The exact wording may evolve, but the **prohibitions** must remain enforceable.

## I2 — Output sentinels are unchanged

The orchestrator parses two specific lines:
- Executor must end with `EXECUTOR_SUMMARY: { ... }` on its own line
- Reviewer must end with `VERDICT: { ... }` on its own line

These tokens (`EXECUTOR_SUMMARY:` and `VERDICT:`) must appear verbatim in the
respective agent prompts. Renaming or reformatting them breaks the orchestrator.

## I3 — Force-fail on red signals

`.claude/commands/auto-iter.md` MUST keep the rule that if any objective signal
(test/lint/typecheck) exits non-zero, the verdict is forced to `fail`, regardless
of the reviewer's call. This blocks the loop from converging on green-reviewer
+ red-pytest.

## I4 — Termination rails

`.claude/commands/auto-iter.md` MUST keep:
- A `MAX_ITERATIONS` cap (numeric upper bound, default 10)
- A `QUIET_STREAK` requirement of at least 2 consecutive `pass` verdicts before
  declaring convergence

Both of these prevent runaway loops and rubber-stamp single-pass approvals.

## I5 — Reviewer cannot edit code

`.claude/agents/reviewer.md` MUST declare `tools:` without `Write` or `Edit`.
The reviewer inspects only. Allowing it to edit breaks the dual-agent separation
that the entire premise of this project depends on.

## I6 — Regression targets are not modified

`examples/*/.baseline-src/`, `examples/*/tests/`, and `examples/*/TASK.md`
are the spec the loop is judged against. Self-improvement edits MUST NOT touch
them. If the self-improver wants new test coverage, it adds a NEW target dir,
not modifies existing ones.

`examples/*/src/` is allowed to drift (it's a workspace humans may experiment
in), but `regression.sh` does NOT use it — every regression run starts from
`.baseline-src/` in a temp dir. So the canonical bugged baseline lives in
`.baseline-src/` and that's what self-improver edits are scored against.

## I7 — Invariant document is not weakened

This file (`docs/INVARIANTS.md`) MAY be added to (new invariants), but existing
invariants MUST NOT be removed or weakened by an automated self-improvement run.
Removing invariants requires a human commit.

## I8 — Test stability across iterations

Tests must remain green across every iteration of `/auto-iter`. The signals
forcing-fail rule (I3) covers the verdict; this invariant adds: an iteration
that breaks a previously-green test is itself a regression. The orchestrator's
force-fail logic in `auto-iter.md` already guarantees the verdict, but executor
prompts must keep the rule "do not break existing tests" prominent. Removing
that rule from executor.md violates this invariant.

## I9 — Honest exhaustion

The Reviewer's `improvements_exhausted: true` claim is the loop's normal exit
condition. The Reviewer prompt MUST keep:
- The honesty clause forbidding invented trivial issues
- The "minor must be worth changing" filter
- The instruction to set `improvements_exhausted: true` when nothing
  meaningful remains across the project-specific MANIFEST dimensions
  (or, when the manifest is missing, the small generic safety-net set)

Weakening any of these breaks the loop's natural termination — either by
making the Reviewer rubber-stamp prematurely (false exhaustion) or by making
it eternally pessimistic (no exit). Both are loop failures.

## I10 — Dual-agent process separation

The Profiler, Executor, and Reviewer roles MUST run as SEPARATE `claude -p`
sub-sessions dispatched by `scripts/dual_agent_iter.sh`. The `/auto-iter`
orchestrator front-end (`.claude/commands/auto-iter.md`) MUST NOT:
- Simulate the loop in its own session (writing fake "iteration N..." prose)
- Use the `Agent` / `Task` tool to dispatch profiler/executor/reviewer
  subagents itself, bypassing the bash driver
- Read, edit, or grep files inside `TARGET_DIR` (doing so re-merges the
  orchestrator with the executor/reviewer context the script isolates)

The mechanical process boundary between roles is the entire premise of this
project. A single Claude session attempting to play multiple roles collapses
into self-approval. Removing the bash-driven separation — either by inlining
the loop into `auto-iter.md` or by giving the orchestrator TARGET_DIR
file-access tools — is forbidden by this invariant.

## I11 — Profiler runs before iteration 1

`scripts/dual_agent_iter.sh` MUST emit a MANIFEST (either via the profiler
sub-session, or via the generic 3-dim safety net when `SKIP_PROFILE=1` or
the profiler persona is missing) BEFORE invoking the executor/reviewer for
iteration 1. The MANIFEST is what the reviewer audits against; without it
the reviewer falls back to the legacy fixed dimension list and the project-
specific lens is lost.

The MANIFEST contract (as parsed by the script):
- A line beginning with `MANIFEST:` followed by valid JSON
- A `dimensions` array of objects, each with at least a `name` field
- The script writes the JSON body to `<PROMPT_DIR>/manifest.json` for inspection

Renaming the `MANIFEST:` sentinel or removing the fallback safety net
violates this invariant.

## I12 — Signal output truncation must keep the failure tail

Token-saving signal truncation in the script (`truncate_signal`) MUST
preserve the LAST `MAX_SIGNAL_TAIL` lines of red signal output and MAY
suppress only earlier lines (with a "... earlier lines omitted ..."
marker). Truncating the tail (where pytest puts the failure summary) would
hide the executor's debug surface. Replacing red output entirely with a
summary string is forbidden.

When the signal is green (`EXIT=0`), the script MAY collapse the body to a
single `EXIT=0` line — green output carries no executor-relevant info.

---

## How invariants are enforced

1. `/self-improve` always passes this file's contents to the reviewer.
2. The reviewer's verdict prompt includes: "If any edit violates an invariant in
   docs/INVARIANTS.md, output `verdict: fail` with severity `blocker`."
3. The meta-loop checks `git diff` of the self-improver's changes against this
   list and reverts if any invariant is touched.
