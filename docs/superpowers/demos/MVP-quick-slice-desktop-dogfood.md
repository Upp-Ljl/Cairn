# MVP Quick Slice — Desktop Side Panel Dogfood

> Date: 2026-05-08
> Subject: Cairn desktop-shell Quick Slice (Day 1+2+3) running against the
>          author's own `~/.cairn/cairn.db`.
> Plan: `docs/superpowers/plans/2026-05-08-product-mvp-side-panel.md`
> Commits exercised: `f088b56` (Day 1), `b9fdecd` (Day 2), Day 3 (this doc).
>
> Decision 5 in the plan allows mixing real DB rows with `cairn-demo-*`
> fixture rows because the author's live DB has no active conflicts /
> dispatches / new outcomes during the dogfood window. Every observation
> below is labeled **(real)** or **(fixture)** so coverage doesn't get
> overstated.

---

## Setup / launch / verify / cleanup steps

```bash
# 1. Inject fixtures (cairn-demo-* rows; idempotent — re-running is safe)
cd packages/desktop-shell
node scripts/mvp-quick-slice-dogfood.mjs --setup

# 2. Inspect what was inserted
node scripts/mvp-quick-slice-dogfood.mjs --status

# 3. Launch the panel + pet + tray
npm start
#    Default mode: panel.html. Add `-- --legacy` to launch the legacy
#    Inspector instead. Tray icon appears in the Windows system tray.

# 4. Walk through the verification checklist below. Tray, panel, summary,
#    Run Log, Tasks, inline expansion. No mutation buttons should appear.

# 5. Quit via tray right-click → Quit (closing the panel just hides it
#    by design — that's the lifecycle fix in main.cjs).

# 6. Remove fixtures
node scripts/mvp-quick-slice-dogfood.mjs --cleanup
node scripts/mvp-quick-slice-dogfood.mjs --status   # all zeros
```

If `npm start` errors on `better-sqlite3` ABI: `npx electron-rebuild -f -w
better-sqlite3` (already in the package README).

---

## Fixture content (what `--setup` injects)

All ids are `cairn-demo-*` so cleanup is a single LIKE filter and there is
zero risk of touching real rows.

| Table              | Fixture row                                       |
|---|---|
| `processes`        | 2 ACTIVE agents: `cairn-demo-agent-cc` (claude-code), `cairn-demo-agent-cursor` |
| `tasks`            | 3 tasks: BLOCKED (auth refactor), FAILED (useAuth refactor), RUNNING (tests_pass eval) |
| `blockers`         | 1 OPEN blocker on `cairn-demo-task-blocked` (deprecation-flag question) |
| `outcomes`         | 1 FAIL outcome on `cairn-demo-task-failed` (tests_pass: 12 failed) |
| `conflicts`        | 1 OPEN FILE_OVERLAP on `shared/types.ts` between the two demo agents |
| `dispatch_requests`| 1 PENDING request from "user" → `cairn-demo-agent-cc` |
| **Total**          | **9 rows** |

---

## Verification checklist + observations

### Tray (Day 3)

- **(fixture)** With fixtures inserted, tray icon renders **red** (alert)
  because `outcomes_failed > 0` and `conflicts_open > 0`. Tooltip on
  hover: `Cairn — 2 agents · 2 blockers · 5 FAIL · 1 conflicts`. (The
  numbers blend real + fixture: 2 agents both fixture, 5 FAIL = 4 real
  TERMINAL_FAIL + 1 fixture FAIL, 1 conflict all fixture.)
- After `--cleanup`, tray drops back to **amber** (warn) because the
  real DB still has `outcomes_failed = 4` (existing TERMINAL_FAIL rows
  from W5 Phase 3 dogfood history) — that flips the priority from
  alert → warn. Tooltip: `Cairn — 0 agents · 1 blockers · 4 FAIL · 0
  conflicts`. **(observed: alert → warn transition works; the icon
  swaps within ~1s of cleanup, which is the polling cadence.)**
- Click tray once → panel pops up (or focuses if already open). Click
  again → panel hides. **Verified.**
- Right-click → context menu shows `Open Cairn` / `Open Legacy
  Inspector` / `Quit`. Each entry works as expected.
- Closing the panel via the OS close button does NOT exit the app —
  tray stays alive, click-to-reopen still works. Quit menu is the only
  exit path. **Lifecycle fix verified.**

### Project Summary card (Day 1)

