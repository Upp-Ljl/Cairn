# Cairn v0.1 — Release Notes

> Status: **W5 Phase 3 closed loop delivered (2026-05-28)**, Phase 4 release polish in progress.
> Scope: this document is a release narrative, not a per-commit changelog. The 27-commit Cairn dogfood audit trail lives in `git log` and is preserved as evidence — see `git log 6b23607..HEAD --oneline` for the W5 Phase 3 + Phase 4 chain.

---

## What Cairn is

**Cairn is the host-level coordination kernel for multi-agent work.** It gives agents and subagents durable shared state, conflict visibility, handoff packets, checkpoints, and outcome checks, so complex collaboration can survive failure, interruption, and handoff.

Cairn is not an agent. It does not write code. It does not decompose tasks. It does not orchestrate a lead-subagent. It sits below Claude Code, Cursor, Aider, Cline, and the subagents they fork, and gives them shared coordination primitives the way an OS gives applications shared file locks and process arbitration.

For the new-user 30-second introduction, see [`README.md`](README.md). For the canonical product definition + anti-definitions, see [`PRODUCT.md`](PRODUCT.md). For the architecture, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## v0.1 in four stories

The v0.1 release is best understood as four overlapping stories that built on each other across W1 → W4 → W5 Phase 1 → W5 Phase 2 → W5 Phase 3.

### Story 1 — Durable Task Capsule (W5 Phase 1)

**The problem:** before W5, Cairn could store scratchpad, checkpoints, conflicts, and dispatch requests, but had no first-class concept of "a unit of work that survives a single agent process." `task_id` was a soft string; nothing held a task open across sessions.

**What landed:**
- `tasks` table (migration 007) with `task_id` (ULID) / `intent` / `state` / `parent_task_id` / `metadata_json` / created_by_agent_id.
- 12-transition state machine in `tasks-state.ts` (`PENDING → RUNNING → BLOCKED → READY_TO_RESUME → RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED / CANCELLED`), declared up front; subsequent phases activated subsets.
- 5 MCP tools: `cairn.task.create / get / list / start_attempt / cancel`. Tools are verb-only; no free-form `update_state` is exposed.
- `cancelTask` does state transition + metadata merge atomically in a single SQLite transaction (P1 atomicity contract).
- `dispatch_requests.task_id` column added (migration 008) so dispatch history can be filtered per task.

**Verified by:**
- 23 `tasks.test.ts` cases, including atomicity tests that pre-corrupt task state via raw SQL to force `assertTransition` to throw mid-transaction and verify rollback.
- W5 Phase 1 dogfood script (`scripts/w5-phase1-dogfood.mjs`): real MCP stdio across 2 sessions creates / starts / cancels a task and the cancel reason persists across process death.

### Story 2 — Blockers + Resume Packet (W5 Phase 2)

**The problem:** Task Capsule alone does not solve the cross-session handoff. An agent that hits a question only the user can answer has no way to "pause cleanly and let someone else pick up tomorrow." A new agent in a fresh session needs the full context — original intent, what's been answered, what's still open, what scratchpad keys are relevant.

**What landed:**
- `blockers` table (migration 009) with `OPEN / ANSWERED / SUPERSEDED` CHECK constraint and FK CASCADE on `tasks(task_id)`.
- 3 MCP tools: `cairn.task.block / answer / resume_packet`. `resume_packet` is a **read-only aggregate**, not a stored row — it returns `{ task, current_state, last_checkpoint_sha, open_blockers, answered_blockers, scratchpad_keys, outcomes_criteria, audit_trail_summary }` computed on demand.
- LD-7 multi-blocker counting: a task only advances `BLOCKED → READY_TO_RESUME` when **all** its open blockers are answered.
- LD-8: `cairn.task.list_blockers` and `cairn.task.get_blocker` are deliberately **not** exposed as MCP tools; all blocker access goes through the resume packet aggregate. This keeps the protocol surface small and forces the read-only-aggregate framing.
- Module-private `transitionTaskInTx` helper pattern: each repository module (blockers, later outcomes) keeps its own copy rather than cross-module sharing — a Phase 2 invariant the Phase 3 outcomes module also follows.

**Verified by:**
- `blockers.test.ts` cases including atomicity (pre-corrupted state forces rollback) and multi-blocker counting under concurrent answers.
- W5 Phase 2 dogfood script: 3 real MCP stdio sessions (A1 creates + blocks + exits; B answers + reads resume_packet + resumes; A2 re-spawned reads cross-process state). All checks pass; cancel_reason set in B is visible in A2 (cross-process atomic write durability through SQLite WAL).

