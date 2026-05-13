# DUCKPLAN — Phase 2: Synchronous Mentor known-answer resolution inside `cairn.task.block`

> Filename: `2026-05-14-phase2-sync-mentor.md`
> Status: **PLAN** — for the next session's lead agent to execute.
> Author: lead agent, drafted fresh against the repo at `D:/lll/cairn` 2026-05-14.
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md` (DUCKPLAN four-section, extended with §0 baked decisions + §5 risks + §6 out-of-scope per repo precedent — see `2026-05-13-mentor-3-layer-decision.md` and `2026-05-14-bootstrap-grill.md`).
> Roadmap classification: **Product MVP polish** (CLAUDE.md §12 D10).

## Thesis (locked, not for re-grilling)

When a Cairn-aware coding agent calls `cairn.task.block(question="…")`, the mcp-server checks the project's `CAIRN.md` `## Known answers` section for a substring match against `question`. If matched, the same MCP call (a) records the blocker, (b) immediately answers it, (c) transitions the task `RUNNING → BLOCKED → READY_TO_RESUME`, (d) returns `{ auto_resolved: true, answer, matched_pattern, … }` to the caller, and (e) writes a scratchpad event for the panel's Activity feed. The agent's next iteration uses the answer with **zero paging latency**. Today the same answer arrives ~30 s later via `mentor-tick.cjs` (panel side, CommonJS scanner), after the agent has already idled — Phase 2 closes that gap to ~0 ms.

Out of scope: `tail.log` scanning (Rule B/F), off-goal drift (Rule C), Mode B Continuous Iteration, Mode A recommender, L3 LLM polish on the kernel side. Listed in §6.

---

## §0. Decisions baked in

These are reversible / local / implementation-detail decisions per `CLAUDE.md` § Decision Rules and `GRILL.md` "Anti-Grilling Patterns". Lead agent has settled them; the executor does not re-ask.