- **(mixed)** With fixtures inserted, summary card reads:
  - active agents = 2 **(all fixture; the author's real `processes` table is empty)**
  - tasks running/blocked/review = 1/2/0 **(fixture: 1/1/0; real: 0/1/0)**
  - open blockers = 2 **(fixture: 1; real: 1)**
  - failed outcomes = 5 **(fixture: 1 FAIL; real: 4 TERMINAL_FAIL)**
  - open conflicts = 1 **(all fixture)**
  - dispatches (last 1h) = 1 **(all fixture)**
- Numbers update within 1s of `--setup` / `--cleanup` without restarting
  the panel. Polling pipeline confirmed.

### Run Log low-fidelity (Day 2)

- **(mixed)** Default tab. After `--setup`, Run Log shows 32 events
  total — 7 fixture (`cairn-demo-*`) + 25 real (W5 dogfood history).
  Per-source counts:
  - tasks: 12 real + 3 fixture
  - blockers: 5 real + 1 fixture (`blocker.opened` row)
  - outcomes: 8 real + 1 fixture (`outcome.fail` row)
  - conflicts: 0 real + 1 fixture (`conflict.detected`)
  - dispatch: 0 real + 1 fixture (`dispatch.pending`)
- Severity colors visually distinguishable: error rows (FAIL / TERMINAL_FAIL
  / task.failed) red-tinted; warn rows (BLOCKED / OPEN blocker / OPEN
  conflict / PENDING dispatch) amber-tinted; info rows (DONE / PASS /
  blocker.answered) plain.
- Newest event sits at the top. Time stamps render as `HH:MM:SS` (local).

### Tasks tab (Day 2)

- **(mixed)** Switch to Tasks tab → list shows 15 rows (12 real + 3
  fixture). State priority puts FAILED first (5 rows: 4 real
  TERMINAL_FAIL → state `FAILED`, 1 fixture FAILED), then BLOCKED (2
  rows: 1 real + 1 fixture), then RUNNING (1 row: fixture), then DONE,
  CANCELLED.
- Click `cairn-demo-task-blocked` → inline expansion shows:
  - blocker pill `OPEN ×1` (warn-tinted)
  - outcome pill `no outcome` (gray)
  - task_id, created_by `cairn-demo-agent-cc`, created/updated rel time
  - latest blocker question text rendered fully
- Click `cairn-demo-task-failed` → inline expansion shows:
  - outcome pill `FAIL (1 criteria)` (red)
  - last evaluation summary `[demo] tests_pass: 12 failed (useAuth.spec.ts...)`
- Click again → row collapses. Polling continues to refresh the rest of
  the list during expansion. **Verified.**
- Click a real BLOCKED task (`01KR0H4TQAFQJSFR5JP25RMD25`) → inline
  expansion shows the original Chinese question text from the W5 Phase
  2 dogfood ("保留旧 sync API 吗？") rendered correctly. **(real)**

### Read-only default

- `CAIRN_DESKTOP_ENABLE_MUTATIONS` was unset for the entire dogfood. The
  panel renders zero mutation buttons. The legacy Inspector (opened from
  the tray menu) also hides its `Resolve` button because preload doesn't
  expose `window.cairn.resolveConflict`. **Verified.**
- `grep -nE "\.run\(|\.exec\(" packages/desktop-shell/*.cjs` finds the
  resolve-conflict path inside the `if (MUTATIONS_ENABLED)` block in
  `main.cjs` only. No other write paths in the desktop side.

---

## US-P coverage map

The plan's five user stories (PRODUCT.md v3 §4.1–§4.5) map onto Quick
Slice components like this:

| US | Story | Quick Slice coverage | Evidence |
|---|---|---|---|
| **US-P1 Project Glance** | "what's happening right now" | ✅ full | Tray badge + summary card surface every state needed (agents, blockers, FAIL, conflicts, dispatch). Tooltip lets the user check status without even opening the panel. |
| **US-P2 Project History** | "how did this task progress" | ⚠️ partial | Run Log timeline + Tasks inline expansion show the major events (BLOCKED → ANSWERED → outcome FAIL/PASS), but the panel does not yet render `scratchpad` keys, full `criteria_json`, or `checkpoints` per task. Drill-down beyond the inline-expansion 6–12-line cap is **Hardening**. |
| **US-P3 Recovery** | "agent went off-track, where do I rewind to" | ❌ not covered | No `checkpoints` view in the Quick Slice. The user still has to look at git log / `cairn.checkpoint.list` MCP output to find a target commit. **Hardening: Checkpoints view + paths preview.** |
| **US-P4 Subagent Result** | "main agent's context compacted; what did the subagent actually return?" | ❌ not covered | No `scratchpad` view. The fixture script doesn't even insert into scratchpad — Run Log's 5 sources omit it on purpose. **Hardening: scratchpad / subagent-result view.** |
| **US-P5 Conflict** | "two agents touched the same file" | ✅ full | Tray flips to alert; summary card increments conflict count; Run Log shows the `conflict.detected` row with severity warn; conflict ID is preserved end-to-end. (Verified with the fixture FILE_OVERLAP on `shared/types.ts`.) |

**Summary**: 2 stories fully covered (US-P1, US-P5), 1 partially (US-P2),
2 not covered (US-P3, US-P4). The two gaps were known going in (plan §3
Non-goals + §11 Later Hardening explicitly defer scratchpad and
checkpoints views).

---

## Components-vs-state matrix (sanity)

| Component | Source data | State during dogfood |
|---|---|---|
| Tray icon            | `queryProjectSummary`     | alert (red) → warn (amber) post-cleanup |
| Tray tooltip         | `queryProjectSummary`     | reflects all four counters every 1s |
| Project summary card | `queryProjectSummary`     | 6 lines, mixed real+fixture, updates without panel restart |
| Run Log              | `queryRunLogEvents`       | 32 events, 5/5 sources active when fixtures present |
| Tasks list           | `queryTasksList`          | 15 rows, state-priority order correct |
| Inline detail        | `queryTaskDetail(taskId)` | shows blocker question + outcome summary correctly |
| Legacy Inspector     | `queryLegacy*`            | opens from tray menu; Resolve button hidden when mutations disabled |
| Pet sprite           | `queryLegacyState`        | unchanged behavior; floats bottom-right |

---

## Bugs / surprises noted

- **`processes` table is empty** in the author's real DB even after
  recent W5 Phase 3 dogfood — that's expected (each MCP session
  registers + DEAD-sweeps), but it means without fixtures the live
  panel's "active agents" line is always 0. Dogfood with real CC
  sessions should populate this; haven't tested that here.
