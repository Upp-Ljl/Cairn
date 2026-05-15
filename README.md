# Cairn

> Local **project control surface** for agentic software work.

![status](https://img.shields.io/badge/status-v0.1--MVP--QuickSlice-orange)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

---

## 30-second summary

> **Cairn is a local project control surface for agentic software work.** A desktop side panel + tray that shows what your AI coding agents are doing on this machine — running tasks, blocked questions, failed outcomes, conflicts between agents, recoverable checkpoints — so you stay in control of long-horizon AI coding without becoming the bottleneck.

> **The pipeline is unattended by design.** A grilled idea flows from `cairn.task.create` to `DONE` (or terminal `FAILED`) without depending on a human in the middle. The states that **look** like HITL gates (`BLOCKED`, `WAITING_REVIEW`, dispatch `PENDING`, conflict `PENDING_REVIEW`) are **escalation paths, not blocking gates** — each closes via a deterministic MCP tool call that any caller can make. The desktop side panel is **read-only observability** over a fire-and-forget pipeline, not a step the pipeline waits on. See [Unattended pipeline](#unattended-pipeline--idea--merged-code-without-hitl-gates) below and [`AUTOMATION.md`](AUTOMATION.md) for the full walkthrough.

You write code in **Cursor / Codex / Claude Code / Kiro**. Cairn does **not** replace those — it's the surface next to them that organizes the agent activity they produce. Each agent assumes it's the only one running: they share no file locks, no state, no message bus, no cross-session memory. Cairn fills that gap with a coordination kernel underneath, and surfaces it to you through a side panel that reads like Activity Monitor or `journalctl --follow`, not like Jira / Linear / Cursor.

- **Cairn does not write code.** It does not decompose tasks. It does not orchestrate a lead-subagent. It is not a Cursor clone, not a Jira/Linear clone, not a "plain MCP service", **not any engine's plugin** (not a Claude Code plugin, not a Cursor extension, not a VS Code add-on — Cairn is daemon-class, runs whether or not any specific agent is installed; see PRODUCT.md §1.3 #10).
- **Customize by editing text, not code.** Per-project behavior (Mode A mentor scope, plan-shape guidance, hard constraints) lives in a single `CAIRN.md` file at the project root. Cockpit settings (mode, escalation thresholds, auto-ship) live in `~/.cairn/projects.json`. Non-developers can shape Cairn without touching JS / SQL / configs scattered across the repo.
- **Two layers, one product:**
  - **Product layer** — desktop side panel, tray status icon, ambient floating marker, Live Run Log. What the user sees.
  - **Kernel layer** — host-level multi-agent coordination kernel; 8 host-level state objects (`processes` / `tasks` / `dispatch_requests` / `scratchpad` / `checkpoints` / `conflicts` / `blockers` / `outcomes`); 29 MCP tools; agent-readable / agent-writable. The supporting infrastructure.
- **Current status:** **v0.2.0 (2026-05-14)** — 17-constraint cockpit redesign + Mode B Continuous Iteration. Modules (in order): M1 State Strip · M2 **Mentor + Todolist** (3-source todos: 🤖 agent self-propose, 🧑‍🏫 Mentor recs, 🐤 user-typed) · M3 Steer (per-session dropdown) · M4 **Sessions** (working/blocked/idle/stale; click to drill into **L2 timeline** with subagent缩进 tree + checkpoint rewind anchors) · M5 Safety/Rewind. Plus **🛤 Mode B Lanes** module — user authorizes N candidates, Cairn auto-watches each through WAITING_REVIEW, stops at REVIEWED per §1.3 #4a. Mentor Rule C off-goal drift wired (LLM-judged, strict-mode for high-confidence). Kernel auto-instruments task state transitions into `session_timeline/<agent>/<ulid>` so agents without skill adoption still produce timeline data. First-launch onboarding wizard for non-developer users. Kernel: 29 MCP tools, 10 migrations, daemon + mcp-server 424 tests. Plan: `docs/superpowers/plans/2026-05-14-cockpit-redesign-and-ship.md`. Release: `docs/releases/v0.2.0.md`.
- **What's next:** macOS code-signing/notarization (Apple Developer cert); Linux .AppImage/.deb; Mode B slice 6 (task.create-on-the-fly from user_todo); cross-engine validation (Cursor/Aider/Codex). No version-tier roadmap; see PRODUCT.md §12 D10 (only "Product MVP" + "Later" buckets).

---

## Why does this exist?

### The multi-agent coordination gap

The agent ecosystem is converging on parallel execution: Claude Code has the Task tool to fork subagents, Cursor has Background Agent, Aider can run multiple instances against the same repo. This trend is not reversing.

But every agent tool still assumes it is the only one present.

**No file locks.** Two agents editing `shared/types.ts` at the same time silently overwrite each other.

**No shared state.** One agent's checkpoint is invisible to the other. A rewind only affects the agent that called it.

**No message bus.** A subagent finishes its work and writes its report back to the main agent's context window. If that window has already been compressed by other output, the report is gone. There is no guarantee of delivery.

**No intent alignment.** The user gives one instruction; two agents interpret it independently. Nobody arbitrates which interpretation is closer to what the user meant.

### What this looks like in practice

A senior engineer using Claude Code and Cursor in parallel on the same codebase. Eight days into a sprint: CC has been refactoring the backend `token_refresh` logic. Cursor is working on the frontend `useAuth` hook. Two days earlier CC changed `TokenStatus` in `shared/types.ts` from an enum to a string union. Cursor, working on React components and seeing no TypeScript error in its local context, quietly changes one of those string values from `"refresh_required"` to `REFRESH_REQUIRED` (all caps). CI fails 23 minutes later. The engineer spends 20 minutes investigating CC's changes before realizing it was Cursor's edit to `shared/`. Manual rollback, re-explaining the correct convention to Cursor, re-run CI: close to an hour lost.

Cairn detects this conflict at MCP-call boundary when Cursor expresses its write intent via `cairn.checkpoint.create`. The notification arrives before the damage is committed.

A second pattern: a subagent writing a Stripe webhook handler discovers that the v3 API is incompatible with the project's existing schema, falls back to v2, and buries this decision in the last two lines of a 1200-token report. The main agent's context window has been filled by two other subagents' output. It reads the summary ("webhook handler done"), misses the v2 fallback, and continues building integration tests against v3 assumptions. CI fails two hours later.

With Cairn, the subagent writes its full report to `cairn.scratchpad.write` before exiting. The main agent can retrieve the original text at any time with `cairn.scratchpad.read`, regardless of how compressed its context window has become.

### Cairn = OS-level coordination

The analogy holds in both directions. An OS does not write your documents. It manages file locks, shared memory, process arbitration, and undo operations so that the applications running on it can do so safely. Cairn does the same for AI coding agents.

---

## What Cairn does (capabilities, by state object)

The four W4 capabilities (conflict visibility / reversible state / dispatchable intent / message reachability) are now joined by W5's Task Capsule + Outcomes verification.

### Conflict visibility / 冲突可见

When two agents express write intent against the same file through Cairn's MCP tools, Cairn detects the overlap at MCP-call boundary and issues a non-blocking notification with timestamp, path, and both agents' stated intent. A second detection layer fires at `git commit` via a pre-commit hook. No false silence.

v0.1 boundary: agents must actively call Cairn tools for their write intent to be visible. Agents that operate purely at the filesystem layer without calling Cairn are transparent to it. This is documented as an explicit limitation, not papered over.

### Reversible state / 状态可逆

Cairn checkpoints the working directory and git HEAD on demand. Rewind supports a `paths` parameter for selective restore (roll back `src/` but leave `docs/` and scratchpad untouched). Every destructive operation is preceded by an automatic `auto:before-*` checkpoint. Preview before rewind shows exactly what will change and what will not.

v0.1 covers L0 (full file tree), L1 (paths subset), and L2 (scratchpad). Agent conversation history, tool call traces, and agent internal state (L3–L6) are v0.2 work, and that boundary is stated explicitly in every rewind response.

### Dispatchable intent / 需求可派

The user describes their intent in natural language. Cairn retrieves relevant scratchpad and checkpoint history, selects the best available active agent (via 5 deterministic fallback rules R1/R2/R3/R4/R6), generates a prompt with the historical context attached, and presents it for the user's review before forwarding. Cairn exits after forwarding. It does not track whether the agent executes correctly.

### Message reachability / 消息可达

Subagents write their complete results to a shared scratchpad (`cairn.scratchpad.write`) before exiting. The main agent reads from scratchpad (`cairn.scratchpad.read`) rather than from its own context window. The full text is always available regardless of how much context compression has occurred. The convention for naming and structure is documented in [`docs/cairn-subagent-protocol.md`](docs/cairn-subagent-protocol.md). v0.2 will add semantic diff between the subagent's original report and the main agent's restatement.

### Task Capsule (W5 Phase 1) / durable multi-agent work item

A **Task Capsule** is a durable host-level work item that can outlive any single agent process and any single session. It carries an `intent`, a `state` (PENDING / RUNNING / BLOCKED / READY_TO_RESUME / WAITING_REVIEW / DONE / FAILED / CANCELLED), and metadata. Multiple agents can read and update the same task across sessions. Task Capsules are an OS primitive — they let the kernel hold a piece of work, but Cairn does not decide what work happens. Agents do.

### Blockers + resume packet (W5 Phase 2) / cross-session handoff

When an agent gets stuck on a question only the user can answer, it calls `cairn.task.block(question)` to create a `blocker` row and transitions the task to BLOCKED. The agent process can then exit cleanly. Later — minutes or days later, in a fresh session — the user (or another agent) calls `cairn.task.answer` and the task moves to READY_TO_RESUME. A new agent picks it up via `cairn.task.resume_packet(task_id)`, which returns a **read-only aggregate** of the task's full context: open + answered blockers, scratchpad keys, the criteria the previous agent committed to, plus an audit summary. Resume packet is computed on demand; it is not an independent persistent state.

### Outcomes DSL + review loop (W5 Phase 3) / verifiable completion

Before declaring a task done, an agent calls `cairn.task.submit_for_review(task_id, criteria)` and the task transitions to WAITING_REVIEW. The criteria is a JSON array of deterministic primitives (`tests_pass` / `command_exits_0` / `file_exists` / `regex_matches` / `scratchpad_key_exists` / `no_open_conflicts` / `checkpoint_created_after`) — AND-aggregated, no LLM-grader in v1. Calling `cairn.outcomes.evaluate(outcome_id)` runs the criteria deterministically and routes PASS → DONE / FAIL → back to RUNNING (the agent fixes the issue and re-submits — criteria is frozen across the retry). For paths the agent gives up on, `cairn.outcomes.terminal_fail(reason)` routes to FAILED.

---

## Unattended pipeline — idea → merged code without HITL gates

Cairn is designed as a **fire-and-forget pipeline**. A grilled, well-specified idea flows from `cairn.task.create` to `DONE` without depending on a human in the middle. The three states that **look** like human-in-the-loop gates (`BLOCKED`, `WAITING_REVIEW`, dispatch `PENDING`) are **escalation paths, not blocking gates** — each has a deterministic auto-resolution path so the pipeline keeps moving even when no human is watching. The desktop side panel is **read-only observability**, not a step the pipeline waits on.

### Where it looks like the pipeline could get stuck — and what closes it

| Apparent HITL state | Why it isn't a human gate | Tool that closes it |
|---|---|---|
| `BLOCKED` task | Any caller (another agent, scheduled retry, fallback policy) can call `cairn.task.answer`. The `resume_packet` carries full context so the next agent picks up cold. | `cairn.task.answer` |
| `WAITING_REVIEW` outcome | `cairn.outcomes.evaluate` runs DSL primitives **deterministically, no LLM judge**. PASS → DONE, FAIL → RUNNING with **frozen criteria** for retry. | `cairn.outcomes.evaluate` |
| Dispatch `PENDING` | 5 fallback rules R1/R2/R3/R4/R6 pre-compute target + prompt. `confirm` is a tool call — agents can auto-confirm non-irreversible intents. R1 (destructive) routes through `rewind.preview`, a deterministic dry-run, not a human gate. | `cairn.dispatch.confirm` |
| Conflict `PENDING_REVIEW` | Recorded, **not blocking**. Pipeline keeps moving while a resolver thread reads `cairn.conflict.list` and calls `cairn.conflict.resolve`. | `cairn.conflict.resolve` |

### Self-healing primitives that keep the pipeline running

- **Durable Task Capsules** survive process death — context lives in `tasks` + `blockers` + `scratchpad`, not in any agent's context window
- **Migration registry with checksum guard** — 10 idempotent migrations apply on every daemon start
- **Rule-first dispatch with LLM degradation** — 5 fallback rules pre-empt LLM for keyword cases; LLM call has 3× exponential backoff, then graceful degradation to rule-derived prompt
- **Deterministic outcome evaluator** — 7 bounded primitives, sync AND-aggregation, no network in v1
- **Frozen criteria across retries** — `outcome_id` stays stable so the agent retries against the same bar (no goalpost shifting)
- **Idempotent `cairn install`** — re-running has no side effects on already-correct state
- **Mandatory `rewind.preview` before destructive rewinds** (R1) with `paths` parameter to bound blast radius
- **Pre-commit hook records, does not block** — conflicts go into the table, commits proceed, resolver acts async

### Things that genuinely don't auto-recover (and aren't HITL either)

- `cairn.outcomes.terminal_fail(reason)` — agent's own give-up signal
- `cairn.task.cancel` — caller-initiated
- Misspecified DSL criteria — grilling-stage problem, not a runtime problem
- Broken underlying tooling (test runner crashed, disk full) — primitive returns deterministic FAIL with reason
- Migration checksum mismatch — fail-loud refusal to start, not silent corruption

There is no "indefinitely waiting on a human" state. The pipeline reaches `DONE`, or it reaches `FAILED` / `CANCELLED` with a recorded reason.

Full walkthrough + code references: [`docs/unattended-pipeline.md`](docs/unattended-pipeline.md).

---

## Three verbs

**Dispatch.** The user has a task and needs the right agent to handle it with the right context. Cairn finds the relevant history, builds the prompt, gets confirmation, and routes it. The agent does the work. Cairn does not.

**Rewind.** Something went wrong, or the direction was wrong, or the user just wants to see what state the codebase was in yesterday at 3pm. Cairn restores the selected checkpoint — files, git HEAD, optionally specific paths only — and reports exactly what it restored and what it left alone.

**Arbitrate.** Two agents are about to step on each other, or already have. Cairn detects the overlap, diagnoses which agents are involved and what files are at stake, suggests a resolution path, and writes the arbitration decision to scratchpad so both agents can read it. The user makes the final call. Cairn does not override agent execution.

---

## Who is this for?

### You will find this useful if

- You regularly run two or more agent tools at the same time (Claude Code + Cursor, Claude Code + Cline, etc.).
- You use Claude Code's Task tool and spawn three or more subagents in a single session.
- You have already hit the "two agents clobbered the same file" or "subagent result never made it back to the main agent" failure modes.
- You are comfortable with CLI and MCP tool-level interaction. Zero-learning-curve GUI is not a v0.1 goal.

### v0.1 is explicitly not for

- **Teams with strict enterprise compliance requirements.** SSO, RBAC, audit logs, SBOM — none of these are v0.1 scope. Building them would turn Cairn into a different product.
- **Non-technical end users.** v0.1 assumes the user can read git output, configure an MCP server, and understand what "checkpoint" means.
- **Multi-person shared daemon scenarios.** v0.1 is single-user local multi-agent. Multi-person shared daemon is v0.3+.
- **Single-agent users.** If you only ever run one agent tool, you do not have a multi-agent coordination problem. Cairn adds no value in that scenario.

---

## What is in the box

### 29 MCP tools (v0.1 + v0.2.0, W1 + W4 + W5 + cockpit-redesign, fully shipped)

Grouped by namespace. The full alphabetical list is asserted in `tests/stdio-smoke.test.ts`; the schemas + dispatch live in `packages/mcp-server/src/index.ts`.

**scratchpad ×4** — `write` / `read` / `list` / `delete`. Persistent shared key-value store; values > 128KB blob-spill to `~/.cairn/blobs/`. All take optional `task_id` for multi-task partitioning.

**checkpoint ×2** — `create` / `list`. Two-phase PENDING → READY snapshot via git-stash backend; CORRUPTED scan on daemon restart for crash recovery.

**rewind ×2** — `to` / `preview`. `to` supports `paths` parameter for selective restore; auto-creates `auto:before-rewind` checkpoint first. `preview` is a dry-run that returns the will-change / will-not-change file lists.

**process ×4** — `register` / `heartbeat` / `list` / `status`. The runner bus. `agent_id` is optional on all four — the mcp-server auto-injects a stable `CAIRN_SESSION_AGENT_ID` (`cairn-<sha1(host:cwd).slice(0,12)>`) at startup.

**conflict ×3** — `list` / `resolve` (since W4 Phase 2). MCP-call + commit-after dual detection writes `OPEN` / `PENDING_REVIEW` rows; `resolve` clears them with TOCTOU guard.

**inspector ×1** — `query`. 15 deterministic SQL templates matched by keyword (no LLM).

**dispatch ×2** — `request` / `confirm`. NL → parsed intent → 5 fallback rules (R1/R2/R3/R4/R6) → user-confirmed agent prompt forwarding. `CAIRN_DISPATCH_FORCE_FAIL=1` env override for demo.

**task ×8** (W5 Phase 1+2+3) — `create` / `get` / `list` / `start_attempt` / `cancel` / `block` / `answer` / `resume_packet` / `submit_for_review`. The Task Capsule lifecycle. `resume_packet` is a read-only aggregate of (task + open/answered blockers + scratchpad keys + outcomes_criteria + audit summary).

**outcomes ×2** (W5 Phase 3) — `evaluate` / `terminal_fail`. Deterministic criteria evaluator + user-driven escape hatch. Both PENDING-only — FAIL state requires `submit_for_review` to reset criteria_json (frozen) before re-evaluation. **Not exposed:** `cairn.outcomes.list` / `cairn.outcomes.get` (outcomes are read through resume_packet, by design).

The `task_id` field threads through scratchpad / checkpoint / outcomes for soft partitioning. The daemon does not enforce or assign `task_id` values — the host agent generates them per Task Capsule and passes them through.

### Pre-implementation validation (PoC-1 + PoC-2, both PASS)

Before writing any feature code for the conflict detection layer, two validation experiments were run.

**PoC-1: SQLite concurrency under multi-agent write load.**
Simulated N concurrent writers (each representing one agent's mcp-server process) hitting the same SQLite database. At N=2/5/10 (the realistic upper bound for v0.1 single-user scenarios): 100% success rate, p99 < 6ms, zero `SQLITE_BUSY` errors surfaced to the application layer. Data integrity confirmed for all 1000 ops per scenario. At N=50 (extreme stress, outside v0.1 scope): p99 = 449ms — recorded as a v0.3 architectural ceiling for cross-machine / shared-daemon scenarios.

Conclusion: SQLite WAL + `busy_timeout=5000ms` is sufficient for v0.1. No stronger concurrency primitive is needed.

**PoC-2: git pre-commit hook end-to-end latency and fail-open behavior.**
Ran the conflict-check hook across five scenarios (0 / 10 / 100 / 1000 staged files, plus no-database). All five passed. At 1000 staged files, p99 = 122ms — 8x under the 1000ms budget. Node cold start (~70ms) is the dominant cost; each SQLite path query adds ~45μs. When the database is absent (user has not installed Cairn), the hook exits 0 in 24ms without blocking the commit.

Conclusion: commit-after detection is viable in v0.1. The fail-open guarantee holds.

Full reports: [`docs/superpowers/plans/2026-04-29-poc-1-results.md`](docs/superpowers/plans/2026-04-29-poc-1-results.md) and [`docs/superpowers/plans/2026-04-29-poc-2-results.md`](docs/superpowers/plans/2026-04-29-poc-2-results.md).

---

## How it works

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                      your machine (local)                        │
  │                                                                  │
  │   ┌──────────────┐  MCP stdio  ┌──────────────────────────────┐ │
  │   │ Claude Code  ├────────────►│                              │ │
  │   │ (Agent A)    │◄────────────┤     cairn  mcp-server        │ │
  │   └──────────────┘             │     (Node.js subprocess)     │ │
  │                                │                              │ │
  │   ┌──────────────┐  MCP stdio  │   29 tools (W1+W4+W5+v0.2)   │ │
  │   │ Cursor / etc.├────────────►│   all shipped                │ │
  │   │ (Agent B)    │◄────────────┤                              │ │
  │   └──────────────┘             └──────────┬───────────────────┘ │
  │                                           │ function call        │
  │                                           ▼                      │
  │                            ┌─────────────────────────────────┐  │
  │                            │        cairn daemon             │  │
  │                            │     packages/daemon/            │  │
  │                            │                                  │  │
  │                            │  8 host-level state objects:    │  │
  │                            │  processes / tasks /             │  │
  │                            │  dispatch_requests / scratchpad /│  │
  │                            │  checkpoints / conflicts /       │  │
  │                            │  blockers / outcomes             │  │
  │                            │           │                      │  │
  │                            │  SQLite (WAL mode)               │  │
  │                            │  ~/.cairn/cairn.db               │  │
  │                            │           │                      │  │
  │                            │  git-stash backend               │  │
  │                            │  snapshots/{ckpt_id}/            │  │
  │                            └─────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────┘
```

Each agent calls Cairn tools via MCP stdio. The mcp-server validates parameters and calls daemon storage functions. The daemon is the sole writer to SQLite. All state is local: `~/.cairn/cairn.db`.

**v0.1 process model note:** The mcp-server imports daemon's compiled `dist/` functions directly. There is no separate long-running daemon process in v0.1 — both run in the same Node process, one per mcp-server instance. A standalone daemon with IPC is the v0.2 architecture direction.

---

## Getting started (current dogfood phase)

v0.1 is not yet npm-published. Install via file-link: clone, build, then run `cairn install` inside your target repo.

![Cairn desktop pet ambient UI](assets/cairn-master-visual.png)

The desktop pet (`packages/desktop-shell/`, Electron) shows ambient coordination status in the corner of your screen. It reflects live SQLite state: idle / running / review / waiting / failed animations map directly to schema queries (see `ARCHITECTURE.md §ADR-8` and `PRODUCT.md §8.2.1`).

### Prerequisites

- Node.js >= 20 (Node 24 recommended; current dev environment runs on 24.x)
- Git
- Claude Code with MCP support (`.mcp.json` configuration)

### Build

```bash
git clone https://github.com/Upp-Ljl/Cairn.git
cd Cairn

# Build the daemon (output goes to packages/daemon/dist/)
cd packages/daemon
npm install
npm run build

# Build the mcp-server (also builds the cairn CLI bin)
cd ../mcp-server
npm install
npm run build
```

### Install into your target repo

From inside your project directory (the repo you want Cairn to coordinate):

```bash
node <absolute-path-to-cairn>/packages/mcp-server/dist/cli/install.js
```

This writes `.mcp.json` (cairn-wedge entry), installs a git pre-commit hook (marker `# cairn-pre-commit-v1`; sidecars to `.cairn/` if a non-cairn hook already exists), and generates `start-cairn-pet.bat` / `.sh` launchers. All three steps are idempotent and safe to re-run.

Once npm-published, the install command will be `npx cairn install` from your target repo. Until then, use the absolute path above.

#### CLI flags

```bash
node <cairn-path>/packages/mcp-server/dist/cli/install.js --help     # usage; no mutation
node <cairn-path>/packages/mcp-server/dist/cli/install.js --version  # prints "cairn <version>"
node <cairn-path>/packages/mcp-server/dist/cli/install.js --dry-run  # preview file changes; writes nothing
```

The CLI is mutation-safe: `--help`, `--version`, and `--dry-run` short-circuit before any file is written. Unknown flags exit 2 with a usage hint instead of silently mutating.

#### Verify the install worked

```bash
# from inside your target repo
ls -la .mcp.json .git/hooks/pre-commit start-cairn-pet.*  # all four should exist
cat .mcp.json | grep cairn-wedge                           # entry should be present
head -2 .git/hooks/pre-commit                              # should show "# cairn-pre-commit-v1" marker
```

Then restart Claude Code so it picks up the new `.mcp.json`. The first `cairn-wedge` MCP tool call confirms end-to-end wiring.

### Wire up Claude Code manually (alternative)

If you prefer not to use `cairn install`, add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "cairn-wedge": {
      "command": "node",
      "args": ["<absolute-path-to>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Replace `<absolute-path-to>` with the actual path to your Cairn clone.

### Sample workflow

```
# In a Claude Code session, create a checkpoint before a big change
cairn.checkpoint.create("before auth refactor")

# Spawn subagents and have them write their results to scratchpad
# (add this to your subagent system prompt or task description):
# "When done, call cairn.scratchpad.write with key subagent/{agent_id}/result
#  and include your full report including any fallback decisions."

# Main agent can read subagent results even after context compression
cairn.scratchpad.read("subagent/agent-b/result")

# Preview a rewind before executing
cairn.rewind.preview("<checkpoint_id>")

# Rewind to that checkpoint, leaving docs/ untouched
cairn.rewind.to("<checkpoint_id>", paths=["src/"])
```

### Sample workflow — Task Capsule with cross-session handoff and outcome verification (W5)

```
# Session A: declare a durable task and start working
cairn.task.create({ intent: "refactor auth module to use the new TokenStatus union" })
# → returns task_id T-001, state PENDING
cairn.task.start_attempt({ task_id: "T-001" })   # → RUNNING

# Session A hits a question only the user can answer; pause cleanly
cairn.task.block({ task_id: "T-001", question: "keep the legacy sync API behind a deprecation flag?" })
# → BLOCKED + blocker.OPEN. The agent process can now exit.

# (Hours or days later, in a fresh session)
cairn.task.answer({ blocker_id: "<id>", answer: "yes — deprecation flag, drop in v0.3" })
# → blocker.ANSWERED + task.READY_TO_RESUME

# Session B (different agent, different process) picks up
cairn.task.resume_packet({ task_id: "T-001" })
# → read-only aggregate: intent + answered question + scratchpad keys + outcomes_criteria
cairn.task.start_attempt({ task_id: "T-001" })   # → RUNNING (resume)

# Session B finishes the work; commit to deterministic verification criteria
cairn.task.submit_for_review({
  task_id: "T-001",
  criteria: [
    { primitive: "tests_pass",        args: { target: "packages/daemon" } },
    { primitive: "no_open_conflicts", args: {} }
  ]
})   # → outcome PENDING + task.WAITING_REVIEW (criteria_json now frozen)

cairn.outcomes.evaluate({ outcome_id: "<id>" })
# → if PASS: task.DONE
# → if FAIL: task back to RUNNING; agent fixes, calls submit_for_review again
#            (criteria stays frozen; outcome.status resets to PENDING),
#            then re-evaluates.
```

For full engineering conventions (commit style, test commands, monorepo structure, push instructions), see [`CLAUDE.md`](CLAUDE.md).

### Run tests

```bash
cd packages/daemon && npm test        # 439 tests (W5 Phase 3 baseline)
cd packages/mcp-server && npm test    # 424 tests + 1 pre-existing skip (W5 Phase 3 baseline)
```

### Run the full Phase 3 closed-loop dogfood (real MCP stdio across 3 sessions)

```bash
cd packages/mcp-server && npm run build
node scripts/w5-phase3-dogfood.mjs    # 32/32 assertions PASS — covers
                                       # the FAIL → fix → resubmit → PASS retry
                                       # cycle, the terminal_fail escape hatch,
                                       # cross-process state durability, and
                                       # the LD-8 (no list/get outcomes) wall.
```

See `docs/superpowers/demos/README.md` for the full Phase 1 / Phase 2 / Phase 3 dogfood index.

---

## What Cairn is not

These are boundary definitions, not disclaimers. Any design or feature request that violates these can be vetoed directly by reference to this list. Authoritative version: PRODUCT.md §1.3.

1. **Cairn is not a coding agent.** It does not write code, open PRs, or edit files.
2. **Cairn is not a Cursor clone / IDE.** No code editor, no diff viewer, no inline completion.
3. **Cairn is not another Claude Code skin.** Claude Code is one of Cairn's "applications" — Cairn is the coordination kernel below it.
4. **Cairn is not a lead-subagent orchestrator.** It does not decompose tasks, dispatch agents, or substitute for agent reasoning.
5. **Cairn is not a Jira / Linear / Asana / sprint-planning / Gantt / enterprise-PM clone.** No sprints, story points, kanban, burn-down, or resource allocation. The product surface organizes real agent activity, not synthetic ticket trees. The "AI PMO layer" framing is descriptive of where Cairn sits in your workflow — it is not a re-implementation of those tools.
6. **Cairn is not a generic agent framework or SDK.** It is a product for end users, not a library for building agents.
7. **Cairn is not a "plain MCP service".** MCP is how agents talk to Cairn; the product the user sees is the desktop side panel + tray.
8. **Cairn does not do cross-machine collaboration in this Slice.** Local-first. All data stays on your machine. Multi-machine sync is Later.
9. **Cairn does not proxy your agents' external calls.** No HTTP proxy, no Recorder/Classifier/Reverter pipeline, no compensation engine for SaaS API side effects. That was a pre-v2 direction that was replaced by the current positioning.

---

## Roadmap

PRODUCT.md v3 §12 D10 retired the v0.2 / v0.3 version-tier roadmap. Two tracks now:

### Delivered — kernel layer + Quick Slice

- **W1+W2** ✅ — 8 MCP tools, SQLite persistence, git-stash checkpoint backend, task_id isolation. PoC-1 (SQLite concurrency) + PoC-2 (git hook latency) both PASS.
- **W4 Phase 1-4** ✅ — four-capability v1: conflict detection (migration 004+006), process bus (4 tools), Dispatch NL (migration 005, 5 fallback rules R1/R2/R3/R4/R6), Inspector query (15 SQL templates), `cairn install` CLI, auto SESSION_AGENT_ID.
- **W5 Phase 1+2+3** ✅ — Task Capsule lifeline + Blockers + resume_packet + Outcomes DSL closed loop. Migrations 007–010. **32/32 dogfood assertions PASS** through real MCP stdio across 3 sessions.
- **Phase 4 docs unification** ✅ — README / CLAUDE / ARCHITECTURE / RELEASE_NOTES / demos index synced.
- **PRODUCT.md v3 reframe** ✅ (commit `3562f1f`) — product-layer framing locked: project-scoped agent work side panel / project control surface; kernel-layer framing preserved as supporting evidence.
- **Product MVP Quick Slice** ✅ (commits `f088b56`..`4c24fb6`) — `packages/desktop-shell/` upgraded from "pet only" to **panel + pet + tray**: project summary card, low-fidelity Live Run Log over 5 event sources, Tasks list with inline expansion, 3-state tray (idle / warn / alert) with tooltip, dogfood fixture script, dogfood report distinguishing real vs `cairn-demo-*` rows. Strict read-only by default; `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` opts only the legacy Inspector's Resolve button into write mode.

### Later (no version tier; see PRODUCT.md §6.3 / §10.4)

Driven by dogfood feedback, not by date.

- **Hardening of the panel surface** — checkpoints view + path preview, scratchpad / subagent-result view, full task drill-down drawer (independent of inline expansion), agent-sessions view as its own tab, blockers + outcomes as their own dedicated views, multi-day dogfood with quantified coverage.
- **Run Log high-fidelity** — true event sourcing (events table + triggers) so `processes` heartbeats / `scratchpad` writes / `checkpoints` events stop being dropped from the Run Log feed; live push instead of 1s polling; filter / grouping / search; replay.
- **Mutation-on-desktop unlock** — answer blocker / rewind / dispatch / resolve conflict from the panel. Blocked on three prerequisites (PRODUCT.md §12 D9): a standalone daemon process with a stable IPC API, a supervisor-identity model in the audit trail, and dogfood evidence about which mutations actually save effort.
- **Path (b) Task tool wrapper** for stronger Claude Code subagent integration; **path (c) fs / process hook** under research.
- **Grader agent hook** (`GraderHook` interface already reserved in DSL types) for non-deterministic outcome verification; **DSL v2** combinators (OR / NOT / nesting); per-attempt outcome history table.
- **L3–L5 checkpoint granularity** (conversation truncation, tool call traces, agent internal state) — needs host-LLM cooperation.
- **Cross-machine / small-team sync.** Local-first stays the default; this is a separate product direction.
- **Non-MCP-aware agent integration** (Cursor / Cline without `.mcp.json`).
- **Large-concurrency optimization** (N=50 SQLite ceiling documented in PoC-1).
- **Floating-marker schema drift fix** — current sprite rules query `lanes` (legacy schema); needs migration to the 8 host-level state objects.

---

## The name

A **cairn** (n.) is a stack of stones placed on a path to mark where someone has been — a waypoint, a direction indicator, a record that someone passed this way. In Tibetan Buddhist tradition, cairns (玛尼堆) mark sacred routes and accumulate over generations of travelers.

The name fits the function. Cairn marks the path your agents walked, records what they changed, and gives you a way back if the path was wrong. It does not walk the path for you.

The desktop side panel + tray + floating marker (`packages/desktop-shell/`) is the desktop expression of this same idea: a small, persistent marker on your screen that shows the state of your agent coordination layer, the way a cairn on a trail shows you how far you have come and whether you are still on course.

---

## Documentation map

| Document | Contents |
|---|---|
| [`PRODUCT.md`](PRODUCT.md) | Product definition **v3** (project control surface / agent work side panel; AI PMO layer as auxiliary framing): positioning, 9 anti-definitions, 5 capabilities + Task Capsule + Outcomes, 8 host-level state objects, US-P1..P5 user stories, UX form (panel / tray / floating marker / Live Run Log), Product MVP scope + Later. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Implementation architecture: system diagram, process model, monorepo structure (daemon / mcp-server / desktop-shell), SQLite schema, MCP tool list, ADRs (incl. ADR-8 Electron over Tauri), known technical debt. |
| [`CLAUDE.md`](CLAUDE.md) | Agent Work Rules + engineering conventions: push workflow, Node/SQLite version constraints, commit style, test commands, monorepo build rules, current 411 / 329 baselines, desktop-shell read-only-by-default boundary. |
| [`packages/desktop-shell/README.md`](packages/desktop-shell/README.md) | Quick Slice usage: launch / tray behavior / Switch DB / mutation flag / dogfood script. |
| [`packages/desktop-shell/SCHEMA_NOTES.md`](packages/desktop-shell/SCHEMA_NOTES.md) | Live DB schema reference for the 6 host-level tables the panel reads (column names + indexes + Run Log time anchors). |
| [`docs/superpowers/plans/2026-05-08-product-mvp-side-panel.md`](docs/superpowers/plans/2026-05-08-product-mvp-side-panel.md) | Product MVP Quick Slice plan (3-day Day-by-day, 5 locked decisions, 17 risks, Later Hardening list). |
| [`docs/superpowers/demos/MVP-quick-slice-desktop-dogfood.md`](docs/superpowers/demos/MVP-quick-slice-desktop-dogfood.md) | Quick Slice desktop dogfood report (real-vs-fixture labels, US-P1..P5 coverage). |
| [`RELEASE_NOTES.md`](RELEASE_NOTES.md) | v0.1 release narrative organized by 4 stories (Task Capsule / Blockers + Resume Packet / Outcomes DSL / Coordination Kernel positioning); verified evidence and known limitations. |
| [`docs/superpowers/demos/README.md`](docs/superpowers/demos/README.md) | W5 Phase 1 / Phase 2 / Phase 3 dogfood index — real MCP stdio cross-process evidence. |
| [`docs/cairn-subagent-protocol.md`](docs/cairn-subagent-protocol.md) | Subagent ↔ scratchpad naming + structure convention (paste-ready prompt template). |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Weekly plans, PoC result reports, pre-implementation validation tracking. |

---

## Contributing

There is no formal contribution process yet. If you are in the early-access group, open an issue or reach out directly.

Commit conventions follow [Conventional Commits](https://www.conventionalcommits.org/): `feat / fix / chore / docs / test` + short English body. No `Co-Authored-By` trailers. No emoji in commit messages. See [`CLAUDE.md`](CLAUDE.md) for the full style guide.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) at the repo root.

```
Copyright 2026 The Cairn Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

The Apache-2.0 grant includes an explicit patent license, which is the relevant differentiator for infrastructure that is intended to be embedded by AI coding agents and their host tools. See `RELEASE_DECISIONS.md` for the rationale.
