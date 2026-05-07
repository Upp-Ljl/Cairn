# W5 Phase 2 — Live Dogfood: BLOCKED-loop Cross-Session Handoff

> **Date**: 2026-05-07
> **Plan**: [`docs/superpowers/plans/2026-05-14-w5-phase2-blockers-resume.md`](../plans/2026-05-14-w5-phase2-blockers-resume.md) §5.4
> **Script**: [`packages/mcp-server/scripts/w5-phase2-dogfood.mjs`](../../../packages/mcp-server/scripts/w5-phase2-dogfood.mjs)
> **Result**: 30/30 assertions PASS

## What this proves

Phase 1 dogfood proved a Task Capsule's identity survives a process exit. **Phase 2 dogfood proves the task can be paused and resumed by a different agent in a different process** — the actual product property the W5 pitch hinges on.

The script runs **three** child `mcp-server` processes (different OS PIDs) against the same SQLite DB, in this order:

1. **A1** opens, creates the task, starts an attempt, raises a blocker, **exits**.
2. **B** opens (separate process), reads the resume packet, sees the open blocker, answers it, observes task → READY_TO_RESUME, calls `start_attempt` to resume → RUNNING, then cancels with a reason. **Exits**.
3. **A2** (re-spawned) opens, calls `cairn.task.get` → sees CANCELLED + the cancel reason that B wrote.

This exercises, end-to-end through real MCP stdio JSON-RPC:

- `cairn.task.block` (RUNNING → BLOCKED) and the atomic state+blocker write
- `cairn.task.answer` and the LD-7 multi-blocker counting (here a 1-blocker case; multi-blocker is unit-tested — see "What's not in this dogfood" below)
- `cairn.task.resume_packet` as a structured artifact for cross-session handoff
- `cairn.task.start_attempt` from `READY_TO_RESUME` (the resume transition activated by Phase 2)
- Phase 1's `cancel` still atomically writing reason+timestamp to metadata in a Phase 2 world
- LD-5 packet schema validation at two different states (BLOCKED, READY_TO_RESUME)
- LD-8 wall (no `list_blockers` / `get_blocker` MCP tools)
- Phase 3 transitions still **inactive** (no `submit_for_review` / `outcomes.evaluate` registered)

## How it was run

```
cd packages/mcp-server
npm run build
node scripts/w5-phase2-dogfood.mjs
```

The script uses `@modelcontextprotocol/sdk` Client + `StdioClientTransport` — exactly the abstractions Claude Code, Cursor, etc. use to talk to a server.

## The 11-step scenario

| # | Process | Tool call | Expected |
|---|---|---|---|
| 1 | A1 | `cairn.task.create({ intent })` | new PENDING task with ulid task_id |
| 2 | A1 | `cairn.task.start_attempt({ task_id })` | PENDING → RUNNING |
| 3 | A1 | `cairn.task.block({ task_id, question, context_keys })` | RUNNING → BLOCKED, blocker.status='OPEN' |
| 4 | A1 | (process exit) | session A is gone |
| 5 | B  | `cairn.task.resume_packet({ task_id })` | packet.current_state='BLOCKED', open_blockers length=1 |
| 6 | B  | `cairn.task.answer({ blocker_id, answer })` | blocker.ANSWERED, task.READY_TO_RESUME (LD-7: 0 OPEN remaining) |
| 7 | B  | `cairn.task.resume_packet({ task_id })` | packet.current_state='READY_TO_RESUME', 0 open / 1 answered |
| 8 | B  | `cairn.task.start_attempt({ task_id })` | READY_TO_RESUME → RUNNING (genuine resume!) |
| 9 | B  | `cairn.task.cancel({ task_id, reason })` | CANCELLED + atomic metadata.cancel_reason / cancelled_at |
| 10 | B | (process exit) | session B is gone |
| 11 | A2 | `cairn.task.get({ task_id })` | CANCELLED + reason — cross-process write durability |

