# DUCKPLAN — Mentor 3-Layer Decision Architecture (CAIRN.md + agent_brief)

> Plan filename: `2026-05-13-mentor-3-layer-decision.md`
> Author: lead agent, after a 4-round grilling session with user 2026-05-13
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md` (DUCKPLAN four-section)
> Status: **PLAN** — for the next session to execute. No implementation in this commit.
> Roadmap classification: **Product MVP polish work** (§12 D10 — only "Product MVP" + "Later").

This plan was created at the end of a context-near-full session. It captures every locked decision so the next session's lead agent can resume without losing fidelity.

---

## 1. Plan — one paragraph

Today's `v0.2-cockpit` ship has the **Mentor auto-tick engine** running (every 30s, rules B/D/E/F/G), but Mentor's escalation default is "stuck → ping the user." User reframed this twice on 2026-05-13:

- **Reframe 1**: Mentor should *decide*, not escalate. Because rewind (Module 4) is a cheap stable safety net, Mentor can be wrong sometimes — the user just rewinds.
- **Reframe 2**: Mentor shouldn't decide via its own LLM call alone. Its judgment basis should come from the *agent's main brain* (the active Claude/Cursor session that has the project loaded) and a *static project-policy file* maintained by the user. Mentor *coordinates*, doesn't *think*.

The lock-in: a per-project file **`CAIRN.md`** at the repo root (parallel to `CLAUDE.md` but for Cairn Mentor's use), structured into ✅ "Mentor auto-decide" / ⚠️ "Mentor decide + announce" / 🛑 "always escalate to user" categories. Mentor reads this + an `agent_brief` (~150-word self-summary the agent writes before raising blockers) + an optional light haiku polish call to produce decisions. Escalation only fires on 🛑 categories (irreversible / strategic / business). All other rules transition from "default escalate" to "default decide."

---

## 2. Expected outputs (files that will exist after implementation)

```
CAIRN.md  ← scaffold added to *this* repo as dogfood (template for other projects)
docs/CAIRN-md-spec.md  ← the canonical schema documentation
packages/desktop-shell/mentor-project-profile.cjs  ← scanner + cache
packages/desktop-shell/mentor-tick.cjs  ← amended to use 3-layer input
packages/desktop-shell/mentor-policy.cjs  ← rules D/E/G refactored
packages/daemon/dist/cli/install.js  ← scaffolds CAIRN.md if missing + adds agent_brief prompt-template hook
packages/desktop-shell/scripts/smoke-mentor-3layer.mjs  ← ≥30 assertions
packages/desktop-shell/scripts/dogfood-llm-3layer.mjs  ← real haiku run
PRODUCT.md  ← §1.3.cockpit amended with "Mentor is team lead via CAIRN.md"
CHANGELOG.md  ← new [0.3.0-mentor-3layer] section
```

Tests targets: 411 daemon + 359 mcp-server unchanged; ≥30 new smokes; existing 254 cockpit smokes still green.

---

## 3. How to verify

```bash
# 0. Pre-flight
cd D:/lll/cairn
git status --short                              # empty modulo .cairn-worktrees/

# 1. Tests still green
cd packages/daemon && npm test                  # 411
cd ../mcp-server && npm test                    # 359

# 2. New smoke
node packages/desktop-shell/scripts/smoke-mentor-3layer.mjs
                                                # expect ≥30 PASS
                                                # covers: CAIRN.md scan, profile cache,
                                                # ✅/⚠️/🛑 routing, agent_brief read,
                                                # light LLM polish, escalation only on 🛑

# 3. Real LLM dogfood
node packages/desktop-shell/scripts/dogfood-llm-3layer.mjs
                                                # expect: provider call with profile + brief
                                                # context; 429-grace if rate-limited

