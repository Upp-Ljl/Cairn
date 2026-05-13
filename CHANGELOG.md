# Changelog

All notable changes to Cairn are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/).

---

## [0.2.0-cockpit-redesign] — 2026-05-14 (Unreleased — push blocked on PAT scope)

**17-constraint cockpit redesign + Mode B Continuous Iteration v1.**

CEO 4-round grill defined 17 product约定 ("完整掌控感")；全 17 closed. Module order locked in spec: M1 State / **M2 Mentor + Todolist** / M3 Steer (session dropdown) / M4 **Sessions** (idle 一等公民 + L2 timeline drill-down) / M5 Safety. Mode B (走开就行) shipped v1 across 5 slices.

### What's new

- **M2 Mentor module** — primary first-class, status header (state · last nudge · today's decisions · 🛤 lanes · needs review)
- **M2 Todolist** — 3 sources (🤖 agent self-propose / 🧑‍🏫 Mentor / 🐤 user), `[派给]` / `[Approve]` write `dispatch_requests` (kernel R1-R6); batch-select → lane
- **M3 Steer per-session dropdown**
- **M4 Sessions module** — replaces Activity Feed; click → L2 timeline drill-down
- **L2 Session Timeline** — chronological agent events, subagent缩进 tree, checkpoint Rewind anchors; scratchpad `session_timeline/<agent>/<ulid>` namespace
- **🛤 Mode B Continuous Iteration v1** — 5 slices: lane data layer + UI module + tick auto-detect WAITING_REVIEW + "+ New lane" form + batch-from-todos
- **First-launch onboarding wizard** — 3 screens for non-dev users
- **Kernel auto-instrumentation** — task tools auto-write session_timeline events (`source: 'kernel'`); agents without skill adoption still produce timeline data
- **Rule C off-goal drift** — LLM-judged, prompt-tuned, strict-mode for high-confidence
- **Session 人话命名** — new MCP tool `cairn.session.name` (#29)
- **B-track ship pipeline** — GH Actions release.yml + extraResources mcp-server bundle + icon.icns
- **Workflow rules** — SELF-REPORT-STOP fields 13/14/15 (mid-run report / push-block / subagent-running anti-patterns)

### MCP tools: 29 (was 28). New: `cairn.session.name`.

### Tests

daemon 411 / mcp-server 424 / desktop-shell smokes ~410 assertions / dogfood ~84 / real-LLM Rule C 9/9. Real-agent dogfood: live `~/.cairn/cairn.db` has 9 session_timeline + 3 agent_proposals + 1 lane PENDING.

### Hard blocker

`git push` rejected — PAT lacks `workflow` scope. 41 commits queued. Resolve at https://github.com/settings/tokens.

---

## [0.3.0-mentor-3layer] — 2026-05-13 (Unreleased)

**Mentor becomes team lead — 3-layer decision via CAIRN.md + agent_brief.**

Default flips from *escalate-when-uncertain* to *decide-by-policy*; the user's confidence comes from cockpit Module 4's cheap rewind (see memory `trust-with-rewind-safety`). Mentor coordinates, doesn't think on its own — its judgment basis is layered:

| Layer | Source | Cost |
|---|---|---|
| **L1** | per-project `CAIRN.md` (the project owner's voice) | $0 |
| **L2** | `scratchpad:agent_brief/<agent_id>` (agent self-summary written before raising a blocker) | $0 |
| **L3** | optional haiku-class LLM polish via `cockpit-llm-helpers.runHelper` | ~$0.0005 |

### What's new

- **`docs/CAIRN-md-spec.md`** — canonical schema for the new per-project policy file (Goal · IS/IS NOT · ✅/⚠️/🛑 Mentor authority · constraints · known answers · current phase). Routing logic + fallback table documented.
- **`packages/desktop-shell/mentor-project-profile.cjs`** — scanner + scratchpad cache (`project_profile/<pid>`). `loadProfile()` is mtime-gated so unchanged CAIRN.md doesn't re-parse. Helpers `matchBucket` (with token-overlap fallback for descriptive bullets) + `matchKnownAnswer`.
- **`packages/desktop-shell/mentor-agent-brief.cjs`** — read-only helpers for `scratchpad:agent_brief/<agent_id>`; staleness flag (>30 min default) + `briefSnippet()` one-liner for nudges.
- **`packages/desktop-shell/mentor-policy.cjs`** rules D/E/G refactored to consult the 3-layer:
  - L1.0 `known_answers` substring → cheapest nudge path (no LLM)
  - L1.1 `🛑 escalate` match → escalate
  - L1.2 `✅ auto_decide` → nudge silently, using L2 brief lean when available
  - L1.3 `⚠️ decide_and_announce` → same as ✅ but with `announce: true` flag for Activity feed
  - unmatched / no profile → conservative escalate (preserves Phase 5 behaviour)
- **`packages/desktop-shell/mentor-tick.cjs`** loads profile + briefs once per project per tick and threads them through `evaluatePolicy`.
- **`packages/mcp-server/src/cli/install.ts`** scaffolds `CAIRN.md` at the project root on first install — full template (all six sections plus "For Cairn-aware coding agents" subsection that documents the agent_brief protocol). Idempotent: existing CAIRN.md is preserved.
- **Repo dogfood**: this repo gets its own `CAIRN.md` with the v0.3 policy filled in. Cairn dogfoods Cairn.

### Tests / Dogfood

- `packages/desktop-shell/scripts/smoke-mentor-3layer.mjs` — **64/64 assertions PASS** covering scanner, missing-file fallback, profile cache mtime-gated reuse, agent_brief read+staleness, Rule D × 6 routes (known_answer / 🛑 / ✅ / ⚠️ / unmatched / legacy), Rule E × 2, Rule G × 3, routeBySignal helper.
- `packages/desktop-shell/scripts/dogfood-llm-3layer.mjs` — real haiku call exercising the L3 polish prompt with profile + brief + question; INFRA-OK grace for 429 / transient (same pattern as `dogfood-llm-tail-summary`). Skips when no provider key configured.
- Prior smokes green: `smoke-mentor-policy` 23/23, `smoke-mentor-tick` 16/16.
- mcp-server: 360 / 1 pre-existing skip — includes new install-CAIRN.md scaffold tests.

### Docs

- **PRODUCT.md §1.3.cockpit** patch: "Mentor is team lead via CAIRN.md authority delegation" subsection. Reaffirms §1.3 #1/#2/#4/#6 anti-definitions (no code-writing / not IDE / etc) still hold — CAIRN.md only widens Mentor's run-time event authority, not the canonical positioning.

### Out of scope (Later, not bound to a version)

- Onboarding wizard that walks non-dev users through filling out CAIRN.md
- Per-project Mentor "conservative-vs-aggressive" slider
- Multi-agent consensus (3 agents vote on a decision)
- Goal-change cascade (invalidate prior nudges when goal changes)
- Hard-wiring L3 polish into the synchronous policy path (plan §3 deliberately keeps L3 stubbed)

---

## [0.2.0-cockpit] — 2026-05-13 (Unreleased)

**Panel cockpit redesign — single-project mission-control surface.**

The L2 (single project) view is rebuilt from the v0.1 "5-tab feature museum" into a **driving-cockpit** layout: agent is the engine, Cairn is the dashboard + wheel + emergency brake + radio. The user can walk away; Cairn's Mentor keeps the agent on goal and only escalates when stuck.

### What's new

- **5 cockpit modules** in `view-cockpit`: state strip, steer-to-agent input box, time-ordered activity feed, rewind safety list, "needs you" escalation surface
- **Project tabs** above the modules — multi-project visibility preserved (5+ projects parallel)
- **Steer module** (Module 2): inject a message into the agent's live session via `scratchpad:agent_inbox/<agent>/<ulid>` + clipboard fallback (D9.1 tier-A first-class mutation)
- **Rewind module** (Module 4): preview + perform `git checkout <sha>` with safety stash, inline confirm dialog (D9.1 tier-B)
- **Mentor supervisor** (`mentor-policy.cjs`): 5 deterministic escalation rules (BLOCKED-question, time-budget, abort-keyword, error-repetition, outcomes-fail) — writes nudges to `scratchpad:mentor/<pid>/nudge/<ulid>`, escalations to `scratchpad:escalation/<pid>/<ulid>`
- **Mentor auto-tick** (`mentor-tick.cjs`): the engine — `setInterval(runOnce, 30s)` iterates projects → RUNNING tasks → fires rules D/E/G; rules B/F deferred until tail.log scanning lands
- **4 LLM helpers** (`cockpit-llm-helpers.cjs`): tail.log summary (low-cost ON), conflict diff explainer (low-cost ON), inbox smart-sort (high-cost OFF), goal-input assist (high-cost OFF). Per-project cost-posture settings in registry
- **Onboarding**: empty-state CTAs (Add project · Define goal · What is Cairn?) + in-panel README overlay; goal-required gate (no goal → Mentor doesn't tick)
- **Keyboard navigation**: `j`/`k` activity scroll, `/` focus steer, `?` open help, `Esc` back to projects
- **PRODUCT.md patches**: §0 audience expansion (programmer + non-developer equal); §1.3 cockpit architecture clause + PoC-3 boundary precision; §12 D9 rewritten to **D9.1 "responsible mutation"** 3-tier (visible/revokable / inline confirm / env-flag legacy)

### Fixes (live-dogfood discoveries)

- `[hidden]{display:none !important}` so `display:flex` author rules don't beat the `hidden` attribute (the ESC half-return bug, formerly PR #7)
- `cockpit-state.cjs`: query real `outcomes` columns (`evaluated_at`/`updated_at`/`created_at`); old code referenced non-existent `submitted_at` and threw on every getCockpitState call
- `cockpit-state.cjs`: filter DEAD agents out of cockpit `agents` list — historical sessions from past months no longer pollute the live count
- Layout: Module 3 (activity feed) gets the real estate via `flex: 1 1 0 + min-height: 260px`; other modules tightened
- DB path fallback: `/dev/null` and `(unknown)` registry sentinels resolve to the global default DB rather than rendering empty cockpit

### Tests

411 daemon + 359 mcp-server (pre-existing) — 16 (auto-tick) + 48 (cockpit-state) + 22 (steer) + 25 (rewind) + 23 (mentor-policy) + 30 (LLM helpers) + 53 (e2e dogfood) + 4 (real-LLM dogfood) = **1031 total green**. Real-LLM dogfood verified provider wiring end-to-end (hit http_429 today — infrastructure verified, content verification on next-rate-window).

### Known gaps (next phase)

- Mentor Rules A (LLM-judged ambiguity) and C (off-goal drift) — Phase-6 LLM hooks; current placeholders return `no_action_phase_5`
- Per-project settings UI — settings persist in `~/.cairn/projects.json` but no panel UI yet; manual JSON edit required
- Onboarding wizard for non-developer users — basic CTAs in place; guided walkthrough not built
- Tail.log scanning for Rules B/F (compile errors, abort keywords in raw agent output)

---

## [0.1.0] — 2026-05-12

**First public release.** The kernel + product surfaces required to manage agent work on a local machine are shipped and verified.

### What's in v0.1.0

#### Kernel layer — host-level multi-agent coordination
- **28 MCP tools** over stdio (`cairn.*` namespace): processes / tasks / scratchpad / checkpoints / conflicts / dispatch / blockers / outcomes
- **8 durable state objects** persisted in SQLite (10 migrations: 001–010)
- **Real Agent Presence v2**: per-session `cairn-session-<12hex>` IDs auto-injected; processes table holds one row per terminal session (no merging)
- **W4** processes / conflicts / dispatch with auto-injected agent IDs + R6 fallback rule
- **W5 Phase 1** Task Capsule lifeline (`tasks` table + 5 tools)
- **W5 Phase 2** Blockers + resume_packet (`blockers` table + 3 tools)
- **W5 Phase 3** Outcomes DSL + review/retry/terminal_fail loop (`outcomes` table + 3 tools + 7-primitive DSL stack)

#### Product layer — project control surface
- **Desktop side panel + tray** (Electron 32 + native HTML/CSS/JS + better-sqlite3)
- **Managed Loop card** (PR #4): register external project → start iteration → generate worker prompt → attach report → collect evidence → review verdict → next-round seed; all read-only against Cairn DB, all wired through `managed-loop-handlers.cjs` IPC
- **Mode A · Mentor**: on-ask advisor chat panel — reads project signals (docs / git / candidates / tasks / outcomes / reports), returns ranked work items with WHY + stakeholders + next_action + confidence; deterministic-skeleton + LLM-polish reasoning chain; multi-turn within a session
- **Mode B · Continuous Iteration**: executor under explicit user authorization — Scout → Worker → Review chain stops at REVIEWED; terminal decisions (accept / reject / merge / push) human-only
- Strict read-only by default; mutations gated behind `CAIRN_DESKTOP_ENABLE_MUTATIONS=1`

#### Installer & onboarding
- **`cairn install` CLI** (PR #3): writes `.mcp.json`, installs pre-commit hook (sidecars if a non-cairn hook exists), generates `start-cairn-pet.bat`/`.sh` launchers. Idempotent.
- **CLI flags**: `--help` / `-h`, `--version` / `-V`, `--dry-run` — all short-circuit before any file write. Unknown flags exit 2 with usage hint.
- **README onboarding** (PR #4): CLI flag reference + verify-install steps for teammates.

#### Packaging (PR #2)
- **electron-builder** config in `packages/desktop-shell/package.json` (NSIS for Windows, dmg for macOS).
- **Windows installer**: `npm run dist:win` → `dist/Cairn Setup 0.1.0.exe` (~86 MB), per-user install (`%LOCALAPPDATA%`), oneClick=false, desktop + start-menu shortcuts.
- **macOS dmg**: config present; build requires macOS or CI (not built from current dev environment).
- **`build/icon.ico`** placeholder generated by `scripts/gen-placeholder-icon.mjs` (pure Node, no external dep). Designer asset is Later-scope.

#### Live testbed evidence
- **agent-game-platform** (`arean.renlab.ai`, real Next.js + Bun + Sentry + MCP-SDK app) managed end-to-end:
  - `dogfood-managed-project-loop` 21/21 PASS (read-only managed loop)
  - `dry-run-mentor-on-agp` PASS (Mentor returns 3 ranked items with WHY + confidence)
  - `dogfood-real-claude-managed-loop` 22/22 PASS — **real** Claude Code worker, sonnet model, audited test coverage and surfaced a real gap (`src/lib/engine/equity.ts` is the only engine module without a paired test file). Cairn captured the structured Worker Report, ran deterministic review, persisted iteration row, produced next-round seed — without mutating the target repo (HEAD unchanged, working tree clean) and without writing to the real `~/.cairn`.

#### Workflow methodology (`docs/workflow/`, PR pre-merge round)
TeamBrain-faithful pipeline adapted to this machine (no `codex` / `claudefast` / `tmux`):
- **GRILL** — force clarity before execution
- **HOWTO-PLAN-PR** — DUCKPLAN four-section plan format
- **TEAMWORK** — N+1+2N parallel dispatch with git worktree isolation
- **FEATURE-VALIDATION** — 1+2+3 cross-engine validation
- **AUTOSHIP** — commit / push / open-PR (auto-authorized; merge / tag / publish still need user)
- **POSTPR** — reviewer-Agent loop until silent or 👍
- **PR-PLAN** — fix planning when reviewer finds P1/P2
- **SELF-REPORT-STOP** — 12-field self-check per turn

### Verification (this release)

- daemon: 411 tests / 29 files pass
- mcp-server: 357 tests / 19 files pass (+14 from `cli-flags.test.ts`; 1 pre-existing skip)
- desktop-shell smokes: `smoke-managed-loop-panel` 60/60, `smoke-continuous-iteration` 42/42, `smoke-boundary-verify` 43/43, `smoke-three-stage-actions` 47/47, `smoke-mentor` 109/109, `smoke-electron-builder-config` 43/43
- Live dogfoods: see Live testbed evidence above

### Known limits (Later-scope, not blocking v0.1)

- npm publish — `@cairn/mcp-server` declares `"@cairn/daemon": "file:../daemon"`. For a true `npm install @cairn/mcp-server` path, daemon must publish first (or bundle into mcp-server). v0.1 tag exists; npm publish step is a separate user decision.
- macOS `.dmg` — config present, build requires macOS runner (GitHub Actions or local Mac).
- Code-signing — neither Windows nor macOS binaries are signed in v0.1.
- Live Run Log (`Later-scope` per PRODUCT.md v3 §12 D10) — not in v0.1; plan is at `docs/superpowers/plans/2026-05-29-v0.2-live-run-log.md` (filename kept for traceability; framing is Later, not v-numbered).
- Real app icon — `build/icon.ico` is a procedural placeholder; designer asset Later.

### Workflow note

PRs #2 and #3 were prepared from the main checkout, not a git worktree, which broke `docs/workflow/TEAMWORK.md` discipline as soon as it was written. PR #4 and subsequent work moved to `.cairn-worktrees/__lead__`. Lesson saved to session memory.

---

## Earlier history

For pre-v0.1 milestones, see:
- `docs/superpowers/plans/2026-04-23-storage-p1.md` ... `p4` (W1 wedge, storage layer)
- `docs/superpowers/plans/2026-05-07-w5-task-capsule.md`, `2026-05-14-w5-phase2-blockers-resume.md`, `2026-05-21-w5-phase3-outcomes.md`, `2026-05-28-w5-phase4-closure.md` (W5 Task Capsule + Blockers + Outcomes DSL)
- `docs/superpowers/plans/2026-05-08-product-mvp-side-panel.md` (Product MVP Quick Slice)
- `docs/superpowers/demos/README.md` (demo index across W1–W5 and Quick Slice)

Tagged milestone: `storage-p1` (P1 persistence layer complete).
