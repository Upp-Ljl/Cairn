# Cairn — Road to Production

> Last updated: 2026-05-11
> Status: MVP Quick Slice delivered. Pushing to production-ready.

## North Star

Cairn is usable by team members (all on Claude Code) managing real projects.
Distributable: Windows `.exe` + Mac `.dmg` + `npm install`.
Live testbed: **Agent Poker Arena** (`arean.renlab.ai`) — Cairn manages its development end-to-end.

---

## Current State (as of 2026-05-11)

| Layer | Status |
|---|---|
| Kernel (28 MCP tools, 8 state objects, 10 migrations) | ✅ Done |
| Product MVP — desktop panel + tray + Live Run Log | ✅ Done |
| Managed project loop (profile / iterate / prompt / evidence / review) | ✅ Done (21/21 dogfood PASS) |
| Panel UI — Managed Loop card DOM wiring | ❌ Modules exist, not connected |
| Packaging — Windows .exe / Mac .dmg | ❌ Not done |
| npm publish prep | ❌ Not done |
| Team onboarding (cairn install stable) | ❌ Needs hardening |
| Full demo on Agent Poker Arena | ❌ Backbone done, UI missing |

---

## Phase Plan

### Phase 0 — Workflow docs (current)
Write `docs/workflow/` methodology: grill protocol, plan format, auto-ship hooks, teamwork dispatch, review loop.
**Done when:** all 5 workflow docs written and committed.

### Phase 1 — Panel UI wiring
Wire the Managed Loop card in `panel.html`: Start / Generate Prompt / Attach Report / Collect Evidence / Review.
No new MCP tools. No new migrations. Pure IPC + DOM.
**Done when:** user can open panel, register agent-game-platform, start an iteration, and see the full loop without touching a script.

### Phase 2 — Team usability + packaging
- `cairn install` hardened for team members (idempotent, clear error messages)
- Windows `.exe` via electron-builder (already in desktop-shell)
- Mac `.dmg` — cross-compile or CI build
- npm publish checklist for `@cairn/mcp-server`
**Done when:** a teammate can install and run Cairn in under 5 minutes with zero prior context.

### Phase 3 — Agent Poker Arena full demo
Run a complete Cairn-managed loop on the live platform:
register → iterate → CC does real work → report attached → evidence collected → review verdict → next round.
**Done when:** one full round of real (non-fixture) development on agent-game-platform is managed and visible in the Cairn panel.

### Phase 4 — Polish + release
Fix everything found in Phase 3. Write user-facing README, install guide, and changelog.
Tag v0.1 release. Push packages.

---

## Testbed: Agent Poker Arena

- **Repo:** https://github.com/anzy-renlab-ai/agent-game-platform (private)
- **Local:** `D:/lll/managed-projects/agent-game-platform`
- **Stack:** Next.js + Bun + Supabase + Sentry + MCP SDK
- **Live:** https://arean.renlab.ai (Vercel)
- **Tests:** 242 passing (`bun test`)
- **Last commit:** `de6875c feat(sound): drama-tag fanfares per tone`

Cairn's job on this project: manage the development loop (not write code, not deploy, not push).