# 4. Live verify
# Start Cairn; let auto-tick run a few cycles; check that BLOCKED tasks
# with answers in CAIRN.md no longer escalate (autopilot stays green).
```

Acceptance gate (must all):

- **Hard floor**: CAIRN.md scanner produces structured profile; mentor-policy rule D consults profile FIRST and emits a nudge (not an escalation) when the answer is in CAIRN.md.
- **Middle gate**: agent_brief read path works; when an agent_brief exists, Mentor's decision references it (Activity feed shows "decided X based on profile + brief").
- **High gate** (skip OK): light LLM polish call (L3) — Phase 9.5 may keep this stubbed; the deterministic L1+L2 path is enough to ship.

---

## 4. Out of scope

- Onboarding wizard that walks non-dev users through filling out CAIRN.md — Phase 10
- Per-project settings UI to toggle Mentor's "conservative-vs-aggressive" slider — Phase 10
- Replacing `cairn install` with a project-init wizard that writes CAIRN.md — Phase 10
- Mentor reading code files via Read tool to enrich L3 — Phase 11+
- Multi-agent consensus (3 agents vote on a decision) — Phase 11+
- Goal-change cascade (when goal changes, invalidate prior nudges/escalations) — Phase 11+

---

## 5. Decision provenance (4 reframes today)

Each reframe locked a specific architectural direction. Future readers: respect these unless user explicitly revisits.

### Reframe 1 (2026-05-13 mid-session): Mentor decides, doesn't escalate

User said: "我觉得即使是agent不会，mentor也能根据项目的整体把握来指定下一步规则，而不是卡着等老板... 因为老板有着开销不大的稳定回退能力，所有可以放心让mentor去干。"

**Implication**: Of the 5 deterministic rules (B/D/E/F/G), 4 flip from "escalate" to "Mentor decides." Only Rule F (abort keywords like `rm -rf` / force-push) keeps hard-escalate because rewind can't undo a public push.

**Confidence threshold**: each decision needs a "would rewind cost ≤ 1 min to fix?" check. If yes → decide. If no → escalate.

### Reframe 2 (2026-05-13 mid-session): Mentor doesn't think on its own — it coordinates

User said: "mentor尽量不要完全靠自己调的llm来决策，我希望更多是agent的主脑？或者能了解全项目的那个session给的一些判断依据，来让mentor来辅助进行决策。"

**Implication**: Three input sources, not one LLM call. L1 (static project file) > L2 (agent's live brief) > L3 (Mentor's light LLM polish). L3 is the *last* layer, not the first.

**Cost target**: 10x cheaper than pure-LLM model. Each decision should be ≤ $0.0005 because L1/L2 are free.

### Reframe 3 (2026-05-13 mid-session): CAIRN.md as the entry point

User said: "可以就从claude.md入手 ... 仿照写个PRODUCT.md，这个文档是项目定位或者方便mentor管理项目，也可以让claude共用的一个文件."

**Implication**: One per-project file, dual-read (Cairn Mentor + Claude/Cursor agent), structured sections. File name `CAIRN.md` (mirrors `CLAUDE.md` naming). Committed to repo so all sessions share it.

**Not CLAUDE.md extension**: CLAUDE.md is the coding agent's playbook (lint / hooks / test commands). CAIRN.md is the project owner's voice (intent / scope / decision authority). Separate roles, no coupling.

### Reframe 4 (2026-05-13 mid-session): Implementation autonomy delegated

User said: "我的理解是这样的，你来提升 ... 主要是能实现我想要的效果即可，怎么实现我不关心."

**Implication**: Lead agent has architecture authority for this phase. User wants the *effect*, not specific implementation choices. This means proposing one design (not 4 options) and shipping it.

---

## 6. Phase breakdown (4 tasks, total ~4.5h)

| Task | Deliverable | Time | Tests |
|---|---|---|---|
| **6.1 CAIRN.md spec + scanner** | `docs/CAIRN-md-spec.md` schema doc + `mentor-project-profile.cjs` scanner that reads CAIRN.md → emits structured JSON to `scratchpad:project_profile/<pid>` | ~1.5 h | profile shape tests, missing-file graceful fallback |
| **6.2 agent_brief protocol** | `scratchpad:agent_brief/<agent_id>` scratchpad convention; `cairn install` adds prompt-template addendum instructing Cairn-aware agents to write briefs before raising blockers | ~45 min | template scaffold test, brief-write/read round-trip |
| **6.3 Rules D/E/G → 3-layer** | mentor-policy.cjs rule bodies rewritten: query profile (L1) → match category ✅/⚠️/🛑 → if ✅ + answer in L1 → nudge directly; if ⚠️ → nudge + announce; if 🛑 → escalate. L3 LLM polish is optional fallback when L1/L2 don't yield an answer | ~1.5 h | each rule's new code path; 5 smokes for routing |
| **6.4 Smoke + dogfood + ship** | smoke-mentor-3layer.mjs (≥30 assertions), dogfood-llm-3layer.mjs (real haiku run, 429-grace), add CAIRN.md scaffold to *this* repo as dogfood, PRODUCT.md patch, CHANGELOG entry, commit + push | ~45 min | all of above |

---

## 7. Open questions (decide during impl, not before)

1. **CAIRN.md missing — silent vs prompt?** When a project has no CAIRN.md, Mentor falls back to conservative-mode (default-escalate). Should panel surface a banner suggesting "create one"? Phase 10 onboarding decides.
2. **agent_brief staleness**: if last brief is > 30 min old, is it still trusted? Lean toward yes (decision quality > freshness) with a "stale brief — Mentor was cautious" Activity-feed hint.
3. **L3 LLM polish cost ceiling**: per-project cap? per-day cap? Lean toward project-level $0.50/day soft cap with red-banner on Module 1 if exceeded.

---

## 8. Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| User writes a bad CAIRN.md (overconfident on ✅ list) → Mentor makes too many wrong calls | High | Activity feed shows EVERY Mentor decision with link to its profile-rule source. User can see drift quickly. Plus rewind. |
| CAIRN.md schema is too rigid → users avoid filling it | Med | Schema is markdown sections, not JSON. Missing sections are valid (Mentor falls back to escalation). |
| Light LLM polish runs amok if profile is empty → all decisions go via L3 | Med | Per-project soft cap (open question #3). Plus: when profile is empty, Mentor doesn't decide — it escalates. |
| `cairn install` template change breaks existing installs | Low | Idempotent; only adds new prompt-template instructions, doesn't break old prompts. |
| 4.5h estimate is optimistic | Med | Acceptable to ship in 2 sessions: 6.1 + 6.2 today + 6.3 + 6.4 tomorrow. Same plan applies. |

---

## 9. Cross-references

- **Memories** (read these on resume):
  - `project_cairn_cairn_md_protocol` — CAIRN.md schema + 3-layer architecture (this plan's source of truth in memory)
  - `feedback_trust_with_rewind_safety` — user's product thesis ("trust Mentor + cheap rewind > stuck waiting for boss")
  - `cairn-mentor-scope-clarified` — amended with "Mentor is team lead via CAIRN.md, not just helper"
  - `autonomous-ship-authorization` — 2026-05-13 user delegated push + autonomy for ship-day work (still applies if user re-confirms in next session)
- **Recent commits to know about**:
  - `631783f` Merge branch 'feat/mentor-auto-tick' — today's v0.2-cockpit ship
  - `fc3dd87` docs: CHANGELOG + README sync for v0.2-cockpit ship
- **PRODUCT.md** — to be patched by this plan:
  - §1.3.cockpit: add "Mentor is team lead via CAIRN.md authority delegation"
  - §3.1: already includes non-dev audience expansion (no change needed)
  - §12 D9.1: tier-A first-class mutation already covers Mentor's nudge writes (no change needed)
- **Workflow**: full SOP at `docs/workflow/README.md`. This is a non-trivial change → goes through worktree (`.cairn-worktrees/<slug>/`), DUCKPLAN (this file), implementation, FEATURE-VALIDATION 1+2+3, AUTOSHIP, POSTPR. Workflow worktree discipline applies.

---

## 10. Resume instructions for next session

When a fresh session starts on this work, the lead agent must:

1. **Read this plan in full**.
2. **Read the 4 cross-referenced memories** (`cairn-md-protocol`, `trust-with-rewind`, `mentor-scope-clarified`, `autonomous-ship-authorization`).
3. **Confirm autonomy with user**: ask once "继续按 2026-05-13 plan 干，授权 push main 吗?" — if yes, proceed without further check-ins until tasks 6.1-6.4 complete.
4. **Cut a worktree**: `.cairn-worktrees/mentor-3layer/` based on `main`. Branch name `feat/mentor-3layer-decision`.
5. **Execute tasks 6.1 → 6.4 in order**. Commit per task. Run smokes after each. Surface only on completion or hard block.
6. **Final**: merge to main via `--no-ff` merge commit. Push origin/main. Final report.

User's autonomy contract for this work (from 2026-05-13 session):
- Self-decide all implementation details
- Push main directly without per-step confirmation
- Don't ask "下一步做啥"; just keep working
- Hard lines (CLAUDE.md): npm publish / force-push / LICENSE / new npm dep / PRODUCT.md anti-definitions — still ask
