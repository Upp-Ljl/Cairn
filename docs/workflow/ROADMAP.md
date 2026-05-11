# Cairn — Road to Production

> Last updated: 2026-05-11
> Status: Kernel + Product MVP + Operations Layer (Mode A/B) all shipped.
> Active gap: packaging, release prep, live demo.

## North Star

Cairn is usable by team members (all on Claude Code) managing real projects.
Distributable: Windows `.exe` + Mac `.dmg` + `npm install`.
Live testbed: **Agent Poker Arena** (`arean.renlab.ai`) — Cairn manages its development end-to-end.

---

## Verified Current State (audit as of 2026-05-11)

| Layer | Tests | Verified |
|---|---|---|
| Daemon (storage / repos / migrations) | 411 / 29 files | ✅ all green |
| MCP-server (28 tools + integration) | 343 / 18 files (1 skip) | ✅ all green |
| Panel UI Managed Loop card | smoke 60/60 | ✅ wired in panel.html:2005-2074 |
| Mode B Continuous Iteration | smoke 42/42 + boundary 43/43 + actions 47/47 | ✅ ready |
| Mode A Mentor | smoke 109/109 + dry-run on agent-game-platform PASS | ✅ ready |
| Managed loop on agent-game-platform | dogfood 21/21 | ✅ live testbed works |

The Phase 1 / 2 / 3 I originally enumerated were already done in earlier sprints. Real gaps follow.

---

## Active Phases

### Phase 4 — Packaging + v0.1 release prep (current)
- Add `electron-builder` config to `packages/desktop-shell/package.json`
- Produce Windows NSIS `.exe` installer
- Write Mac `.dmg` config (build needs Mac or CI)
- Harden `cairn install` CLI for fresh-clone teammate setup
- Remove `"private": true` from `packages/mcp-server/package.json` (npm publish prep) — requires user approval
- Tag `v0.1.0` — requires user approval

### Phase 5 — Live Run Log (Later, not time-bound)
Per PRODUCT.md v3 §12 D10 the project no longer ships version-numbered roadmaps (no "v0.2" / "v0.3"). The plan file (`docs/superpowers/plans/2026-05-29-v0.2-live-run-log.md`) keeps its original filename for traceability, but the **content** is Later-scope, not a versioned release.
Gated on Phase 4 finishing.

### Phase 6 — Agent Poker Arena full demo
Run one complete real-Claude-driven loop on the live platform: Mentor recommends → user picks candidate → Mode B Scout/Worker/Review chain → fix lands in agent-game-platform → next round.

---

## Workflow

All new work follows `docs/workflow/README.md`:
- GRILL before plan
- DUCKPLAN before implement (`HOWTO-PLAN-PR.md`)
- TEAMWORK for parallel work (worktrees + N+1+2N pattern)
- FEATURE-VALIDATION before push (1+2+3 cross-engine)
- AUTOSHIP to land
- POSTPR loop until reviewer silent
- PR-PLAN for fix iterations
- SELF-REPORT-STOP 12-field self-check per turn

---

## Testbed: Agent Poker Arena

- **Repo:** https://github.com/anzy-renlab-ai/agent-game-platform (private)
- **Local:** `D:/lll/managed-projects/agent-game-platform`
- **Stack:** Next.js 16 + Bun + Supabase + Sentry + MCP SDK
- **Live:** https://arean.renlab.ai (Vercel)
- **Tests:** 242 passing (`bun test`)

Cairn's job on this project: manage the development loop (read project signals, recommend candidates, dispatch workers, collect evidence, review). Cairn does NOT write code in agent-game-platform.
