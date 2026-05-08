# Cairn DB Schema Reference — desktop-shell Day 1

**Source**: live SQLite DB at `C:\Users\jushi\.cairn\cairn.db` (resolved via `path.join(os.homedir(), '.cairn', 'cairn.db')`)
**Repo commit**: `1da7f7653e33ec9cbd98c953dac8d78e50d6f820` (main)
**Migrations applied through**: `010-outcomes` (10/10)
**Captured**: 2026-05-08

---

## Key findings (TL;DR for plan reconciliation)

All three critical assumptions in the desktop-shell plan are CONFIRMED by the live DB:

| Assumption | Verdict | Evidence |
|---|---|---|
| `tasks` PK is `task_id`, NOT `id` | CONFIRMED | `task_id TEXT PRIMARY KEY` |
| `tasks` has `parent_task_id`, `state`, `intent`, `created_at`, `updated_at`, `created_by_agent_id` | CONFIRMED | all present, exactly as named |
| `tasks` does NOT have `current_attempt` | CONFIRMED | column absent (only 8 columns: task_id, intent, state, parent_task_id, created_at, updated_at, created_by_agent_id, metadata_json) |
| `blockers.raised_at` (NOT `created_at`) | CONFIRMED | columns are `raised_at` + `answered_at`; no `created_at` on blockers |

**No surprises.** No plan-side rename needed.

**Watch-outs** (not blockers, but desktop-shell code must use correct names):
- `conflicts` PK is `id` (not `conflict_id`); paths column is `paths_json` (TEXT JSON, not `paths`)
- `dispatch_requests` PK is `id` (not `request_id` or `dispatch_id`); time columns are `created_at` + `confirmed_at` (no `updated_at`, no `failed_at`)
- `processes` PK is `agent_id` (no surrogate `id`); time columns are `registered_at` + `last_heartbeat`
- `outcomes` UNIQUE on `task_id` (1:1 with task); evaluation time is `evaluated_at` (nullable until graded)
- `tasks.metadata_json` is the only blob-y column; everything else is scalar
- All timestamps are `INTEGER` epoch-ms (Unix ms). No `TEXT` ISO strings anywhere.

---

## Run Log time anchor table (UNION ALL projection)

The 5 sources for the live Run Log feed. All timestamps are INTEGER epoch-ms. Use this exact column for `ts` in `ORDER BY ts DESC`:

| Source | Table | `ts` column | Notes |
|---|---|---|---|
| Task lifecycle | `tasks` | `updated_at` | covers create / state-transition / done / fail. fall back to `created_at` only if you also want a "task created" event distinct from later updates. |
| Blocker raised / answered | `blockers` | `COALESCE(answered_at, raised_at)` | filter by `status` to know which event it is. Or emit two rows per blocker (one at `raised_at`, one at `answered_at`) if you want both. |
| Outcome evaluation | `outcomes` | `COALESCE(evaluated_at, updated_at)` | `evaluated_at` is null while PENDING; use `updated_at` as fallback. |
| Conflict events | `conflicts` | `COALESCE(resolved_at, detected_at)` | filter by `status` to label OPEN vs RESOLVED. |
| Dispatch events | `dispatch_requests` | `COALESCE(confirmed_at, created_at)` | `confirmed_at` is null while PENDING. |

`processes.last_heartbeat` is intentionally **not** in the Run Log feed (heartbeats are noisy and continuous; surface them in a "live presence" sidebar instead).

---

## Graceful empty / missing strategy

| Table | If table missing (older DB) | If empty | If query throws |
|---|---|---|---|
| `tasks` | render "No tasks yet — Cairn is set up but no work has been started." | render skeleton, no error | log + render empty |
| `blockers` | hide blocker pill entirely | hide blocker pill | hide blocker pill |
| `outcomes` | hide outcome chip on task rows | hide outcome chip | hide outcome chip |
| `processes` | render "No agents registered." | render "0 agents online" | render "agent presence unavailable" |
| `conflicts` | hide conflicts panel | render "No conflicts." | hide conflicts panel |
| `dispatch_requests` | hide dispatch lane | render "No dispatch requests." | hide dispatch lane |

Detection: at panel boot, run `SELECT name FROM sqlite_master WHERE type='table' AND name IN (...)` once and cache the set. All later queries gate on table presence to avoid `no such table` SQLite errors. Catch `SqliteError` per-query so one bad table never breaks the whole panel.

