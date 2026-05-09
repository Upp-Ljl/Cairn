# Agent Identity + Recovery Surface dogfood (2026-05-09)

**Round**: UI hardening — surfacing the kernel-layer atomic capabilities
(checkpoint / rewind) that have existed since W1 but were never visible
to the user, and turning the technical session list into a humane
project control panel.

**Commits**:
- `9174034` feat: add human-readable agent identity labels
- `6fbc4ac` feat: add project recovery surface
- `3977f22` style: simplify agent activity panel hierarchy
- `<this>`  docs + dogfood

**Run**: `node packages/desktop-shell/scripts/dogfood-identity-recovery.mjs`

## What changed in UI semantics

### Before (technical surface)
- Each row showed `claude-code/session-file medium-high busy 7f5bf59f-aaaa-bbbb`
- Family group titles: `LIVE` / `RECENT` / `INACTIVE` / `DEAD`
- Attribution chip: `cap` / `hint` / `cwd` (read by no human ever)
- Source chip: `MCP` / `Claude Code` / `Codex` (OK but next to raw session id)
- Tray tooltip raw counts; users couldn't see if a project was recoverable.

### After (project control surface)
- Each row shows
  `[Working]  Claude Code · Terminal 1     project folder    2m ago`
  `           D:\lll\cairn`
- Family group titles: `Working now` / `Recent` / `Inactive` / `Dead` / `Unknown`
- Attribution chip: `project folder` / `MCP-reported` / `manual`
- Source chip removed from primary row (the display label already says
  "Claude Code · Terminal 1")
- Click row → detail card with `Source: Observed via Claude Code session
  file`, `Confidence: medium-high`, `Why this state: …`, and the raw
  technical fields users only need when debugging.
- New **Recovery Card** between Prompt Pack and Pulse: `RECOVERY (Good
  / Limited / None)` + counts + last READY anchor + `copy recovery
  prompt` action.
- Task detail's checkpoint section renamed `recovery anchors` and
  surfaces the latest READY anchor as `SAFE`. Per-task `copy recovery
  prompt for this task` link.

## Agent naming rule

`agent-activity.cjs::decorateActivity` is the single place that builds
display identity. Every consumer (panel renderer, tooltip aggregator,
prompt pack generator) reads off the same fields.

**Per-app numbering** (`numberActivitiesByApp`):
- Per project, per app (mcp / claude-code / codex), sorted by
  `started_at` (or `registered_at` for MCP) ascending, with
  `session_id` ASCII order as tiebreaker. Stable across re-scans
  regardless of input order.

**Display label**:
- `mcp #1` → `Cairn MCP · Runner`
- `mcp #N` → `Cairn MCP · Runner N`
- `claude-code #N` → `Claude Code · Terminal N`
- `codex #N` → `Codex · Terminal N`

**Short label**: `MCP 1` / `Claude 2` / `Codex 1` (used in tray
tooltip aggregations and tight grids).

**Human state label** (decoupled from raw state):
| Raw state | Human label |
|---|---|
| `active` (mcp) | Working |
| `busy` (claude) | Working |
| `idle` (claude) | Ready |
| `recent` (codex) | Recent |
| `inactive` (mcp/codex) | Inactive |
| `stale` (mcp) | Stale |
| `dead` (mcp/claude) | Dead |
| `unknown` | Unknown |

**State explanation** (one-liner shown in detail):
> "The runner claimed ACTIVE but its heartbeat is older than the TTL
> window."  (mcp stale)
> "Claude Code's session file reports it is in a turn right now."
> (claude busy)
> "Codex's local rollout log was written to in the last minute."
> (codex recent)

**Privacy**: smoke verifies that for every activity, the union of
`display_label + short_label + app_label + seat_label + source_label +
human_state_label + state_explanation + attribution_label` contains no
raw session_id / agent_id / pid substring. Raw identifiers stay in
`detail.*` (rendered only on click).

## Recovery Card rules

**Confidence**:
| Branch | Trigger |
|---|---|
| `Good`    | At least one READY checkpoint within last 24h |
| `Limited` | Older READY only (>24h) **OR** PENDING only |
| `None`    | No checkpoints **OR** only CORRUPTED |

**Last READY anchor** (most prominent line):
`<id_short> "<label>" @<git_head_short> · <relative time> · for <task intent>`

**Safe anchors list** (expand inline): top 3 READY + top 1 PENDING.
Each anchor: status badge + label + id_short + git_head + relative time.

