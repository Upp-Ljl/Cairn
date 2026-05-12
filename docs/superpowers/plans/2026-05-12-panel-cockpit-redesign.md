# DUCKPLAN — Panel Cockpit Redesign (Product MVP polish)

> Plan filename: `2026-05-12-panel-cockpit-redesign.md`
> Author: lead agent (synthesized from 7 rounds of grilling + 1 reframe round on 2026-05-12)
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md` (DUCKPLAN four-section)
> Status: **PLAN** — no implementation code lands until this file is reviewed.
> Supersedes: a prior draft `2026-05-12-panel-inbox-redesign.md` (since deleted, never pushed) that misframed the panel as a multi-project inbox. User correction on 2026-05-12 reframed it as a **single-project cockpit**.
> Roadmap classification: **Product MVP polish work** (per PRODUCT.md v3 §12 D10 — only "Product MVP" and "Later" buckets exist).

## 1. Plan — one paragraph

The panel is a **single-project cockpit**. The user's external coding agent (Claude Code etc.) is the **engine** that does the actual work — writes code, runs tests, opens PRs. Cairn does NOT execute work. Cairn is the **cockpit / dashboard / radio / emergency brake** around the agent: it makes the agent's work visible, lets the user steer without context-switching to the agent's session, and lets the user rewind when direction goes wrong. Inside the cockpit, **Cairn's Mentor role** acts as a **supervisor that talks to the agent on the user's behalf when the user is busy** — Mentor nudges the agent to stay on goal, intercepts simple drifts, and only escalates to the user when it genuinely cannot resolve the situation. The user is the manager who walks away, comes back to see progress, and is interrupted minimally.

This plan supersedes the prior multi-project triage-inbox draft. **Multi-project visibility stays** (top-of-panel project tabs), but each project's main view is its own cockpit.

---

## 2. Architecture

Read-anti-definition first:

> **Cairn (and the cockpit) is NOT the engine. The agent is the engine.** Earlier framings that said "Cairn autopilot ON" sounded like Cairn was driving; that's wrong. The cockpit shows you that **the agent is driving, with Mentor in the co-pilot seat**, and you can walk away.

| Role | Who/What | Does what |
|---|---|---|
| **Agent** (Claude Code, Cursor, Aider, Codex, ...) | The actual engine | Writes code, runs tests, opens PRs, all real work |
| **Cairn Mentor** | Logical role inside Cairn (not a separate process) | Sends guidance messages to the running agent · monitors agent output · catches simple drifts · escalates to user when stuck |
| **Cairn Panel (cockpit)** | The desktop-shell UI | Shows agent's work · accepts user steer messages (no session switch) · surfaces checkpoint rewind · surfaces escalations |
| **User** | The manager | Sets goal · walks away · returns to glance · intervenes when Mentor escalates |

This preserves PRODUCT.md v3 §1.3 anti-definitions ("Cairn 不是 agent / 不写代码 / 不拆任务"). Mentor's "decisions" are confined to **routing / nudging / escalation timing**, not to writing or running code.

---

## 3. Cockpit layout (5 modules)

```
┌─────────────────────────────────────────────────────────┐
│ [project1] [project2] [+]            goal: <one line>  │  ← project tabs + goal pill
├─────────────────────────────────────────────────────────┤
│ Module 1 — STATE STRIP                                  │
│ 🟢 agent working · Mentor guiding · you can walk away   │
│ 进度: ████████░░░░ 47%   ETA: ~25 min   ⚡ agent B 2:34 │
│ Latest Mentor nudge: "走 sanity check, 避免 flake"      │
├─────────────────────────────────────────────────────────┤
│ Module 2 — STEER (radio to agent)                       │
│ ┌─────────────────────────────────────────────────┐    │
│ │ 给 agent 说一句:  ____________________  [Send]  │    │  ← inject into live session
│ └─────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│ Module 3 — ACTIVITY FEED (time-ordered, live)           │
│ 14:02  Mentor → B: "重写 sanity check 用 deterministic"│
│ 14:00  B:  ran vitest, 3 tests failed                   │
│ 13:48  B:  merged PR #6                                 │
│ 13:32  Mentor → B: "再跑一遍 Monte-Carlo"               │
│ 13:15  B:  task started: equity tests                   │
├─────────────────────────────────────────────────────────┤
│ Module 4 — SAFETY (rewind, always visible)              │
│ ⌛ Rewind to:                                           │
│  • before B's commit (3 min ago)                        │
│  • before today's session start (4h ago)                │
│  • before goal change (2d ago)                          │
├─────────────────────────────────────────────────────────┤
│ Module 5 — NEEDS YOU (only when Mentor escalates)       │
│ (nothing right now — Mentor handling on track)          │
│                                                         │
│ When something needs you, this section turns red,       │
│ tray icon flashes, single click here lands you at the   │
│ escalation point.                                       │
└─────────────────────────────────────────────────────────┘
```

**Module priorities**:
- Module 1 (state strip) — always top of fold; one glance = "is everything OK?"
- Module 2 (steer) — second; the wheel grab without session switch
- Module 3 (activity feed) — third; the dashboard scroll
- Module 4 (safety) — always visible footer-ish; the brake pedal
- Module 5 (needs-you) — usually empty; only flashes on escalation

---

## 4. Locked decisions

29 from the prior 7-round grill carry forward, restructured to fit the cockpit metaphor. Plus 4 NEW decisions from the cockpit reframe (Round 8).

### A. Carried forward (from inbox grilling, still valid under cockpit)

| # | Decision | Where it lives in cockpit |
|---|---|---|
| 1 | Visual style = Linear / Notion (易读优先) | Whole cockpit |
| 2 | Mentor's body source = external leader coding agent | Module 1 (latest nudge) + Module 3 (activity feed) |
| 3 | Mentor recompute = goal-change only (not periodic, not event-driven) | Mentor 's recompute logic; surfaced as a tab-pill update |
| 4 | Per-project leader (CC / Cursor / Codex / Aider) | Per-tab settings; Module 2 talks to that tab's leader |
| 5 | "Talk to leader" / "Steer agent" = inject into live session; fall back to clipboard | Module 2 (the textbox + Send button) |
| 6 | Rewind shows checkpoints; user picks one to revert to | Module 4 |
| 7 | Tray notification click → directly lands on escalation point | Tray → Module 5 highlighted |
| 8 | Keyboard support = j/k/Enter/Esc + mouse-friendly (both) | Cockpit-wide |
| 9 | "What is Cairn?" link = in-panel one-page README | Help icon top-right |
| 10 | 4 LLM auxiliary helpers (low-cost default-on, high-cost manual-on): tail.log summary · conflict explainer · inbox-equivalent smart sort · goal input assist | Various spots; details §4.C |
| 11 | Audience = programmer + non-developer, equal weight (PRODUCT.md §0 patch) | All copy, every module |
| 12 | §12 D9 rewritten: "default read-only" → "responsible mutation" (3 tiers) | Module 2 (steer) is tier-A first-class; Module 4 rewind is tier-B confirm-dialog; legacy Inspector keeps env-flag (tier-C) |

### B. Replaced by cockpit reframe (these change)

| # | Was | Now |
|---|---|---|
| 13 | "Multi-project inbox / triage 处理 mode" | **Single-project cockpit / watch + occasionally intervene mode**. Multi-project visibility = top-of-panel project tabs, not a list. |
| 14 | "5+ projects 并行 folded into project groups" | **Project tabs at top**; each tab opens its own cockpit. Tab badge = unread escalations for that project. |
| 15 | "Sort by project group · within group by urgency" | Within one cockpit's activity feed = time-ordered (newest first). Cross-tab badge order = tabs with red Module 5 status come first. |
| 16 | "Multi-select hover-checkbox lock-mode bulk archive" | **Dropped.** Cockpit doesn't accumulate items to process; activity feed scrolls. |
| 17 | "Archive (soft-hide) + delete (hard) two distinct actions" | **Re-scoped**: activity-feed items never archive (they scroll out of view). Only Mentor escalations in Module 5 can be archived (acknowledging = archived). Hard-delete remains for whole tasks at the management edge. |
| 18 | "Default group fold state — 🔴 projects expanded, others collapsed" | **Re-scoped**: project tabs with red Module 5 auto-foreground when panel opens; other tabs stay in normal order. |
| 19 | "Inbox empty state = guidance buttons" | **Re-scoped to cockpit empty state**: no project yet → "Add a project + define a goal" CTA (goal is required for Mentor; see #20). |

### C. New decisions from cockpit reframe (Round 8)

| # | Decision |
|---|---|
| 20 | **Goal is required to start a project.** Empty goal → no Mentor activity (no agent autopilot). Onboarding flow makes user define goal before the cockpit unlocks the autopilot state. |
| 21 | **Mentor escalation policy = first-class product surface (not implicit).** The user explicitly configures (per-project, or global default) WHEN Mentor escalates: (a) after N failed mentor-nudge attempts on same issue, (b) when agent reports BLOCKED, (c) when time-budget exceeded, (d) when user-named keywords appear in agent output. See §5 for the full policy. |
| 22 | **Activity feed = single time-ordered stream of `agent:` events + `Mentor → agent:` events + `state` events**, NOT separated swim lanes. The whole story reads top-to-bottom. Filtering chips above the feed: [all] [Mentor only] [agent only] [state changes only]. |
| 23 | **"Walk-away mode" is the default user posture.** The cockpit defaults to "user can leave; Mentor handles things." User does not need to confirm every Mentor nudge to the agent. User-confirmation gates are explicit and reserved for Module 5 escalations only. |

---

## 5. Mentor escalation policy (the core mechanism)

This is the user's stated "保护我多线程做工作" mechanism. Mentor must filter aggressively or it loses the point.

| Trigger | Default behavior |
|---|---|
| **Agent hits an ambiguous decision** (e.g. "use vitest or bun:test?") | If decision is reversible + low-stakes (e.g. test framework when both work) → Mentor picks one and notes choice in activity feed. If irreversible or high-stakes (e.g. schema change, dep upgrade, license-affecting choice) → escalate to user via Module 5. |
| **Agent compile/test error** | Mentor sends a nudge; if agent still stuck after 2 nudges → escalate. |
| **Agent goes off-goal** (Mentor detects via LLM-aided diff against goal) | First time → Mentor nudges privately. Second time same direction → escalate to user. |
| **Agent reports BLOCKED with question** | If question matches a known pattern Mentor can answer from project rules / past decisions → Mentor answers. Otherwise → escalate. |
| **Time budget hit** | Configurable per-task; default → escalate at 80% of budget. |
| **User-named abort keywords** (e.g. "rm -rf", "DROP TABLE", "force push") detected in agent's planned action | Always escalate, never Mentor-resolve. |
| **Outcome evaluation fails** | Default → Mentor proposes retry once; if 2nd attempt fails outcome → escalate. |
| **All else** | Continue silently. |

User can configure thresholds per-project in a Settings drawer (Phase 6 work). Default thresholds shipped with sensible-conservative bias (escalate more rather than less).

---

## 6. Expected outputs

What lands when implemented (a future PR set, NOT this plan):

- `packages/desktop-shell/panel.html` — drop the `view-runlog/tasks/sessions/reports/coord` 5-tab inner shell (most of that data lands in the cockpit's activity feed). Project tabs at top. Single-project cockpit body with 5 modules. Drawer support kept for the prior-design's "detail drawer" if needed but secondary.
- `packages/desktop-shell/panel.js` — new renderers: `renderCockpit(projectId)`, `renderStateStrip`, `renderActivityFeed(events)`, `renderRewindList`, `renderEscalations`. Project tab switcher. Steer input handler.
- `packages/desktop-shell/main.cjs` — IPC: `cairn.cockpit.state` (returns one project's cockpit payload), `cairn.cockpit.steer` (Module 2: send a message into agent's live session, tiered inject→clipboard), `cairn.cockpit.rewind` (Module 4: revert to a checkpoint), `cairn.cockpit.ack-escalation`.
- `packages/desktop-shell/mentor-handler.cjs` — re-scoped to the supervisor role: `mentorNudge(taskId, message)`, `mentorEvaluate(eventStream)`, `mentorEscalate(reason, payload)`. Stops being a "list ranked work items" generator.
- `packages/desktop-shell/mentor-policy.cjs` (new) — implements §5 escalation policy. Configurable per-project; sane defaults.
- `packages/desktop-shell/SCHEMA_NOTES.md` — possibly new tables: `escalations` (id, project_id, task_id, reason, status PENDING/ACKED/RESOLVED, created_at). Activity events themselves can reuse `scratchpad` or a new minimal `activity_events` table — TBD in phase 1.
- `PRODUCT.md` — three patches: §0 audience expansion · §12 D9 rewrite · §1.3 Mentor scope clarification (with the cockpit architecture). Memory `cairn-mentor-scope-clarified` is the source of truth.
- `docs/superpowers/demos/panel-cockpit-walkthrough.md` — recorded walkthrough (after phases finish).
- A FEATURE-VALIDATION dogfood script (`packages/desktop-shell/scripts/dogfood-panel-cockpit.mjs`): cockpit payload shape · steer injection vs clipboard fallback · Mentor escalation triggering · rewind through Module 4 · activity feed time-order · project-tab switching · keyboard nav. ≥40 assertions.

---

## 7. How to verify

```bash
# 0. Pre-flight — current main checkout, panel build present.
cd D:/lll/cairn
git status --short
ls packages/desktop-shell/panel.html packages/desktop-shell/panel.js
                                            # expect: both present