| # | Decision | Rationale |
|---|---|---|
| **D-1** | **Where the CAIRN.md parser lives for mcp-server: option (b) — move canonical parser to `packages/daemon` as TypeScript; both desktop-shell `.cjs` and mcp-server `.ts` import from `daemon/dist/`.** | The three candidates were (a) duplicate TS parser inside mcp-server, (b) canonical in daemon TS with both clients consuming `dist/`, (c) keep desktop-shell as owner + mcp-server spawn-reads CAIRN.md with a minimal helper. Option (a) creates two scanners that drift (the existing `mentor-project-profile.cjs::matchKnownAnswer` and a new one) — Phase 2 ships fine, Phase 3 breaks when known-answer matching semantics diverge. Option (c) puts a markdown-parser in mcp-server's hot path with worse cache story. Option (b) matches the cross-package pattern already in use (CLAUDE.md "monorepo 结构": "跨包 import 走 daemon 的 `dist/`"). Daemon already exports types/repos that mcp-server consumes; adding a `storage/cairn-md/` module is the same pattern. Desktop-shell keeps its existing `.cjs` (no churn there), but re-points the pure-parse functions to `require('../daemon/dist/cairn-md/scanner.js')` — see §2 step 3 for the bridge. |
| **D-2** | **Auto-resolve is atomic with the block, executed as two sequential repo calls inside a single outer `db.transaction()`.** | `recordBlocker` and `markAnswered` each open their own `db.transaction()`. better-sqlite3 flattens nested transactions to SAVEPOINTs (see comment in `blockers.ts::transitionTaskInTx`), so wrapping the pair in an outer `db.transaction()` is safe and gives the call a single visible commit. From the caller's perspective the task observes `RUNNING → BLOCKED → READY_TO_RESUME` transition without any intermediate window where another mcp-server session can race. State machine (`tasks-state.ts`) permits both transitions; no schema change. |
| **D-3** | **Caching: mtime-gated re-scan of CAIRN.md per `ws.gitRoot`, stored in the existing `scratchpad` table under key `project_profile_kernel/<sha1(gitRoot)>`.** | Same convention as desktop-shell's `project_profile/<project_id>` key. We **do not** share the desktop-shell key — the desktop side uses a project-row UUID, mcp-server has no `projects` table. Different key prefix prevents collision; both layers re-scan independently when their respective mtime advances. No new migration. Cache invalidation: TTL is implicit via mtime; manual force-rescan via env `CAIRN_KERNEL_PROFILE_NOCACHE=1` (for tests). |
| **D-4** | **Scratchpad key for the Activity event: `mentor/<session_agent_id>/auto_resolve/<ulid>`.** | Aligns with existing namespaces: `mentor/<pid>/nudge/<ulid>` and `escalation/<pid>/<ulid>` (per `CAIRN.md` "where does mentor write nudges"). One ULID per auto-resolve event — never re-keyed. Value JSON shape: `{ task_id, blocker_id, question, matched_pattern, answer, source: "kernel_sync", scanned_from: "<abs path to CAIRN.md>", resolved_at: <ms> }`. The desktop-shell Activity-feed renderer already scans `scratchpad` for `mentor/` keys; this surfaces automatically without panel-side changes. |
| **D-5** | **Substring matching reuses the existing semantics: `question.toLowerCase().includes(pattern.toLowerCase())`.** | Identical to `matchKnownAnswer` in `mentor-project-profile.cjs` (line 584). The canonical parser in daemon exports `matchKnownAnswer(knownAnswers, question)` with the same shape. **First match wins** (top-down bullet order). Matching ≥1 pattern yields auto-resolve; matching 0 patterns is a normal block (no behavior change). Multiple matches do NOT escalate — we trust author bullet ordering. The matched pattern is recorded in the response + scratchpad so the user can refactor CAIRN.md if the first-match rule picks the wrong bullet. |
| **D-6** | **Backward-compat shape: `auto_resolved` is an additive boolean field on the existing block response.** | Existing response: `{ blocker, task }` or `{ error: { code, … } }`. New shape on auto-resolve: `{ blocker, task, auto_resolved: true, answer, matched_pattern, scratchpad_key }`. New shape on normal block (no match, CAIRN.md absent, etc.): `{ blocker, task, auto_resolved: false }`. Existing tests assert `'blocker' in r` and `task.state === 'BLOCKED'` — auto_resolve cases change `task.state` to `READY_TO_RESUME`, which **does** require updating existing tests (`packages/mcp-server/tests/tools/task.test.ts` line 295). See §5 risk 5. |

---

## §1. Plan (one paragraph)

Lift CAIRN.md scanning out of desktop-shell `.cjs` into a canonical TypeScript module `packages/daemon/src/cairn-md/scanner.ts` that exports `loadProfile(db, gitRoot)`, `matchKnownAnswer(profile, question)`, and the `Profile` type. Re-point `mentor-project-profile.cjs` at the new dist module so desktop-shell loses ~600 lines of duplication. In `packages/mcp-server/src/tools/task.ts::toolBlockTask`, before calling `recordBlocker`, look up the profile for `ws.gitRoot`, run `matchKnownAnswer(profile, args.question)`. If a hit is returned, wrap the `recordBlocker` + `markAnswered` pair in a single `db.transaction()`, write a `mentor/<agentId>/auto_resolve/<ulid>` scratchpad event in the same transaction via `putScratch`, and return `{ blocker, task: <READY_TO_RESUME row>, auto_resolved: true, answer, matched_pattern, scratchpad_key }`. If no hit, fall through to the existing behavior with `auto_resolved: false` appended. Zero new MCP tools, zero new migrations, zero new npm deps. One new file in daemon, one modified file in mcp-server, one modified file in desktop-shell (the bridge), plus tests + one smoke + dogfood evidence.

---

## §2. Expected outputs

### New files