## Captured output (real run)

```
server entry: D:\lll\cairn\packages\mcp-server\dist\index.js
registered cairn.task.* tools: [
  'cairn.task.answer',
  'cairn.task.block',
  'cairn.task.cancel',
  'cairn.task.create',
  'cairn.task.get',
  'cairn.task.list',
  'cairn.task.resume_packet',
  'cairn.task.start_attempt'
]

── STEP 3: A1: cairn.task.block → BLOCKED + blocker.OPEN ──
{
  "blocker": {
    "blocker_id": "01KR0H6SDR...",
    "task_id": "01KR0H6SDJJHJDCKZ104DTRCER",
    "question": "保留旧 sync API 吗？",
    "context_keys": ["scratchpad/T-001/old-api-survey"],
    "status": "OPEN",
    "raised_by": "cairn-6eb0e3c955f4",
    "raised_at": 1778134509285,
    "answer": null,
    "answered_by": null,
    "answered_at": null,
    "metadata": null
  },
  "task": { ..., "state": "BLOCKED", "updated_at": 1778134509285 }
}

── STEP 4: A1 closed (process A1 has exited) ──

── STEP 5: B (different process): cairn.task.resume_packet → BLOCKED + 1 open_blocker ──
{
  "packet": {
    "task_id": "01KR0H6SDJJHJDCKZ104DTRCER",
    "intent": "W5 Phase 2 dogfood — BLOCKED-loop closed-loop handoff",
    "current_state": "BLOCKED",
    "last_checkpoint_sha": null,
    "open_blockers": [{
      "blocker_id": "01KR0H6SDR...",
      "question": "保留旧 sync API 吗？",
      "context_keys": ["scratchpad/T-001/old-api-survey"],
      "raised_at": 1778134509285
    }],
    "answered_blockers": [],
    "scratchpad_keys": [],
    "outcomes_criteria": [],
    "audit_trail_summary": "## Task ...\n..."
  }
}

── STEP 6: B: cairn.task.answer → blocker.ANSWERED + task.READY_TO_RESUME ──
{
  "blocker": {
    ...
    "status": "ANSWERED",
    "answer": "保留，加 deprecation 注释",
    "answered_by": "cairn-6eb0e3c955f4",
    "answered_at": 1778134509289
  },
  "task": { ..., "state": "READY_TO_RESUME" }
}

── STEP 8: B: cairn.task.start_attempt → RUNNING (genuine resume from READY_TO_RESUME) ──
{ "task": { ..., "state": "RUNNING" } }

── STEP 9: B: cairn.task.cancel → CANCELLED + cancel_reason atomically in metadata ──
{
  "task": {
    ...,
    "state": "CANCELLED",
    "metadata": {
      "cancel_reason": "demo: phase 2 closed loop verified",
      "cancelled_at": 1778134509292
    }
  }
}

── STEP 11: A2 (re-spawned, new PID): cairn.task.get → CANCELLED + cancel_reason ──
{
  "task": {
    ...,
    "state": "CANCELLED",
    "metadata": {
      "cancel_reason": "demo: phase 2 closed loop verified",
      "cancelled_at": 1778134509292
    }
  }
}

── ASSERTIONS ──
PASS: tools/list exposes the 8 cairn.task.* verbs (5 Phase 1 + 3 Phase 2)
PASS: LD-8: list_blockers / get_blocker NOT registered
PASS: Phase 3 transitions still inactive: submit_for_review / outcomes.evaluate NOT registered
PASS: step 1-3 ... (transition + blocker shape assertions)
PASS: step 5: resume_packet schema valid + content matches
PASS: step 6: blocker ANSWERED + task READY_TO_RESUME (LD-7: 0 OPEN remaining)
PASS: step 7: resume_packet schema valid + content matches new state
PASS: step 8: task.state RUNNING (resume succeeded)
PASS: step 9: task.state CANCELLED + cancel_reason in metadata
PASS: step 11: A2 sees CANCELLED + reason (cross-process atomic write durability)

30/30 assertions PASS

Phase 2 BLOCKED-loop closed-loop handoff verified through real MCP stdio.
```