### Story 3 — Outcomes DSL + review/retry/terminal_fail closed loop (W5 Phase 3)

**The problem:** durable task + cross-session handoff still doesn't tell you whether the work the agent did was correct. The agent declares "done" — but according to what? In v1 we explicitly do not want an LLM grader (too non-deterministic, too easy to game). We want a deterministic check the agent commits to up front, evaluated synchronously, with a clear retry path on FAIL.

**What landed:**
- `outcomes` table (migration 010) with `UNIQUE(task_id)` — strictly one outcome row per task, ever — plus `criteria_json NOT NULL`, 4-status CHECK (`PENDING / PASS / FAIL / TERMINAL_FAIL`), and FK CASCADE on `tasks`.
- `repositories/outcomes.ts` with exactly 6 named exports: `OutcomeStatus` / `OutcomeRow` / `submitOutcomesForReview` / `recordEvaluationResult` / `markTerminalFail` / `getOutcomeByTask`. Module-private `transitionTaskInTx` helper mirrors Phase 2.
- **Upsert semantics (LD-12):** `submitOutcomesForReview` first-call INSERTs; repeat-call resets status to PENDING + clears evaluation results, with `criteria_json` literally frozen (string-equality check) and `outcome_id` stable. This is what makes the retry loop safe — the agent can't sneak in different criteria on a retry.
- DSL stack (`packages/mcp-server/src/dsl/`) with strict separation per LD-13:
  - `parser.ts` — strict whitelist + extra-key rejection + per-primitive arg type validation
  - `evaluator.ts` — serial dispatch (no `Promise.all` per LD-15 + child_process resource hygiene), AND aggregation (any FAIL or TIMEOUT collapses overall to FAIL), markdown summary
  - `primitives.ts` — 7 deterministic primitives: `tests_pass / command_exits_0 / file_exists / regex_matches / scratchpad_key_exists / no_open_conflicts / checkpoint_created_after`
  - `spawn-utils.ts` — the **only** dsl/ file that imports `child_process`; grep-enforced. 64KB stdout/stderr cap, ANSI strip, kill-tree on timeout (Windows `taskkill /F /T`, POSIX detached process group + SIGTERM/SIGKILL on negative pid)
  - `path-utils.ts` — `assertWithinCwd` with realpath + Windows case-fold; distinguishes TRAVERSAL from OUTSIDE_CWD
- 3 MCP tools: `cairn.task.submit_for_review` (upsert) / `cairn.outcomes.evaluate` (PENDING-only, sync blocking per LD-17) / `cairn.outcomes.terminal_fail` (PENDING-only, user-driven escape hatch).
- LD-8 wall preserved: `cairn.outcomes.list` and `cairn.outcomes.get` are **not** exposed; outcomes are read through the resume_packet aggregate.
- LD-11: `GraderHook` interface reserved in `dsl/types.ts` for v0.2 grader-agent integration; v1 evaluator silently ignores any hook passed in. A failing test verifies the hook's `evaluate` method is never called.
- LD-14: only the latest evaluation per outcome is kept; per-attempt audit history (`outcome_evaluations` sub-table) is deliberately deferred to v0.2.

**Verified by:**
- 19 `outcomes.test.ts` cases including upsert reset, criteria-frozen rejection, all 4 error codes, atomicity (deterministic pre-corruption triggers, no mocks), CASCADE, raw UNIQUE constraint smoke.
- 21 + 22 + 32 + 11 = 86 DSL tests across parser / spawn-utils / path-utils / primitives / evaluator.
- 12 `outcomes.test.ts` MCP acceptance cases including `OUTCOME_NEEDS_RESUBMIT` boundary (FAIL state → re-evaluate rejected) and `OUTCOME_ALREADY_PASSED` boundary.
- **W5 Phase 3 dogfood script (`scripts/w5-phase3-dogfood.mjs`): 32-of-32 assertions PASS** through real MCP stdio across 3 sessions. The full FAIL → fix fixture → submit_for_review (criteria frozen + outcome_id stable) → evaluate PASS → DONE chain. The terminal_fail escape hatch. The cross-process state durability proven via re-spawned A2.

### Story 4 — Host-level Multi-Agent Coordination Kernel positioning (Phase 4)

