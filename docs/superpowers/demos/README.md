# Cairn — Live Dogfood Demo Index

> Each demo here is a real MCP-stdio cross-process exercise, not a unit test. Each one spawns the actual `dist/index.js` MCP server (one or more times), invokes tools as a real `@modelcontextprotocol/sdk` client would, and asserts on the JSON responses. They prove that the shipped MCP protocol surface — not just the underlying daemon repo — actually behaves as documented.

Reproduce any of them after a fresh build:

```bash
cd packages/mcp-server
npm run build
node scripts/<demo-script>.mjs
```

---

## W5 Phase 1 — Task Capsule lifeline

**Doc:** [`W5-phase1-task-handoff.md`](./W5-phase1-task-handoff.md)
**Script:** `packages/mcp-server/scripts/w5-phase1-dogfood.mjs`

What it proves:

- A `task_id` survives process death. Session A1 creates a task and cancels it with a reason; the cancel_reason is set atomically with the state transition (single SQLite transaction). Session A2, spawned as a new Node process with a different PID, reads the same task and sees `state=CANCELLED` + the reason intact in metadata.
- The 5 task tools (`cairn.task.create / get / list / start_attempt / cancel`) are registered through the real MCP `tools/list` and behave per spec.
- LD-8 wall: there is no `cairn.task.update_state` MCP tool — verbs only.

---

## W5 Phase 2 — BLOCKED-loop closed-loop handoff

**Doc:** [`W5-phase2-task-handoff.md`](./W5-phase2-task-handoff.md)
**Script:** `packages/mcp-server/scripts/w5-phase2-dogfood.mjs`

What it proves:

- A real cross-session BLOCKED → ANSWERED → RESUMED loop, end to end, with three Node processes:
  1. A1 creates a task, starts it, blocks on a question, then closes its MCP client (genuine "session A leaves" — not just a function return).
  2. B (different process) reads `cairn.task.resume_packet`, gets the open blocker; calls `cairn.task.answer`; the task moves to READY_TO_RESUME (LD-7 multi-blocker counting verified by 0 remaining open). B starts the attempt, finishes, cancels with a different reason; closes.
  3. A2, re-spawned again, calls `cairn.task.get` and sees the cancel_reason that B wrote — proving cross-process atomic write durability through SQLite WAL.
- `resume_packet` is a read-only aggregate that includes `outcomes_criteria` (empty array in Phase 2; populated in Phase 3 once outcomes are submitted).
- LD-8 still holds: `list_blockers` / `get_blocker` are not registered MCP tools.

---

## W5 Phase 3 — Outcomes DSL closed-loop verification

**Doc:** [`W5-phase3-task-handoff.md`](./W5-phase3-task-handoff.md)
**Script:** `packages/mcp-server/scripts/w5-phase3-dogfood.mjs`
**Result:** 32-of-32 assertions PASS.

What it proves:

- The full `RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED` loop through real MCP stdio across 3 sessions (A1 → B → A2). The criteria starts FAIL, the test agent fixes the fixture, calls `submit_for_review` again with no criteria (upsert reset), the outcome PENDING is restored with `outcome_id` and `criteria_json` literally stable, and the next `evaluate` returns PASS → task DONE.
- LD-12 boundary cases: first-call without criteria → `EMPTY_CRITERIA`; repeat-call with conflicting criteria → `CRITERIA_FROZEN`.
- LD-17 evaluate boundaries: `OUTCOME_NEEDS_RESUBMIT` from FAIL state, `OUTCOME_ALREADY_PASSED` from PASS state.
- Terminal_fail escape hatch on a second task → outcome.TERMINAL_FAIL + task.FAILED + reason captured in evaluation_summary.
- LD-8 wall: `cairn.outcomes.list` / `cairn.outcomes.get` are not in `tools/list`.
- Cross-process verification: A2 (re-spawned, new PID) reads both tasks and sees `task1=DONE` + `task2=FAILED` — SQLite WAL atomic write durability across processes.
- Fixture isolation: each run uses a `mkdtempSync` tmp dir as `ws.cwd`, so `file_exists` paths resolve against an isolated scratch directory; cleanup happens at the end via `rmSync({ recursive: true, force: true })`. The user's real `~/.cairn/cairn.db` is untouched.

---

## What these demos do not cover

- L3+ checkpoint granularity (agent conversation history / tool call traces / agent internal state / subagent tree). v0.2 work.
- LLM grader (`GraderHook` reserved in `dsl/types.ts` but ignored by the v1 evaluator). The Phase 3 demo asserts the hook is not called when a bogus one is passed in, but does not exercise an actual grader implementation.
- Non-MCP-aware tool integration (Cursor / Cline without `.mcp.json`). v0.2+ wrapper / sidecar path.
- Cross-machine sync. v0.3+ explicit non-goal.
- POSIX spawn / kill-tree path. The Phase 3 spawn experiment (gate before the production `spawn-utils.ts` was written) ran on Windows only this dev cycle. The POSIX branch is in the source but not exercised by these demos.

For the full v0.1 limitations list see [`RELEASE_NOTES.md`](../../../RELEASE_NOTES.md) "Current limitations".
