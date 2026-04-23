# Cairn

> **Undo for agents.** 让你敢让 AI 干活。

![status](https://img.shields.io/badge/status-early--development-orange)

**Cairn is the safety net for agents** — let the AI do the work without piling on restrictions or watching every step. If something goes wrong, roll it back. Every action is recorded. What can't be undone, Cairn will tell you honestly.

---

## You are probably using AI like this right now

You open Claude Code or Cursor, give the agent a task, and then — you hesitate. Not because the agent is bad at its job. Because there is no way back if it does something you didn't intend.

So you compensate with friction:

- **Add restrictions upfront.** "Don't touch this directory." "Ask me before opening a PR." "Read-only mode." "No `rm` commands." You cut capability in half just to feel safe.
- **Sit there and approve every step.** You wanted the AI to do the work. You ended up being the keyboard operator anyway.

Both approaches are the same thing: **using human effort to compensate for the absence of a rollback net.** The agent is capable of far more than you let it do, because you cannot trust what you cannot undo.

The root cause is narrow but concrete. File-layer mistakes are already solved — GitButler, Claude Code worktrees, and Dagger Container Use let agents make changes in isolation and discard them. But the moment an agent does something outside the file layer — opens a PR, runs a database migration, charges a Stripe customer, posts to Slack, writes to a SaaS — there is no unified tool to undo it. You are left hunting through logs and writing one-off rollback scripts per incident.

Cairn is not another agent tool. It replaces the mental model of "add restrictions and watch closely" as your primary risk management strategy.

---

## What Cairn does

Cairn sits between your agent and the outside world. Every time the agent makes an external call, Cairn handles three things:

**Record.** Every outbound call is logged to a per-agent lane — what was called, what changed, in what order.

**Classify.** Before the call goes out, Cairn categorizes it: pure read, idempotent write, reversible, or irreversible. The classification drives what happens next.

**Revert.** If something goes wrong, `cairn revert lane-X` unwinds all of that agent's external side effects in reverse order, using pre-registered compensation actions — GitHub PR closed, database row restored, Stripe charge refunded.

**Five promises Cairn keeps:**

1. **Honest Receipt** — every revert returns a structured receipt that separates "reverted," "partially reverted," and "could not revert, here's what happened." Exit code `0` means the reversible parts are confirmed gone. It does not mean the world is back to normal if irreversible side effects exist. Cairn says so explicitly.
2. **Atomicity** — one agent's calls are treated as an all-or-nothing unit. Revert either completes fully or is marked `partial-revert` and halts, forcing human review. No silent half-states.
3. **Reversibility** — calls are classified before they go out, not after. Compensation actions are registered at call time. You are not discovering what can't be undone after the fact.
4. **Isolation** — reverting one agent's lane does not touch another agent's lane. If two agents ran in parallel, rolling back one leaves the other intact.
5. **Semantic Consistency** — after a revert, the API-layer system-of-record state matches what it was before the agent started. Side effects beyond that boundary — emails sent, CI minutes consumed, notifications delivered — are outside what any tool can honestly promise, so Cairn enumerates them in the receipt instead of pretending.

**Honest Receipt is the first property, not one of five.** The others are sub-claims it backs up. What distinguishes Cairn from a naive "undo layer" is not that it can revert things — it is that it tells the truth about what it reverted.

Cairn is the compensation plane in your agent stack, the same way a control plane handles routing and a data plane handles traffic. It does one thing and does not expand into adjacent concerns.

---

## How it works

**Architecture**

```
                              [ Orchestrator ]
                                     │
              ┌──────spawn───────────┼──────────spawn───────┐
              ▼                      ▼                      ▼
       [ Subagent A ]         [ Subagent B ]         [ Subagent C ]
        code-agent             db-agent               notify-agent
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                 every external call│is proxied through Cairn
                                    ▼
              ╔═══════════════════════════════════════════╗
              ║                  C A I R N                ║
              ║   ┌─────────────────────────────────┐     ║
              ║   │  Recorder     (per-lane log)    │ ◀── timeline + handles
              ║   ├─────────────────────────────────┤     ║
              ║   │  Classifier   (① ② ③ ④)         │ ◀── gate decision
              ║   ├─────────────────────────────────┤     ║
              ║   │  Reverter     (compensations)   │ ◀── reverse-order unwind
              ║   └─────────────────────────────────┘     ║
              ║   ⏸ Approval Gate  — blocks ④ egress      ║
              ╚═══════════════════════════════════════════╝
                                    │
         ┌──────────┬────────────┬──┴───────┬───────────┬──────────┐
         ▼          ▼            ▼          ▼           ▼          ▼
      GitHub    Postgres      Stripe      Slack      Linear     Notion
```

**Key mechanisms**

- Single chokepoint — all agent outbound calls go through Cairn (MCP proxy + HTTP proxy)
- Per-agent lane isolation — each agent has an independent timeline; reverts do not interfere with each other
- Pre-egress classification — calls are categorized before they leave, not after
- Compensation handles registered at call time — when a call is allowed through, its rollback action is logged simultaneously
- Approval gate on irreversible operations — hard deletes, payouts, regulatory submissions block until you explicitly approve or deny

---

## The five properties

| Property | What it means |
|---|---|
| **Honest Receipt** | Receipt separates "reverted / partial / irreversible-acknowledged." Exit `0` is not a lie. |
| **Atomicity** | One agent's ops are all-or-nothing. Partial revert halts and flags. |
| **Reversibility** | Classification and compensation registration happen before the call goes out. |
| **Isolation** | Rolling back lane A does not touch lane B. |
| **Semantic Consistency** | Post-revert API state equals pre-agent API state. Out-of-boundary side effects are enumerated in the receipt, not silently omitted. |

The Reverter is not a thin wrapper around compensation API calls. It enforces five mechanisms on every step: invariant check, optimistic lock, idempotency key, a per-step and per-lane state machine, and structured receipt output. Any compensator that exits `0` without confirming state convergence is a product-level failure more dangerous than "can't undo." Cairn treats that as a regression, not an edge case.

---

## Modes: strict / acceptIrreversible / bypass

How Cairn handles calls classified as irreversible (class ④) is up to you, not the product. Three modes, analogous to Claude Code's permission modes:

| Mode | What happens on ④ calls | CC analog | Good for |
|---|---|---|---|
| **strict** (default) | Call is blocked, approval gate opens, you must explicitly approve or deny | CC default permission mode | First install, production environments, unfamiliar agents |
| **acceptIrreversible** | Call goes through with a prominent warning, logged as `accepted-irreversible` | CC `acceptEdits` | Users who know the agent's behavior and review receipts |
| **bypass** | Call goes through silently, still recorded to timeline | CC `bypassPermissions` | Sandboxes, personal repos, fully isolated environments |

One important difference from CC's bypass: **Cairn's bypass mode still records everything and preserves full revert capability on reversible operations.** CC bypass means no safety net. Cairn bypass means the safety net runs quietly without interrupting you.

Set mode in `~/.cairn/config.yaml`, or per-session: `cairn start --mode bypass` / `CAIRN_MODE=strict cairn start`.

---

## Example

A personal dev session, Friday afternoon. You ask Claude Code to add a `TODO.md` to a sandbox repo and open a PR for review, then go make coffee.

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  $ cairn lanes                                                              │
╰─────────────────────────────────────────────────────────────────────────────╯
pipeline  launch-team-tier-2026-04-21            T+180s   state: PAUSED

  LANE   AGENT          OPS  LAST WRITE              CLASS  STATUS
  ────   ───────────    ───  ────────────────────    ─────  ──────────────
  A      code-agent      5   POST /issues/842/..      ③     [PASS] running
  B      db-agent        5   COMMIT txn (3 writes)    ③     [WARN] data-loss risk on B.2
  C      notify-agent    6   POST stripe/prices       ③     [WARN] push fan-out on C.2
  O      orchestrator    1   PUT /pulls/842/merge     ④     [HOLD] approval gate open

╭─────────────────────────────────────────────────────────────────────────────╮
│  $ cairn revert lane-B --dry-run                                            │
╰─────────────────────────────────────────────────────────────────────────────╯
┌─ dry-run · no external calls will be issued ────────────────────────────────┐
│  step 1  B.5  rollback txn marker                         [PASS]           │
│  step 2  B.4  DELETE FROM team_seats WHERE id IN (12,13,14)                │
│  step 3  B.3  DELETE FROM pricing_tiers WHERE id = 7                       │
│  step 4  B.2  ALTER TABLE pricing_tiers DROP COLUMN new_tier   [WARN]      │
│               └─ destructive: column data will be lost                     │
│                                                                             │
│  cross-lane dependency scan:                                                │
│   [WARN] lane A.3 writes `pricing.ts` referencing column `new_tier`         │
│          reverting B alone will leave PR #842 failing CI                    │
└─────────────────────────────────────────────────────────────────────────────┘

╭─────────────────────────────────────────────────────────────────────────────╮
│  $ cairn revert lane-B --confirm                                            │
╰─────────────────────────────────────────────────────────────────────────────╯
▸ acquiring lane-B write lock ........................................ [PASS]
▸ freezing lane-A and lane-C (inbound proxy paused) .................. [PASS]
▸ executing compensations (reverse order)
    B.5  rollback marker ............................................. [PASS]  18ms
    B.4  DELETE FROM team_seats (3 rows) ............................. [PASS]  42ms
    B.3  DELETE FROM pricing_tiers WHERE id=7 ........................ [PASS]  11ms
    B.2  ALTER TABLE DROP COLUMN new_tier ............................ [PASS] 204ms
▸ resuming lane-A, lane-C inbound proxy .............................. [PASS]

┌─ revert complete ───────────────────────────────────────────────────────────┐
│  lane A   ③ running     (untouched, 5 ops retained)                         │
│  lane B   ↩ reverted    (5 ops compensated, schema restored)    [PASS]      │
│  lane C   ③ running     (untouched, 6 ops retained)                         │
│  lane O   ⏸ still held at approval gate O.1                                 │
│                                                                             │
│  note: PR #842 in lane A now fails CI (refs dropped column).                │
│        run `cairn revert lane-A` or push a fix to `feat/team-tier`.         │
└─────────────────────────────────────────────────────────────────────────────┘
```

The receipt shows what was reverted and what wasn't. If the agent had sent an email notification to a reviewer, it would appear in `irreversibleSideEffects` — Cairn tells you it went out and that you may want to send a follow-up manually. It does not pretend it can recall an email.

---

## Installation

```bash
# Install Cairn as a local daemon
brew install cairn   # macOS (planned)
# or
curl -fsSL https://cairn.dev/install.sh | sh   # any platform (planned)

# Start the daemon
cairn start
```

Cairn runs entirely on your local machine. Your agents point to:
- MCP: `localhost:7777` (stdio or SSE)
- HTTP proxy: `http://localhost:7778`

No data leaves your machine unless you explicitly configure cloud sync (v0.3+).

**v0.0.1 Preview** is in development. The preview targets a single external target (GitHub sandbox repo) with the full `record → classify → revert` pipeline, the five-mechanism compensator engine, and three fault injection scenarios in CI. See the Status section for the success criteria.

---

## Integrations

Works with any agent framework that supports an MCP server or HTTP proxy:

- **Claude Code** — add Cairn as MCP server in `~/.claude/settings.json`
- **Cursor** — configure MCP in Cursor settings
- **LangGraph / CrewAI** — middleware / callback integration (planned v0.2)
- **GitButler Agents** — drop-in next to virtual branches (planned v0.2)

---

## Status

**v0.0.1 Preview in development.** Not yet usable in production.

Preview scope: one external target (GitHub sandbox repo), HTTP proxy only, CLI only, no web UI, no HTTPS MITM. Full compensator engine with fault injection.

**Success criteria for v0.0.1 Preview:**
- A developer who did not write Cairn can install it and run the demo in under 10 minutes
- Screencast reaches at least one of: 100 GitHub stars / 1k video views / 3 unsolicited issues from non-authors
- All three fault injection scenarios pass in CI: `F-invariant` (incomplete before-image), `F-optlock` (concurrent modification conflict), `F-midstep` (mid-compensation failure producing `partial-revert`)

**Planned compensation targets for v0.1 MVP:**
- Local filesystem (write / delete / move)
- Local HTTP requests (generic)
- Local SQLite / Postgres (via Docker)
- GitHub API (PR / issue / branch operations)
- Stripe (test mode)

**Stretch (v0.2+):** Slack, Linear, Notion, MongoDB, S3, Kafka, Redis, Elasticsearch, BigQuery.

---

## Project structure

```
cairn/
├── README.md           # This file
├── IMPLEMENTATION.md   # Engineering implementation doc (single source of truth)
├── mockups/            # UI mockups
│   └── timeline.html   # Web timeline preview
├── cmd/                # CLI + daemon entry points (planned)
├── recorder/           # MCP + HTTP proxy (planned)
├── classifier/         # Four-class classification engine (planned)
├── reverter/           # Compensating action library (planned)
└── adapters/           # Per-target adapters (planned)
```

---

## Roadmap

- **v0.0.1 Preview (now):** GitHub sandbox, HTTP proxy, CLI, full compensator engine, fault injection CI
- **v0.1 MVP (0-3 months):** Local-first full pipeline — filesystem + local HTTP + SQLite/Postgres + GitHub + Stripe test mode; MCP proxy; web timeline
- **v0.2 (3-6 months):** LLM fallback classifier; 15 adapter targets; web approval UI; LangGraph / GitButler integrations
- **v0.3 (6-12 months):** Team mode — multi-user approval, role-based policy, SIEM export, self-hosted option
- **v0.4 (12+ months):** Enterprise — SSO, SOC2 Type II, on-prem, policy-as-code

See `IMPLEMENTATION.md` for the engineering plan and the positioning document for the full roadmap.

---

## Docs

- `IMPLEMENTATION.md` — engineering implementation doc, single source of truth for architecture and build plan
- `mockups/timeline.html` — UI mockup for the lane timeline view
- Positioning document is at `~/.claude/plans/agent-gitbutler-b-partitioned-feather.md` (private)

---

## License

TBD — likely Apache 2.0 for core, commercial for enterprise features.

---

## Contact

TBD
