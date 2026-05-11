# TEAMWORK — Parallel Dispatch

> N sonnet workers + 2N probes + 1 opus reporter, each in a git worktree.
> Adapted from TeamBrain `docs/TEAMWORK.md`.

## When to Dispatch in Parallel

Use parallel TEAMWORK when:
- Tasks have **non-overlapping write sets** (different files / different packages)
- Each task takes > 15 min standalone
- No task's output is another task's input

Do NOT parallelize when:
- Tasks share files (race condition)
- Critical path dependency (lead agent does it, not a subagent)
- Trivial work (< 15 min) — overhead exceeds gain

---

## The N + 1 + 2N Pattern

For N tasks dispatched in parallel:

| Role | Count | Model | Job |
|---|---|---|---|
| Worker | N | sonnet | Implement one task in its own worktree |
| Probe | 2N (2 per worker) | haiku | Fast JSON probe checking worker output mid-flight |
| Reporter | 1 | opus | Aggregate all worker results, identify conflicts, write final summary |

The reporter ALWAYS uses the strongest model. It is the only agent that sees all worker outputs together. The lead agent (this Claude) then verifies the reporter's summary against actual git state — trust but verify.

---

## Worktree Isolation

Each worker gets its own git worktree under `.cairn-worktrees/<task-slug>`:

```bash
# create
git worktree add .cairn-worktrees/packaging-win-nsis -b packaging/win-nsis-mvp

# worker operates in .cairn-worktrees/packaging-win-nsis
# files written there do NOT pollute lead agent's main checkout

# when worker is done
git worktree remove .cairn-worktrees/packaging-win-nsis
# OR keep it and merge the branch
```

This prevents the most common multi-agent failure: agent A's stash steps on agent B's read.

Lead agent NEVER works in the main checkout while workers are running. Lead agent works in `.cairn-worktrees/__lead__` if needed.

`.cairn-worktrees/` is gitignored so worktree state never leaks into commits.

---

## Dispatch Format

Each Agent dispatch must give the worker:

```
# Task
<one-paragraph description; specific, not vague>

# Plan reference
docs/superpowers/plans/YYYY-MM-DD-<slug>.md (read it first)

# Worktree
.cairn-worktrees/<task-slug>
You are in worktree <task-slug>. All file writes go there. Do NOT cd back to main.

# Acceptance checklist
- [ ] <item 1>
- [ ] <item 2>

# Verify command
<exact command + expected output>

# Out of scope
<what NOT to touch>

# Reporting (required)
Before reporting done, your final message MUST include:
- Files modified (with line counts)
- Commands run + actual output (not paraphrased)
- Test results
- Residual risks (anything that might be wrong)
- Confidence: 0.0-1.0
```

---

## Model Routing

| Task type | Model |
|---|---|
| Architecture decision, plan review, reporter aggregation | opus |
| Feature implementation (each worker) | sonnet |
| JSON probe / fast verification / mechanical tasks | haiku |

Why this matters: opus reporter sees N worker outputs in one context — needs depth. Sonnet workers do focused implementation. Haiku probes are throwaway one-shot JSON producers, latency-sensitive.

---

## Verification Rule (Trust But Verify)

When a worker reports done, the LEAD agent (not the reporter) must verify:

```bash
# Did the claimed files actually get modified?
git -C .cairn-worktrees/<task-slug> diff --stat HEAD

# Did the claimed tests actually pass? Re-run them.
cd .cairn-worktrees/<task-slug>/packages/<pkg> && npm test

# Are there residual risks the worker flagged?
# Read the worker's final message; cross-check against the diff.
```

"Worker says it works" is NOT verification. The output of the verify command is.

If the worker's claim diverges from reality, the worker failed. Fix in this session, not in a follow-up issue.

---

## Cairn As Its Own Coordination Layer

When multiple subagent workers run on the Cairn repo, Cairn's own kernel can manage them:

- Each Agent registers via `cairn.process.register`
- Their writes (touched files) emit conflicts via the pre-commit hook
- Conflicts go to `cairn.conflict.resolve`, not `git reset --hard`

This is dogfood: we use Cairn while building Cairn. When the workflow we describe here causes a conflict, the conflict surfaces in Cairn's panel.

---

## Two-Engine Cross-Validation (per worker)

Each worker output must pass cross-validation per `FEATURE-VALIDATION.md`. Workers do not self-attest; the probes do.

This is the difference between TeamBrain's N + 1 + **2N** vs simpler N + 1: the 2 probes per worker are the second-engine attestation. Without probes, worker drift is invisible until POSTPR review.