- `packages/daemon/src/cairn-md/scanner.ts` — canonical TypeScript port of `mentor-project-profile.cjs`. Exports:
  - `type Profile` (matching the v2 shape in `docs/CAIRN-md-spec.md`)
  - `function scanCairnMd(absPath: string): Profile`
  - `function loadProfile(db: DB, gitRoot: string): Profile` (mtime-gated cache via scratchpad key `project_profile_kernel/<sha1(gitRoot).slice(0,16)>`)
  - `function matchKnownAnswer(profile: Profile, question: string): { pattern: string; answer: string } | null`
  - Internal helpers (`splitSections`, `extractBullets`, `parseKnownAnswers`, etc.) — not exported, ports of the `.cjs` originals byte-for-byte equivalent in match semantics.
- `packages/daemon/src/cairn-md/index.ts` — barrel re-export.
- `packages/daemon/tests/cairn-md/scanner.test.ts` — ≥20 assertions: parses a fixture CAIRN.md with all v2 sections; round-trip cache hit / mtime-advance miss; `matchKnownAnswer` first-match-wins; absent-file → `exists: false`; malformed file (no H1) → `exists: true, project_name: null`; cache key shape; multi-pattern match returns first.
- `packages/mcp-server/tests/tools/task-auto-resolve.test.ts` — ≥15 assertions, new file (do not mix with existing `task.test.ts` to keep blast radius bounded). Covers: happy path (RUNNING → block(matched q) → response has `auto_resolved: true` + `task.state === 'READY_TO_RESUME'`); no-match path (`auto_resolved: false`); CAIRN.md absent (no error, normal block); blocker.answer matches; scratchpad key written and parseable; raised_by + answered_by both default to ws.agentId; concurrent two-task scenario (no leak between tasks); cache mtime invalidation observable.
- `packages/mcp-server/scripts/smoke-phase2-sync-mentor.mjs` — ≥10 assertions: real stdio MCP boot → `cairn.task.create` → `start_attempt` → `block(question="which test framework should I use here?")` → response asserts `auto_resolved: true, answer.includes("vitest"), matched_pattern.includes("test framework")` → `cairn.scratchpad.list` shows the new key.

### Modified files

- `packages/mcp-server/src/tools/task.ts`:
  - Add imports from `../../daemon/dist/cairn-md/index.js` for `loadProfile` + `matchKnownAnswer`.
  - Extend `toolBlockTask` per §1 — new lookup branch before `recordBlocker`, new transactional wrapper, new return shape with `auto_resolved` field. Existing error paths unchanged.
  - Helper `function emitAutoResolveEvent(ws, payload)` — internal, calls `putScratch` once.
- `packages/mcp-server/src/index.ts`:
  - One-line `description` field update on the `cairn.task.block` tool definition (mentions auto-resolve). No schema change to `inputSchema`.
- `packages/desktop-shell/mentor-project-profile.cjs`:
  - Replace the pure-parse internals with `require('../daemon/dist/cairn-md/index.js')`-backed delegations. Public function shapes (`scanCairnMd`, `matchKnownAnswer`, `loadProfile`, etc.) preserved so existing panel code + smokes are not touched. Internal helpers (`splitSections`, `extractBullets`, …) become thin wrappers.
  - Cache key for desktop-shell remains `project_profile/<project_id>` — unchanged.
- `packages/daemon/package.json`:
  - No new deps. `"build"` output includes the new `cairn-md/` directory automatically (TS picks it up).
- `CHANGELOG.md`:
  - New `[0.3.x-phase2-sync-mentor]` entry: "kernel-side known-answer resolution shortens BLOCKED → READY_TO_RESUME from ~30s to ~0ms".

### Not changed

- No new MCP tool. No new migration. No SQLite schema change. No new npm dep. No PRODUCT.md edit. No `tasks-state.ts` edit. No `blockers.ts` edit. No `index.ts` MCP-tool-registration table change (only a description string).

---

## §3. How to verify

