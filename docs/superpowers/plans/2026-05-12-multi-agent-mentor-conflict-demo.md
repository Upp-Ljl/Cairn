# DUCKPLAN — Multi-Agent Mentor → Conflict-Capable Demo

> Plan filename: `2026-05-12-multi-agent-mentor-conflict-demo.md`
> Author: lead agent
> Date: 2026-05-12
> Workflow: per `docs/workflow/HOWTO-PLAN-PR.md` (DUCKPLAN four-section)
> Status: **PLAN** — execution deliverable is the `demos/multi-agent-mentor-on-arena.md` doc + screen recording, not this file.

This plan was grilled out across 4 rounds with the user. Decisions locked at the end of round 4 are summarized in §6 "Grilled decisions log" for traceability — if a future reader wants to know "why this and not that", look there.

---

## 1. Plan

Run the full Cairn loop end-to-end on the live `agent-game-platform` repo, driven by **Mentor → two concurrent Claude workers → Cairn observes**, and capture the result as evidence that Cairn's multi-agent coordination capability is real.

Flow:

1. Open the Cairn panel against `agent-game-platform` registered as a managed project.
2. Invoke Mode A Mentor — Mentor returns a ranked work-item list.
3. From the list, the demo runner picks **two items that look independent but are likely to touch shared engine code**:
   - **Agent A** — *Audit `src/lib/engine/*.ts` test coverage and propose missing tests* (was Phase 6's surfaced gap)
   - **Agent B** — *Add unit tests to `src/lib/engine/equity.ts`* (the exact module Phase 6 flagged as uncovered)
4. Both prompts go to two `claude` CLI worker processes, sandboxed in two separate **worktrees** of agent-game-platform (`.cairn-demo-worktrees/agent-a` and `.cairn-demo-worktrees/agent-b`) so the filesystem-level collision is real (both workers may write to `src/lib/engine/`).
5. Cairn's process table picks up both as separate sessions (Real Agent Presence v2 IDs).
6. As both workers stage commits, Cairn's pre-commit hook fires on staged-path overlap and writes a `PENDING_REVIEW` row to the `conflicts` table — IF the workers actually overlap. If they don't, the demo still succeeds (see §5).
7. The Cairn legacy Inspector (launched with `CAIRN_DESKTOP_ENABLE_MUTATIONS=1`) shows the conflict row in red. The user clicks Resolve. The row transitions to `RESOLVED`. The transition is captured on screen.
8. Both workers' actual commits land on a `demo/multi-agent-mentor-<date>` branch in agent-game-platform. The user pushes that branch as the audit artifact.

The point of the demo is not "we engineered a collision." It is **"Cairn knows two agents are running, knows when they collide, can resolve the collision, and never lost state."** Whether collision actually happens in any one run is secondary to having the mechanism on screen.

---

## 2. Expected outputs

After execution lands:

- `docs/superpowers/demos/multi-agent-mentor-on-arena.md` — demo write-up (the actual-result counterpart to this plan, per §6 "Grilled decisions log" item 8).
- `packages/desktop-shell/scripts/dogfood-multi-agent-mentor-demo.mjs` — the driver script. Spawns 2 `claude` workers in 2 worktrees of agent-game-platform, registers both as Cairn sessions, asserts post-flight invariants.
- Worker run dirs preserved under `~/.cairn/worker-runs/wr_<id>/` for both agents (tails + final reports).
- `~/.cairn/cairn.db`:
  - `processes` table — 2 new rows tagged `cwd=...agent-game-platform`
  - `conflicts` table — possibly 1 `PENDING_REVIEW` row that transitions to `RESOLVED`
  - `scratchpad` table — 2 entries under `subagent/<agent_id>/result` keys per `docs/cairn-subagent-protocol.md`
- `D:/lll/managed-projects/agent-game-platform`:
  - Branch `demo/multi-agent-mentor-2026-05-12` with up to 2 real commits (one per agent)
  - `main` branch untouched
- A user-recorded screen capture (≤5 min, mp4/Loom) showing the Cairn panel + legacy Inspector during the run. Recording is user-driven; demo script pauses for "ready to record" / "stop recording" prompts.

---

## 3. How to verify

Plain commands. Each one ends with a deterministic check.

```bash
# 0. Pre-flight: target repo on main, clean
cd D:/lll/managed-projects/agent-game-platform
git status --short                              # expect: empty
git branch --show-current                       # expect: main
git rev-parse HEAD                              # capture as PRE_HEAD

# 1. Cairn worktrees ready, kernel built
cd D:/lll/cairn
ls .cairn-worktrees/__lead__/                    # expect: dir exists
cd packages/mcp-server && npm run build 2>&1 | tail -2
                                                # expect: tsc exit 0

# 2. Tests still green at the commit this demo lands on
cd D:/lll/cairn/packages/daemon && npm test 2>&1 | tail -2
cd ../mcp-server && npm test 2>&1 | tail -2
                                                # expect: 411 / 357 pass, no new failures

# 3. Run the demo driver
node packages/desktop-shell/scripts/dogfood-multi-agent-mentor-demo.mjs
                                                # expect: ≥20 assertions PASS
                                                # expect: ≥0 and ≤1 conflict rows
                                                # expect: both worker runs reach status `exited`

# 4. Process table proof
node -e '
  const { openDatabase } = require("./packages/daemon/dist/storage/db.js");
  const db = openDatabase({ readonly: true });
  const rows = db.prepare("SELECT agent_id, capabilities FROM processes ORDER BY started_at DESC LIMIT 5").all();
  console.log(JSON.stringify(rows, null, 2));
'                                                # expect: ≥2 rows tagged cwd=...agent-game-platform

# 5. Conflict + resolve proof (if conflict occurred)
node -e '
  const { openDatabase } = require("./packages/daemon/dist/storage/db.js");
  const db = openDatabase({ readonly: true });
  const c = db.prepare("SELECT id, status, paths_json FROM conflicts ORDER BY created_at DESC LIMIT 3").all();
  console.log(JSON.stringify(c, null, 2));
'                                                # expect: latest conflict status = RESOLVED (if any)

# 6. Resume packet recoverable for both agents
# (uses cairn.task.resume_packet read for each task_id)
node packages/desktop-shell/scripts/dogfood-multi-agent-mentor-demo.mjs --probe-resume
                                                # expect: 2 resume packets readable
                                                # expect: each carries last-known scratchpad ref + checkpoint id

# 7. Post-flight: agent-game-platform main untouched, demo branch present
cd D:/lll/managed-projects/agent-game-platform
git rev-parse HEAD                              # expect: == PRE_HEAD (still on main)
git branch --list 'demo/multi-agent-mentor-*'   # expect: branch exists
git log demo/multi-agent-mentor-2026-05-12 --oneline | wc -l
                                                # expect: 1 or 2 (one or both agents committed)
```

Acceptance gate (hard floor + middle gate):

- **Hard floor** (must pass): `processes` shows 2 rows; legacy Inspector renders conflict row IF present; user can manually click Resolve and the row transitions to `RESOLVED`.
- **Middle gate** (must also pass): both agents' state is recoverable via `cairn.task.resume_packet` after the run.
- **High gate** (skipped — not in scope): Mode B auto-redispatches a new worker.

---

## 4. Probes (FEATURE-VALIDATION cross-engine)

Two-engine probes per `docs/workflow/FEATURE-VALIDATION.md`. Each probe runs against the FINAL `~/.cairn/cairn.db` snapshot.

### Gate 1 — claude haiku, JSON only

```bash
PROMPT='Open ~/.cairn/cairn.db (readonly). Output canonical JSON only:
{
  "processes_count_for_agp_cwd": <int>,
  "conflicts_count_pending_review": <int>,
  "conflicts_count_resolved": <int>,
  "scratchpad_subagent_keys": [<list of keys matching "subagent/*/result">]
}'
claude --model haiku -p "$PROMPT" > /tmp/gate1.json
jq -S . /tmp/gate1.json > /tmp/gate1.canonical.json
```

### Gate 2 — general-purpose Agent subagent (fresh context)

Dispatch `Agent(subagent_type: "general-purpose", prompt: <same as above>)`. Save to `/tmp/gate2.json`. Canonicalize.

```bash
diff -u /tmp/gate1.canonical.json /tmp/gate2.canonical.json
# expect: zero output
```

### Gate 3 — real run

```bash
# Same queries via the daemon storage handle, in a single Node call
node -e '
  const { openDatabase } = require("./packages/daemon/dist/storage/db.js");
  const db = openDatabase({ readonly: true });
  const out = {
    processes_count_for_agp_cwd: db.prepare(
      "SELECT COUNT(*) c FROM processes WHERE capabilities LIKE '%agent-game-platform%'"
    ).get().c,
    conflicts_count_pending_review: db.prepare(
      "SELECT COUNT(*) c FROM conflicts WHERE status='PENDING_REVIEW'"
    ).get().c,
    conflicts_count_resolved: db.prepare(
      "SELECT COUNT(*) c FROM conflicts WHERE status='RESOLVED'"
    ).get().c,
    scratchpad_subagent_keys: db.prepare(
      "SELECT key FROM scratchpad WHERE key LIKE 'subagent/%/result'"
    ).all().map(r => r.key).sort(),
  };
  console.log(JSON.stringify(out, null, 2));
' | jq -S . > /tmp/gate3.canonical.json

diff -u /tmp/gate1.canonical.json /tmp/gate3.canonical.json
# expect: zero output — Gate 1+2 AI engines agree with reality
```

If any gate diverges, the demo is not over — the demo runner re-asserts before declaring done.

---

## 5. Out of scope

Locked off this DUCKPLAN to prevent scope creep:

- **Forcing a collision when none happens naturally.** If both agents finish without overlap, the demo records "two parallel agents managed cleanly, no conflict surfaced this run" — that is still a valid demo of Cairn's capability surface. The README + recording-narration calls this out.
- **Reading `~/.claude/daemon/roster.json` or any Agent View internal state.** Undocumented surface; Later when Anthropic ships an API. See §9.
- **Side-by-side Agent View + Cairn panel screen-capture.** Different demo, separate plan. See §9.
- **Live Run Log (events table)** — Later-scope per PRODUCT.md v3 §12 D10. The Run Log timeline view is not built; the demo evidence uses screenshots of the existing legacy Inspector + log output instead.
- **Mode B auto-redispatch after RESOLVED** — the "high gate" in §3. Not in this demo. The handlers exist (per the Mode B smoke 42/42); a Mode B-chained demo is a follow-up.
- **Code-signing / SmartScreen warning suppression on Cairn.exe.**
- **macOS reproduction of this same demo** — needs a Mac.
- **Public marketing / X / HN write-up.** Audience is team/partner internal alignment per the round-1 grill answer.
- **Auto-recording.** User handles recording; demo script does not invoke screen-capture tooling.
- **`npm publish`** — still locked behind user terminal-decision.

---

## 6. Grilled decisions log

These are the decisions made interactively during plan grilling. If future-me wonders "why N and not M", the source of truth is here.

| Round | Question | Decision |
|---|---|---|
| 1 | Agent count? | **2** — minimum collision. 3-agent variant deferred. |
| 1 | Conflict source? | **Concurrent → conflict (combined)** — two parallel tasks, may or may not collide. |
| 1 | Run location? | **Local agent-game-platform clone** at `D:/lll/managed-projects/agent-game-platform`. |
| 1 | Audience? | **Team / partner internal alignment.** Polish level: doc + key screenshots + ≤5min recording. |
| 2 | Initial task split? | **Two-arm-length tasks (expected non-overlap but may overlap)** — Mentor's lens, not forced collision. |
| 2 | Cairn life signs to show? | **Core trio: processes(2 rows) + pre-commit hook + panel highlight.** Plus RESOLVED transition, scratchpad. User is satisfied with current product display; Live Run Log skipped this round. |
| 2 | Acceptance gate? | **Hard floor + middle (resume packet recoverable for both agents).** High gate (Mode B chain) NOT required. |
| 2 | Target-repo git fate? | **Real commits, on a `demo/...` branch, user pushes as audit artifact.** Not stash/reset. |
| 3 | Session launch model? | **Mentor 模式起头**: Mentor proposes 2 looks-parallel tasks, both go to real `claude` CLI workers. Not pure script. |
| 3 | Budget? | **Strict**: sonnet × 2, <30 min/agent, ~$0.50 total. Up to 3 re-runs allowed. |
| 3 | Evidence form? | **Doc + 2-5 min user-recorded screen capture (mp4/Loom).** |
| 3 | Doc timing? | **Both**: plan upfront (this file) + actuals doc afterwards (`multi-agent-mentor-on-arena.md`). |
| 4 | Mentor task pair? | **A audit engine coverage + B add equity.ts tests** — extends Phase 6's surfaced gap, highest collision probability among the 3 options. |
| 4 | Bail-out if no collision? | **No collision is still a valid demo** — Cairn surfaces 2 sessions; mechanism is on screen even if the row never appears. |
| 4 | Resolve path? | **CAIRN_DESKTOP_ENABLE_MUTATIONS=1 + legacy Inspector** — demo-only flag. User clicks Resolve manually on camera. |
| 4 | Recording? | **User-driven** — demo script does not script-record. |
| 5 | Cairn × Agent View positioning? | **Both audiences served: Cairn panel is self-adaptive.** When Claude Code's Agent View is running, Cairn panel compresses the agent-presence list (it would be duplicate) and emphasizes what Agent View can't see (conflicts / Mentor / rewind / cross-tool). When Agent View not running, Cairn panel shows the full agent list. Implementation hook: Cairn panel detects `~/.claude/daemon/` presence at panel-open. See §9 for fuller framing. |
| 5 | Use `claude agents` background mode in demo? | **No — keep vanilla `claude` CLI invocation (same as Phase 6).** The user's principle is "don't artificially engineer the conflict story" — applies to launch mode too. Trade-off accepted: Agent View won't render the demo sessions, but the demo's audience (team/partner internal alignment, round 1) doesn't need that side-by-side. The Cairn-vs-Agent-View comparison story is captured in §9, not enacted in this run. |
| 5 | Read `~/.claude/daemon/roster.json` in demo? | **No — stay cross-tool neutral.** Coupling to undocumented Anthropic state files is a Later decision; this demo does not depend on it. |

---

## 7. Implementation hints for the runner script

Reversible / local-scope decisions delegated to the agent doing the implementation; documented here so the grilled context isn't lost:

- Spawn pattern: re-use `worker-launcher.cjs::launchManagedWorker` for both agents — same code path Phase 6 dogfood already verified. Two parallel invocations with `provider: 'claude-code'`.
- Worktrees of agent-game-platform: create with `git worktree add D:/lll/managed-projects/.cairn-demo-worktrees/agent-{a,b} -b demo/multi-agent-mentor-2026-05-12-{a,b} main`. Each worker `cwd`s into its own worktree.
- Branch merge at end: the demo script does NOT merge. It leaves both demo branches and tells the user the push command to run.
- Cleanup: `git worktree remove` is the demo script's last step IF the user pressed "demo complete and I have my recording." Otherwise leave for inspection.
- Timing between A and B start: 5 seconds delay. Reasoning: not so short that processes-table writes get coalesced, not so long that it feels artificially staggered.
- Conflict detection trigger: lean on the existing pre-commit hook (already installed by `cairn install` on agent-game-platform via the registered managed-project record). No new hook code.
- `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` set only for the demo-runner subprocess that opens the legacy Inspector. Never written to env files.

---

## 8. Risks + open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Neither agent writes to `engine/` shared code → no collision → demo shows "nothing happened" | Med | Acceptance gate already covers this: 2 processes + mechanism = success. Doc narration explains. |
| `claude` CLI fails on either agent (rate-limit / network) | Med | Allow 3 re-runs per round-3 budget. If 3 fail, abort + write "infrastructure issue" doc. |
| Worker writes to `~/.cairn` real path bypass sandbox | High | Demo runner sandboxes HOME for Cairn writes (same trick as `dogfood-real-claude-managed-loop.mjs`). |
| Legacy Inspector resolve button doesn't actually call `conflict.resolve` | Low | Existing smoke covers the IPC. If broken, fall back to MCP call in screencast narration. |
| user's pushed `demo/...` branch on agent-game-platform clutters that repo | Low | Branch name is dated; delete after team alignment. Doc records "this branch is demo-artifact; delete after viewing." |

Open question (NOT blocking this plan, asks back to user before EXECUTING):
- **Do we want to keep the `demo/...` branch on agent-game-platform indefinitely as proof, or delete after one team-meeting?** Default: delete after one team meeting (≤7 days).

---

## 9. Cairn × Claude Code Agent View — positioning (Round 5 grilled-out)

Anthropic shipped Agent View (Research Preview, May 2026) covering: list of CC background sessions, peek/attach/detach/stop, Haiku-summarized activity. State at `~/.claude/daemon/roster.json` + `~/.claude/jobs/<id>/state.json`. **No documented programmatic API.** Source: https://code.claude.com/docs/en/agent-view

### What Agent View covers vs what Cairn covers

| Capability | Agent View | Cairn |
|---|---|---|
| List CC background sessions, peek/attach/reply/stop | ✅ | partial (panel is read-only by default) |
| Cross-tool visibility (Codex, Cursor, Aider, vanilla `claude`) | ❌ | ✅ |
| pre-commit hook conflict detection (PENDING_REVIEW) | ❌ | ✅ |
| Mentor — ranked work items with WHY + confidence | ❌ | ✅ |
| Rewind / checkpoint / resume packet | ❌ | ✅ |
| Scratchpad inter-agent context | ❌ | ✅ |
| Project-scoped, multi-project view | ❌ (CC-only) | ✅ |
| Documented external coordinator API | N/A | N/A |

Agent View covers approximately 1/4 of Cairn's value surface — the agent-presence display. The other 3/4 (cross-tool, kernel-level state, Mentor brain, rewind) Anthropic does not address.

### Cairn's positioning relative to Agent View

**Cairn is the substrate Anthropic doesn't ship.** When both are running on the same machine, the user's natural mental model is:

- **Agent View** = "live attention layer" — what's running, what needs my input, what state is each
- **Cairn** = "coordination + memory layer" — what conflicts, what's the recommended next work, what's recoverable, what's seen across tools

These are complementary, not competing. The product strategy is:

1. **Do NOT ship a session-list UI that competes with Agent View on its strongest axis.** Cairn's panel agent-presence list will become a "fallback" view active when Agent View is not detected.
2. **Self-adaptive panel**: at panel-open, detect `~/.claude/daemon/` presence. If detected → compress agent-presence display, highlight Cairn-unique surfaces (conflicts / Mentor / rewind / cross-tool agents). If not → full agent-presence display.
3. **Do not depend on undocumented Anthropic state files.** Reading `roster.json` would be useful but the surface can break on every Claude Code release. Hold until Anthropic ships an API.
4. **Cross-tool visibility stays as Cairn's core moat.** Codex, Cursor, Aider users have no Agent View — Cairn is their only multi-session surface.

### How this affects the demo

The demo executes with vanilla `claude` invocations (same as Phase 6). Agent View will not render these sessions because they are not background (`claude agents`) sessions. That is fine for this demo's internal-alignment audience — the message is **"Cairn sees and acts on what Agent View doesn't have"**, not **"Agent View and Cairn shown side-by-side"**. A future demo can stage the side-by-side; this one focuses on Cairn's own surface.

### Out of scope for this plan, captured here as the next planning item

- The self-adaptive panel implementation (detect Agent View, compress vs full display).
- A future demo that DOES use `claude agents` background mode + shows Agent View next to Cairn panel side-by-side.
- An API or formal handshake with Anthropic to integrate Cairn into Agent View as a "conflict / coordination" overlay.

These become a separate plan: working title `2026-05-XX-cairn-x-agent-view-self-adaptive-panel.md`. Not blocking this demo.