If `~/.cairn/cairn.db` itself is missing → render onboarding card "Cairn DB not found at `~/.cairn/cairn.db` — run `cairn install` and start an MCP session to initialize it."

---

## Per-table schema

### 1. `tasks` (rowcount: 12)

| col | type | null | default | pk |
|---|---|---|---|---|
| task_id | TEXT | NO | — | 1 |
| intent | TEXT | NO | — | — |
| state | TEXT | NO | — | — |
| parent_task_id | TEXT | YES | — | — |
| created_at | INTEGER | NO | — | — |
| updated_at | INTEGER | NO | — | — |
| created_by_agent_id | TEXT | YES | — | — |
| metadata_json | TEXT | YES | — | — |

**FK**: `parent_task_id REFERENCES tasks(task_id) ON DELETE SET NULL`
**CHECK**: `state IN ('PENDING','RUNNING','BLOCKED','READY_TO_RESUME','WAITING_REVIEW','DONE','FAILED','CANCELLED')` — 8 states
**Indexes**: `idx_tasks_state`, `idx_tasks_parent`, `idx_tasks_created_at`

**Quick Slice usage**:
- Task list: `SELECT … FROM tasks ORDER BY updated_at DESC LIMIT 50`
- Run Log feed: project `(task_id, state, updated_at AS ts, 'task' AS kind)`
- Tree: `parent_task_id` is nullable; root tasks have `parent_task_id IS NULL`
- Active set: `WHERE state IN ('PENDING','RUNNING','BLOCKED','READY_TO_RESUME','WAITING_REVIEW')`

### 2. `blockers` (rowcount: 3)

| col | type | null | default | pk |
|---|---|---|---|---|
| blocker_id | TEXT | NO | — | 1 |
| task_id | TEXT | NO | — | — |
| question | TEXT | NO | — | — |
| context_keys | TEXT | YES | — | — |
| status | TEXT | NO | — | — |
| raised_by | TEXT | YES | — | — |
| raised_at | INTEGER | NO | — | — |
| answer | TEXT | YES | — | — |
| answered_by | TEXT | YES | — | — |
| answered_at | INTEGER | YES | — | — |
| metadata_json | TEXT | YES | — | — |

**FK**: `task_id REFERENCES tasks(task_id) ON DELETE CASCADE`
**CHECK**: `status IN ('OPEN','ANSWERED','SUPERSEDED')`
**Indexes**: `idx_blockers_task`, `idx_blockers_status`

**Quick Slice usage**:
- Blocker pill on task row: `SELECT 1 FROM blockers WHERE task_id=? AND status='OPEN' LIMIT 1`
- Run Log: `(task_id, raised_at AS ts, 'blocker_raised')` and `(task_id, answered_at AS ts, 'blocker_answered')` for ANSWERED rows
- `context_keys` is JSON array of scratchpad keys (TEXT, not arr) — parse before use

### 3. `outcomes` (rowcount: 8)

| col | type | null | default | pk |
|---|---|---|---|---|
| outcome_id | TEXT | NO | — | 1 |
| task_id | TEXT | NO | — | — |
| criteria_json | TEXT | NO | — | — |
| status | TEXT | NO | — | — |
| evaluated_at | INTEGER | YES | — | — |
| evaluation_summary | TEXT | YES | — | — |
| grader_agent_id | TEXT | YES | — | — |
| created_at | INTEGER | NO | — | — |
| updated_at | INTEGER | NO | — | — |
| metadata_json | TEXT | YES | — | — |

**FK**: `task_id REFERENCES tasks(task_id) ON DELETE CASCADE`
**UNIQUE**: `task_id` (1:1 — at most one outcome per task)
**CHECK**: `status IN ('PENDING','PASS','FAIL','TERMINAL_FAIL')`
**Indexes**: `idx_outcomes_status`, `sqlite_autoindex_outcomes_2` (the unique index)

**Quick Slice usage**:
- Outcome chip on task row: `LEFT JOIN outcomes o ON o.task_id=t.task_id` — render `o.status` as colored chip (PASS green, FAIL red, TERMINAL_FAIL dark red, PENDING gray)
- Run Log: `(task_id, COALESCE(evaluated_at, updated_at) AS ts, 'outcome_'||status)` — only emit row when `evaluated_at IS NOT NULL` to avoid noise from PENDING-stage upserts
- `criteria_json` is JSON DSL stack — do not render raw in the panel; show `evaluation_summary` instead