```bash
# 0. Pre-flight: clean working tree
cd D:/lll/cairn
git status --short                                # only .cairn-worktrees/ allowed

# 1. Existing tests still green
cd packages/daemon && npm test                    # 411 → 411 + ≥20 new = ≥431
cd ../mcp-server && npm test                      # 329 → 329 + ≥15 new = ≥344

# 2. Type-check
cd packages/daemon && npx tsc --noEmit
cd ../mcp-server && npx tsc --noEmit

# 3. Build artifacts visible (mcp-server depends on daemon/dist)
cd packages/daemon && npm run build
ls packages/daemon/dist/cairn-md/scanner.js       # expect present
ls packages/daemon/dist/cairn-md/index.js         # expect present
ls packages/daemon/dist/cairn-md/scanner.d.ts     # expect present

# 4. New mcp-server smoke (real stdio session)
cd packages/mcp-server && npm run build
node scripts/smoke-phase2-sync-mentor.mjs
# expect: 10/10 assertions PASS
# asserts:
#   - mcp-server boots against a fresh CAIRN_HOME
#   - test fixture CAIRN.md is written with `## Known answers` section
#     containing "which test framework => vitest..."
#   - cairn.task.create + start_attempt succeeds
#   - cairn.task.block({ question: "which test framework should I use here?" })
#     returns auto_resolved=true, task.state="READY_TO_RESUME",
#     answer.includes("vitest"), matched_pattern.includes("test framework")
#   - cairn.scratchpad.list(prefix="mentor/") shows one key matching
#     /^mentor\/cairn-session-[0-9a-f]{12}\/auto_resolve\/[0-9A-Z]{26}$/
#   - scratchpad payload has source="kernel_sync"
#   - second block on same task with non-matching question returns
#     auto_resolved=false and task.state="BLOCKED"
#   - cairn.task.resume_packet shows the resolved blocker in history

# 5. Live dogfood (real Claude Code session)
# Steps the user runs (Claude Code attached to D:/lll/cairn):
# a) ensure .cairn-worktrees/__lead__/ or main has the updated CAIRN.md
# b) in CC: ask CC to call cairn.task.create + start_attempt + 
#    cairn.task.block(task_id=<id>, question="which test framework should I use here?")
# c) assert CC's next tool result shows auto_resolved=true + answer containing "vitest"
#    in the same response, before any 30s mentor-tick fires
# d) assert panel Activity feed shows a "Mentor saved you a paging" line
#    within ~1s (panel polls scratchpad every 2s)

# 6. Regression: desktop-shell smokes still pass (parser is now a delegate)
cd packages/desktop-shell
node scripts/smoke-mentor-3layer.mjs              # ≥30 PASS (unchanged target)
# any other smoke that touches mentor-project-profile.cjs should remain green
```

Acceptance gate (all must hold):
- **Hard floor**: smoke 10/10 PASS; daemon + mcp-server total tests pass count strictly increases from baseline.
- **Middle gate**: live dogfood — CC observes `auto_resolved: true` in the same MCP response, no 30 s wait.
- **High gate**: desktop-shell smokes unchanged (parser delegation invisible from outside).

---

## §4. Probes (FEATURE-VALIDATION hard-match cross-check)

Two `claude --model haiku -p` probes against the artifact, plus a hard-match diff.

**Probe 1** — canonicalize the response shape:

```bash
claude --model haiku -p \
  "Given this TypeScript signature snippet from packages/mcp-server/src/tools/task.ts:
$(grep -A 30 'export function toolBlockTask' packages/mcp-server/src/tools/task.ts | head -60)

Output one-line JSON: {field_names_added: string[], task_state_on_auto_resolve: string, scratchpad_key_prefix: string}. No prose, no markdown fence." \
  > /tmp/probe-haiku.json
```

**Probe 2** — same prompt against a second engine for hard-match:

```bash
claude --model sonnet -p \
  "Given this TypeScript signature snippet from packages/mcp-server/src/tools/task.ts:
$(grep -A 30 'export function toolBlockTask' packages/mcp-server/src/tools/task.ts | head -60)

Output one-line JSON: {field_names_added: string[], task_state_on_auto_resolve: string, scratchpad_key_prefix: string}. No prose, no markdown fence." \
  > /tmp/probe-sonnet.json