## What's verified, what isn't

**Verified by this dogfood**:

1. **End-to-end MCP wiring of the BLOCKED loop** through real stdio JSON-RPC, not mocks or in-process imports.
2. **Cross-session resume**: A1 raises a blocker and exits; B (a different process) reads the resume packet, answers, and resumes the task. This is the actual product story.
3. **Cross-process state durability**: a write made by B is visible to a freshly-spawned A2 with no coordination outside the SQLite DB.
4. **Atomic state + metadata writes** survive intact in Phase 2: `cancel` still atomically writes state=CANCELLED and metadata.cancel_reason/cancelled_at in a single transaction (this is Phase 1's `cancelTask` verb working unchanged after Phase 2 added blockers).
5. **Resume packet schema** (LD-5) holds at two distinct states (BLOCKED and READY_TO_RESUME) — content shape passes the validator.
6. **LD-8 wall**: `cairn.task.list_blockers` / `cairn.task.get_blocker` are not registered as MCP tools — all blocker access must go through `resume_packet` aggregation.
7. **Phase 3 boundary**: `cairn.task.submit_for_review` / `cairn.outcomes.evaluate` are NOT registered (verified via `tools/list`). Phase 3 work hasn't leaked into Phase 2.

**Not in this dogfood (covered elsewhere)**:

- **Multi-blocker counting (LD-7)**: this is fully covered by Day 2 unit tests (`packages/daemon/tests/storage/blockers.test.ts` — `markAnswered` 2-of-2 case) and Day 3 acceptance tests (`packages/mcp-server/tests/tools/task.test.ts` — `cairn.task.answer` 1-of-2 vs 2-of-2 cases). Reproducing it via pure MCP would need either a new tool (out of scope) or DB writes that bypass the `recordBlocker` RUNNING-only guard (mixes MCP and non-MCP code paths). The unit + acceptance coverage is sufficient evidence; the dogfood demonstrates the single-blocker branch.
- **Atomicity rollback** of `recordBlocker` and `markAnswered`: covered by deterministic-trigger tests in `blockers.test.ts` (NOT NULL violation + raw-SQL state inconsistency). Rolling back inside a stdio call doesn't add new evidence.
- **`BLOCKED → CANCELLED` transition** (cancel directly from a blocked task): covered by `tasks.test.ts` and `task.test.ts` integration cases. The dogfood goes through `READY_TO_RESUME → RUNNING → CANCELLED` instead, which is the more interesting handoff path.

## Note on agent_id

Both child processes report `created_by_agent_id`/`raised_by`/`answered_by` as the same `cairn-6eb0e3c955f4` because `openWorkspace` derives the agent_id deterministically from `sha1(host:cwd).slice(0,12)` (per `CLAUDE.md`). Same workspace = same agent_id. Cross-process state-sharing is what the dogfood exercises; cross-host / cross-cwd handoff would naturally produce different agent_ids and is outside this script's scope.

## Reproducing

```bash
# Build the server (only needed once after each Phase 2 source change)
cd packages/mcp-server && npm run build

# Run the dogfood (must run from packages/mcp-server so SDK resolves)
node scripts/w5-phase2-dogfood.mjs
```

The script asserts 30 invariants and exits non-zero on any failure, so it's safe to wire into CI as a smoke test for the W5 BLOCKED loop.

## Observed gotcha

During development, `dist/resume-packet.js` got out of sync with the source after a code-fix iteration where `npm run build` wasn't re-run. The dogfood failed at step 5 with `no such column: request_id` because the stale dist was running an earlier (buggy) version of the audit-trail SQL. Lesson: any Phase 2 source change requires `npm run build` before the dogfood will see it. The script could be hardened to run the build itself; left for a future polish.
