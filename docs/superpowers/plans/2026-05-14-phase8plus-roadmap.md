# Phase 8+ Roadmap — remaining items toward "self-felt productivity" goal

> Filename: `2026-05-14-phase8plus-roadmap.md`
> Status: **ROADMAP** — captures the 4 ⏳ items the user named at the end of the 2026-05-14 ship session. Each entry is a candidate Phase, not committed to execution order yet — pick based on whichever blocking dependency is unblocked next session.
> Author: lead agent, 2026-05-14, after Phase 1-7 landed on `origin/main` (head: `5357dff`).
> Roadmap classification: **Product MVP polish** (CLAUDE.md §12 D10 — only "Product MVP" + "Later").
> Workflow: each item below becomes its own DUCKPLAN (`HOWTO-PLAN-PR.md`) before execution. This file is the parent map, not an executable plan.

## Carry-over from 2026-05-14 EOD report

After Phase 1-7 shipped, the user named these four remaining items as "下一个的 phase 阶段":

1. Rule C off-goal drift (needs LLM provider)
2. Tail.log scanning for Rules B + F (needs worker-run infrastructure)
3. Mode B Continuous Iteration (the biggest lever)
4. Real packaging + distribution (macOS / Linux / installer)

What's already on `origin/main` (so each plan below composes, doesn't reinvent):

- 7 phases of bootstrap + sync mentor (Phase 1-7).
- Kernel-side `cairn.task.block` auto-resolves on `## Known answers` + ✅/⚠️/🛑 authority bullets and writes scratchpad activity events per route.
- Panel Module 1 widgets: Whole · Mentor-saved badge · Stale-agent warning · Last-24h glance.
- `.claude/skills/cairn-aware.md` auto-installed by `cairn install`.
- Daemon CAIRN.md scanner (TS, canonical) lives in `packages/daemon/src/cairn-md/`.

## §8 — Rule C off-goal drift (LLM-gated)

**Why it matters**: today Mentor only fires on agent-side events (block, time-budget, outcomes). A common failure mode is "agent doing the wrong thing well" — committing 200 lines of code that drifts away from `## Whole`. Rule C is the missing eye.