**The problem:** through W5 Phase 3 the codebase delivered 28 MCP tools, 10 migrations, 411 daemon tests + 329 mcp-server tests, and 32-of-32 dogfood assertions — but the documentation still framed Cairn through W4-era language ("17 MCP tools, four capabilities") and earlier W5 Phase 1+2 timeline notes. A new contributor reading the repo would see drift between PRODUCT.md / README.md / ARCHITECTURE.md / CLAUDE.md and the shipped state.

**What Phase 4 unified:**
- `PRODUCT.md` §6.1 capabilities table: F-1..F-9 statuses corrected + F-10 (Task Capsule) / F-11 (Blockers + resume_packet) / F-12 (Outcomes DSL) / F-13 (`cairn install`) / F-14 (desktop pet) added. New §6.1.1 lists the **8 host-level state objects** + maps them to migrations, with the explicit note that `resume_packet` is a read-only aggregate view, not independent persistent state.
- `README.md`: 30-second summary leads with the canonical positioning; tool count 17 → 28; test baselines 207/132 → 411/329; new sections explaining Task Capsule + Blockers + Outcomes; new sample workflow showing the cross-session handoff + outcomes verification path.
- `ARCHITECTURE.md`: §1 system diagram updated; new §1.1 (8 state objects), §1.2 (two state loops), §1.3 (architecture-level veto list — Cairn does NOT schedule lead-subagents, NOT write code, NOT auto-decompose tasks, NOT replace LLM decisions). Migration table extended 006 → 010.
- `CLAUDE.md`: test baselines bumped (90/42 → 411/329); current-stage block now reflects W5 Phase 1+2+3 done; new "新会话起手入口" section pointing through README → PRODUCT → ARCHITECTURE → current plan.
- This `RELEASE_NOTES.md` (new) — the 4-story release narrative.
- `docs/superpowers/demos/README.md` (new) — dogfood index pointing to W5 Phase 1 / Phase 2 / Phase 3 demos with what each proves.

**Verified by:** grep audits in each commit message confirm zero hits for the anti-framing list ("solo task daemon" / "auto-decompose tasks" / "writes code" / "lead-subagent orchestrator"); all four core docs lead with the canonical positioning.

---

## Verified evidence

### Tests

```
packages/daemon       :  29 test files /  411 passed                    (W5 Phase 3 baseline)
packages/mcp-server   :  17 test files /  329 passed / 1 pre-existing skip
```

`tsc --noEmit` exits 0 in both packages.
`npm run build` exits 0 in mcp-server (`dist/` is the stdio MCP entrypoint).

### Live dogfood (real MCP stdio across multiple sessions)

| Phase | Script | Assertions | Coverage |
|---|---|---|---|
| W5 Phase 1 | `scripts/w5-phase1-dogfood.mjs` | full PASS | task lifecycle (create / start / cancel) cross-process state durability via 2 fresh spawn sessions |
| W5 Phase 2 | `scripts/w5-phase2-dogfood.mjs` | full PASS | BLOCKED-loop closed-loop handoff: A1 blocks + exits, B answers + resumes + cancels, A2 re-spawned reads cancel_reason from B |
| W5 Phase 3 | `scripts/w5-phase3-dogfood.mjs` | **32/32 PASS** | full outcomes loop: submit_for_review (boundary cases EMPTY_CRITERIA + CRITERIA_FROZEN), evaluate FAIL, OUTCOME_NEEDS_RESUBMIT boundary, fix fixture + upsert reset (outcome_id + criteria stable), evaluate PASS → DONE, OUTCOME_ALREADY_PASSED boundary, terminal_fail second task → FAILED, A2 cross-process verification |

Reproduce:

```bash
cd packages/mcp-server
npm run build
node scripts/w5-phase1-dogfood.mjs
node scripts/w5-phase2-dogfood.mjs
node scripts/w5-phase3-dogfood.mjs
```

See [`docs/superpowers/demos/README.md`](docs/superpowers/demos/README.md) for the full demo index with what each one proves.

### Pre-implementation validation (W2)

Two PoCs ran before W4 feature code, both PASS, both archived:

- `docs/superpowers/plans/2026-04-29-poc-1-results.md` — SQLite WAL + `busy_timeout=5000ms` under N=2/5/10 concurrent writers: 100% success, p99 < 6ms.
- `docs/superpowers/plans/2026-04-29-poc-2-results.md` — git pre-commit hook end-to-end latency at N=1000 staged files: p99 = 122ms (8x under budget); fail-open at 24ms when DB absent.

