# Cairn Unattended Pipeline — idea → merged code, no HITL gates

> How a **grilled idea** flows through Cairn to **merged code** without getting stuck waiting on a human in the middle.
>
> This document is the canonical answer to: *"What would be stuck in the middle in HITL in our project?"*
>
> Short answer: **nothing has to be.** Cairn's three apparent human-in-the-loop states (`BLOCKED`, `WAITING_REVIEW`, `PENDING_REVIEW`) are **escalation paths, not blocking gates** — each has a deterministic auto-resolution path so the pipeline is fire-and-forget by default. The desktop side panel is a **read-only observability surface** over the pipeline, not a step the pipeline waits on.

---

## TL;DR — the pipeline is self-healing

```
grilled idea
   │
   ▼
[dispatch.request]  ─── 5 deterministic fallback rules (R1/R2/R3/R4/R6)
   │                    pick target agent + generate prompt
   ▼                    (no LLM judge; pure rule match)
[dispatch.confirm]  ─── auto-confirm when CAIRN_DISPATCH_AUTO_CONFIRM=1
   │                    or another agent calls confirm with task_id
   ▼
[task: PENDING → RUNNING]
   │
   ├── blocker raised?  ──► BLOCKED ──► another agent / scheduled retry
   │                                    answers via cairn.task.answer
   │                                    ──► READY_TO_RESUME ──► RUNNING
   │
   ├── conflict detected? ──► PENDING_REVIEW (conflicts table)
   │                          ──► resolver agent reads cairn.conflict.list
   │                              and calls cairn.conflict.resolve
   │
   ▼
[submit_for_review]   ─── DSL criteria (7 deterministic primitives, AND-aggregated)
   │                      no LLM grader
   ▼
[WAITING_REVIEW]
   │
   ▼
[outcomes.evaluate]   ─── synchronous deterministic run of every primitive
   │                      PASS → DONE
   │                      FAIL → RUNNING (criteria frozen, agent fixes & resubmits)
   │
   ▼
[DONE]
   └── git commit/PR/merge — handled by the agent's own toolchain;
       Cairn does not gate this step.

Failure terminal: cairn.outcomes.terminal_fail(reason) → FAILED
                  (only when the agent itself gives up; not a human gate)
```

The states that **look** like HITL gates are points where Cairn **records** that something needs an answer. They do not require the answer to come from a human. Any process — another agent, a scheduled retry, a deterministic resolver — can supply the answer through the same MCP tool surface.

---

## The three "stuck in the middle" states — and how each auto-resolves

| State | What looks like HITL | Auto-resolution path | MCP tool that closes it |
|---|---|---|---|
| `BLOCKED` (task) | Agent raised `cairn.task.block(question)` — task suspended | Any caller (another agent, scheduled retry, fallback policy) calls `cairn.task.answer(blocker_id, answer)`. Task → `READY_TO_RESUME` → `RUNNING`. The `resume_packet` aggregates **open + answered blockers + scratchpad keys + frozen criteria + audit summary** so the next agent starts cold with full context. | `cairn.task.answer` |
| `WAITING_REVIEW` (outcome) | Agent submitted DSL criteria — task suspended | `cairn.outcomes.evaluate(outcome_id)` runs every primitive **deterministically and synchronously**. No LLM judge. PASS → `DONE`. FAIL → back to `RUNNING` with criteria frozen so the agent retries against the same bar (no goalpost shifting). Calling `evaluate` is a tool call any agent can make — no human required. | `cairn.outcomes.evaluate` |
| `PENDING` (dispatch_request) | NL intent waiting for confirmation | 5 deterministic **fallback rules R1/R2/R3/R4/R6** pre-compute the target agent + prompt without LLM. `cairn.dispatch.confirm` can be called by the requesting agent itself (auto-confirm) when the intent is non-irreversible. R1 (irreversible/delete operations) is the **only** rule that mandates a real preview step before execution — and even that is satisfied by `cairn.rewind.preview` (a deterministic dry-run), not a human. | `cairn.dispatch.confirm` |
| `PENDING_REVIEW` (conflict) | Two agents wrote to overlapping paths | Resolver agent reads `cairn.conflict.list` and calls `cairn.conflict.resolve` with a deterministic strategy (last-writer-wins / merge-via-scratchpad / rewind-loser). Pre-commit hook records the conflict but does **not** block commits — agents stay unblocked. | `cairn.conflict.resolve` |

