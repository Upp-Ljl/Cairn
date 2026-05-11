# Cairn Workflow — Index

> Faithful adaptation of the TeamBrain "grilled idea → merged code" pipeline,
> adapted for: (a) we are NOT starting from scratch — Cairn has 28 MCP tools,
> kernel, product MVP already shipped; (b) this machine has no `codex`, no
> `claudefast`, no `tmux`. Two-engine cross-validation uses `claude` CLI +
> Agent subagents instead.

---

## Pipeline Overview

```
grilled idea
   │
   ▼  GRILL.md — Claude grills until intent is unambiguous
DUCKPLAN (plan / expected outputs / how-to-verify / probes)
   │
   ▼  HOWTO-PLAN-PR.md — write the plan with verify hands
TEAMWORK dispatch (N sonnet workers + 2N probes + 1 opus reporter, in git worktrees)
   │
   ▼  TEAMWORK.md — parallel work without conflicts
Feature validation 1+2+3 (claude probe → second engine → real run, JSON hard-match)
   │
   ▼  FEATURE-VALIDATION.md — cross-engine evidence
local green (tests + typecheck + smoke + dogfood)
   │
   ▼  AUTOSHIP.md — push to feature branch, open PR
PR opened
   │
   ▼  POSTPR.md — auto-review loop until reviewer silent/👍
Codex / subagent review → fix in same PR (no follow-up issue punt) → re-push
   │
   ▼  PR-PLAN.md — fix planning when review finds issues
Stop conditions: CI green + no conflict + reviewer silent or 👍
   │
   ▼
auto-merge
```

---

## Documents

| File | Purpose | Maps to TeamBrain |
|---|---|---|
| `ROADMAP.md` | Current state → production maturity, 6 phases | (project-specific) |
| `GRILL.md` | Grill until intent unambiguous | (project-specific) |
| `HOWTO-PLAN-PR.md` | DUCKPLAN four-section plan format | `docs/HOWTO-PLAN-PR.md` |
| `TEAMWORK.md` | N+1+2N parallel dispatch, git worktrees, opus reporter | `docs/TEAMWORK.md` |
| `FEATURE-VALIDATION.md` | 1+2+3 cross-engine validation (Cairn adaptation) | TeamBrain Feature validation 1+2+3 (claudefast → codex exec → tmux) |
| `AUTOSHIP.md` | Commit + push + PR (auto-authorized) | (project-specific) |
| `POSTPR.md` | Auto-review loop until reviewer silent | `docs/POSTPR.md` |
| `PR-PLAN.md` | Fix planning after review finds issues | `docs/PR-PLAN.md` |
| `SELF-REPORT-STOP.md` | 12-field self-check at end of each turn | TeamBrain Self-Report Stop hook |

---

## What TeamBrain Has That Cairn Adapts

| TeamBrain | This machine status | Cairn adaptation |
|---|---|---|
| `codex` CLI for second-engine review | ❌ not installed | `claude --model haiku/sonnet -p` as a second invocation, OR Agent subagent (different context) |
| `claudefast -p` for fast JSON probe | ❌ not installed | `claude --model haiku -p` (cheap, fast) |
| `tmux` interactive evidence | ❌ Windows | Direct `Bash` with output capture |
| `gh` CLI for PR ops | ❌ not installed | GitHub REST API via `curl` + PAT |
| `.codex/worktrees/<task>` | (TeamBrain convention) | `.cairn-worktrees/<task>` via `git worktree add` |
| Codex bot review per push | ❌ no bot | Manual: dispatch Agent (`general-purpose`) for review after push |

---

## Where We Differ From TeamBrain "From Scratch"

We are NOT a greenfield project:

- Cairn has 28 MCP tools, 10 migrations, 411 daemon tests, 343 mcp-server tests passing
- Mode A Mentor, Mode B Continuous Iteration, Mode C Multi-Cairn handlers all exist
- Panel UI for Managed Loop is wired
- Live testbed (agent-game-platform) has working dogfood

So we apply TeamBrain workflow to:
- New features we're adding (packaging, Live Run Log — Later-scope per PRODUCT.md v3 §12 D10, live demo)
- Bugs found via testbed
- Polish for v0.1 release

We do NOT need TeamBrain's "Walking Skeleton" Milestone discipline because we are not building from scratch. We DO need TeamBrain's PR review loop because every new PR going forward should follow it.
