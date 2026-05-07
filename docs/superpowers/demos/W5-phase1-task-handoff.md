# W5 Phase 1 — Live Dogfood: Cross-Session Task Capsule Handoff

> **Date**: 2026-05-07
> **Plan**: [`docs/superpowers/plans/2026-05-07-w5-task-capsule.md`](../plans/2026-05-07-w5-task-capsule.md) §5.5.1
> **Script**: [`packages/mcp-server/scripts/w5-phase1-dogfood.mjs`](../../../packages/mcp-server/scripts/w5-phase1-dogfood.mjs)
> **Result**: 9/9 assertions PASS

## What this proves

Phase 1 ships a **Durable Task Capsule** primitive — a task identity that outlives the process / session / agent that created it. This dogfood verifies that property end-to-end through the **real MCP stdio protocol** (same path Claude Code uses), not through unit tests.

Two independent `mcp-server` child processes are spawned (different OS PIDs, separate stdio transports) against the same SQLite DB. A task is created in process A, modified in process A, read from process B, cancelled in process B with a reason, and re-read in process A — proving the metadata write was atomic with the state transition and the cross-process view is immediately consistent.

## How it was run

```
cd packages/mcp-server
npm run build
node scripts/w5-phase1-dogfood.mjs
```

The script uses `@modelcontextprotocol/sdk` Client + StdioClientTransport — exactly the abstractions any MCP host (Claude Code, Cursor, Cline) uses to talk to a server. No internal repo function imports, no test helpers, no mocks.

## The 6-step scenario

| # | Process | Tool call | Expected |
|---|---|---|---|
| 1 | A | `cairn.task.create({ intent })` | new PENDING task with ulid task_id |
| 2 | A | `cairn.task.start_attempt({ task_id })` | PENDING → RUNNING |
| 3 | B | `cairn.task.get({ task_id })` | sees RUNNING (cross-process read) |
| 4 | B | `cairn.task.cancel({ task_id, reason })` | RUNNING → CANCELLED + atomic metadata write |
| 5 | A | `cairn.task.get({ task_id })` | sees CANCELLED + metadata.cancel_reason + metadata.cancelled_at |
| 6 | A | `cairn.task.start_attempt({ task_id })` | structured `{ error: { code: 'INVALID_STATE_TRANSITION', ... } }` — no thrown stdio crash |

## Captured output (real run)

```
server entry: D:\lll\cairn\packages\mcp-server\dist\index.js
registered cairn.task.* tools: [
  'cairn.task.create',
  'cairn.task.get',
  'cairn.task.list',
  'cairn.task.start_attempt',
  'cairn.task.cancel'
]

── STEP 1: session A: cairn.task.create ──
{
  "task": {
    "task_id": "01KR0BV0J6V8ZMRD9K5RBAKS0Q",
    "intent": "W5 Phase 1 dogfood — cross-session task handoff demo",
    "state": "PENDING",
    "parent_task_id": null,
    "created_at": 1778128880199,
    "updated_at": 1778128880199,
    "created_by_agent_id": "cairn-6eb0e3c955f4",
    "metadata": null
  }
}

── STEP 2: session A: cairn.task.start_attempt → RUNNING ──
{
  "task": { ..., "state": "RUNNING", "updated_at": 1778128880201 }
}

── STEP 3: session B (different process): cairn.task.get → sees RUNNING ──
{
  "task": { ..., "state": "RUNNING" }
}

── STEP 4: session B: cairn.task.cancel → CANCELLED + metadata ──
{
  "task": {
    ...,
    "state": "CANCELLED",
    "updated_at": 1778128880206,
    "metadata": {
      "cancel_reason": "demo: handoff scenario complete",
      "cancelled_at": 1778128880206
    }
  }
}

── STEP 5: session A: cairn.task.get → CANCELLED + metadata.cancel_reason ──
{
  "task": {
    ...,
    "state": "CANCELLED",
    "metadata": {
      "cancel_reason": "demo: handoff scenario complete",
      "cancelled_at": 1778128880206
    }
  }
}

── STEP 6: session A: cairn.task.start_attempt on CANCELLED → INVALID_STATE_TRANSITION ──
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "from": "CANCELLED",
    "to": "RUNNING",
    "message": "Invalid task state transition: CANCELLED -> RUNNING"
  }
}

── ASSERTIONS ──
PASS: task_id round-trip
PASS: state PENDING on create
PASS: state RUNNING after start_attempt
PASS: cross-process read sees RUNNING
PASS: cancel transitions to CANCELLED
PASS: cancel_reason in metadata
PASS: cancelled_at is a number
PASS: session A re-reads CANCELLED + reason
PASS: start_attempt on CANCELLED returns structured error

ALL 9 ASSERTIONS PASS — Phase 1 cross-session task handoff verified.
```

## What's verified, what isn't

**Verified by this dogfood**:

1. **MCP stdio wiring**: 5 `cairn.task.*` tools register and respond correctly through the real stdio protocol.
2. **Cross-process state durability**: write in process A is observable from process B with no extra plumbing — the SQLite DB is the source of truth.
3. **Atomic state + metadata write on cancel**: `cancelTask` repo verb wraps state transition AND `metadata.cancel_reason` + `metadata.cancelled_at` patch in a single `db.transaction()`. Both writes succeeded together.
4. **Guard rejection is data, not exception**: `INVALID_STATE_TRANSITION` arrives as a structured error response. Stdio is not crashed; the host can present it as a UI message and continue.
5. **`updated_at` reflects every state change** (1778128880199 → ...0201 → ...0206), unique per write.

**Not yet covered (Phase 2/3 work)**:

- `BLOCKED` / `READY_TO_RESUME` transitions — `cairn.task.block` / `cairn.task.answer` are Phase 2.
- `WAITING_REVIEW` / outcomes verification — Phase 3.
- Full closed-loop story (refactor → block → cross-day handoff → outcomes verify) — Phase 4 demo.

## Note on agent_id

Both child processes report `created_by_agent_id: "cairn-6eb0e3c955f4"`. This is **expected behavior**, not a bug: `openWorkspace` derives agent_id deterministically from `sha1(host:cwd).slice(0,12)` (see `CLAUDE.md` "Phase 1-4 落地约定"). Two processes opened in the same project workspace share an agent_id by design — agent identity is **workspace-scoped**, not process-scoped. The cross-process property the dogfood proves is the **shared SQLite write log**, which is what makes a task survive any individual process exiting.

The day a true multi-agent (different cwd / different host) handoff is exercised, the agent_id values will differ — and the same DB+task model will still work, because nothing in the lifecycle actually keys on agent_id beyond the metadata `created_by` audit field.

## Reproducing

```bash
# Build the server
cd packages/mcp-server && npm run build

# Run the dogfood (must run from packages/mcp-server so SDK resolves)
node scripts/w5-phase1-dogfood.mjs
```

The script asserts 9 invariants and exits non-zero on any failure, so it's safe to wire into CI as a smoke test for the W5 lifecycle.