**Hidden when**: `total === 0 AND confidence === 'none'`. A project
that's never had a checkpoint shouldn't take screen space — the user
sees "no checkpoints" via the `confidence_reason` line on the prompt
when they ask for one.

**Visibility for users**: this is the FIRST surface in the panel that
mentions the kernel's checkpoint primitive at all. Until now those
were W1 artifacts available only via MCP tools.

## Copy recovery prompt example

Project-level prompt (1.2KB on this box):

```
You are a coding agent helping a user inspect Cairn's recovery
anchors for cairn.
Cairn is a project control surface (read-only); it does NOT execute
rewind. Your job is to look, not to act.

# Current recovery state (from Cairn)
Confidence: NONE — No checkpoints recorded for this project. Ask an
agent (or the kernel layer) to create one before risky work.
Counts: 0 READY · 0 PENDING · 0 CORRUPTED (0 total).

# What to do
1. Inspect the latest READY anchor. Report what it covers (paths,
   git_head, label).
2. Compare it against the user's current goal. Note any gap.
3. Recommend whether a rewind is appropriate. Do NOT execute the
   rewind without confirming the boundary with the user.
4. If you do rewind, use Cairn's rewind primitives
   (cairn.rewind.preview / cairn.rewind.to). Never stash or
   force-push as a substitute.

# Hard rules
- Do not push, merge, or force any branch unless the user explicitly
  authorizes.
- Do not execute rewind without first showing the preview to the user.
- Do not infer the user's intent from previous transcripts; ask if
  uncertain.
- Treat Cairn's recovery summary as advisory; if it disagrees with
  what you observe, surface the disagreement, do not silently override.
```

Task-level prompt (similar shape, scoped to one task; references
`cairn.rewind.preview` / `cairn.rewind.to` explicitly).

**Smoke + dogfood guarantees**:
- Always says "Cairn is a project control surface (read-only); it
  does NOT execute rewind."
- Always says "Do not push, merge, or force any branch unless the
  user explicitly authorizes."
- Always says "Never use git stash / git reset --hard / force-push as
  a substitute."
- Never has a positive auto-execute imperative ("run rewind now",
  "execute rewind first" without negation).
- Privacy: never embeds api keys, transcripts, raw cwd, agent_id —
  smoke + dogfood both sweep with regex.

## Smoke / dogfood results

| Smoke | Asserts | Status |
|---|---|---|
| `smoke-agent-display-identity` (NEW) | 91/91 | PASS |
| `smoke-recovery-surface` (NEW)       | 57/57 | PASS |
| `smoke-agent-activity`     | 98/98 | PASS regression |
| `smoke-goal-signals`       | 46/46 | PASS regression |
| `smoke-goal-registry`      | 38/38 | PASS regression |
| `smoke-goal-interpretation`| 102/102 | PASS regression |
| `smoke-pre-pr-gate`        | 65/65 | PASS regression |
| `smoke-goal-loop-prompt-pack` | 85/85 | PASS regression |
| `smoke-project-rules`      | 36/36 | PASS regression |
| `smoke-worker-reports`     | 58/58 | PASS regression |
| `smoke-claude-session-scan`| 52/52 | PASS regression |
| `smoke-codex-session-log-scan` | 64/64 | PASS regression |
| `smoke-register-from-unassigned` | 44/44 | PASS regression |
| `smoke-day3-sessions`      | exit 0 | PASS regression |
| `smoke-day5-task-tree`     | exit 0 | PASS regression |
| `smoke-presence-v2`        | exit 0 | PASS regression |
| `smoke-stale-health`       | exit 0 | PASS regression |
| `smoke-electron-boot` (real Electron spawn) | exit 0 | PASS |
| `dogfood-identity-recovery` (THIS, live)    | exit 0 | PASS |

**+148 new unit assertions** (91 + 57) on top of the existing surface.
Every smoke green.

### Live dogfood snapshot on D:\lll\cairn

