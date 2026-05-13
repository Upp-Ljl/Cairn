# BOOTSTRAP — Phased plan (Phase 1 approved 2026-05-13)

> Filename: `2026-05-14-bootstrap-grill.md`
> Status: **APPROVED for execution** — CEO greenlit 2026-05-13 with autonomy on implementation details (per `[[autonomous-ship-authorization]]` + `[[resolve-grill-memo-yourself]]`).
> Source: 2026-05-13 CEO-channel review backlog (Teams A–G, 7 lanes).
> Roadmap classification: **Product MVP polish** (§12 D10 — only "Product MVP" + "Later").
> Workflow: §2 is the executable DUCKPLAN (Outcomes / Steps / Cross-cutting / Risks / Acceptance = 5-section equivalent of HOWTO-PLAN-PR.md 4-section). §3 is the trajectory. §4 is dependency. §5 is the answered grilling memo (CEO-channel 2026-05-13 grilled and locked).

---

## §0. Decisions baked in (2026-05-13 CEO-channel + lead-agent autonomy)

These 4 implementation decisions were grilled and locked. Recorded here so any future re-reader sees them without re-grilling.

| # | Decision | Source | Implementation impact |
|---|---|---|---|
| D-1 | **`## Goal` is KEPT but serves `## Whole`** — Whole is the project's stable north star (CC-drafted, user-confirmed); Goal is the *current sub-Whole milestone* that can drift over time. Both sections exist in schema v2. | CEO 2026-05-13: "goal 可以有，但还是服务于 whole vision" | Schema v2 = drop only `## Current phase` (time-anchored); `## Goal` rephrased as "current milestone toward Whole." Scanner reads both fields. Step 4 updated. |
| D-2 | **Mentor's internal 3 layers renamed `profile / brief / polish`** — reserve `L1/L2/L3` exclusively for panel view tiers. | Lead agent autonomy (CEO: "你自己决定，我只看效果") | Rename in `mentor-policy.cjs` / `mentor-project-profile.cjs` / `mentor-agent-brief.cjs` exports + comments + docs. Phase 2 work (D1 in backlog); Phase 1 just doesn't introduce new "L1/L2/L3" Mentor-side references. |
| D-3 | **A1 install logic via spawn-child-process, NOT `require()` from Electron main.** | Lead agent autonomy (CEO: "你来决策，我只看效果和用户体验") | `packages/desktop-shell/install-bridge.cjs` spawns `node <mcp-server dist>/cli/install.js` with `--json` output and parses the result. No code lift into Electron main. CLI remains source of truth. |
| D-4 | **A2 dispatch via `scratchpad:agent_inbox/<agent_id>/<ulid>`** (cockpit-steer's proven pattern), NOT `dispatch_requests` table. | Lead agent autonomy (CEO: "也按你建议吧") | Reuse `cockpit-steer.cjs::supervisorId()` ulid+key generator. New `findCairnAwareAgent(projectRoot)` helper in `cockpit-state.cjs`. |

---

## §1. Sequencing thesis

**Order: A → F+G (bundle) → C → D → B → E.** Justification, by blocker:

1. **A must precede everything user-facing.** Today's first-touch is "clone + build 3 packages + `cairn install` from CLI + manually edit CAIRN.md." If we ship anything else first (Mode B/C, packaging, non-dev pitch) we ship onto sand: a new user will never reach those surfaces. A1 (move install into daemon) + A2/A3/A4 (CAIRN.md draft loop) is the only slice that converts the panel from "developer console" into "thing a project owner can open."
2. **F and G bundle into A because they are touched by A's edits.** A3 rewrites CAIRN.md schema → F4 (excise stale phrasing) and F2 (USER-TESTING-GUIDE §2/§4.1 sync) flow off the same edit. G1 (stray files) is 10 minutes and must land before any worktree work to keep the main checkout clean.
3. **C precedes B.** Mode B (Continuous Iteration) chains scout → worker → review under Mentor's authorization. Today's Mentor has stubbed rules A and C (LLM judge / off-goal drift) and no tail.log scanning (rules B/F). Shipping Mode B on top of an incomplete Mentor is asking for the auto-chain to either over-escalate or under-escalate; C5 (L3 polish wired in) plus C1–C4 (rule completeness) closes the safety net first.
4. **D follows C because D's "translate state names" is a property of the surfaces Mentor decisions land on.** Doing D1 (L1/L2/L3 naming collision) and D4 (kernel-state translation) before C is wasted polish if C5 changes which strings the Activity feed emits.
5. **B before E.** Mode B is product-defining; packaging (E) only matters once there's a coherent product to package. E is largely independent of everything else (see §4) and can also run in parallel as a later background lane.
6. **E last.** electron-builder NSIS already produces an artifact; the unblockable work is macOS/Linux builds and the auto-update channel — both isolated, both deferrable.

Trade-off accepted: F5 (non-dev pitch with screenshots) and D5 (first-run overlay) feel close to A in spirit but are *display* of bootstrap, not bootstrap itself. They go in Phase 2 (D) so they describe the bootstrap that actually ships, not the one we plan.

---

## §2. Phase 1 detailed — Bootstrap + repo hygiene

### §2.1 Outcomes (observable behaviour after Phase 1)

1. **Add Project flow from panel works end-to-end on a brand-new repo with zero CLI.** Click `＋ Add project…` → choose folder → daemon writes `.mcp.json` + pre-commit hook + start launchers + a populated `CAIRN.md` (haiku-drafted fallback if no CC session is attached; CC-drafted if one is attached and responds within the timeout).
2. **A new project's first card on the panel reads:** "Cairn drafted a 1-line **Whole**; review or accept." Clicking accept commits the CAIRN.md edit to the working tree (not auto-`git add`-ed — that's the user's call).
3. **CAIRN.md v2 schema is in effect**: `## Goal` and `## Current phase` removed; `## Whole` (one sentence) added; "What's in flight" becomes a panel-rendered line drawn from `tasks` + `processes`, not a file field.
4. **No HITL gate at any step.** If CC is not attached, the local haiku produces the first draft; if haiku is unavailable, the scaffold from `install.ts` lands as-is and an Activity-feed event marks "draft pending — Mentor will retry on next CC attach." Pipeline does not block.
5. **Repo hygiene**: untracked `0`, `query-db.cjs`, `query_db.cjs`, `{const`, `packages/daemon/query*.{cjs,js}` are deleted or moved under `.gitignore`d locations; `CAIRN_DESKTOP_LEGACY` env var name confirmed (or fixed).

### §2.2 Concrete steps (numbered, file-scoped, sized S/M/L)

| # | Task | Files touched | Size |
|---|---|---|---|
| 1 | **G1 — sweep stray files**: delete or `.gitignore` the 6 untracked `query*` / `0` / `{const` paths; reproduce them only if they're real (likely sqlite scratch from a prior dogfood — delete). | `.gitignore`; root deletion | S |
| 2 | **G2/G3 — env name + tray aggregation note**: grep `CAIRN_DESKTOP_LEGACY` across repo; if typo, rename. Document tray idle/warn/alert aggregation as a 10-line comment block at the top of `main.cjs` near the tray IPC. | `packages/desktop-shell/main.cjs` (comment); rename in 1–2 places if typo confirmed | S |
| 3 | **A1 — extract install logic into daemon-callable module**: lift `runInstall()` from `packages/mcp-server/src/cli/install.ts` into a shared module the desktop-shell can `require()` without going through the CLI shell. Keep the CLI wrapper as-is for CI/power users. Path: new `packages/daemon/dist/install/runInstall.js` or expose via existing dist. **No new npm dep.** | `packages/mcp-server/src/cli/install.ts` (extract pure logic into `packages/mcp-server/src/install/core.ts` and re-export); `packages/desktop-shell/install-bridge.cjs` (new, ~80 LOC, just spawns `node` against the existing CLI entry — see §2.4 risk 1 for why spawn-not-require) | M |
| 4 | **A3 — CAIRN.md schema v2** (per D-1): update `docs/CAIRN-md-spec.md` and the `CAIRN_MD_TEMPLATE` constant in `install.ts`. **Add** `## Whole` (one sentence, no bullets, the project's stable north star — CC-drafted, user-confirmed). **Keep** `## Goal` reframed as "current sub-`## Whole` milestone — what we're driving toward right now." **Drop** `## Current phase` (the time-anchored section: `**Last updated**: …`, `Phase`, `This week`, `Next week`). Add 2-line `> Cairn renders "What's in flight" — do not edit by hand` marker (computed line, not stored in file). | `docs/CAIRN-md-spec.md`; `packages/mcp-server/src/install/core.ts` (or wherever template lives after step 3); `packages/desktop-shell/mentor-project-profile.cjs` (scanner: extract `whole_sentence` + keep `goal`, drop `current_phase`); `CAIRN.md` (this repo's own — dogfood) | M |
| 5 | **A4 — local haiku fallback drafter**: new `packages/desktop-shell/cairn-md-drafter.cjs`. Inputs: project_root, git log tail (last 20 commits, oneline), top-level dir tree (1 level, ≤ 50 entries), package.json `name`/`description` if present. Output: a `## Whole` sentence + suggested ⚠️/🛑 entries derived from package.json scripts (e.g., `npm publish` → 🛑). Uses the Mentor's existing provider plumbing in `mentor-handler.cjs`. **Falls back to template scaffold if provider unavailable**; no thrown errors. | `packages/desktop-shell/cairn-md-drafter.cjs` (new); reuses `mentor-handler.cjs` provider client | M |
| 6 | **A2 — dispatch a draft request to attached CC via scratchpad inbox**: at panel "Add project" completion, if any `processes` row for that project_root has `client:claude-code` (or `client:cursor`) capability, write a scratchpad key `agent_inbox/<agent_id>/<ulid>` with body: "draft CAIRN.md `## Whole` and ✅/⚠️/🛑 lines for the project at `<root>`; deliverable is the file written to `<root>/CAIRN.md` (the haiku fallback already wrote a baseline — replace it or annotate it). Anti-framing: this is a Project Director's job description, not a Senior Engineer's. Mentor is NOT Claude Code's plan-mode output." Concurrently start A4 haiku draft with a 30s race; whichever lands first wins, the other is offered as "alternative draft" in the Activity feed. | `packages/desktop-shell/main.cjs` (add-project handler ~line 1001 — extend); `packages/desktop-shell/cockpit-state.cjs` (new helper `findCairnAwareAgent(projectRoot)`); reuses existing `agent_inbox` namespace from `cockpit-steer.cjs` | M |
| 7 | **fs.watch CAIRN.md → confirmation card on `## Whole` line**: when CAIRN.md is created/modified, the panel re-scans `mentor-project-profile.cjs` and renders a Module-1 (state strip) one-sentence confirmation: "Whole: `<rendered ## Whole>`". No mutation button; this is read-only display per D9. | `packages/desktop-shell/mentor-project-profile.cjs` (already exists — add `whole_sentence` field to extracted profile); `packages/desktop-shell/panel.html` + the existing state-strip renderer | M |
| 8 | **A5 — anti-framing in dispatch prompt**: literally bake the "Project Director's job description, not Senior Engineer's; Mentor is NOT Claude Code's plan-mode output" sentence into the prompt body in step 6. Plus 3-line example of what a good `## Whole` reads like (single sentence, names the *finished form*, not the *current sprint*). | (already in step 6's prompt body) | S |
| 9 | **A6 — make CC actually read the inbox**: append to the `cairn install`–scaffolded `CAIRN.md` template a new section `## For Cairn-aware coding agents` step "0. Before any other action, check `cairn.scratchpad.list(prefix='agent_inbox/<your-agent-id>/')` and handle any pending items." Also append a 1-line hint to the `.mcp.json` `description` field (descriptive, agents that parse the field will see it). **No CC-side protocol change required** — we change what the *project repo* tells the agent, which CC already reads via CLAUDE.md/CAIRN.md inheritance. | `packages/mcp-server/src/install/core.ts` (template update); `docs/CAIRN-md-spec.md` (schema doc update); existing `CAIRN.md` in this repo gets the same edit as dogfood | S |
| 10 | **F2 + F4 — doc sync flow-off**: USER-TESTING-GUIDE-draft.md §2 (Add Project) + §4.1 (CAIRN.md schema) rewritten against new flow; grep-sweep "Agent OS", "三动词", "v2 PoC-3 dispatch" out of `docs/**`. F3 ("Phase 4" disambiguation): add a one-line "Phase 4 (kernel) vs Phase 4 (desktop-shell)" note in `ARCHITECTURE.md` glossary section. | `docs/USER-TESTING-GUIDE-draft.md`; `docs/**` (grep-replace); `ARCHITECTURE.md` (one note) | M |

Total: 10 tasks, 2 S + 6 M + 0 L (excluding cross-cutting). Estimated 12–16h focused work, or two 1-day sessions.

### §2.3 Cross-cutting concerns

- **scratchpad key conventions**: Phase 1 introduces two new namespaces consistent with the existing `agent_inbox/<agent_id>/<ulid>` and `project_profile/<project_id>` patterns. No new tables, no new migrations.
  - `agent_inbox/<agent_id>/<ulid>` — reused; A2 writes the CAIRN.md draft request here.
  - `project_profile/<project_id>` — Mentor's L1 cache of CAIRN.md; A4/A2 both invalidate it on file write.
- **IPC handler pattern**: extend the existing `ipcMain.handle('add-project', …)` at `main.cjs:1001` rather than adding a sibling handler. Same return shape; new fields `cairn_md_action: 'drafted_haiku' | 'drafted_cc' | 'scaffolded' | 'preserved'`, `draft_dispatched_to: <agent_id | null>`.
- **Provider client**: A4 reuses `mentor-handler.cjs`'s existing haiku-call plumbing (no new HTTP client; no new dep).
- **No new SQLite migrations.** A6's "CC reads inbox" works entirely through scratchpad + file content; no schema change.
- **No new MCP tools.** All A-team work composes existing 28 tools.
- **Read-only D9 stays intact.** "Accept the drafted CAIRN.md" is a *file write* (the haiku already wrote it); no DB mutation. Panel does not gain a mutation button. The Activity-feed confirmation card is read-only.

### §2.4 Risks worth grilling BEFORE writing code

1. **Risk: A1 says "move install logic into daemon."** Daemon process model today is "spawned per `npm start` of desktop-shell" — it is not a long-running daemon with an IPC port. Calling `runInstall()` directly inside the Electron main process via `require()` puts node-fs / write side effects into the renderer-adjacent main process. **Grill**: do we (a) `require()` from Electron main and accept the coupling, or (b) `spawn` the existing CLI binary as a child process and parse its JSON output? Option (b) is cleaner (preserves CLI as source of truth, idempotent, no shared mutable state). Recommend (b). Decide before step 3.

2. **Risk: A2's "CC polling agent_inbox" depends on CC actually reading CAIRN.md at session start.** Today, CC reads `CLAUDE.md` automatically; whether it reads `CAIRN.md` depends on the user adding it to CC's context. **Grill**: is appending a sentence to `.mcp.json`'s `description` enough? Or do we also need to append `Read @CAIRN.md` to a project's `CLAUDE.md` (which Cairn shouldn't own)? Recommended answer: step 9 modifies CAIRN.md content so an agent that ever reads it gets the instruction; we **do not** mutate CLAUDE.md. If a user's CC never reads CAIRN.md, the haiku fallback covers it — A2 is best-effort, A4 is the hard floor.

3. **Risk: A4 haiku draft may produce a `## Whole` sentence that frames the project wrong** (e.g., describes today's state instead of the finished form). **Grill**: how do we keep the haiku from drifting? Recommended: bake a 3-example few-shot into the prompt + require output to match a `/^[A-Z].{20,200}\.$/` shape (single sentence, capitalised, period-terminated, 20–200 chars). On format failure, fall back to scaffold-template (not retry — drift means the project signal is too thin).

4. **Risk: race between A2 (CC) and A4 (haiku).** If CC writes first and haiku writes second, we clobber the better draft. **Grill**: who arbitrates? Recommended: haiku runs *first* and always writes the file; A2's CC request is dispatched with the haiku draft inline as input ("here's the baseline — improve it or replace it"). This eliminates the race and gives CC strictly better context. Cost: ~1¢ per project add for haiku call. Cheap. Acceptable.

5. **Risk: panel's "What's in flight" computed line could be empty on first add** (no tasks yet) and look broken. **Grill**: do we render "Nothing in flight — your AI workforce is idle" (literal) or hide the line entirely? Recommended: render the literal — empty state is a real state and the panel is built to show it (Module 3 Activity feed already handles empty).

### §2.5 Acceptance gates (concrete verification commands)

```bash
# 0. Pre-flight: clean checkout
cd D:/lll/cairn
git status --short                               # only .cairn-worktrees/ allowed

# 1. Existing tests still green (no regressions in kernel/mcp)
cd packages/daemon    && npm test                # 411
cd ../mcp-server      && npm test                # 329 → +N new install-core tests
cd ../desktop-shell                              # vitest is N/A; uses smoke scripts

# 2. New smokes (Phase 1 must add these)
node packages/desktop-shell/scripts/smoke-add-project-flow.mjs
                                                 # ≥ 25 assertions:
                                                 # - add-project handler accepts project_root
                                                 # - install side effects land (.mcp.json + hook + launchers + CAIRN.md)
                                                 # - CAIRN.md contains "## Whole" section (v2 schema)
                                                 # - haiku fallback path writes file when provider stubbed
                                                 # - scratchpad agent_inbox key written when CC presence simulated
                                                 # - profile re-scan picks up "whole_sentence"
                                                 # - panel state strip renders "Whole: <...>"
                                                 # - re-running add-project is idempotent

node packages/desktop-shell/scripts/smoke-cairn-md-v2-schema.mjs
                                                 # ≥ 10 assertions on schema doc + template parity

# 3. Live dogfood (real Electron + real haiku call)
cd packages/desktop-shell && npm start
# Manual: click ＋ Add project…; pick D:\lll\some-empty-test-repo; verify:
#   - CAIRN.md exists in target with populated "## Whole"
#   - Activity feed shows a "draft delivered (haiku|cc)" event
#   - panel state strip shows the Whole sentence
#   - .mcp.json and pre-commit hook present

# 4. Repo hygiene check
git ls-files --others --exclude-standard         # empty (G1 done)
grep -rn 'CAIRN_DESKTOP_LEGACY' packages/        # consistent spelling
```

Acceptance gate (must all):
- **Hard floor**: `smoke-add-project-flow.mjs` ≥ 25 PASS; CAIRN.md created on a brand-new empty repo with no CC attached (haiku-only path).
- **Middle gate**: when a CC session is attached (simulated by a registered `processes` row with `client:claude-code` capability), the scratchpad `agent_inbox/<agent_id>/<ulid>` key is written and the dispatch prompt contains the anti-framing sentence verbatim.
- **High gate (skip OK)**: real CC actually consumes the inbox key and writes a better CAIRN.md. This is observation-only on Phase 1; we don't gate the merge on a CC-side behaviour we don't control.

---

## §3. Phase 2+ outline

### Phase 2 — Mentor rule completeness (Team C) + minor D bleed-in

Slice: C1/C2 (rules A & C — LLM judge / off-goal drift via L3 polish), C3/C4 (rules B & F — tail.log scanner; needs the per-process tail-log path already plumbed by the cockpit work), C5 (L3 wired into synchronous policy path with cost ceiling — open question #3 from 2026-05-13-mentor-3-layer plan), C6 (agent_brief staleness: >30 min → flag in Activity feed, do not discard), C7 (observed-behaviour loop — log Mentor decisions + user rewinds into a learning JSONL, no auto-tuning yet). Bundled D1 (naming collision L1/L2/L3 — rename Mentor's layers to "M1/M2/M3" or "profile/brief/polish" to free L1/L2/L3 for panel view layers).

### Phase 3 — Product Layer UX polish (Team D minus D1, D6)

D2 multi-agent steer target selector; D3 old `#view-project` 5-tab cleanup (remove dead code, single-source the view); D4 non-developer language pass (translate `WAITING_REVIEW` → "reviewing your work"; `BLOCKED` → "stuck — needs an answer"; `PENDING_REVIEW` (conflict) → "two agents wrote the same file"); D5 first-run "What is Cairn?" overlay (one-screen, 5 cards: surface / kernel / Mentor / Continuous / Multi-Cairn). D6 (mac/Linux) intentionally deferred to Phase 5 with E2.

### Phase 4 — Mode B Continuous Iteration (Team B1 + B2)

B1 Mode A Mentor recommender (ranked work items + WHY + stakeholders) — depends on Phase 2's full Mentor rule set. B2 Mode B Continuous Iteration (user-authorised chain: scout → worker → review, stop at REVIEWED — per §1.3 #4a anti-definition). B3 Multi-Cairn v0 deferred to Phase 5 (it's a separate axis, independent of B1/B2).

### Phase 5 — Distribution + Multi-Cairn (Teams E + B3)

E1 published installer artifact; E2 mac/Linux builds; E3 auto-update channel (Squirrel.Mac / electron-updater); E4 first-launch onboarding (cooperates with Phase 3's D5 overlay). B3 Multi-Cairn v0 (shared dir + JSONL outbox, read-only — per §1.3 #8a anti-definition). F1 ARCHITECTURE.md v3→v4 rewrite as paperwork closer; F5 non-dev pitch doc with screenshots/GIFs (drawn from finalised packaging).

---

## §4. Cross-phase dependency map

| Item | Blocks | Reason |
|---|---|---|
| A1 (install in daemon) | A2, A3, A4, A6, F2 | Every CAIRN.md-touching task needs a single source of truth for the template & install side effects. F2 docs the new flow. |
| A3 (schema v2) | C5 (L3 polish) | L3 reads CAIRN.md sections; if schema changes mid-Phase-2, L3 prompt construction breaks. C5 must wait until A3 lands. |
| A3 | F1 (ARCHITECTURE v3→v4) | F1 documents the layered model; the 5-layer story now includes the CAIRN.md substrate (L1 substrate for Operations layer). |
| A4 (haiku drafter) | A2 | A2 races against A4; recommended (§2.4 risk 4) is A4 always writes first, A2 gets the draft as input. |
| A6 (CC reads inbox) | (none in Phase 1) | A6 is best-effort. Its absence does not block ship. |
| G1 (stray files) | All worktree work | Dirty main checkout breaks `git worktree add` cleanly. Must precede step-3-onward. |
| C1–C5 (Mentor rules) | B1 (Mentor recommender), B2 (Mode B) | Both Mode A and Mode B depend on a Mentor that has the full rule set + L3 wired in. Shipping B on a stubbed Mentor risks under/over-escalation. |
| C5 (L3 wired) | gated on A3 | Confirmed above. |
| D1 (naming L1/L2/L3) | D4 (state-name translation) | D4 changes panel copy; D1 changes layer names. Doing D4 first leaves stale L1/L2/L3 strings. |
| **E (packaging) ⊥ everything** | nothing else gates E | E1/E2/E3 are isolated build-system work. Can run as a parallel background lane any time after Phase 1 stabilises. Confirmed: A items do not touch electron-builder config. |
| F2 (USER-TESTING-GUIDE §2/§4.1) | gated on A1 + A3 | Doc reflects the new flow + new schema; can't write it until the flow is real. |
| F5 (non-dev pitch + screenshots) | gated on Phase 3 (D) | Screenshots are of the polished panel; capturing them before D3/D4/D5 means re-shooting. |
| B3 (Multi-Cairn v0) | gated on E1 (installer) loosely | Multi-Cairn assumes ≥ 2 machines running Cairn. Without a real installer, the test surface is "2 dev checkouts" which is acceptable but suboptimal. Not a hard block. |

---

## §5. Grilling memo

Five questions for the CEO-reviewer before we DUCKPLAN Phase 1.

**Q1.** Why is A6 (CC polling `agent_inbox`) inside Phase 1 instead of a follow-up?
**A.** Because A6 as scoped *does not require a CC-side protocol change*. We append instructions to the `CAIRN.md` template and the `.mcp.json` `description`. CC reads CAIRN.md whenever the user includes it in context (today, common); CC reads `.mcp.json` to discover the MCP server. **We are not modifying CC.** If CC never reads CAIRN.md, A4 (haiku) covers the draft on its own and the pipeline still ships — A6 is graceful enhancement, not a gate. If the reviewer's concern is "we're depending on user behaviour (adding CAIRN.md to context)," the honest answer is: yes, partially. The hard floor (A4) does not depend on user behaviour; A6 enhances when the user does the natural thing.

**Q2.** A1 says "move install into daemon"; should we instead spawn the CLI as a child?
**A.** Yes — recommendation in §2.4 risk 1 is spawn-not-require. Backlog phrasing said "into the daemon"; literal interpretation would put install fs-side-effects into Electron main, which is uglier than child-spawn. The spawn approach keeps the existing CLI as source of truth, preserves idempotency, gives clean JSON output to parse, and avoids any new coupling. If the reviewer prefers in-process for some reason (e.g., latency), say so now — implementation will be very different.

**Q3.** Backlog item A3 says drop `## Goal` and `## Current phase`. The today's `CAIRN.md` template has both, and `mentor-project-profile.cjs` scanner probably keys off them. Aren't we breaking the Mentor 3-layer plan that just shipped?
**A.** Partly. The 3-layer plan (`2026-05-13-mentor-3-layer-decision.md`) treats `## Goal` and `## Current phase` as legal-but-optional sections — Mentor falls back when absent. Dropping them is a schema simplification, not a contract break. **But** the scanner code (`mentor-project-profile.cjs`) will need a one-line update to stop extracting those fields, and any test that asserts their presence needs deletion. This is a Phase 1 deliverable already in §2.2 step 4. Reviewer should confirm: do we *delete* the fields from the schema, or *deprecate* them (still parse if present)? Recommendation: delete (less code, less drift). If the user wants a "what was here before" memo, we put it in the CHANGELOG, not the template.

**Q4.** A4 (local haiku drafter) introduces a network dependency at panel "add project" time. Doesn't that violate "no HITL gates" in spirit if the network is down?
**A.** No, because A4 has a deterministic fallback to the existing scaffold template (graceful degradation, mirrors the dispatch LLM degradation pattern in `AUTOMATION.md`). The pipeline does not wait on the network; it tries haiku for ≤ 5s, falls back to scaffold, marks Activity-feed event "haiku unavailable — used scaffold; will improve when CC attaches." This is the same pattern as `completionWithRetry` in the daemon's `dispatch/llm-client.ts`. No HITL.

**Q5.** Is "anti-framing" (A5) really worth a dedicated backlog item, or is it just prompt copy?
**A.** It's prompt copy. §2.2 collapses A5 into step 6 (it's a sentence in the dispatch prompt body). The reviewer should know this is **not** being silently dropped — it's executed but doesn't earn its own step. Same applies as a sub-item: A6 has two surfaces (CAIRN.md template addendum and `.mcp.json` description hint), which is arguably *2 sub-items*, but both are tiny and pair naturally. Flagging here per the instruction "if a backlog item is actually 2-3 sub-items, note that": **A6 splits into A6a (CAIRN.md template addendum) and A6b (.mcp.json description hint).**

Bonus sub-item discovery:
- **A2 splits into A2a (CC dispatch via `agent_inbox`) and A2b (fs.watch + Module-1 confirmation card)** — the dispatch and the panel response are independent code paths and could be reviewed separately.
- **G2 splits into G2-rename and G2-verify** — first determine if the env var is actually misspelled (grep found consistent `CAIRN_DESKTOP_LEGACY` spelling, looks fine); if no typo, G2 collapses to G3-only.

---

## §6. Excluded from Phase 1 (deliberately)

| Item | Why pushed |
|---|---|
| **D5 — First-run "What is Cairn?" overlay** | Tempting to bundle with A's first-touch story, but the overlay describes a *finished* product. Building it now means rebuilding it after D3/D4 reshape the panel copy. Push to Phase 3. |
| **F5 — Non-dev pitch with screenshots/GIFs** | Same reason as D5 — capturing screenshots before D-team polishes the panel produces throwaway assets. Phase 5 closer. |
| **B1 — Mentor recommender (ranked work items + WHY)** | Sounds adjacent to A's `## Whole`, but B1 needs the full Mentor rule set (C1–C7). Building B1 on stubbed rules invites the same "Mentor sounds smart but drifts" failure the 2026-05-13 reframe was meant to fix. Wait for Phase 2 to finish. |
| **E1 — published installer artifact** | electron-builder NSIS already produces a working artifact; "published" means uploading to GitHub Releases and that's a CI/release-engineering concern orthogonal to bootstrap. Phase 5. |
| **F1 — ARCHITECTURE.md v3→v4 rewrite** | Big paperwork lift. Doing it now means re-doing it after C5 changes Mentor's layer wiring. F1 is the *closer*, after the new layout is real. |

Cut summary: 5 items, all "feels close" but each fails the test "does Phase 1's value depend on this?". Phase 1 stands without them.

---

## Appendix — Author's call-outs (under-defined / contradictory in backlog)

These are not part of the plan body; flagging for the reviewer per instructions.

1. **Backlog A3 says "What's in flight becomes a panel-computed line."** Computed from what? `tasks` table only? `tasks` + `processes` + `dispatch_requests`? Most useful is "active tasks for this project, plus running `processes` rows attributed via `cwd`/`git_root`." Recommend: explicit definition in DUCKPLAN. Suggested formula:
   ```
   in_flight = count(tasks where status in {RUNNING, READY_TO_RESUME})
             + count(processes where state='active' and project_match(p, project))
   ```
2. **Backlog A2 dispatches a "draft request" via `agent_inbox`.** `agent_inbox` today is a scratchpad namespace, not a `dispatch_request` row. The backlog text said "dispatch a draft request" which could be read as "use `cairn.dispatch.request` MCP tool." Recommend: use `agent_inbox` (scratchpad namespace, already proven by cockpit-steer), NOT `dispatch_requests` table (that's for keyword-fallback routing of NL intents to agents — different beast). Flag for reviewer confirmation.
3. **Backlog A3 drops `## Goal` but Mode A Mentor (B1) was specced against `## Goal` as one input signal.** If B1's "ranked work items + WHY" reads project intent, it now reads `## Whole` instead. Recommend updating Mode A spec in DUCKPLAN. Not a Phase 1 problem (B1 is Phase 4) but worth recording.
4. **G2 — `CAIRN_DESKTOP_LEGACY` typo.** Grepped: consistent spelling across `CLAUDE.md`, `docs/USER-TESTING-GUIDE-draft.md`, panel code. **No typo found.** Backlog item should be marked verified, not "verify the env var name." G3 (tray aggregation logic) is the real ask.
5. **D1 — "L1/L2/L3 naming collision."** Backlog frames this as a Mentor-layers vs panel-view-layers collision; today's Mentor 3-layer plan (2026-05-13) names them L1/L2/L3. Recommend: rename Mentor's layers to "profile / brief / polish" in code + docs; reserve L1/L2/L3 for panel view layers (Mode A — multi-project, Mode B — single-project, Mode C — task-detail). This is Phase 2 work, not Phase 1.
6. **Backlog has no item for "Cairn project itself needs a v2 CAIRN.md."** The current repo's `CAIRN.md` predates the schema-v2 change. Recommend bundling that edit into §2.2 step 4 as dogfood — already implicit but should be explicit.

---

*End of DRAFT. Awaiting CEO grilling pass. Implementation will branch into one DUCKPLAN per phase.*