```

**Hard-match assertion**:

```bash
jq -S . /tmp/probe-haiku.json > /tmp/h.json
jq -S . /tmp/probe-sonnet.json > /tmp/s.json
diff /tmp/h.json /tmp/s.json
# expect: zero diff
# expected canonical value:
#   {"field_names_added":["auto_resolved","answer","matched_pattern","scratchpad_key"],
#    "task_state_on_auto_resolve":"READY_TO_RESUME",
#    "scratchpad_key_prefix":"mentor/"}
```

If `diff` is non-zero, the response shape is under-documented in the code comments — fix the comments until both engines canonicalize identically. This is the FEATURE-VALIDATION Gate 1/Gate 2 mechanic.

---

## §5. Risks + mitigations

1. **Risk — concurrent `block` calls on the same task.** Two MCP sessions both call `block` on the same RUNNING task simultaneously. The first one acquires the write lock (better-sqlite3 SQLite is single-writer); the second sees `task.state === 'BLOCKED'` and `assertTransition('BLOCKED', 'BLOCKED')` throws `Invalid task state transition`. The second call returns `INVALID_STATE_TRANSITION` error — the same behavior as today. Auto-resolve does not introduce a new race window because the entire {check known_answers, recordBlocker, markAnswered, putScratch} sequence is inside one outer `db.transaction()` (D-2). **Mitigation**: explicit `db.transaction()` wrapper in `toolBlockTask` auto-resolve path; existing `INVALID_STATE_TRANSITION` error code covers the loser; unit test in `task-auto-resolve.test.ts` simulates a pre-blocked task to verify the error path is unchanged.

2. **Risk — CAIRN.md absent or malformed.** `loadProfile` returns a `Profile` with `exists: false` (or `exists: true` with empty `known_answers`). `matchKnownAnswer` returns `null`. Code path falls through to the existing `recordBlocker` call, response is `{ blocker, task, auto_resolved: false }`. **No HITL gate introduced** (AUTOMATION.md compliant). **Mitigation**: explicit unit test for both absent + malformed cases in `scanner.test.ts` and `task-auto-resolve.test.ts`.

3. **Risk — multiple `## Known answers` patterns match the same question.** First-match-wins per D-5. If author wrote two contradicting bullets (e.g. `which language => Python` followed by `language => TypeScript`), the first one wins; the question contains both substrings. **Mitigation**: matched pattern is recorded in the response + the scratchpad event, so the user can spot a mis-ordered CAIRN.md by reading the Activity feed and reorder bullets accordingly. We do **not** add a "warn on multi-match" branch — that's a Phase 3 polish if the failure mode is ever observed.

4. **Risk — layer crossing per D-1.** Desktop-shell currently runs the scanner in its own Electron process; now the parser source-of-truth is in daemon `dist/`. If daemon `dist/` is missing (forgot to `npm run build`), desktop-shell will fail to require. **Mitigation**: `packages/desktop-shell/mentor-project-profile.cjs` adds a require-failure guard that throws a clear error message ("daemon dist not built — run `cd packages/daemon && npm run build`") at module load time. Same pattern as existing `daemon/dist/storage/db.js` consumers in mcp-server.

5. **Risk — backward-compat: existing `task.test.ts` line 289 asserts `task.state === 'BLOCKED'` on every block call.** If the test's question matches a real CAIRN.md `## Known answers` substring (it doesn't today — questions are bespoke for the test), the assertion flips. **Mitigation**: tests in `task.test.ts` already use unique question strings (`"Should we keep the old API?"`, `"Keep old sync API?"`, etc.) that don't intersect with any current dogfood CAIRN.md pattern. Also: `task.test.ts`'s `beforeEach` opens a `mkdtempSync` cairn-root, NOT the repo's CAIRN.md — the test's `ws.gitRoot` is `process.cwd()` which resolves to `D:/lll/cairn` only when run from the repo root, but the test does not write a CAIRN.md to that tmp dir, so the parser path always hits `exists: false`. **Defensive add**: in `task-auto-resolve.test.ts`, pass `opts.cwd` to `openWorkspace` so the parser looks for `<tmp>/CAIRN.md` which we create per-test. This isolates the new test suite from the repo's own CAIRN.md.