```
==> live registry: 2 project(s)
     - (legacy default) @ (unknown)  hints=2
     - cairn @ D:\lll\cairn  hints=0
==> live scans: claude=3  codex=27

  Project: cairn
     43 activities
        [Inactive] Codex · Terminal 1                 matched by project folder      ~78h ago
            why: No recent activity; the source still reports the session exists.
            source: Observed via Codex local session log · confidence=medium
        [Inactive] Codex · Terminal 10                matched by project folder      ~76h ago
        … and 35 more

  Project: (legacy default)
     2 activities
        [Stale   ] Cairn MCP · Runner                 manually assigned              ~22h ago
            why: The runner claimed ACTIVE but its heartbeat is older than the TTL window.
        [Stale   ] Cairn MCP · Runner 2               manually assigned              ~18h ago

==> project recovery surface:
  Project: cairn
     confidence:   NONE
     reason:       No checkpoints recorded for this project. Ask an
                   agent (or the kernel layer) to create one before
                   risky work.
     counts:       0 ready · 0 pending · 0 corrupted (0 total)
     prompt:       1206 chars
     leak-check: ok

==> read-only invariants:
     ok    ~/.cairn/cairn.db mtime unchanged
```

Notice how every row reads as plain English now:
- The user sees "Codex · Terminal 12 — Inactive — matched by project
  folder — 76h ago" instead of `codex/session-log medium 019e0a97-...`.
- Stale heartbeat MCP rows include a one-line *why*, so users
  understand why the rows aren't dead but aren't live either.
- The Recovery Card on a project with no checkpoints says exactly
  that, with a concrete next step ("Ask an agent (or the kernel
  layer) to create one before risky work.")

## Read-only / secret-safety boundary

| Surface | Writes? |
|---|---|
| `~/.cairn/projects.json` (registry, including `active_goal` / `project_rules`) | ✅ allowed (prior rounds) |
| `~/.cairn/project-reports/<id>.jsonl` (worker reports) | ✅ allowed (prior round) |
| `~/.cairn/cairn.db` (SQLite) | ❌ verified mtime unchanged in dogfood |
| `~/.claude/**` | ❌ source-grep clean |
| `~/.codex/**` | ❌ source-grep clean |
| `.cairn-poc3-keys/**` | ❌ read-only; gitignored |
| Recovery prompt outputs | n/a; runtime leak-check ok in dogfood |

**Mutation grep** (`\.run\(|\.exec\(`) on production desktop-shell
files: still **1 match** (`main.cjs`, dev-flag `resolveConflict`).
Pre-existing; this round adds zero new mutation surfaces.

## Risks

**P1**: none.

**P2**:
1. Live `cairn.db` on this box has 0 checkpoints, so the Recovery
   Card always renders "None" today. The card is correct; the underlying
   data isn't there yet because no agent has called
   `cairn.checkpoint.create` against this box's runtime DB. Action: when
   a real agent does its next round on this project, it should drop a
   checkpoint, and the dogfood will start showing "Limited" or "Good".

**P3**:
1. **Codex per-app numbering reaches 25**: when a user has 25+
   inactive Codex rollout files in the 7-day window, the panel shows
   `Codex · Terminal 25` etc. That's accurate but probably noisy.
   Polish: collapse the "Inactive (N)" group into a folded row when
   N > 5, with "click to expand all".
2. **Recovery Card hidden when 0 checkpoints**: matches the spec ("a
   project that's never had a checkpoint shouldn't take screen
   space"), but means the user has no obvious entry point to learn
   that checkpoints exist. Could add a one-line CTA on the empty
   state: "Ask an agent to create one. (Cairn has cairn.checkpoint.*
   tools.)"
3. **MCP rows show "manually assigned"** for the legacy default
   project's two hints — that's because they were attached via
   `add-hint` long ago. The label is correct; users may forget what
   that means. Detail card explains: `Why this state: …` + the
   manual-hint history is recoverable from the registry.

## Next-round candidates

(Do not start without explicit ask.)

1. **Inactive group folding** — collapse `Inactive (N)` to a single
   row on first render when N > 5; expand on click.
2. **Recovery Card empty-state CTA** — single line "Ask an agent to
   create a checkpoint" with a copy prompt that asks the agent to do
   exactly that. Still advisory; Cairn doesn't create them.
3. **Per-task safe-anchor banner** when at least one task in the
   tree has a READY checkpoint; surface it on the Tasks tab tree
   view, not just the detail card.
4. **L1 project card adds a small recovery dot** (green/amber/grey)
   so users see at-a-glance which projects are recoverable.
5. **Identity smoke parity** — write a parallel `smoke-recovery-prompt`
   that locks down the prompt text contract more strictly (line
   counts, phrase requirements) so future LLM-rewrite hooks can't
   loosen the language without a smoke break.
