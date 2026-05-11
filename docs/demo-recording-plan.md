# Cairn End-to-End Demo — Recording Plan

> **Goal**: a 12-15 min vertical slice showing Mode A · Mentor + Mode B · Continuous Iteration + Mode C · Multi-Cairn v0 in one continuous human-gated flow.
> **Status**: draft. Not a recording cue sheet until user sign-off and the dependencies in §"Hard constraints" are all green.
> **Dependencies**:
> - B1 — PRODUCT.md v4 (commit `359fc71`)
> - A3 — Mode B Continuous Iteration handler (commit `1ce4c3a`)
> - Multi-Cairn v0 outbox (commit `5dd4549`)
> - Day-6 dogfood: real-Claude Three-Stage end-to-end (commit `df63319`)
> - A2 — Mentor scaffold handler + smoke (commit `368d065`)
> - **A2-UI** — Mentor panel sub-section render (not yet landed; this plan blocks on it — see §"Approval gates")
> - B2 — Mentor Layer detailed spec (commit `1184164`)

---

## Hard constraints (read before pressing record)

| # | Constraint | Why |
|---|---|---|
| 1 | Mentor stays **read-only** on `agent-game-platform` clone throughout the recording | User lock: don't touch agent-game-platform code in this round. Mentor's input whitelist (B2 spec §2.1) is read-only by design; demo MUST visibly honor it |
| 2 | Continuous Iteration's worker mutation runs on a **temporary throwaway repo** (`~/cairn-demo-temp/`), NOT on `~/cairn-demo-target/` (agent-game-platform clone) | Mode B writes commits in the working tree; agent-game-platform is read-only signal source. Recording must show the target-switch explicitly so viewers see Cairn does not auto-mutate read sources |
| 3 | Full real-LLM end-to-end run is estimated **\$10–\$15** per recording (≈ 11 calls: 2 Mentor + 3 Scout + 3 Worker + 3 Review on real Claude / Codex) | Budget guardrail; partial mock runs would undermine the demo's "real agent did real work" claim |
| 4 | Inspector UI requires `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` (Day-5 decision) | Accept / Reject / Resolve buttons are dev-flag-gated in the panel; without the env var the segment-4 closure can't be filmed |
| 5 | Mentor UI requires `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` (A2 Path-A decision) | Mentor's "Pick to start Continuous Iteration" button is mutation-gated; without the env var segment 2 → 3 transition won't work |
| 6 | Recording cannot start until **A2-UI** lands (panel renders the Mentor sub-section) | `368d065` shipped the handler layer + smoke but the panel-side UI binding is the follow-up commit. Until that lands, segment 2 cannot be filmed |
| 7 | All recording artifacts (clips, transcripts, screenshots) land under `~/cairn-demo-recordings/<YYYY-MM-DD>/`, **not** in this repo's working tree | Keeps the repo clean; recording outputs are not source code |
| 8 | Voiceover language: **English** (matches PRODUCT.md §0's English TL;DR audience); recording captions optional Chinese | Demo target is the broader engineer audience, not just internal Cairn users |

---

## Pre-flight checklist

Run before pressing record:

```bash
# 1. Dependencies present at expected commits
cd ~/path/to/cairn && git log --oneline -8
# expect: A2-UI commit (TBD) ≥ 368d065 ≥ 1184164 ≥ 359fc71 ≥ 1ce4c3a ≥ 5dd4549

# 2. Mode A/B/C primitives present on disk
ls packages/desktop-shell/managed-loop-handlers.cjs \
   packages/desktop-shell/project-candidates.cjs \
   packages/desktop-shell/multi-cairn.cjs \
   packages/desktop-shell/mentor-*.cjs    # A2 handler files

# 3. Environment
export CAIRN_DESKTOP_ENABLE_MUTATIONS=1
export CAIRN_SHARED_DIR=/tmp/cairn-demo-shared
export CAIRN_NODE_ID=$(cat ~/.cairn/node-id.txt)
export ANTHROPIC_API_KEY=...   # real LLM cost will be incurred

# 4. Throwaway repo for Mode B mutations
rm -rf ~/cairn-demo-temp && git init ~/cairn-demo-temp
cd ~/cairn-demo-temp \
  && printf "# Demo throwaway\n\nReceives Mode B worker commits during the recording.\n" > README.md \
  && git add . && git commit -m "init"

# 5. Read-only target for Mentor signal source
test -d ~/cairn-demo-target || git clone <agent-game-platform-url> ~/cairn-demo-target
cd ~/cairn-demo-target && git checkout <pinned-demo-commit>   # reproducibility

# 6. Pre-seed Multi-Cairn outbox (segment 5)
mkdir -p $CAIRN_SHARED_DIR
cat docs/fixtures/mock-published-candidates.jsonl > $CAIRN_SHARED_DIR/published-candidates.jsonl
# (fixture file is a 5-line JSONL with synthetic second-node entries —
#  see "Mockup data" in segment 5 below for the exact content)

# 7. Mentor history warm-up (segment 2's first turn shouldn't look "first ever")
node packages/desktop-shell/scripts/mentor-warmup.mjs   # creates 2-3 prior turn records

# 8. Launch
cd packages/desktop-shell && CAIRN_DESKTOP_ENABLE_MUTATIONS=1 npm start

# 9. Verify panel boot
# expect tray icon + Mentor sub-section visible + Inspector reachable
```

If any step ≠ green, abort and fix before recording. The recording is real-LLM and re-takes cost the full budget.

---

## Screen layout

```
┌─────────────────────────────────────────────────────────────────┐
│                                                ┌──────────────┐ │
│  ┌──────────────────────────────────────┐      │ Cairn panel  │ │
│  │ Inspector window (left half)          │      │  (right edge,│ │
│  │  - segs 1-2: idle / project card      │      │   ~500px)    │ │
│  │  - seg 3-4: Three-Stage Loop UI       │      │              │ │
│  │  - seg 5: Team sub-section            │      │ Mentor chat  │ │
│  └──────────────────────────────────────┘      │ + state card │ │
│                                                 │              │ │
│  ┌──────────────────────────────────────┐      │ Three-Stage  │ │
│  │ Background terminal (visible, idle)   │      │ Loop button  │ │
│  │  $ cd ~/cairn-demo-target             │      │ Team button  │ │
│  │  $ git log --oneline -5               │      │              │ │
│  └──────────────────────────────────────┘      └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

Optional: a small floating terminal showing `watch -n1 stat -c '%Y' ~/.cairn/cairn.db` so viewers can visually confirm SQLite mtime does NOT move during segment 2.

---

## Segment 1 — Setup (00:00 – 01:00) [~1 min]

**On-screen state**
- Cairn panel just launched, no project selected
- Inspector window open but empty
- Background terminal shows `~/cairn-demo-target` `git log` head + `git status` (clean)
- Title overlay: "Cairn — local AI engineering operations layer"

**Voiceover (~60 words)**
> "This is Cairn — a local AI engineering operations layer. It sits between you and the AI agents on your laptop. You give it a goal in plain English. It reads your project's real state — commits, tasks, blockers — and turns that into a ranked work list. With your authorization, it can chain agent runs and stop for your review. Let me show you, on a real codebase."

**On-screen beats**
1. (00:00) Cold open on empty panel + title overlay
2. (00:20) Cut to read-only target terminal — `git log` showing recent activity
3. (00:40) Cursor pans back to Cairn panel; user clicks "Add project" → picks `~/cairn-demo-target` → project card appears

**Screenshot anchors**
- **A1** — empty panel + title overlay (cover image)
- **A2** — terminal showing the read-only target's git head (proves real codebase)
- **A3** — project card just added (Cairn now knows the target)

**Artifacts produced**
- One project registry entry in `~/.cairn/projects.json` for `~/cairn-demo-target`
- `RECORDING_TRANSCRIPT.md` segment 1 timestamp log
- No LLM cost yet

---

## Segment 2 — Mentor (01:00 – 04:00) [~3 min]

**On-screen state**
- Cairn panel switches to Mentor sub-section
- Chat input gets focus; mentor-history sidebar shows 2-3 prior warm-up turns (so this doesn't look like "first ever")
- Mid-segment: 5 ranked work items render
- SQLite mtime watch shows **no change** for the entire segment (Mentor is read-only)

**Voiceover (~75 words, split across segment)**
> Open (~25 w): "First — Mentor. I'm pointing it at agent-game-platform, a project I haven't touched in a month. Mentor reads it strictly read-only. Watch."
> Mid (~30 w, while Mentor responds): "It just read PRODUCT.md, the last 20 commits, the candidate log, the kernel state. No prompt content. No secrets. No files outside the project tree."
> Close (~20 w): "Top item: outcomes evaluator has no tests. Notice the confidence score and the evidence references — that's auditable."

**On-screen beats**
1. (01:00) User clicks Mentor sub-section
2. (01:10) User types: `what should we focus on in agent-game-platform`
3. (01:20–01:35) "Mentor thinking…" indicator (~15 s for real-LLM call)
4. (01:35) 5 ranked items render in order
5. (01:50) Camera close-up: item #1 with `description / why / next_action / confidence / evidence_refs`
6. (02:30) User clicks "Why?" on item #2 → follow-up turn rendered
7. (03:15) Follow-up rendered; voiceover transitions to seg-3 hook: "Now let me pick item #1 and let Cairn run with it"
8. (03:50) Cursor hovers over "Pick to start Continuous Iteration" button on item #1

**Screenshot anchors**
- **B1** — empty Mentor chat with user's question typed, pre-send
- **B2** — 5 ranked items rendered (full view)
- **B3** — close-up of item #1: all schema fields visible (description / why / next_action / confidence / evidence_refs)
- **B4** — follow-up turn showing multi-turn capability ("why is item #2 below item #1?")
- **B5** — SQLite mtime watch showing **no change** during the segment (proof of read-only on kernel state)

**Artifacts produced**
- `~/.cairn/mentor-history/<projectId>.jsonl`: +2 records (initial Q + follow-up Q)
- Cairn SQLite mtime UNCHANGED during this segment (Mentor only writes its own history JSONL, per B2 spec §9.4)
- `RECORDING_TRANSCRIPT.md` segment 2 entry + verbatim voiceover transcript
- LLM cost: ~\$3–4 (2 real Claude Sonnet calls, each ~6 K tokens in / ~1.5 K tokens out per B2 spec §4.4 budget)

---

## Segment 3 — Continuous Iteration (04:00 – 09:00) [~5 min]

**On-screen state**
- User clicks "Pick to start Continuous Iteration" on Mentor item #1
- **Target-switch dialog appears** — voiceover emphasizes this is intentional
- User picks target = `~/cairn-demo-temp` (throwaway repo), NOT the read-only target
- Authorization scope dialog: user selects "auto-run top 3 candidates, stop on first ROLLED_BACK or boundary violation"
- Inspector switches to Three-Stage Loop UI
- Chain runs: Scout → Worker × 3 → Review × 3, stopping at REVIEWED for each
- One Worker run trips boundary verify (planted via pre-flight, see §"Recording risks")

**Voiceover (~80 words, split)**
> Open (~30 w): "Now — Continuous Iteration. Important: I'm switching the worker target to a throwaway repo. Mentor read agent-game-platform; the agent runs that follow will not touch it. Different surface — read versus mutate."
> Mid-1 (~25 w, during Scout): "Scout reads the throwaway repo and proposes three small candidates — a missing test, a doc gap, a tiny refactor. I authorized top three. Worker spawns on each."
> Mid-2 (~15 w, during boundary trip): "Watch this — candidate 2 trips boundary verify, touches .env. Mode B auto-stops, flags `needs_human`."
> Close (~15 w): "Three REVIEWED candidates. Cairn never auto-accepted. Never auto-merged."

**On-screen beats**
1. (04:00) Pick button → target-switch dialog appears (key moment, slow camera)
2. (04:15) User explicitly picks `~/cairn-demo-temp`
3. (04:30) Authorization scope dialog → user picks "auto-run top 3"; "stop on ROLLED_BACK or boundary violation" pre-checked
4. (04:45) Three-Stage Loop UI in Inspector — Scout running
5. (05:15) Scout emits 3 candidates (the `## Scout Candidates` block visible in worker pane)
6. (05:30) Worker 1 starts on candidate 1 (missing test); real-Claude streaming output visible
7. (06:15) Worker 1 done; Review stage triggered automatically
8. (06:30) Review verdict renders; candidate 1 → REVIEWED (clean)
9. (06:45) Worker 2 starts on candidate 2; partway through, touches `.env`
10. (07:15) Boundary verify trips → Inspector shows `boundary_violations: ['.env touch']`; candidate 2 → REVIEWED with `needs_human=true`
11. (07:45) Worker 3 starts on candidate 3 (small refactor); clean run
12. (08:30) Worker 3 done; review verdict renders; candidate 3 → REVIEWED
13. (08:50) Inspector queue shows: 3 REVIEWED candidates, 1 tagged `needs_human`; chain auto-stopped

**Screenshot anchors**
- **C1** — target-switch dialog (proves intentional handoff, not magic)
- **C2** — authorization scope dialog with "auto-run top 3" + boundary-stop checkboxes visible
- **C3** — Three-Stage UI mid-chain (Scout done, Worker 1 running, Worker 2/3 queued)
- **C4** — real-Claude streaming output in worker pane (proves real LLM, not mock)
- **C5** — boundary-verify trip in Inspector with `boundary_violations` field highlighted
- **C6** — 3 REVIEWED rows in queue with one `needs_human` tag

**Artifacts produced**
- `~/cairn-demo-temp` working tree: 2 worker commits (candidates 1 and 3); candidate 2's changes rolled back due to boundary trip
- `~/.cairn/project-candidates/<demo-temp-projectId>.jsonl`: 3 candidate lifecycle records (PROPOSED → PICKED → WORKING → REVIEWED, with candidate 2 carrying `boundary_violations` + `needs_human`)
- `~/.cairn/project-iterations/<demo-temp-projectId>.jsonl`: 3 iteration records
- `~/.cairn/project-reports/<demo-temp-projectId>.jsonl`: 3 worker reports + 3 review verdicts
- Cairn SQLite mtime MOVES (Mode B writes processes / heartbeats / status transitions)
- `RECORDING_TRANSCRIPT.md` segment 3 entry + worker spawn timestamps + LLM call log
- LLM cost: ~\$6–8 (3 Scout calls × ~\$0.5 + 3 Worker calls × ~\$1.5 + 3 Review calls × ~\$0.7)

---

## Segment 4 — Human-in-loop closure (09:00 – 12:00) [~3 min]

**On-screen state**
- Inspector queue with 3 REVIEWED candidates visible
- User clicks candidate 1 → diff pane opens; worker report + review verdict visible side-by-side
- User clicks Accept; status flips to ACCEPTED
- User clicks candidate 2 (`needs_human`); boundary violation field prominent; user reads the violation, clicks Reject + types reason
- User clicks candidate 3; diff + verdict; Accept
- Queue empties; project card final counts show

**Voiceover (~70 words, split)**
> Open (~30 w): "Here's the human gate. Three candidates waiting. For each I see the diff, the worker's report, the reviewer's verdict, the boundary-check result. I'm not trusting Cairn's word — I'm verifying."
> Mid (~20 w, during reject): "This one tripped boundary verify. Worker tried to touch .env. I reject with a reason — Cairn remembers."
> Close (~20 w): "Two accepted, one rejected. The accepted commits sit in the throwaway repo's working tree. I still haven't pushed. That's still my call."

**On-screen beats**
1. (09:00) Inspector queue → user clicks candidate 1
2. (09:15) Diff pane + worker report + review verdict all visible (single frame)
3. (09:45) Accept button click → status flips to ACCEPTED with timestamp
4. (10:00) User clicks candidate 2 (the `needs_human` one)
5. (10:15) `boundary_violations` field highlighted in detail view
6. (10:30) User reads violation; clicks Reject; types reason: "worker touched .env — out of scope"
7. (11:00) User clicks candidate 3 → diff + verdict
8. (11:20) Accept click
9. (11:40) Queue is empty; project card now shows: "Accepted: 2 / Rejected: 1 / In flight: 0"
10. (11:50) Camera close-up on project card final counts

**Screenshot anchors**
- **D1** — REVIEWED queue with 3 rows visible (full Inspector)
- **D2** — single frame with diff + worker report + review verdict (this is the "evidence" frame)
- **D3** — boundary_violations field on candidate 2 (the rejected one)
- **D4** — project card final counts (2 ACCEPTED / 1 REJECTED / 0 in flight)

**Artifacts produced**
- 3 candidate status transitions: 2× REVIEWED → ACCEPTED, 1× REVIEWED → REJECTED
- `~/.cairn/project-candidates/<demo-temp-projectId>.jsonl`: +3 lines (final transitions)
- Cairn SQLite: candidate state final
- `RECORDING_TRANSCRIPT.md` segment 4 entry + Accept/Reject timestamps
- LLM cost: \$0 (no LLM calls — pure UI mutation)

---

## Segment 5 — Multi-Cairn ambient (12:00 – 13:00) [~1 min]

**On-screen state**
- Inspector → user clicks "Team" sub-section
- Read-only list of published candidates from a **mock second Cairn node** renders (pre-seeded into `$CAIRN_SHARED_DIR/published-candidates.jsonl` during pre-flight)
- Each row shows: short node_id / description / candidate_kind / status / kind_chip
- User clicks one → drill-down shows the same 4-field snapshot, nothing more (no diff, no prompt)
- User closes drill-down

**Voiceover (~55 words)**
> "Last thing. If you run multiple Cairn nodes sharing a folder — a Dropbox, an SMB share, even a synced git tree — each node sees the others' published candidates. Read-only. No auth, no daemon, no real-time sync protocol. Just append to a shared JSONL file. That's Multi-Cairn v0 — deliberately small, deliberately a test wedge."

**On-screen beats**
1. (12:00) User clicks Team sub-section in Inspector
2. (12:15) 5 mock published candidates from "node bbbb1111ccc2" render
3. (12:30) User clicks one → drill-down detail panel
4. (12:45) Drill-down shows only description / candidate_kind / status / kind_chip (no diff, no prompt, no commit — the boundary)
5. (12:55) User closes drill-down

**Screenshot anchors**
- **E1** — Team sub-section with 5 mock rows from second node
- **E2** — drill-down detail panel showing only the 4-field snapshot (the "we don't share more than this" frame)

**Artifacts produced**
- NO new outbox writes from this segment (read-only consumer of the pre-seeded fixture)
- `RECORDING_TRANSCRIPT.md` segment 5 entry

**Mockup data (pre-seeded into `$CAIRN_SHARED_DIR/published-candidates.jsonl` during pre-flight; lives at `docs/fixtures/mock-published-candidates.jsonl` in the repo as a one-off fixture for reproducible recording — fixture file is NOT created by this plan, see §"What this plan does not cover")**

```jsonl
{"event_version":1,"node_id":"bbbb1111ccc2","published_at":1715419000000,"project_id":"demo-peer-project","candidate_id":"c_peer01abc234","snapshot":{"description":"Add input validation to auth handler","candidate_kind":"bug_fix","status":"REVIEWED","kind_chip":"safety"}}
{"event_version":1,"node_id":"bbbb1111ccc2","published_at":1715419100000,"project_id":"demo-peer-project","candidate_id":"c_peer02def345","snapshot":{"description":"Cover settings.ts with table-driven tests","candidate_kind":"missing_test","status":"PROPOSED","kind_chip":"coverage"}}
{"event_version":1,"node_id":"bbbb1111ccc2","published_at":1715419200000,"project_id":"demo-peer-project","candidate_id":"c_peer03ghi456","snapshot":{"description":"Rename Game.tick() → Game.step() for consistency","candidate_kind":"refactor","status":"PICKED","kind_chip":"naming"}}
{"event_version":1,"node_id":"bbbb1111ccc2","published_at":1715419300000,"project_id":"demo-peer-project","candidate_id":"c_peer04jkl567","snapshot":{"description":"Document the leaderboard sort tiebreak rule","candidate_kind":"doc","status":"PROPOSED","kind_chip":"clarity"}}
{"event_version":1,"node_id":"bbbb1111ccc2","published_at":1715419400000,"project_id":"demo-peer-project","candidate_id":"c_peer05mno678","snapshot":{"description":"Investigate flaky scoring test (seen 3× in last week)","candidate_kind":"bug_fix","status":"PROPOSED","kind_chip":"flake"}}
```

---

## Segment 6 — Wrap (13:00 – 14:00) [~1 min]

**On-screen state**
- Wide shot showing panel + Inspector both visible at once
- Subtle overlay: elapsed timer (≈ 14:00)
- Cut to summary card overlay with key stats
- Closing tagline: "Cairn — local, read-only by default, advisor + executor under your authorization"

**Voiceover (~75 words)**
> "Recap. I typed two questions in a chat panel. I clicked three Accept-or-Reject buttons. I read three diffs. That was all the input I gave. Cairn read agent-game-platform read-only, translated my pick into three real agent runs on a throwaway repo — with boundary checks that caught one violation. Three candidates' worth of work landed in roughly 12 minutes, gated end-to-end by me. That's the operations layer."

**On-screen beats**
1. (13:00) Cut to wide shot of full screen
2. (13:20) Summary card overlay fades in with:
   - "1 chat session, 2 turns" (Mentor)
   - "3 candidates auto-chained" (Mode B)
   - "1 boundary violation caught + auto-stopped" (Mode B safety)
   - "2 accepted, 1 rejected — all human-gated" (closure)
   - "Multi-Cairn: 5 peer candidates visible (read-only)" (Mode C)
   - "Total cost: ~\$12 in LLM calls"
3. (13:55) Fade

**Screenshot anchors**
- **F1** — wide shot with both panel + Inspector + tray + background terminal visible (the "this is the whole product surface" frame)
- **F2** — summary card overlay (final frame; cover-image candidate)

**Artifacts produced**
- `RECORDING_TRANSCRIPT.md` segment 6 entry + final summary block
- (post-recording, manual) `summary.json` with stats — used for blog post / release notes

---

## Total budget

| Item | Estimate |
|---|---|
| Recording runtime | 14:00 (within 12-15 min target) |
| LLM calls | 11 total (2 Mentor + 3 Scout + 3 Worker + 3 Review) |
| LLM cost | \$10–\$15 (real Claude Sonnet at current rates; per B2 spec §4.4 budgets) |
| Pre-flight + env setup | 20–30 min |
| Post-production (cut, captions) | 1–2 hours |
| Re-recordable? | Yes — full real-LLM cost again per take. Plan for 1–2 takes minimum |
| Disk space (1080p @ 60fps) | ~ 1 GB / min → ~ 15 GB per take |

---

## Recording-day risks

| Risk | Mitigation |
|---|---|
| Real-LLM non-determinism in Scout / Worker / Review outputs | (a) accept it — that's authenticity; (b) if first-take Scout output is unusable, re-seed the candidate pool from a pre-recorded successful run before re-rolling |
| Boundary-verify trip is required for segment 3 beat 10 (needs `needs_human` row) | Pre-flight: craft a candidate in the throwaway repo's Scout-friendly state that naturally tempts the worker to touch `.env` (e.g. leave a `.env.example` near config files); fallback: manually inject the trip via a contrived candidate description if natural trip fails |
| Mentor history persistence visible on first turn | Pre-flight script `mentor-warmup.mjs` writes 2-3 prior turn records before recording — segment 2's first turn isn't "Cairn's first ever chat", which would weaken the "advisor with memory" claim |
| Multi-Cairn second node is mocked, not real | Voiceover explicitly says "read-only snapshot" and "no real-time sync"; if viewers ask "is the other node alive?", answer is "this fixture demonstrates the shape; running two real Cairn nodes is identical mechanism, just slower to film" |
| Real-Claude latency makes seg 3 long | The 5-min budget for seg 3 already assumes ~ 1 min per worker run; if real Claude is slow, edit out idle stretches in post (clearly marked in `RECORDING_TRANSCRIPT.md` cuts) |
| Worker writes to wrong target (e.g. accidentally on demo-target instead of demo-temp) | Hard constraint #2 is enforced by the target-switch dialog in seg 3 beat 1; verify in pre-flight that the dialog actually appears (panel UI dep) |
| API key rate limit | Pre-flight: run one mock LLM call to verify quota; have a backup key if seg-3 mid-recording rate-limits |
| Terminal exposing `~/.cairn-push-token/` paths | Pre-flight: `cd ~/cairn-demo-target` only; never `cd ~/path/to/real-cairn-checkout` during recording |

---

## Alignment check

| Source | Demo respects it by |
|---|---|
| PRODUCT.md §6.5.1 (Mode A · Mentor framing) | Segment 2 voiceover uses "ranked work items + WHY + 干系人 / stakeholders" language; never claims "Mentor decides" |
| PRODUCT.md §6.5.2 (Mode B safety boundaries) | Segment 3 demonstrates the "auto-stop at REVIEWED" rule; segment 4 emphasizes human Accept; no auto-commit / auto-push / auto-merge anywhere in voiceover |
| PRODUCT.md §6.5.3 (Multi-Cairn v0 form) | Segment 5 voiceover uses exact wording: "shared dir + JSONL outbox + read-only"; no claim of auth, sync, real-time |
| PRODUCT.md §1.3 #4a/b (advisor vs executor) | Segment 2 → 3 transition (Pick button) is the explicit moment Mentor's advice becomes Mode B's executor action — user-authorized handoff visible on screen |
| B2 spec §1 (Mentor interaction model) | Mentor is in a new sub-section (peer to Inspector); chat panel; multi-turn within session; on-ask only — segment 2 beat 6 demonstrates the follow-up question pattern |
| B2 spec §3 (output schema) | Screenshot B3 close-up shows all schema fields: description / why / next_action / confidence / evidence_refs — proves the schema is real, not a marketing slide |
| B2 spec §6 (max items 5, on-ask only) | Segment 2 shows exactly 5 items; triggered by user typing; no auto-push during the recording |
| Day-6 dogfood (real-Claude Three-Stage e2e on throwaway repo) | Segment 3 is essentially Day-6's dogfood with auto-chain layer on top; same throwaway-repo pattern; same real-Claude provider |

---

## What this plan does NOT cover

- The first-time setup wizard flow (project add, hint editing) — assumed user has the project pre-added; if needed, can be a 30-second cutaway in segment 1
- Codex sessions adapter visualization (the Sessions sub-section's Codex tab) — out of demo arc to avoid clutter; existence is mentioned but not demoed
- The "manual run via Codex CLI" `next_action` path from B2 spec §3.2 — demo only walks the Mode B path (Mentor → Pick → Continuous Iteration)
- Failure recovery / retry flows — happy path only; one boundary-trip is shown but no retry is demonstrated
- Anything in `~/.codex/sessions/` raw transcript content — adapter is metadata-only and not user-facing in this demo
- The fixture file `docs/fixtures/mock-published-candidates.jsonl` is referenced but **NOT created by this plan** — that fixture file lives outside this docs-only plan; a separate small follow-up task should land it before recording day (a 5-line JSONL, ~10 lines including a header comment, with the exact content shown in segment 5's "Mockup data" block above)
- Audio normalization / captioning workflow — recording-side concern, not in the plan's scope

---

## Approval gates (must all be green before pressing record)

1. **A2-UI commit landed** — panel renders the Mentor sub-section (handler-layer is in `368d065`; UI binding TBD; this is the demo's hardest blocker)
2. **`CAIRN_DESKTOP_ENABLE_MUTATIONS=1` confirmed working** — Accept / Reject / Mentor Pick buttons all visible in panel and Inspector
3. **`agent-game-platform` clone pinned to a deterministic commit** — recording must be reproducible across takes
4. **Multi-Cairn mock outbox fixture committed** — `docs/fixtures/mock-published-candidates.jsonl` exists in the repo (separate small task per §"What this plan does not cover")
5. **Throwaway repo (`~/cairn-demo-temp`) initialized fresh** — first commit landed so worker can branch off cleanly
6. **API key valid + budget approved** — pre-check that \$10–\$15 spend is OK; have a backup key for rate-limit fallback
7. **Disk space ≥ 30 GB free** — for 1–2 takes at 1080p60
8. **Mic / audio tested** — voiceover intelligible at -12 LUFS approximately
9. **Mentor warm-up script run** — `~/.cairn/mentor-history/<projectId>.jsonl` has 2-3 prior turn records so segment 2 doesn't look like first-ever chat

---

## Status

Draft only. Awaiting user sign-off + dependency completion (especially gate #1). After sign-off + A2-UI land + fixture commit, this plan can be executed in ~ 1.5 hours total (pre-flight + recording + post-prod first pass).

Once recorded, this file will be archived (move to `docs/archive/demo-recording-plan-<YYYY-MM-DD>.md`) and replaced by a `docs/demo-2026-MM-DD.md` containing the actual recording's `RECORDING_TRANSCRIPT.md` + screenshot anchors + cost log.
