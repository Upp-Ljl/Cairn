# Teamwork: Multi-Agent Parallel Dispatch

> How to split work across multiple Claude Code sessions without conflicts.

## When to Use

Use parallel dispatch when:
- Tasks have **non-overlapping write sets** (different files, different packages)
- Work is independent (no task needs another's output to start)
- Each task takes > 15 minutes

Do NOT parallelize when:
- Tasks share files (race condition on writes)
- One task's output is another task's input
- The work is on the critical path (do it yourself, don't wait for a subagent report)

---

## Dispatch Format

Each dispatched task must receive in its prompt:

```
# Task
<what to do — specific, not vague>

# Acceptance checklist
[ ] <item 1>
[ ] <item 2>

# Verify command
<exact command + expected output>

# Out of scope
<what not to touch>

# When done
Report back:
- Files modified
- Commands run + results
- Test output
- Residual risks
```

---

## Model Routing

| Task type | Model |
|---|---|
| Architecture decisions, review, strategy | opus |
| Feature implementation (each phase) | sonnet |
| Mechanical tasks (rename, format, migrate) | haiku |

---

## Reporter Pattern

For large parallel batches (N workers):
1. N sonnet workers each do one independent task
2. 1 opus reporter aggregates all results, identifies conflicts, produces final summary

Main agent does not relay worker reports directly — it verifies them first (trust but verify).

---

## Verification Rule

When a subagent reports done, main agent must verify:
- Were the claimed files actually modified? (`git diff`)
- Did the claimed tests actually pass? (run them)
- Are there residual risks the subagent flagged?

"Subagent says it passed" is not verification. The output of the verify command is.

---

## Cairn as the Coordination Layer

When multiple CC sessions are running on the same project:
- Each session registers as a process in Cairn (`cairn.process.register`)
- Shared state (tasks, blockers, conflicts) lives in `cairn.db`
- Pre-commit hook detects overlapping writes and raises a conflict
- Conflicts resolved via `cairn.conflict.resolve`, not `git reset --hard`

This is Cairn eating its own dog food: the team uses Cairn to coordinate while building Cairn.
