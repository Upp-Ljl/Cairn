# DUCKPLAN — Phase 3: kernel-side authority-bucket routing in `cairn.task.block`

> Filename: `2026-05-14-phase3-authority-routing.md`
> Status: **PLAN** — for execution this session.
> Source: Phase 2 closer reveals Mentor only fires on `## Known answers` substring. CAIRN.md `## Mentor authority` ✅/⚠️/🛑 is unconsulted in the synchronous block path. This plan extends the same call to consult all three buckets.
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md`; decisions baked in §0 per `feedback_resolve_grill_memo_yourself`.
> Roadmap classification: **Product MVP polish** (CLAUDE.md §12 D10).

## Thesis

Phase 2 shipped: `cairn.task.block` reads CAIRN.md `## Known answers` + returns `auto_resolved: true + answer` in the same MCP call. Coverage is narrow — only exact-pattern blockers auto-resolve.

Phase 3 widens it: when `## Known answers` misses, try `## Mentor authority` bucket matching (same `matchBucket` semantics already used by `mentor-policy.cjs` Rule D). Three routes per CAIRN.md spec:
- ✅ `auto_decide` → auto-resolve, silent (no Activity announcement)
- ⚠️ `decide_and_announce` → auto-resolve, **plus** `announce: true` flag (panel renders it in Activity feed)
- 🛑 `escalate` → **do NOT** auto-resolve; return `auto_resolved: false` + a `mentor_recommendation: { route: 'escalate', matched_pattern, body }` field so the agent knows Cairn flagged it irreversible. The blocker stays OPEN. The agent / user decides.

This composes existing kernel primitives + the existing `matchBucket` semantics — no new MCP tools, no schema, no LLM.

## §0. Decisions baked in

| # | Decision | Rationale |
|---|---|---|
| **D-1** | Routing order: known_answers (Phase 2, narrowest) → 🛑 escalate (highest stake, wins over auto_decide if both match) → ✅ auto_decide → ⚠️ decide_and_announce → no match (passive block) | Mirrors `routeBySignal` in desktop-shell `mentor-policy.cjs` (which orders 🛑 first); maintains semantic parity across layers. |
| **D-2** | On ✅/⚠️ auto-resolve, the synthesized answer is `"Mentor proceeded per CAIRN.md rule: <matched bullet>"` — exactly the wording `mentor-policy.cjs::composeNudgeBody` uses today. | Cross-layer consistency. Agent reading the answer sees the same phrasing whether it came from kernel sync path or panel-side mentor-tick. |
| **D-3** | On 🛑 match, the response shape is `{ blocker, task: BLOCKED, auto_resolved: false, mentor_recommendation: { route: 'escalate', matched_pattern, body } }`. Task state stays BLOCKED — kernel does not unilaterally resolve a 🛑. Caller decides next step. | Honors CAIRN.md semantics. Agent sees the recommendation in the response and can: (a) wait for user, (b) abandon, (c) override per its own judgment. |
| **D-4** | Scratchpad event keys per route: `mentor/<agent_id>/auto_decide/<ulid>` (✅) / `mentor/<agent_id>/announce/<ulid>` (⚠️) / `mentor/<agent_id>/escalate/<ulid>` (🛑). The Phase-2 `auto_resolve/<ulid>` key is reserved for known_answers matches (preserved for distinction). | Each route surfaces distinctly in the Activity feed so the user can scan "Mentor decisions" vs "Mentor escalations" without re-parsing JSON. |
| **D-5** | Response field name for the recommendation (escalate path): `mentor_recommendation` not `escalation`. | "Escalation" implies kernel created a Module 5 row; this path doesn't (it's a hint to the agent). Reserve `escalation` for the Module-5 path. |
| **D-6** | Reuse `matchBucket` from `daemon/src/cairn-md/scanner.ts` (already exported and used in Phase 2 scanner tests). No new helper. | Same two-stage substring + ≥2 token-overlap fallback semantics as desktop-shell. One canonical matcher across both layers. |

## §1. Plan (one paragraph)

In `mcp-server/src/tools/task.ts::toolBlockTask`, after the existing `matchKnownAnswer` check fails (no `auto_resolved` from known_answers path), apply a second-pass `matchBucket` against profile.authority in order: escalate → auto_decide → decide_and_announce. On 🛑 hit: return `{ blocker, task: BLOCKED, auto_resolved: false, mentor_recommendation }` with the blocker left OPEN; emit `mentor/<agent_id>/escalate/<ulid>` scratchpad event. On ✅ hit: same outer `db.transaction()` pattern as Phase 2 (recordBlocker + markAnswered + putScratch), but the synthesized answer is `"Mentor proceeded per CAIRN.md rule: <bullet>"`, scratchpad key is `mentor/<agent_id>/auto_decide/<ulid>`, response gains `route: 'auto'`. On ⚠️ hit: same as ✅ but `route: 'announce'` + scratchpad key `mentor/<agent_id>/announce/<ulid>`. Zero new MCP tools, zero new migrations, zero new npm deps. One modified file (`task.ts`), three new tests in `tests/tools/task-auto-resolve.test.ts`, one extended dogfood script.

## §2. Expected outputs

- `packages/mcp-server/src/tools/task.ts` — extend `toolBlockTask` second-pass logic; new `BlockTaskResultEscalate` interface in the union; `mentor_recommendation` shape.
- `packages/mcp-server/tests/tools/task-auto-resolve.test.ts` — extend with sections for 🛑 / ✅ authority / ⚠️ authority routes (≥9 new assertions on top of Phase 2's 14).
- `packages/mcp-server/scripts/phase2-sync-mentor-dogfood.mjs` — rename to `phase23-mentor-dogfood.mjs` (or add a sibling) covering the three new routes end-to-end via MCP stdio.

## §3. How to verify

```bash
cd packages/daemon && npm test                    # 439 (no change)
cd ../mcp-server && npm test                      # 377 + new Phase 3 cases
cd packages/mcp-server && node scripts/phase23-mentor-dogfood.mjs
# → expect: 4 routes verified (known_answer / escalate / auto_decide / decide_and_announce)
#   + passive-block path still works
#   + all auto-resolve cases write scratchpad mentor/<agent_id>/<route>/<ulid>
```

## §4. Risks + mitigations

1. **🛑 / ✅ token-overlap matches false-positive on benign questions.** Mitigation: keep matchBucket's existing ≥2 content-token requirement, which already excludes most one-word coincidences. Document in CAIRN.md spec that authors keep bullets short. No code change.
2. **Bucket ordering ambiguity** if a question matches both 🛑 and ✅. Mitigation: D-1 locks order — 🛑 always wins (per `routeBySignal`). Test covers it.
3. **Backward compat**: existing Phase 2 tests assert response shape with `auto_resolved` boolean. Phase 3 adds new optional fields (`route`, `mentor_recommendation`) — additive, no breakage.

## §5. Out of scope (defer)

- Tail.log scanning for Rule B/F — needs worker-run infrastructure that doesn't exist yet on the kernel side.
- LLM judge for Rule A / Rule C — separate phase; provider config concern.
- Mode A recommender (panel-side "next suggested work item") — UI work, separate concern.
- Mode B Continuous Iteration — biggest gun, separate phase.