**Key invariant:** every state transition above is driven by an MCP tool call. The tool surface does not care whether the caller is human, an agent, a scheduled task, or another process. The state machine (`VALID_TRANSITIONS` in `packages/daemon/src/storage/tasks-state.ts`) is the contract — anything that can call the tools can drive the pipeline forward.

---

## Anti-stuck mechanisms (mirror of the self-healing pattern)

These are the design choices that keep the pipeline from blocking in practice.

| Blocker that could stall the pipeline | Cairn's resolution |
|---|---|
| Agent process dies mid-task | Task Capsule survives process death (`tasks` table is durable); next session calls `cairn.task.resume_packet(task_id)` and continues. No state lives only in an agent's context window. |
| Subagent result buried in main agent's context window | `cairn.scratchpad.write` persists the full report; `cairn.scratchpad.read` retrieves it byte-for-byte regardless of compression. Convention in `docs/cairn-subagent-protocol.md`. |
| Two agents stomp on the same file | MCP-call-boundary conflict detection + pre-commit hook double-layer. Conflict is **recorded, not blocked** — agents stay unblocked while a resolver thread handles it asynchronously. |
| Schema drift after upgrade | Migration registry with checksum guard (`packages/daemon/src/storage/migrations/index.ts`). 10 migrations 001-010 land idempotently on every daemon start. Already-applied migrations are skipped; corrupted checksums fail loudly rather than silently mis-migrate. |
| Daemon offline / not running | desktop-shell reads SQLite directly (read-only); presence heartbeat (`cairn.process.heartbeat`) tracks liveness; agents that lose presence drop to `stale` state without blocking other agents. |
| Outcome evaluator hangs on a slow primitive | DSL primitives are deterministic and bounded: `tests_pass` / `command_exits_0` / `file_exists` / `regex_matches` / `scratchpad_key_exists` / `no_open_conflicts` / `checkpoint_created_after`. Synchronous AND-aggregation, no LLM grader, no network in v1. |
| Dispatch LLM unavailable | Dispatch path is **rule-first, not LLM-first**: the 5 fallback rules (R1/R2/R3/R4/R6) pre-empt the LLM in `applyFallbackRules` for the keyword cases. LLM call retries 3× with exponential backoff (`completionWithRetry` in `packages/daemon/src/dispatch/llm-client.ts`), then graceful degradation to a rule-derived prompt. |
| Bad checkpoint / rewind blast radius | `cairn.rewind.preview` is mandatory before destructive rewinds (R1 rule). Rewind supports a `paths` parameter to restrict blast radius. Auto `auto:before-*` checkpoint is created before every destructive op. |
| Re-install / re-setup partial state | `cairn install` CLI is idempotent — writes `.mcp.json` + pre-commit hook + start script; re-running has no side effects on already-correct state. |
| Agent picks wrong target | Dispatch only **proposes** an agent + prompt; the actual execution is the agent host's job (Claude Code Task tool / Cursor / Aider). If the wrong agent runs, the outcome will FAIL deterministically and the task returns to `RUNNING` for a retry against the frozen criteria. |

These are the analogs to a fire-and-forget worker loop: durable work items, idempotent re-entry, deterministic evaluators, rule-first fallback before LLM, graceful degradation when an upstream dependency is missing, recorded-but-non-blocking conflict detection.

---

## Idea → merged code walkthrough (no HITL)

A grilled, well-specified idea travels through the pipeline like this:

