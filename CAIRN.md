# Cairn

> Per-project policy file for Cairn Mentor. Cairn dogfoods Cairn — this
> is the dogfood instance that the v0.3 scanner reads when the panel
> watches this repo. Schema reference: `docs/CAIRN-md-spec.md`.

## Goal

Ship the host-level multi-agent coordination kernel + project control surface that lets a programmer (or non-developer) walk away from a long-horizon multi-agent coding project and trust the work to continue without losing context.

## What this project IS / IS NOT

- IS: a host-level coordination kernel for agent / subagent work (`processes` / `tasks` / `dispatch_requests` / `scratchpad` / `checkpoints` / `conflicts` / `blockers` / `outcomes`)
- IS: a project control surface (desktop side panel + tray + floating marker + Live Run Log)
- IS: an MCP server (`cairn-wedge`) consumed by Claude Code / Cursor / Codex / Aider
- IS NOT: an agent
- IS NOT: a coding agent
- IS NOT: an IDE
- IS NOT: a task daemon
- IS NOT: a Linear / Jira / Asana clone
- IS NOT: a generic agent framework

## Mentor authority (decision delegation)

- ✅ retry transient test failures up to 2x
- ✅ pick TypeScript over JavaScript when blocker asks "which language"
- ✅ use vitest (real DB, no mocks) when blocker asks "which test framework"
- ✅ propose a CLAUDE.md / docs note when the user asks about a non-obvious local convention
- ⚠️ reduce a task time budget when 80% elapsed and progress visible
- ⚠️ extend a task time budget by 30% on the first request
- ⚠️ swap haiku ↔ sonnet for an auxiliary LLM helper to save cost
- 🛑 npm publish
- 🛑 force-push to main
- 🛑 amend any pushed commit
- 🛑 delete a remote branch
- 🛑 LICENSE edit
- 🛑 add a new npm dependency
- 🛑 edit PRODUCT.md anti-definitions
- 🛑 change canonical positioning (project control surface + kernel)
- 🛑 introducing a new MCP tool
- 🛑 modifying a landed migration

## Project constraints

- no new npm dependencies (Cairn keeps a small surface)
- tests hit a real DB, not mocks
- desktop-shell stack frozen: Electron 32 + native HTML/CSS/JS + better-sqlite3 — no React / Vue / Svelte / Tailwind / Vite / TypeScript in desktop-shell
- desktop-shell is strict read-only (D9 lock) — no mutation buttons unless `CAIRN_DESKTOP_ENABLE_MUTATIONS=1`
- commit messages: conventional commits in English; no `Co-Authored-By: Claude` trailer
- worktree discipline: every non-trivial change runs in `.cairn-worktrees/<slug>/`
- never `--no-verify` / `git reset --hard` / force operations without explicit user authorization

## Known answers

- which test framework => vitest (Phase 5+ convention) — real DB, no mocks; for desktop-shell smokes write `.mjs` scripts under `packages/desktop-shell/scripts/`
- which language => TypeScript for daemon + mcp-server; CommonJS .cjs for desktop-shell
- next migration number => see CLAUDE.md "已落地约定" — currently 011
- where do tasks live => `tasks` + `blockers` + `outcomes` (W5 Task Capsule, 3-table combo)
- where does mentor write nudges => `scratchpad:mentor/<pid>/nudge/<ulid>`
- where does mentor write escalations => `scratchpad:escalation/<pid>/<ulid>` with status PENDING

## Current phase

**Last updated**: 2026-05-13
- Phase: Mentor 3-layer decision architecture
- This week: ship CAIRN.md + agent_brief + 3-layer rules D/E/G + dogfood
- Next week: monitor live tick decisions; refine matcher / staleness window from real usage

---

## For Cairn-aware coding agents

If you are a coding agent (Claude Code / Cursor / Codex / Aider) working
inside this repo with Cairn attached, the following protocol applies:

1. **Read this file** at session start. Treat the IS/IS NOT and Mentor
   authority sections as policy from the project owner.
2. **Before raising a blocker** (calling `cairn.task.block`), first write
   a brief to scratchpad key `agent_brief/<your-agent-id>`. Format:

   ```json
   {
     "version": 1,
     "agent_id": "<your-cairn-session-agent-id>",
     "task_id": "<current task_id if any>",
     "summary": "what you're trying to do right now (≤ 150 words)",
     "stuck_on": "what's blocking you (≤ 80 words)",
     "options_considered": ["option A", "option B"],
     "lean": "your current preference + why",
     "written_at": <Date.now()>
   }
   ```

   Cairn Mentor reads this brief as L2 input to its decision and may
   resolve the blocker without paging the user.
3. **Subagent results** still write to `subagent/{agent_id}/result` per
   `docs/cairn-subagent-protocol.md`. The agent_brief is the *self-summary*
   from the main agent's perspective; it's about *you*, not your
   subagents.
4. The scratchpad key `project_profile/<project_id>` is Mentor's cache of
   this file — do not write to it from the agent side.