**Approach**:
- Read agent's recent activity for the project (last N task transitions + last commits + scratchpad agent_brief if present).
- Build an L3 polish prompt: "given Whole + recent activity, is the work on-path? If not, output a one-sentence redirect."
- Conservative threshold (don't fire on every slight drift): require ≥ N consecutive evaluations to say off-goal before emitting a nudge.
- Emit nudge to existing scratchpad `mentor/<pid>/nudge/<ulid>` namespace.

**Prerequisites**:
- LLM provider config (~/.cairn/llm-keys with CAIRN_LLM_KEY or ANTHROPIC_API_KEY) — same plumbing the existing 4 LLM helpers use.
- Per-project cost ceiling (open-Q from 2026-05-13 plan §7 Q3) — sketch: per-day soft cap, red banner on Module 1 if exceeded, fall back to no-action on cap.

**Files likely touched**:
- `packages/desktop-shell/mentor-policy.cjs::evaluateRuleC_offGoal` (today: stubbed `no_action_phase_5`)
- `packages/desktop-shell/cockpit-llm-helpers.cjs` — new `judgeOffGoal(input, opts)` helper
- `packages/desktop-shell/mentor-tick.cjs` — feeds ws.gitRoot recent commits + task transitions
- new smoke + dogfood pair (stub for offline; real-LLM dogfood with 429-grace pattern from `dogfood-llm-tail-summary.mjs`)

**Risk**: cost runaway if provider keys are loose; mitigation = soft cap + dry-run mode.

---

## §9 — Tail.log scanning for Rules B + F (worker-run infra needed)

**Why it matters**: today Rules B (compile/test error repetition) and F (abort keyword: `rm -rf`, `force-push`, ...) require raw agent stdout. mentor-tick comment line 31: "Tick v1 omits them — evaluatePolicy returns null for those rules when context arrays are missing." Phase 9 wires the data flow.

**Approach**:
- Tail.log scanning already exists in `dogfood-llm-tail-summary.mjs` for the summary helper — same path pattern.
- Each managed worker run writes `~/.cairn/worker-runs/wr_<id>/tail.log`. mentor-tick scans the most recent N runs per project.
- For Rule B: count `Error:` / `FAILED` / `TypeError` lines in the last 200 lines; if ≥ 3 distinct error signatures, fire `evaluateRuleB_errorRepetition` with the `recentErrors` array.
- For Rule F: substring match against `abortKeywords` config (today `['rm -rf', 'force push', '--force', 'DROP TABLE', 'TRUNCATE TABLE']`) over the same tail. On hit, fire `evaluateRuleF_abortKeywords`.
- No LLM needed for either rule. Pure deterministic text scan.

**Prerequisites**:
- Worker-run infrastructure that actually writes tail.log files. Today the worker-runs dir exists (`packages/desktop-shell/managed-loop-handlers.cjs` writes them when a managed loop is running) but the typical CC user is NOT running through managed-loop — they're running CC directly via MCP, no tail.log. So this phase only fires when the user is using Mode B Continuous Iteration (§10) or a future "managed CC" wrapper.
- Concretely: §9 should follow §10 (Mode B) OR add a thin "tail-log scanner for non-managed sessions" that captures CC's stdout via a wrapper script. The wrapper-script path is messier.

**Files likely touched**:
- `packages/desktop-shell/mentor-tick.cjs` — new `gatherTailContext(projectRoot, hints)` helper, threads `recentErrors` + `recentAgentText` into `evaluatePolicy`.
- `packages/desktop-shell/mentor-policy.cjs` — rules already exist; nothing changes.
- new smoke that synthesizes a tail.log fixture + asserts both rules fire.

**Risk**: false-positive on Rule F when an agent is explaining `rm -rf` in a code comment rather than planning to run it. Mitigation: require keyword + context (e.g., shell-call-shaped line, not Markdown).

---

## §10 — Mode B Continuous Iteration (the biggest lever)

**Why it matters**: PRODUCT.md §6.5.2 — the headline v4 Operations Layer feature. User authorizes a set of candidates → Cairn auto-chains scout → worker → review for each, stops at REVIEWED, user accepts/rejects/pushes. This is what "走开就行" actually looks like in practice.

**Anti-definition guardrail (CRITICAL — PRODUCT.md §1.3 #4a)**: chain stops at REVIEWED. Accept / reject / push / merge / cross-candidate sequencing are **always** the user's call. Boundary verify violations auto-stop and tag `needs_human`.

**Approach** (high level — DUCKPLAN this separately):
- Existing primitives compose: `cairn.task.create` + `start_attempt` + `submit_for_review` + `outcomes.evaluate` already give the per-candidate state machine.
- New: a "lane" or "chain" concept that bundles N candidates with an authorization scope. Could re-use the existing `lanes` table that's already in the daemon (per grep earlier).
- New panel surface: "Continuous Iteration" sub-section in Module 2 (Steer) with "Authorize N candidates → run chain" button. Read-only after launch except the user can revoke.
- State machine: `LANE_PENDING → LANE_RUNNING → LANE_REVIEWED (stop here) → LANE_ACCEPTED/REJECTED (user)`.

**Prerequisites**:
- Existing kernel state objects (tasks / outcomes / scratchpad) cover most of it.
- Scout / worker / review roles need clear conventions (which agent does which step?). Today: a single CC session does all three; Mode B might dispatch to subagent via `cairn.dispatch.request` with R6 fallback rules.

**Files likely touched (big lift)**:
- new `packages/daemon/src/cairn-md/` (no — keep parser there); rather:
- new `packages/daemon/src/lanes/` repository (or extend the existing one if `packages/daemon/src/storage/repositories/lanes.ts` already exists — grep first)
- new MCP tools: `cairn.lane.create` / `cairn.lane.advance` / `cairn.lane.revoke` (this adds new tools — CLAUDE.md tracks the 28-tool count; the cap holds because Phase 8-9 add zero)
- new panel section + IPC handlers in desktop-shell
- new smoke + dogfood across multi-session

**Risk**: boundary creep — accidentally letting Mode B auto-accept / auto-push violates §1.3 #4a. Mitigation: hardcode `state !== 'REVIEWED' → no advance to accept/push`; smoke that asserts auto-advance past REVIEWED returns `BOUNDARY_VIOLATION`.

**Estimated scope**: 3-5× the size of Phase 7. Likely a 2-3 session ship.

---

## §11 — Real packaging + distribution (macOS / Linux / installer)

**Why it matters**: today users must `clone + build 3 packages + npm start`. Non-developer audience (PRODUCT.md §3.1) literally cannot get to the product. Until this lands, Cairn's reach is "the lead agent + the user."

**Approach**:
- `electron-builder` config already exists in `packages/desktop-shell/package.json` (`dist:win`, `dist:mac`, `dist:dir` scripts). NSIS Windows build was working at one point.
- Phase 11 = three deliverables:
  1. CI workflow to build artifacts on push (GitHub Actions matrix: win/mac/linux).
  2. Sign + notarize macOS (Apple Developer cert required — user/business decision).
  3. Auto-update channel (electron-updater + GitHub Releases).
- Also: first-launch onboarding inside the packaged app — what happens when a non-dev double-clicks the .exe and sees the panel for the first time. This is the "What is Cairn?" overlay item from D5 backlog.

**Prerequisites**:
- Apple Developer cert + Windows code-signing cert (user/business decision — neither is technical).
- GitHub Actions runner minutes (free tier covers MVP).

**Files likely touched**:
- new `.github/workflows/release.yml` (electron-builder build matrix)
- new `packages/desktop-shell/electron-updater.cjs` (auto-update wiring)
- update `packages/desktop-shell/main.cjs` to register the updater
- new "What is Cairn?" overlay in panel.html (first-launch only, dismissed via localStorage or registry flag)
- README.md install section rewrite (drop "clone + build", add "download from Releases")

**Risk**: code-signing is gnarly across 3 OSes; mitigation: ship un-signed Windows first (warns user but works), defer mac notarization to follow-up.

**Estimated scope**: 1-2 sessions for the build pipeline; signing/notarization may extend.

---

## Suggested execution order

| Phase | Item | Blocked-by | Dogfood payoff |
|---|---|---|---|
| **§8** | Rule C off-goal drift | LLM provider config (one-time setup) | High — catches the "agent did wrong thing well" failure mode that today costs the most user-time-on-rewind |
| **§9** | Tail.log scanning | §10 OR managed-CC wrapper (small) | Medium — only helpful when there's a worker run actually producing tail.log |
| **§10** | Mode B Continuous Iteration | nothing (composes existing) | **Highest** — the "走开就行" headline feature; user authorizes 5 candidates, Cairn chains them, user accepts at REVIEWED |
| **§11** | Packaging + distribution | nothing technical (cert decisions are user/business) | High once non-devs are the target; until then only matters for "ship to public" milestone |

**Pragmatic next-session pick**: probably §10 (Mode B) if the user wants the biggest single jump in product feel. §8 if they want Mentor to feel smarter on the same dogfood without expanding scope. §11 if the priority shifts to "get other users." §9 is best bundled with §10 since both need worker-run plumbing.

## Cross-refs

- 2026-05-13-mentor-3-layer-decision.md — predecessor (Phase 0 of this stack)
- 2026-05-14-bootstrap-grill.md — Phase 1 (bootstrap pipeline)
- 2026-05-14-phase2-sync-mentor.md — Phase 2 (kernel-side known_answer auto-resolve)
- 2026-05-14-phase3-authority-routing.md — Phase 3 (✅/⚠️/🛑 routing)
- PRODUCT.md §6.5 — Operations Layer Mode A/B/C definitions
- PRODUCT.md §4.1 US-P1 — Project Glance user story (Phase 7 partial; §11 first-launch overlay closes the rest)
- AUTOMATION.md — "no HITL gates" contract; §8/§9/§10 all must respect it

## Stop conditions for "向最终目标进发" scope

The user's stated scope is "向最终目标进发" (multi-phase, ongoing). Per `[[no-unsolicited-status-reports]]` + workflow SELF-REPORT-STOP field 13, a session within this scope stops only at:

(a) the named end-state delivered on `origin/main`
(b) a hard blocker that cannot be self-resolved (e.g., context exhaustion, missing credentials user hasn't supplied)
(c) the user types something

After all four §8-§11 items ship, the "self-felt productivity" thesis from 2026-05-14 ("起码我们自己用的话能真的感知到提效") is closed. After that, the natural next scope is "ship to non-developer users" — which is bigger than this roadmap and needs its own framing.