# 1. Local tests + tsc (kernel layer unchanged by this plan).
cd packages/daemon && npm test && npx tsc --noEmit
cd ../mcp-server && npm test && npx tsc --noEmit
                                            # expect: tests pass, no new failures

# 2. Run the cockpit dogfood (TO BE WRITTEN in phase 7).
node packages/desktop-shell/scripts/dogfood-panel-cockpit.mjs
                                            # expect: ≥40 assertions PASS

# 3. Live dogfood — open against real ~/.cairn/cairn.db.
npm --prefix packages/desktop-shell start
# Manually verify the 23 locked decisions hold + 4 cockpit-reframe decisions
# (state strip glance · steer ↔ injection · activity feed live update ·
#  rewind one-click · Mentor escalation arriving in Module 5).
```

**Acceptance gate**:

- **Hard floor**: cockpit renders with all 5 modules visible without overflow; ESC drawer regression doesn't return (PR #7 fix preserved); empty cockpit shows the goal-required CTA.
- **Middle gate**: Mentor escalation rule fires on a synthetic "agent BLOCKED" event in dogfood, reaches Module 5, user-ack archives the escalation; steer injection delivers to a live mock-agent session; rewind reverts via checkpoint repository.
- **High gate** (Later — out of this redesign): multi-leader-per-project, machine-learning over user's past escalation acks to auto-tune thresholds, cross-project goal-sharing.

---

## 8. Out of scope (locked off this plan)

- **Auto-tuning escalation thresholds via ML over user ack history**. Phase X.
- **Multi-leader-per-project**. One leader per project tab; switching invalidates the active task's nudges.
- **Cross-project search**. Stick to single-project cockpit; cross-project = the tabs UX only.
- **Mobile / responsive**. Desktop only.
- **Re-skin legacy Inspector**. Cockpit is its own surface; legacy Inspector stays as-is.
- **PRODUCT.md v4 reframe**. Three §0 / §1.3 / §12 patches only. The v3 layered architecture survives intact.
- **The 3 still-open questions** below — answered during implementation, not in this plan.

---

## 9. Phase breakdown

| Phase | What lands | Approx LOC | Tests |
|---|---|---|---|
| **0. PRODUCT.md patches** | §0 audience expansion · §12 D9 rewrite · §1.3 Mentor scope + cockpit architecture. Pure docs. | ~150 lines | none |
| **1. Cockpit payload + IPC** | `cairn.cockpit.state` handler. Joins agent state, latest Mentor nudge, recent activity events, checkpoints, escalations. No UI yet. | ~400 lines + tests | shape tests |
| **2. 5 modules rendered** | panel.html cockpit body, panel.js renderers per module. Project tabs. No interactivity beyond display. | ~700 lines | renderer smoke |
| **3. Steer (Module 2) + injection** | Live-session inject with tiered fallback (clipboard). Mock-agent harness for tests. | ~400 lines + tests | inject + fallback |
| **4. Rewind (Module 4)** | Wire into existing checkpoint repository. Tier-B confirm dialog. | ~300 lines | rewind smoke |
| **5. Mentor supervisor + escalation policy** | `mentor-policy.cjs` implementing §5. Mentor → agent nudge channel (writes to agent's prompt-template feed). Escalation surfaces to Module 5. | ~700 lines + tests | each escalation rule |
| **6. LLM helpers + per-project settings** | 4 helpers from R7 wired (tail summary on, conflict explainer on, smart-sort off, goal-assist off). Per-project leader picker. Escalation threshold settings. | ~500 lines | each helper |
| **7. Onboarding · goal required gate · keyboard · dogfood** | Empty cockpit guides to "add project + define goal". Goal-required gate (no Mentor without goal). Keyboard nav. ≥40-assertion dogfood. FEATURE-VALIDATION 1+2+3. | ~400 lines + script | full dogfood |

Total: ~3550 lines + ~7 test/dogfood files. ~1.5-2 weeks focused, possibly faster with TEAMWORK N+1+2N delegation.

Phases 1-4 = visible cockpit MVP. Phase 5 = the autopilot mechanism. Phases 6-7 = polish + onboarding + verification.

---

## 10. Open questions

1. **Activity event storage**: extend `scratchpad` (key like `activity/<ts>/<project>`)? new table `activity_events`? Decide phase 1.
2. **Project tab limit + ordering**: max N visible tabs? Overflow → "..." dropdown? Tab order = pinned + recently-active? Decide phase 2.
3. **Escalation acknowledgment persistence**: when user acks an escalation, does it archive (out of view) or stay as "resolved" tag in history? Decide phase 5.
4. **Steer-injection delivery semantics**: does Mentor see user's steer message and adjust its own nudge plan, or does it bypass Mentor and go straight to the agent? Decide phase 3.
5. **Goal-change → all pending Mentor nudges**: invalidate? re-evaluate against new goal? Decide phase 5.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Inject-into-live-session (decision #5)** primitive doesn't exist in kernel | High | Phase 3 must implement via scratchpad + agent prompt template "check for pending steer at loop start". Fallback (clipboard) ships with Cairn-unaware agents. |
| **Mentor supervisor + escalation policy** is functionally the autopilot — gets close to the废止-PoC-3 line. | Med | Boundary preserved: Mentor only routes / nudges / escalates, doesn't write code. Decisions live in §5 policy table; user-configurable per-project. Audit at /plan-ceo-review. |
| **Audience expansion (#11)** is a real strategic move | High | Recommend /plan-ceo-review before phase 0 starts. Resource allocation implications. |
| **Cockpit single-project view** may feel cramped for users who do work on 5+ projects | Med | Project tabs preserve multi-project visibility; user testing in phase 7 validates this. |
| **23+4 = 27 locked decisions = some will be wrong** | Med | Phase 7 dogfood + actual hands-on usage is the truth-test. Don't declare done until used for a week. |
| **Mentor escalation false positives** annoy user back into "always interrupted" pain | Med | Default thresholds ship conservative-escalate; user-tunable; track ack:dismiss ratio over time. |

---

## 12. Cross-references

- **Memory** `cairn-mentor-scope-clarified` (amended 2026-05-12 round 7+8) — Mentor scope precise boundary (strategic → external; auxiliary → Cairn LLM OK; supervisor role for agent walk-away → core Mentor mechanism).
- **Memory** `cairn-dark-zones-and-pitfalls` (amended 2026-05-12) — PoC-3 boundary precision: full LLM dispatch decisions still 废止; auxiliary + supervisor LLM roles revived.
- **Memory** `cairn-canonical-positioning` (v4 layers) — still authoritative. This redesign is product-layer + Mentor-handler only; kernel layer untouched.
- **Recent fix** `73cf902 fix(panel): ESC from project view no longer leaves L2 visible behind L1` (PR #7) — `[hidden] { display: none !important }` and the `setView` reset stay; cockpit builds on that.
- **Superseded plan** `2026-05-12-panel-inbox-redesign.md` — deleted this commit. Did not match user's actual intent (inbox/triage shape was wrong; cockpit is right).
- **PRODUCT.md** patches required before implementation: §0 (audience), §1.3 (Mentor scope + cockpit architecture), §12 D9 (responsible mutation). Phase 0 work.