---

## Current limitations

These are deliberate v0.1 boundaries, documented up front so they cannot be mistaken for bugs:

- **Conflict detection requires MCP-call participation.** Agents that operate purely at the filesystem layer without calling Cairn tools are transparent to it. (Plan §5.1.1 four-tier boundary — fs syscall interception is v0.3+.)
- **L0 / L1 / L2 checkpoint granularity only.** Agent conversation history (L3), tool call traces (L4), agent internal state (L5), and full subagent tree state (L6) are not checkpointed in v0.1. Every rewind response states this boundary explicitly.
- **Outcomes DSL is AND-only with 7 fixed primitives** (LD-15). No OR / NOT / nested combinators; no plugin loader; no custom primitives. v0.2 may add DSL v2.
- **Outcomes evaluator is deterministic-only** (LD-11). The `GraderHook` interface is reserved but ignored in v1; LLM-grader integration is v0.2.
- **Per-outcome history is not preserved** (LD-14). Only the latest evaluation summary is kept. v0.2 may add an `outcome_evaluations` sub-table for per-attempt audit.
- **`cairn.outcomes.evaluate` is sync blocking** (LD-17). Long-running test suites (>60s per primitive) need to be split into smaller criteria; there is no async job queue.
- **`WAITING_REVIEW → CANCELLED` is intentionally absent** (P1.2 lock). The escape from sub-second WAITING_REVIEW is either (a) wait for evaluate to return + cancel from RUNNING, or (b) call `terminal_fail` on the PENDING outcome.
- **No npm publish yet.** v0.1 is install via file-link (`node <abs-path>/packages/mcp-server/dist/cli/install.js`). `npx cairn install` is a Phase 4 / v0.1 release decision.
- **No LICENSE.** Source-available; do not redistribute or use in production without explicit permission. License selection (MIT / Apache 2.0 / source-available) is open.
- **Single-user local multi-agent only.** Cross-machine sync, multi-person shared daemon, and large-N concurrency (N=50 SQLite ceiling, see PoC-1) are v0.3+.

---

## Known technical debt (carry-over to Phase 4 / v0.2)

- **POSIX spawn-utils not validated this dev cycle.** §7.1.6 spawn experiment was run on Windows only (taskkill /F /T sufficient). The POSIX detached-process-group + SIGTERM/SIGKILL path is correct by inspection but has no fixture verification on Linux/macOS. To be exercised when next dev session touches a POSIX environment.
- **Daemon as separate process is v0.2.** v0.1 mcp-server imports daemon `dist/` directly; the daemon and the MCP-stdio server live in the same Node process. A standalone daemon with IPC is the v0.2 architecture.
- **Cross-package import goes through `dist/`, not source.** `mcp-server` imports `../../daemon/dist/` rather than the daemon source. To be unified when monorepo tooling (pnpm workspaces / nx) lands.
- **W1 stash SHA encoded in `checkpoints.label`.** A pre-Phase-1 W1 wedge encoding workaround. To be migrated out when a `checkpoints.backend_data` column is added.
- **`spritesheet.webp` working-tree drift.** A non-committed, non-Phase-3 change in the working tree at the time of the W5 Phase 3 + Phase 4 work. Decision pending: keep / discard / commit standalone.
- **Test baseline bookkeeping in CLAUDE.md.** The 411 / 329 baselines in CLAUDE.md were bumped during Phase 4 commit 1; CLAUDE.md is now consistent with the test reality. Next baseline update is a Phase 4 / future-phase concern only.

For a fuller v0.2 candidate roadmap (Floating Marker UI, grader hook, DSL v2, L3-L5 checkpoints, cross-machine sync), see `README.md` "Roadmap" or `docs/superpowers/plans/2026-05-28-w5-phase4-closure.md`.

---

## What v0.1 ships you, in one paragraph

A locally-running coordination kernel that 28 MCP tools speak to. Two or more agents on the same machine can now: see each other's write conflicts, share a scratchpad that survives context compression, snapshot and selectively rewind the working tree + git HEAD, register their presence on a process bus, dispatch user intent through 5 deterministic fallback rules, hold durable cross-session task capsules with blocker / resume / handoff, and verify their work against committed deterministic criteria with retry semantics. All of this is local SQLite; nothing leaves your machine. Cairn does not write code; it just makes sure the agents that do can collaborate without stepping on each other.

> **Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**
