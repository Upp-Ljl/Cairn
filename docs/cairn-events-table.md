# cairn_events memo (deferred)

**Status:** not implemented. This is a forward-looking note, not a plan.
Day 5 explicitly held the table back so we ship task chains + checkpoints
first. The panel currently fakes an "events feed" by `UNION ALL`-projecting
6 source tables in `queries.cjs::queryRunLogEvents`. That works, but
several real needs are pushing toward a dedicated table.

## Why we'll eventually want it

The current Run Log derives events on every poll by re-reading the 6
source tables and projecting them into a uniform shape. Three pain
points are accumulating:

1. **Poll cost grows with row count.** Every 1s tick re-runs 6 ordered
   `SELECT … LIMIT 200` queries. Today the DB has tens of rows; once
   real users accumulate thousands, this will be wasteful — the panel
   only ever cares about the last ~200 events, not the last 200
   per-source.
2. **No event identity.** A blocker raised + answered yields two synthetic
   rows in the projection, but they share `target=blocker_id`. We can't
   give the user "mark as read" / "ack" semantics without a stable
   `event_id` per emission.
3. **No project attribution at the source.** The Run Log is currently
   DB-wide. To make it project-aware we either re-join through tasks /
   processes on every poll (slow), or we record `agent_id` on the event
   row at emit time and filter cheaply. The latter is what `cairn_events`
   would unlock.

Day 5's `checkpoint.*` events are the smallest concrete data point: they
slot into the existing UNION today, but are also the strongest argument
that the projection-style feed doesn't scale — we've now added a 6th
source for ~30 lines of code, with no story for project-scoping.

## Proposed schema (sketch)

```
CREATE TABLE cairn_events (
  event_id    TEXT PRIMARY KEY,                -- ulid / uuid
  ts          INTEGER NOT NULL,                -- unix ms
  source      TEXT NOT NULL,                   -- tasks|blockers|outcomes|conflicts|dispatch|checkpoints|presence
  type        TEXT NOT NULL,                   -- e.g. task.failed, blocker.opened
  severity    TEXT NOT NULL CHECK (severity IN ('info','warn','error')),
  agent_id    TEXT,                            -- emitter (NULL for system)
  task_id     TEXT,                            -- COALESCE attribution
  target_id   TEXT,                            -- originating row pk (e.g. blocker_id, conflict id)
  message     TEXT,                            -- short human-readable, truncate to ~256
  metadata_json TEXT                           -- structured extras; never required
);
CREATE INDEX idx_events_ts             ON cairn_events(ts DESC);
CREATE INDEX idx_events_agent_ts       ON cairn_events(agent_id, ts DESC);
CREATE INDEX idx_events_task_ts        ON cairn_events(task_id, ts DESC);
```

`agent_id` is the join hook for project-scoped feeds (panel filters
`agent_id IN hints`). `target_id` keeps the projection's existing
foreign-key shape so panels can deep-link.

## Which mutations should emit

This is the boundary between mcp-server / daemon repos and the events
table. Every state-changing repo function emits one row at commit time.

| Repo function (current)              | Event type            |
|--------------------------------------|-----------------------|
| `tasks.create`                       | `task.created`        |
| `tasks.transition` (any state)       | `task.<lower-state>`  |
| `blockers.raise`                     | `blocker.opened`      |
| `blockers.answer`                    | `blocker.answered`    |
| `outcomes.submitForReview`           | `outcome.pending`     |
| `outcomes.recordEvaluationResult`    | `outcome.<lower-status>` |
| `outcomes.markTerminalFail`          | `outcome.terminal_fail` |
| `conflicts.detect` / `record`        | `conflict.detected`   |
| `conflicts.resolve` / `markPending`  | `conflict.<status>`   |
| `dispatch.request`                   | `dispatch.pending`    |
| `dispatch.confirm` / fail / reject   | `dispatch.<status>`   |
| `checkpoints.create` / `markReady`   | `checkpoint.<status>` |
| `processes.register` / `markDead`    | `presence.registered`/`presence.dead` |

Heartbeats (`processes.heartbeat`) **MUST NOT** emit — they would
swamp the table at 30s × N agents. Surface them in Sessions, not
events.

## How the panel consumes it

```js
// project-scoped feed (replaces current queryRunLogEvents):
SELECT event_id, ts, source, type, severity, agent_id, task_id, target_id, message
  FROM cairn_events
 WHERE agent_id IN (?, ?, ?)
    OR task_id IN (SELECT task_id FROM tasks WHERE created_by_agent_id IN (?, ?, ?))
 ORDER BY ts DESC
 LIMIT 200;

// global feed (current behavior, kept for legacy Inspector):
SELECT … FROM cairn_events ORDER BY ts DESC LIMIT 200;
```

Both reads are a single index hit on `idx_events_ts` (or the agent/task
composite). Panel poll cost drops from 6 ordered scans to 1.

## What this memo deliberately does NOT specify

- **Real event bus / pub-sub.** This is just a table. Subscribers poll.
- **Cross-machine sync.** Out of scope — Cairn is single-host.
- **Replay.** Rebuilding state from the event log is a v0.4+ topic.
- **Retention.** Cap at ~100k rows or 30 days; a sweeper job is later.
- **Schema migration.** Day 5+ when we actually implement; will be
  migration `011-cairn-events`.

When this lands it will replace the projection in `queryRunLogEvents`
(and the Day 5 checkpoint addition gets folded back into the emit
sites) but the panel-side renderer and event shape stay the same.
That's the whole point of using this projection-first approach now.
