# Cairn AUTOMATION — unattended pipeline overview

> **Cairn is a fire-and-forget pipeline for agentic software work.** A grilled idea flows from `cairn.task.create` to `DONE` (or terminal `FAILED`) **without depending on a human in the middle**.
>
> The states that look like HITL gates are escalation paths, not blocking gates. The desktop side panel is **read-only observability** over the pipeline, not a step the pipeline waits on.
>
> This is the top-level pointer. Canonical walkthrough lives at [`docs/unattended-pipeline.md`](docs/unattended-pipeline.md).

---

## What "no HITL in the middle" means concretely

A human-in-the-loop step is one where the pipeline **cannot proceed** until a person acts. Cairn has **zero** such steps. It has states that record "a question / a verdict / a conflict needs an answer", but the answer can come from:

- another agent
- a scheduled retry
- a deterministic resolver
- a fallback policy
- a human (optional)

The MCP tool surface treats all of these identically. The state machine (`VALID_TRANSITIONS` in `packages/daemon/src/storage/tasks-state.ts`) is the contract.

---

## The "stuck in the middle" states — and how each auto-resolves

| State | What looks like HITL | Auto-resolution path |
|---|---|---|
| `BLOCKED` (task) | Agent raised `cairn.task.block(question)` | Any caller calls `cairn.task.answer(blocker_id, answer)`. Task → `READY_TO_RESUME → RUNNING`. `resume_packet` provides full context for cold pickup. |
| `WAITING_REVIEW` (outcome) | Agent submitted DSL criteria | `cairn.outcomes.evaluate(outcome_id)` runs every primitive **deterministically and synchronously, no LLM judge**. PASS → `DONE`. FAIL → `RUNNING` with **frozen criteria**. |
| Dispatch `PENDING` | NL intent waiting for confirm | 5 fallback rules R1/R2/R3/R4/R6 pre-compute target + prompt. `cairn.dispatch.confirm` is a tool call — auto-confirmable for non-irreversible intents. R1 (destructive) routes through `rewind.preview`, a deterministic dry-run, not a human gate. |
| Conflict `PENDING_REVIEW` | Two agents wrote overlapping paths | **Recorded, not blocking.** Resolver agent reads `cairn.conflict.list` and calls `cairn.conflict.resolve` asynchronously. The pipeline keeps moving. |

---

## Self-healing primitives

- **Durable Task Capsules** survive process death — context lives in `tasks` + `blockers` + `scratchpad`, not in any agent's context window
- **Migration registry with checksum guard** — 10 idempotent migrations apply on every daemon start
- **Rule-first dispatch with LLM degradation** — 5 fallback rules pre-empt LLM for keyword cases; LLM call has 3× exponential backoff, then graceful degradation to rule-derived prompt
- **Deterministic outcome evaluator** — 7 bounded primitives (`tests_pass`, `command_exits_0`, `file_exists`, `regex_matches`, `scratchpad_key_exists`, `no_open_conflicts`, `checkpoint_created_after`), sync AND-aggregation, no network in v1
- **Frozen criteria across retries** — `outcome_id` stays stable so the agent retries against the same bar
- **Idempotent `cairn install`** — re-running has no side effects on already-correct state
- **Mandatory `rewind.preview` before destructive rewinds** (R1) with `paths` parameter to bound blast radius
- **Pre-commit hook records, does not block** — conflicts go into the table, commits proceed, resolver acts async
- **Scratchpad message reachability** — subagent results survive context-window compression; main agent retrieves byte-for-byte via `cairn.scratchpad.read`

---

## What genuinely cannot auto-recover (and isn't HITL either)

These are explicit terminal outcomes with recorded reasons — not "indefinitely waiting on a human":

- `cairn.outcomes.terminal_fail(reason)` — agent's own give-up signal
- `cairn.task.cancel` — caller-initiated terminate
- Misspecified DSL criteria — grilling-stage problem; runtime retries can't auto-correct intent
- Broken underlying tooling (test runner crashed, disk full) — primitive returns deterministic FAIL with reason
- Migration checksum mismatch — fail-loud refusal to start, not silent corruption

---

## Mapping to standard unattended-pipeline patterns

| Pattern | Cairn's analog |
|---|---|
| Durable work queue | `tasks` table + `VALID_TRANSITIONS` state machine |
| Idempotent re-entry | Migration checksum guard + `cairn install` idempotency + `submit_for_review` re-call with frozen `outcome_id` |
| Deterministic evaluator (no LLM judge) | DSL outcomes evaluator — 7 primitives, AND-aggregated, sync |
| Rule-first / LLM-fallback routing | Dispatch fallback rules R1/R2/R3/R4/R6 ahead of LLM; LLM has 3× exponential backoff |
| Recorded-but-non-blocking conflict | Pre-commit hook + MCP-boundary writes to `conflicts` table; commits are not blocked |
| Context recovery on process death | `cairn.task.resume_packet(task_id)` aggregates blockers + scratchpad + criteria |
| Detached/async work | Agent process can exit on `BLOCKED`; another process resumes via `resume_packet` |
| Bounded retry / terminal give-up | Outcomes retry loop with frozen criteria + `terminal_fail` as explicit give-up |
| Read-only observability surface | desktop-shell side panel reads SQLite, never mutates state |

---

## Canonical pointer

Full walkthrough, ASCII flow diagram, and code references: [`docs/unattended-pipeline.md`](docs/unattended-pipeline.md).
