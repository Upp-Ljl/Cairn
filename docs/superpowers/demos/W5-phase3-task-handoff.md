# W5 Phase 3 — Live Dogfood: Outcomes Closed-Loop

> **Date**: 2026-05-07
> **Plan**: [`docs/superpowers/plans/2026-05-21-w5-phase3-outcomes.md`](../plans/2026-05-21-w5-phase3-outcomes.md) §5.5
> **Script**: [`packages/mcp-server/scripts/w5-phase3-dogfood.mjs`](../../../packages/mcp-server/scripts/w5-phase3-dogfood.mjs)
> **Result**: 32/32 assertions PASS

## What this proves

Phase 2 dogfood proved "session A blocks, session B resumes." **Phase 3 dogfood proves "Cairn really validates agent work"** — the full FAIL→fix→PASS retry cycle, the CRITERIA_FROZEN contract, and the user-driven terminal_fail escape hatch, all through real MCP stdio across independent OS processes.

The script runs **three** child `mcp-server` processes against the same SQLite DB:

1. **A1** opens, creates the task, starts an attempt, **exits**.
2. **B** opens (separate process), exercises the full outcomes closed loop:
   - boundary EMPTY_CRITERIA (first submit without criteria is rejected)
   - first `submit_for_review` with `file_exists` criteria → WAITING_REVIEW + PENDING outcome
   - boundary CRITERIA_FROZEN (second submit with different criteria is rejected)
   - `evaluate` → FAIL (file absent) → task back to RUNNING
   - boundary OUTCOME_NEEDS_RESUBMIT (evaluate again in FAIL state is rejected)
   - fix: `fs.writeFileSync` creates the file (simulating agent completing the work)
   - upsert-reset: `submit_for_review` without criteria → PENDING, outcome_id stable, criteria stable
   - `evaluate` → PASS → task DONE
   - boundary OUTCOME_ALREADY_PASSED (evaluate again in PASS state is rejected)
   - second task: create + start + submit + `terminal_fail` → TERMINAL_FAIL + FAILED
   - **B exits**
3. **A2** (re-spawned) reads both tasks — DONE and FAILED — confirming cross-process state durability.

## Reproduction commands

```bash
cd packages/mcp-server
npm run build
node scripts/w5-phase3-dogfood.mjs
```

## The 16-step scenario

| # | Session | MCP call | What it asserts |
|---|---|---|---|
| 1 | A1 | `cairn.task.create({ intent })` | new PENDING task (taskId1) |
| 2 | A1 | `cairn.task.start_attempt({ task_id })` | PENDING → RUNNING |
| 3 | A1 | (process exit) | session A is gone; state persists in SQLite |
| 4 | B | `cairn.task.submit_for_review({ task_id })` — no criteria | error EMPTY_CRITERIA (LD-12 first-call guard) |
| 5 | B | `cairn.task.submit_for_review({ task_id, criteria: [file_exists] })` | outcome PENDING + task WAITING_REVIEW; outcomeId1 recorded |
| 6 | B | `cairn.task.submit_for_review({ task_id, criteria: [DIFFERENT.tmp] })` | error CRITERIA_FROZEN (LD-12 freeze guard) |
| 7 | B | `cairn.outcomes.evaluate({ outcome_id: outcomeId1 })` | FAIL; task → RUNNING; perPrimitive[0] FAIL; outcome_id + criteria stable |
| 8 | B | `cairn.outcomes.evaluate({ outcome_id: outcomeId1 })` (FAIL state) | error OUTCOME_NEEDS_RESUBMIT |
| 9 | B | `fs.writeFileSync(path.join(tmpDir, 'WILL_NOT_EXIST.tmp'), 'fixed')` | local fix (simulates agent work) |
| 10 | B | `cairn.task.submit_for_review({ task_id })` — no criteria, upsert reset | outcome → PENDING; outcome_id stable; criteria stable; task WAITING_REVIEW |
| 11 | B | `cairn.outcomes.evaluate({ outcome_id: outcomeId1 })` | PASS; task → DONE; outcome PASS |
| 12 | B | `cairn.outcomes.evaluate({ outcome_id: outcomeId1 })` (PASS state) | error OUTCOME_ALREADY_PASSED |
| 13 | B | create taskId2 + start + submit(NOPE_TERMINAL.tmp) + `terminal_fail` | outcome TERMINAL_FAIL + task FAILED + evaluation_summary='demo terminal' |
| 14 | B | (process exit) | session B is gone |
| 15 | A2 | `cairn.task.get({ task_id: taskId1 })` | DONE (cross-process) |
| 16 | A2 | `cairn.task.get({ task_id: taskId2 })` | FAILED (cross-process) |

## Key actual JSON output excerpts

### Step 7 — FAIL evaluate (file absent)

```json
{
  "outcome": {
    "outcome_id": "01KR0VSEPFA6K7S43408DYG2QW",
    "status": "FAIL",
    "evaluation_summary": "## Evaluation result: FAIL\n\n- [✗] file_exists({\"path\":\"WILL_NOT_EXIST.tmp\"}) — file not found: WILL_NOT_EXIST.tmp (0ms)"
  },
  "task": { "state": "RUNNING" },
  "evaluation": {
    "status": "FAIL",
    "perPrimitive": [
      {
        "primitive": "file_exists",
        "args": { "path": "WILL_NOT_EXIST.tmp" },
        "status": "FAIL",
        "detail": "file not found: WILL_NOT_EXIST.tmp",
        "elapsed_ms": 0
      }
    ]
  }
}
```

