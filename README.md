# Cairn

> Multi-agent collaboration kernel for your dev machine.

![status](https://img.shields.io/badge/status-v0.1--dogfood-orange)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![license](https://img.shields.io/badge/license-TBD-lightgrey)

---

## 30-second summary

Cairn is the coordination layer that sits under your AI coding agents. When you run Claude Code and Cursor side by side, or spawn three subagents from a single CC session, nothing in the current ecosystem handles how those agents coordinate. Each one assumes it is the only agent running: they share no file locks, no state, no message bus.

Cairn fills that gap. It is not another agent. It does not write code. Think of it the way you think of an OS relative to the apps running on it: Word and Excel don't coordinate with each other — the OS does. Cairn is that layer for Claude Code, Cursor, Aider, and friends.

- **Cairn does not write code.** It coordinates agents that do.
- **Three verbs: Dispatch / Rewind / Arbitrate.** These are the only things Cairn does.
- **Four capabilities:** conflict visibility, reversible state, dispatchable intent, message reachability.
- **Current status:** v0.1 wedge shipped — 8 MCP tools live, running in dogfood. PoC-1 and PoC-2 pre-implementation validations passed before any feature code was written.
- **What's next:** W3 pre-implementation validation wrap-up, then W4–W7 four-capability v1 build phase.

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

## What Cairn does (the four capabilities)

### Conflict visibility / 冲突可见

When two agents express write intent against the same file through Cairn's MCP tools, Cairn detects the overlap at MCP-call boundary and issues a non-blocking notification with timestamp, path, and both agents' stated intent. A second detection layer fires at `git commit` via a pre-commit hook. No false silence.

v0.1 boundary: agents must actively call Cairn tools for their write intent to be visible. Agents that operate purely at the filesystem layer without calling Cairn are transparent to it. This is documented as an explicit limitation, not papered over.

### Reversible state / 状态可逆

Cairn checkpoints the working directory and git HEAD on demand. Rewind supports a `paths` parameter for selective restore (roll back `src/` but leave `docs/` and scratchpad untouched). Every destructive operation is preceded by an automatic `auto:before-*` checkpoint. Preview before rewind shows exactly what will change and what will not.

v0.1 covers L0 (full file tree), L1 (paths subset), and L2 (scratchpad). Agent conversation history, tool call traces, and agent internal state (L3–L6) are v0.2 work, and that boundary is stated explicitly in every rewind response.

### Dispatchable intent / 需求可派

The user describes their intent in natural language. Cairn retrieves relevant scratchpad and checkpoint history, selects the best available active agent, generates a prompt with the historical context attached, and presents it for the user's review before forwarding. Cairn exits after forwarding. It does not track whether the agent executes correctly.

### Message reachability / 消息可达

Subagents write their complete results to a shared scratchpad (`cairn.scratchpad.write`) before exiting. The main agent reads from scratchpad (`cairn.scratchpad.read`) rather than from its own context window. The full text is always available regardless of how much context compression has occurred. v0.2 will add semantic diff between the subagent's original report and the main agent's restatement.

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

### 8 MCP tools (v0.1 wedge, W1+W2, fully shipped)

| Tool | Semantics |
|---|---|
| `cairn.scratchpad.write(key, content, [task_id])` | Persist a named note to SQLite. Supports `task_id` slicing for multi-task isolation. Auto-creates an `auto:before-scratchpad-write` checkpoint before writing. |
| `cairn.scratchpad.read(key, [task_id])` | Read a named note verbatim, uncompressed. |
| `cairn.scratchpad.list([task_id])` | List all notes, optionally filtered by `task_id`. |
| `cairn.scratchpad.delete(key, [task_id])` | Delete a named note. Completes the CRUD set. |
| `cairn.checkpoint.create(label, [task_id])` | Snapshot the working directory and git HEAD. Two-phase commit: PENDING → READY. |
| `cairn.checkpoint.list([task_id])` | List checkpoints, optionally filtered by `task_id`. |
| `cairn.rewind.to(checkpoint_id, [paths])` | Restore to a checkpoint. Supports `paths` for selective restore. Auto-creates an `auto:before-rewind` checkpoint first. |
| `cairn.rewind.preview(checkpoint_id, [paths])` | Preview what a rewind would change and what it would leave alone. Dry-run, no side effects. |

The `task_id` field on scratchpad and checkpoint provides soft partitioning: all data from a given task shares the same `task_id`, making it filterable across tools. The daemon does not enforce or assign `task_id` values — the host agent generates them and passes them through.

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
  │   ┌──────────────┐  MCP stdio  │     8 tools (shipped)        │ │
  │   │ Cursor / etc.├────────────►│   + N tools (v0.1 roadmap)   │ │
  │   │ (Agent B)    │◄────────────┤                              │ │
  │   └──────────────┘             └──────────┬───────────────────┘ │
  │                                           │ function call        │
  │                                           ▼                      │
  │                            ┌─────────────────────────────────┐  │
  │                            │        cairn daemon             │  │
  │                            │     packages/daemon/            │  │
  │                            │                                  │  │
  │                            │  repositories/                   │  │
  │                            │  scratchpad / checkpoints        │  │
  │                            │  processes / conflicts           │  │
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

v0.1 has no release packaging. This is an early-access / dogfood build. You clone, build, and wire up `.mcp.json` manually.

### Prerequisites

- Node.js >= 24
- Git
- Claude Code with MCP support (`.mcp.json` configuration)

### Build

```bash
git clone https://github.com/Upp-renlab/Cairn.git
cd Cairn

# Build the daemon (output goes to packages/daemon/dist/)
cd packages/daemon
npm install
npm run build

# Build the mcp-server
cd ../mcp-server
npm install
npm run build
```

### Wire up Claude Code

Add to your project's `.mcp.json` (or your global Claude Code MCP config):

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

For full engineering conventions (commit style, test commands, monorepo structure, push instructions), see [`CLAUDE.md`](CLAUDE.md).

### Run tests

```bash
cd packages/daemon && npm test        # 67 tests
cd packages/mcp-server && npm test    # 9 tests (8 acceptance + 1 stdio smoke)
```

---

## What Cairn is not

These are boundary definitions, not disclaimers. Any design or feature request that violates these can be vetoed directly by reference to this list.

1. **Cairn is not an agent.** It does not execute development tasks, write code, open PRs, or edit files. For development work, use an agent. Not Cairn.

2. **Cairn is not a dashboard.** You do not need to monitor 10 agents simultaneously in a grid view. That was an earlier design direction that was abandoned. The current UX model is ambient and CLI-first.

3. **Cairn is not a desktop pet.** A v1 concept had an anthropomorphized desktop companion. v2 dropped it. The v0.2 Floating Marker is a static visual carrier for the Inspector channel, not an animated character.

4. **Cairn is not an agent framework or SDK.** It is a product for end users, not a library for developers building agents.

5. **Cairn is not another Claude Code skin.** Claude Code is one of Cairn's "applications." Cairn is the coordination kernel below it.

6. **Cairn does not do cross-machine collaboration (v0.1).** Local-first. All data stays on your machine. Cross-machine sync is v0.3+.

7. **Cairn does not proxy your agents' external calls.** There is no HTTP proxy, no Recorder/Classifier/Reverter pipeline, no compensation engine for SaaS API side effects. That was a previous product direction (pre-v2) that was replaced by the current Agent OS positioning.

---

## Roadmap

### v0.1 (in progress, W1–W12 2026)

- W1+W2 complete: 8 MCP tools, SQLite persistence, git-stash checkpoint backend, task_id isolation
- W2 complete: PoC-1 (SQLite concurrency) + PoC-2 (git hook latency) both PASS
- W3: pre-implementation validation wrap-up (PoC-4 dogfood, D-1 research)
- W4–W7: four-capability v1 build — conflict detection, process bus, Dispatch NL, Inspector query
- W8–W10: integration, hardening, acceptance criteria verification
- W11–W12: release packaging, onboarding polish

### v0.2

- **Floating Marker** — persistent ambient desktop UI (Tauri; right-corner float panel with three visibility modes). This is the primary v0.2 UX investment.
- **Path (b): Task tool wrapper** — stronger CC subagent integration for message reachability
- **Echo diff / reverse summary** — semantic diff between subagent original output and main agent restatement
- **Inspector panel UI** — conflict history, checkpoint timeline, scratchpad browser
- L3–L5 checkpoint granularity (conversation truncation, tool call traces, agent internal state)

### v0.3+

- Cross-machine collaboration (multi-daemon sync, likely CRDT-based)
- Non-MCP-aware agent integration (Cursor, Cline without `.mcp.json` — wrapper/sidecar path, pending D-1 research)
- Large-concurrency optimization (N=50 SQLite ceiling documented in PoC-1, addressed here)
- Multi-user shared daemon

---

## The name

A **cairn** (n.) is a stack of stones placed on a path to mark where someone has been — a waypoint, a direction indicator, a record that someone passed this way. In Tibetan Buddhist tradition, cairns (玛尼堆) mark sacred routes and accumulate over generations of travelers.

The name fits the function. Cairn marks the path your agents walked, records what they changed, and gives you a way back if the path was wrong. It does not walk the path for you.

The v0.2 Floating Marker is the desktop expression of this same idea: a small, persistent marker on your screen that shows the state of your agent coordination layer, the way a cairn on a trail shows you how far you have come and whether you are still on course.

---

## Documentation map

| Document | Contents |
|---|---|
| [`PRODUCT.md`](PRODUCT.md) | Product definition v2: positioning, four capabilities, user stories, roadmap, anti-definitions, UX forms |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Implementation architecture: system diagram, process model, monorepo structure, SQLite schema, MCP tool list, ADRs, known technical debt |
| [`CLAUDE.md`](CLAUDE.md) | Engineering conventions: push workflow, Node/SQLite version constraints, commit style, test commands, monorepo build rules |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Weekly plans, PoC result reports, pre-implementation validation tracking |

---

## Contributing

There is no formal contribution process yet. If you are in the early-access group, open an issue or reach out directly.

Commit conventions follow [Conventional Commits](https://www.conventionalcommits.org/): `feat / fix / chore / docs / test` + short English body. No `Co-Authored-By` trailers. No emoji in commit messages. See [`CLAUDE.md`](CLAUDE.md) for the full style guide.

## License

No LICENSE file is present in the repository yet. The codebase is source-available. Do not distribute or use in production without explicit permission from the authors.

<!-- TODO for user: decide on license (MIT / Apache 2.0 / source-available with eventual open-source) and add a LICENSE file at repo root. The old README listed "likely Apache 2.0 for core, commercial for enterprise features" as TBD — that decision is still open. -->