6. **Risk — performance: each `block` now does a `statSync` + (sometimes) a markdown re-parse.** mtime-gated cache (D-3) means re-parse only fires when CAIRN.md actually changed on disk. Cold path: ~5 ms parse for a 100-line CAIRN.md. Warm path: one `statSync` (~50 µs) + one SQLite scratchpad SELECT (~50 µs). Compared to the avoided 30 s mentor-tick wait, this is free. **Mitigation**: smoke includes timing assertion: `block` call from RUNNING → response in < 50 ms even on cold cache.

---

## §6. Out of scope (deferred, with rationale)

| # | Item | Why deferred |
|---|---|---|
| 1 | **Rule B/F — `tail.log` scanning** (agent runtime tail-log parsing for blocker-like events) | Requires per-process tail-log paths plumbed by cockpit work that isn't in mcp-server's surface. Not on the critical path for the synchronous-known-answer thesis. → Phase 3. |
| 2 | **Rule C — off-goal drift detection** (Mentor recognizes when work is drifting from `## Goal`) | Needs L3 LLM polish call inside mcp-server, with cost ceiling logic. Phase 2's thesis is specifically the zero-LLM path. → Phase 3. |
| 3 | **Mode B Continuous Iteration** (auto-chain scout → worker → review) | Depends on a full Mentor rule set (1+2). Building on incomplete Mentor risks under/over-escalation, same trap §1.3 of the bootstrap-grill plan flagged. → Phase 4. |
| 4 | **Mode A Mentor recommender** (ranked work items + WHY) | Same blocker as Mode B. → Phase 4. |
| 5 | **L3 LLM polish in mcp-server** (haiku call to disambiguate near-miss matches) | Adds a network dep to a synchronous MCP call. Out-of-spec for "synchronous, deterministic, zero-LLM" thesis. Could land later as a graceful-degradation branch when `matchKnownAnswer` returns null, but the cost/latency trade is a separate decision. → Later. |
| 6 | **`auto_resolved` event emitted via dispatch_requests row** | Considered making the event a `dispatch_requests` row (auditable, queryable). Cut: scratchpad event is the proven "Activity feed input" pattern, panel already polls it, no new table semantics. → Not planned. |
| 7 | **Token-overlap fallback for `matchKnownAnswer`** (the 2-token stage in `mentor-project-profile.cjs::matchBucket`) | `matchKnownAnswer` today is substring-only (line 584); the token fallback is on `matchBucket` for ✅/⚠️/🛑 bullets, not known-answers. Phase 2 preserves substring-only semantics for known-answers. → Not planned (would change semantics). |
| 8 | **Two-way write: kernel writes a missing pattern back to CAIRN.md when user manually answers a blocker** ("Mentor learns") | Touches CAIRN.md as a file write from mcp-server → policy file becomes mutated by the kernel, no longer purely user-authored. Violates the "CAIRN.md is the project owner's voice" contract from `docs/CAIRN-md-spec.md`. → Not planned. |

---

## §7. Implementer checklist (cut from the verify section for at-a-glance)

- [ ] Port parser to TS at `packages/daemon/src/cairn-md/scanner.ts` (D-1); fixture-based unit tests ≥20 assertions
- [ ] Wire desktop-shell bridge — `mentor-project-profile.cjs` delegates to daemon `dist/`; smoke unchanged
- [ ] Extend `toolBlockTask` with the auto-resolve branch (D-2, D-4, D-5, D-6)
- [ ] New mcp-server unit suite `task-auto-resolve.test.ts` ≥15 assertions
- [ ] New smoke `packages/mcp-server/scripts/smoke-phase2-sync-mentor.mjs` ≥10 assertions
- [ ] Update `cairn.task.block` description string in `packages/mcp-server/src/index.ts` (one line)
- [ ] CHANGELOG entry
- [ ] Verify `daemon && npm test`, `mcp-server && npm test`, both `tsc --noEmit`
- [ ] Live dogfood with real CC session — record evidence in `docs/superpowers/demos/phase2-sync-mentor.md`
- [ ] Commit on `feat/phase2-sync-mentor` worktree per `docs/workflow/TEAMWORK.md`; push via lead's normal path

---

*End of plan.*