### Step 10 — upsert reset (outcome_id stability)

```json
{
  "outcome": {
    "outcome_id": "01KR0VSEPFA6K7S43408DYG2QW",
    "status": "PENDING",
    "criteria": [{ "primitive": "file_exists", "args": { "path": "WILL_NOT_EXIST.tmp" } }],
    "evaluated_at": null,
    "evaluation_summary": null
  },
  "task": { "state": "WAITING_REVIEW" }
}
```

outcome_id is identical to step 5. criteria is frozen — unchanged.

### Step 11 — PASS evaluate (file now exists)

```json
{
  "outcome": {
    "outcome_id": "01KR0VSEPFA6K7S43408DYG2QW",
    "status": "PASS",
    "evaluation_summary": "## Evaluation result: PASS\n\n- [✓] file_exists({\"path\":\"WILL_NOT_EXIST.tmp\"}) — file found: WILL_NOT_EXIST.tmp (1ms)"
  },
  "task": { "state": "DONE" },
  "evaluation": {
    "status": "PASS",
    "perPrimitive": [
      {
        "primitive": "file_exists",
        "args": { "path": "WILL_NOT_EXIST.tmp" },
        "status": "PASS",
        "detail": "file found: WILL_NOT_EXIST.tmp",
        "elapsed_ms": 1
      }
    ]
  }
}
```

### Step 13 — terminal_fail outcome shape

```json
{
  "outcome": {
    "outcome_id": "01KR0VSEPVQ1MFQTHF7C21570P",
    "status": "TERMINAL_FAIL",
    "evaluated_at": 1778145606364,
    "evaluation_summary": "demo terminal"
  },
  "task": {
    "state": "FAILED"
  }
}
```

## Full assertion sweep (actual run output)

```
PASS: tools/list: cairn.task.submit_for_review registered
PASS: tools/list: cairn.outcomes.evaluate registered
PASS: tools/list: cairn.outcomes.terminal_fail registered
PASS: LD-8 wall: cairn.outcomes.list and cairn.outcomes.get NOT registered
PASS: step 1: task PENDING on create
PASS: step 2: task RUNNING after start_attempt
PASS: step 4 (boundary A): EMPTY_CRITERIA error on first submit without criteria
PASS: step 5: task.state WAITING_REVIEW after submit_for_review
PASS: step 5: outcome.status PENDING
PASS: step 5: outcome_id recorded (non-null)
PASS: step 6 (boundary B): CRITERIA_FROZEN error on conflicting criteria
PASS: step 7: evaluation result.status FAIL
PASS: step 7: task.state back to RUNNING after FAIL evaluate
PASS: step 7: outcome.status FAIL
PASS: step 7: outcome_id stable after evaluate
PASS: step 7: criteria stable after evaluate (JSON.stringify equality)
PASS: step 7: perPrimitive[0] is file_exists FAIL
PASS: step 8 (boundary C): OUTCOME_NEEDS_RESUBMIT error in FAIL state
PASS: step 10 (upsert reset): outcome.status back to PENDING
PASS: step 10 (upsert reset): outcome_id identical to step 5 (stable)
PASS: step 10 (upsert reset): criteria identical to step 5 (frozen, stable)
PASS: step 10 (upsert reset): task.state WAITING_REVIEW
PASS: step 11: evaluation result.status PASS
PASS: step 11: task.state DONE after PASS evaluate
PASS: step 11: outcome.status PASS
PASS: step 12 (boundary D): OUTCOME_ALREADY_PASSED error in PASS state
PASS: step 13c: task 2 WAITING_REVIEW after submit
PASS: step 13d: outcome.status TERMINAL_FAIL
PASS: step 13d: task.state FAILED after terminal_fail
PASS: step 13d: evaluation_summary contains terminal reason
PASS: step 14 (cross-process): A2 sees taskId1 state DONE
PASS: step 14 (cross-process): A2 sees taskId2 state FAILED

32/32 assertions PASS
```

## What's verified, what isn't (Phase 3 v1 boundary)

**Verified in this dogfood:**
- Outcomes closed loop (RUNNING→WAITING_REVIEW→FAIL→RUNNING→WAITING_REVIEW→DONE) through real MCP stdio
- LD-12: first-call EMPTY_CRITERIA guard + CRITERIA_FROZEN freeze
- Upsert-reset semantics (submit without criteria resets FAIL→PENDING, outcome_id and criteria stable)
- terminal_fail user escape hatch (WAITING_REVIEW→TERMINAL_FAIL + task→FAILED)
- OUTCOME_NEEDS_RESUBMIT and OUTCOME_ALREADY_PASSED boundary guards
- `file_exists` primitive deterministic AND aggregation (1 primitive, PASS/FAIL)
- Cross-process state durability: A2 re-spawn sees correct final states for both tasks
- LD-8 wall: `cairn.outcomes.list` and `cairn.outcomes.get` absent from tools/list

**NOT verified in Phase 3:**
- Grader agent (LD-11) — human/agent grader hook deferred to v0.2
- DSL v2 OR/NOT combinators (LD-15) — deferred to v0.2
- Automatic re-evaluation on re-submit (LD-17 variant) — current design requires explicit `evaluate` call
- `cairn.outcomes.list` / `cairn.outcomes.get` via MCP — LD-8 intentionally excludes these
- Multi-primitive AND aggregation with ≥2 primitives — unit-tested in `evaluator.test.ts`; not demoed here
- L3–L6 memory checkpoints integration — independent Phase 3 concern