- **Tray click on macOS** opens the context menu by default, not a
  toggle. Quick Slice prioritizes Windows (R11) so this is acceptable;
  Hardening will need a per-platform branch (`tray.popUpContextMenu()`
  on macOS, `togglePanel()` on Windows, etc).
- **Run Log `dispatch.pending` event** on the fixture renders correctly,
  but the real DB's `idx_dispatch_requests_created_at` is bypassed by
  the `COALESCE(confirmed_at, created_at)` ORDER BY (R16 in the plan).
  At MVP scale this is sub-millisecond; the note carries forward.
- **Tray icon resolution**: 16×16 base64 PNGs render slightly fuzzy on
  hi-dpi displays. Hardening item: ship multi-resolution `.ico`.

---

## What this dogfood is NOT

- Not a multi-day stress test. Single ~20-minute session.
- Not a multi-agent live-traffic test. Real `processes` rows = 0.
- Not a security review. Mutation flag was off; checking the off-path
  only, not the on-path threat model.
- Not a performance test under load. Largest table observed at ≤15
  rows. R16 (Run Log query plan) timed sub-millisecond at this scale;
  re-test required if any table exceeds ~10k rows.

---

## Conclusion

Quick Slice DoD checklist (plan §13) all green:

1. PRODUCT.md v3 framing ✓
2. plan patched + Day-by-day delivered ✓
3. desktop-shell starts as project control surface ✓
4. Run Log default tab, 5 sources active ✓
5. summary card renders matching SQLite ✓
6. tasks list + inline expansion ✓
7. blockers / outcomes / conflicts visible (summary + Run Log + Tasks
   inline) ✓
8. tray icon with idle/warn/alert + tooltip + click toggle + right-click
   menu ✓
9. tray lifecycle: panel close ≠ app exit; only Quit menu exits ✓
10. read-only default verified ✓
11. queries.cjs + JSDoc typedefs ✓
12. desktop dogfood with real + fixture mix, this doc ✓
13. no new kernel primitive / MCP tool / migration / npm dep / push ✓

Two US-P gaps (P3 Recovery, P4 Subagent Result) are documented
out-of-scope and live in §11 Later Hardening. The Quick Slice is
shippable as-is; whether it's pushable to origin is a separate,
owner-level decision.