### 4. `processes` (rowcount: 0)

| col | type | null | default | pk |
|---|---|---|---|---|
| agent_id | TEXT | NO | — | 1 |
| agent_type | TEXT | NO | — | — |
| capabilities | TEXT | YES | — | — |
| status | TEXT | NO | — | — |
| registered_at | INTEGER | NO | — | — |
| last_heartbeat | INTEGER | NO | — | — |
| heartbeat_ttl | INTEGER | NO | 60000 | — |

**CHECK**: `status IN ('ACTIVE','IDLE','DEAD')`
**Indexes**: `idx_processes_status`
**No `cwd` column** (plan should not assume one exists)

**Quick Slice usage**:
- Live presence: `SELECT * FROM processes WHERE status != 'DEAD' ORDER BY last_heartbeat DESC`
- Stale detection: client-side, compare `now - last_heartbeat` vs `heartbeat_ttl`; render "stale" badge when exceeded even if `status='ACTIVE'` (DB-side staleness sweeper may not have run)
- `capabilities` is JSON array — parse before rendering chips

### 5. `conflicts` (rowcount: 0)

| col | type | null | default | pk |
|---|---|---|---|---|
| id | TEXT | NO | — | 1 |
| detected_at | INTEGER | NO | — | — |
| conflict_type | TEXT | NO | — | — |
| agent_a | TEXT | NO | — | — |
| agent_b | TEXT | YES | — | — |
| paths_json | TEXT | NO | — | — |
| summary | TEXT | YES | — | — |
| status | TEXT | NO | — | — |
| resolved_at | INTEGER | YES | — | — |
| resolution | TEXT | YES | — | — |

**CHECK**: `conflict_type IN ('FILE_OVERLAP','STATE_CONFLICT','INTENT_BOUNDARY')`
**CHECK**: `status IN ('OPEN','RESOLVED','IGNORED','PENDING_REVIEW')`
**Indexes**: `idx_conflicts_detected_at`, `idx_conflicts_status`

**Quick Slice usage**:
- Conflicts panel: `SELECT * FROM conflicts WHERE status IN ('OPEN','PENDING_REVIEW') ORDER BY detected_at DESC`
- Run Log: `(NULL AS task_id, COALESCE(resolved_at, detected_at) AS ts, 'conflict_'||status)`
- `paths_json` is JSON array of file paths — parse + render as bullet list

### 6. `dispatch_requests` (rowcount: 0)

| col | type | null | default | pk |
|---|---|---|---|---|
| id | TEXT | NO | — | 1 |
| nl_intent | TEXT | NO | — | — |
| parsed_intent | TEXT | YES | — | — |
| context_keys | TEXT | YES | — | — |
| generated_prompt | TEXT | YES | — | — |
| target_agent | TEXT | YES | — | — |
| status | TEXT | NO | — | — |
| created_at | INTEGER | NO | — | — |
| confirmed_at | INTEGER | YES | — | — |
| task_id | TEXT | YES | — | — |

**FK** (added by migration 008): `task_id REFERENCES tasks(task_id) ON DELETE SET NULL`
**CHECK**: `status IN ('PENDING','CONFIRMED','REJECTED','FAILED')`
**Indexes**: `idx_dispatch_requests_status`, `idx_dispatch_requests_created_at`, `idx_dispatch_requests_task_id`

**No `failed_at` / `rejected_at` column.** All terminal-state timestamps collapse into `confirmed_at` if you want one — but in practice REJECTED/FAILED rows leave `confirmed_at NULL`. To find "when did this hit terminal state", you only have `created_at`. Acceptable for v0.1; flag if Run Log needs richer ordering.

**Quick Slice usage**:
- Dispatch lane: `SELECT * FROM dispatch_requests ORDER BY created_at DESC LIMIT 20`
- Link to task: `LEFT JOIN tasks ON tasks.task_id = dispatch_requests.task_id`
- Run Log: `(task_id, COALESCE(confirmed_at, created_at) AS ts, 'dispatch_'||status)`

---

## Non-target tables (present but out of scope for Day 1 panel)

`schema_migrations`, `scratchpad`, `checkpoints`, `compensations`, `lanes`, `ops` — present in the live DB but not on the desktop-shell Day 1 surface. Listed here so future iterations don't re-discover them.