1. **Express intent.** The originating agent (or a scheduled trigger, or `cairn install`'s sample script) calls `cairn.task.create(intent, criteria)`. The task is `PENDING` with the DSL criteria stored upfront.
2. **Dispatch.** `cairn.dispatch.request(nl_intent)` parses the intent and applies the 5 fallback rules R1/R2/R3/R4/R6 to pick a target agent + generated prompt. For most non-irreversible intents this is deterministic. The dispatch is auto-confirmed via `cairn.dispatch.confirm(request_id)` — there is no human prompt review in the unattended path. R1 (irreversible/destructive) routes through `cairn.rewind.preview` for a deterministic dry-run instead of a human gate.
3. **Execute.** Task transitions `PENDING → RUNNING`. The agent does the work. It writes its full report to `cairn.scratchpad.write(key, body)` before exiting so context-window loss cannot strand the result.
4. **Hit a blocker?** Instead of waiting in-context, the agent calls `cairn.task.block(question)`. Task → `BLOCKED`. The process can exit cleanly. A second agent picks the task up later via `cairn.task.resume_packet(task_id)` (returns all blockers + answered context + scratchpad keys + criteria), calls `cairn.task.answer`, task → `READY_TO_RESUME → RUNNING`, work resumes.
5. **Hit a conflict?** Pre-commit hook + MCP-boundary detection record the overlap in the `conflicts` table. The pipeline **does not pause** — a separate resolver agent reads `cairn.conflict.list` and calls `cairn.conflict.resolve` asynchronously.
6. **Submit for review.** Agent calls `cairn.task.submit_for_review(task_id, criteria)`. Task → `WAITING_REVIEW`. Criteria is **frozen** — no goalpost shifting on retry.
7. **Evaluate.** `cairn.outcomes.evaluate(outcome_id)` runs every DSL primitive synchronously. **PASS** → task → `DONE`. **FAIL** → task → `RUNNING`, agent gets a structured failure report, fixes the issue, calls `submit_for_review` again with the same `outcome_id` (criteria stays frozen). This is the FAIL → fix → resubmit → PASS retry loop. Bounded by the agent's own retry budget; agent calls `cairn.outcomes.terminal_fail(reason)` when it gives up (the only true terminal-stop path, and it is the **agent's** decision, not a human's).
8. **Merge.** Once `DONE`, the agent commits and pushes / opens PR / merges via its own toolchain. Cairn does not gate this step — it has already verified that the criteria pass.

**Where does the human appear?** Only in observation. The desktop side panel (read-only by D9 lock) shows Live Run Log + Tasks list + tray status. The human watches, the pipeline runs. The human can intervene through any MCP tool any time — but the pipeline does not depend on that intervention happening.

---

## The few things that genuinely cannot auto-recover

Honest enumeration, in the spirit of "graceful degradation has limits":

- **`cairn.outcomes.terminal_fail(reason)` was called.** Task → `FAILED` and is terminal. The agent declared the work impossible. By design — not a HITL gate, a give-up signal.
- **`cairn.task.cancel` was called.** Task → `CANCELLED`. Caller-initiated. Note: `WAITING_REVIEW → CANCELLED` is **intentionally absent** from `VALID_TRANSITIONS` (P1.2 lock) — `evaluate` is a sub-second transit state; the contract is "always evaluate first, then cancel from `RUNNING` if needed".
- **DSL criteria misspecified at task creation.** If the criteria are wrong, every evaluate-retry will FAIL the same way and never converge. The agent's retry budget will exhaust and it will call `terminal_fail`. The pipeline does not auto-correct the original intent — that is a grilling-stage problem, not a runtime problem.
- **Underlying tooling broken** (test runner crashed, git remote unreachable, disk full). The primitive returns a deterministic FAIL with the underlying error; agent sees the failure reason in the FAIL → fix loop and either resolves the infrastructure issue or terminal-fails.
- **Migration checksum mismatch.** The daemon refuses to start until the user resolves the corrupted local DB. This is intentional fail-loud, not fail-silent — the alternative is silent data corruption.

Note that **none of these are "stuck in the middle"** — they are explicit terminal outcomes. The pipeline either reaches `DONE` or it reaches `FAILED`/`CANCELLED` with a recorded reason. There is no "indefinitely waiting on a human" state.

---

## Mapping to common patterns

For readers coming from other unattended-pipeline systems:

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
| Read-only observability | desktop-shell side panel reads SQLite, never mutates state |

---

## Code references

- State machine: `packages/daemon/src/storage/tasks-state.ts` (`VALID_TRANSITIONS`)
- Dispatch fallback rules: `packages/daemon/src/dispatch/` (R1/R2/R3/R4/R6 in `applyFallbackRules`)
- LLM retry/degradation: `packages/daemon/src/dispatch/llm-client.ts` (`completionWithRetry`)
- DSL evaluator: `packages/mcp-server/src/dsl/` (7 primitives, stack frozen — only `spawn-utils.ts` imports `child_process`)
- Outcomes repository (no list/get MCP surface — LD-8): `packages/daemon/src/storage/outcomes-repo.ts`
- Migrations 001-010: `packages/daemon/src/storage/migrations/`
- Subagent protocol: `docs/cairn-subagent-protocol.md`
- Architecture: `ARCHITECTURE.md` §4 (state objects), §1 (system diagram)
- Product framing: `PRODUCT.md` §0, §1.3 (canonical positioning + anti-definitions)
