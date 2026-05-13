# CAIRN.md — Per-Project Policy File Spec

> Canonical schema for the per-project `CAIRN.md` file that Cairn Mentor reads
> as the project owner's voice. Source-of-truth for the scanner in
> `packages/desktop-shell/mentor-project-profile.cjs` and for the 3-layer
> decision architecture documented in
> `docs/superpowers/plans/2026-05-13-mentor-3-layer-decision.md`.

## What this file is

`CAIRN.md` is a markdown file at the repo root, **committed to git**, parallel
to `CLAUDE.md`. It is read by two consumers:

1. **Cairn Mentor** (the auto-tick engine in `packages/desktop-shell/mentor-tick.cjs`):
   uses the structured sections to decide whether a runtime event should be
   *Mentor-resolved*, *Mentor-decided-and-announced*, or *escalated to the user*.
2. **Coding agents** (Claude Code / Cursor / Codex / Aider): read it to align
   their work with the owner's intent. Same file, two readers.

`CAIRN.md` is **not** `CLAUDE.md`. `CLAUDE.md` is the coding agent's playbook
(lint commands, hooks, local gotchas). `CAIRN.md` is the project owner's
policy file (intent, scope, decision delegation). Both can coexist; separate
roles.

## Why this design

User-locked decisions on 2026-05-13 (memory: `cairn-md-protocol`):

- Mentor's default is **decide**, not **escalate** — because cockpit Module 4
  rewind makes errors cheap to undo. So Mentor needs a project-owner-supplied
  authority list (the ✅/⚠️/🛑 sections).
- Mentor coordinates, doesn't think on its own — its judgment basis comes from
  this file (L1) plus the active agent's brief (L2), with L3 LLM polish only
  as a last fallback. CAIRN.md is the L1 substrate.

## Schema versions

- **v1** (2026-05-13 — superseded): `## Goal` was the only direction-anchor; `## Current phase` carried time-anchored fields (`**Last updated**`, `Phase`, `This week`, `Next week`).
- **v2** (2026-05-14 — current): adds `## Whole` (the stable complete-form sentence — the north star); reframes `## Goal` as "the current sub-`Whole` milestone"; drops `## Current phase` entirely. AI-development cadence makes human-week/-month framing rot fast; "what's in flight" is now panel-computed from live `tasks` + `processes`, not stored in the file.

Profiles are tagged with `version: 2` in the scratchpad cache; pre-v2 cache rows are invalidated on read.

## Skeleton (schema v2)

```markdown
# <Project Name>

## Whole
<one sentence — the project's stable complete form; Mentor's north star.
 CC-drafted from your repo, user-confirmed.>

## Goal
<one sentence — the current sub-`Whole` milestone. Can change as the project
 iterates; `Whole` stays.>

## What this project IS / IS NOT
- IS: <one item per line, plain prose>
- IS NOT: <one item per line>

## Mentor authority (decision delegation)
- ✅ Mentor auto-decide: <list of reversible / low-stakes things>
- ⚠️ Mentor decide + announce: <reversible but worth knowing>
- 🛑 Always escalate to user: <irreversible / strategic / business>

## Project constraints
- <constraint line, plain prose>

## Known answers
- <question substring> => <canonical answer>
```

All sections are **optional**. A missing section is valid — the scanner
returns the empty list / null for it, and Mentor falls back to conservative
default-escalate behavior for the affected category.

## Section semantics

### `## Whole`

The project's stable complete-form description. ONE sentence. Mentor's north star — every authority bullet (✅/⚠️/🛑) implicitly serves Whole. Cairn drafts this from artifacts the user has already produced (`CLAUDE.md`, `README.md`, `package.json`, recent commit messages) at first install and asks the user to confirm/correct ONE sentence. Users do not write this cold.

Format expectation: single sentence, 20-200 chars, period/question/exclamation terminated. Sentences longer than ~200 chars usually indicate the author tried to pack a roadmap into Whole — split into Whole + Goal instead.

### `## Goal`

The current sub-`Whole` milestone — what we are driving toward right now. ONE sentence. CAN drift as the user iterates; `Whole` stays. Mentor uses Goal to disambiguate "is this work on the path to Whole?" vs "is this work off-goal drift?". When Goal and Whole conflict (rare), Whole wins.

### `## What this project IS / IS NOT`

Two bullet-list buckets prefixed `IS:` / `IS NOT:` (or `不是` for zh) per line.
The scanner extracts each bullet's text after the prefix. Used by Mentor's
off-goal drift heuristic (Rule C, deferred) and surfaced verbatim in agent
briefs when an agent asks "is feature X in scope?".

### `## Mentor authority (decision delegation)` — the core section

Three categories, each a bullet list. Lines may start with the emoji or the
ASCII tag:

| Emoji | ASCII tag | Mentor action |
|---|---|---|
| ✅ | `auto:` | Decide and act. No Activity-feed announcement (kept quiet so user isn't paged). |
| ⚠️ | `announce:` | Decide and act, but emit an `info` event to the Activity feed so user can spot drift retroactively. |
| 🛑 | `escalate:` | Skip L1/L2/L3 — emit a `PENDING` escalation to Module 5 (Needs You). |

The scanner parses each bullet's text, normalizes whitespace, and stores a
lowercase substring match key. Mentor's policy rules use these as the L1
gate before any LLM call.

**Example**:

```markdown
## Mentor authority (decision delegation)
- ✅ retry transient test failures (flake-likely) up to 2x
- ✅ pick a TypeScript over a JavaScript file when blocker asks "which language"
- ⚠️ reduce a task's time budget when 80% elapsed and progress visible
- 🛑 npm publish / force-push / LICENSE edit / new npm dep
- 🛑 introducing a new MCP tool
```

### `## Project constraints`

A flat bullet list of cross-cutting rules ("no new npm dependencies", "tests
must hit a real database, not mocks", etc.). Surfaced to agent briefs and
to L3 LLM polish prompts as the "boundary rules" anchor.

### `## Known answers`

A bullet list mapping question substrings → canonical answers, in the form:

```markdown
- <substring> => <answer>
```

The scanner parses each line on `=>` (whitespace-tolerant). Mentor's Rule D
(BLOCKED with question) checks `blocker.question.toLowerCase()` against each
substring (also lowercased); first hit returns the corresponding answer
as a nudge. This is the cheapest decision path — no LLM call required.

### "What's in flight" (panel-computed, NOT a file section)

In schema v1 this lived as a `## Current phase` markdown section with `**Last updated** / This week / Next week` fields. In v2 it is **removed from the file** — AI-development cadence makes human-week framing mis-anchor in days.

The panel computes a live "in flight" line from kernel state:

```
in_flight_summary = count(tasks where state in {RUNNING, READY_TO_RESUME, BLOCKED, WAITING_REVIEW})
                  + count(processes where state='active' and matches(project_root))
```

No file edit required. Always fresh. Survives across sessions because tasks + processes are durable kernel state.

## Scanner output shape

`mentor-project-profile.cjs::scanCairnMd(filePath)` returns:

```ts
type Profile = {
  version: 2,                    // schema v2 (2026-05-14)
  source_path: string,           // abs path scanned (may not exist)
  exists: boolean,               // false ⇒ all fields below are defaults
  source_mtime_ms: number | null,
  source_sha1: string | null,    // sha1 of file content (truncated 16-hex)
  scanned_at: number,            // Date.now() at scan time
  project_name: string | null,   // first H1, trimmed
  whole_sentence: string | null, // ## Whole — single sentence, the north star
  goal: string | null,           // ## Goal — current sub-Whole milestone
  is_list: string[],
  is_not_list: string[],
  authority: {
    auto_decide: string[],       // ✅ lines
    decide_and_announce: string[], // ⚠️ lines
    escalate: string[],          // 🛑 lines
  },
  constraints: string[],
  known_answers: Array<{ pattern: string, answer: string }>,
  raw_sections: Record<string, string>, // section header → body text, for debug
};
```

`current_phase` was removed in v2 — see "What's in flight" section above. Pre-v2 cached rows are invalidated on read by the version check in `readCachedProfile`.

## Cache convention

The scanner writes the profile JSON into the `scratchpad` table under key
`project_profile/<project_id>`. Mentor-tick reads this key before each rule
evaluation. Refresh policy:

- **On panel boot**: scan once per project; write cache.
- **Per-tick**: if `source_mtime_ms` from disk > cached `source_mtime_ms`,
  re-scan and rewrite cache. Otherwise reuse.
- **Manual override**: a future panel button (Phase 10) can force re-scan.

## Routing logic (recap)

Given a runtime event whose category falls into one of ✅ / ⚠️ / 🛑:

```
if 🛑 in profile.authority.escalate matches event:
    emit escalation (Module 5)
elif L1 known_answers matches event.question_substring:
    emit nudge with answer (no LLM call) — cheapest path
elif ⚠️ matches:
    decide via L2 (agent_brief) or L3 (LLM polish);
    emit nudge AND info event to Activity feed
elif ✅ matches:
    decide via L2 or L3;
    emit nudge silently
else:
    profile is silent on this category → conservative default:
      emit escalation (Phase 9 default) OR nudge (later phases via heuristic)
```

## Fallback behavior

| Condition | Mentor behavior |
|---|---|
| `CAIRN.md` does not exist | Conservative mode: default-escalate for all BLOCKED / time-budget / outcomes-fail events. Activity feed shows "no CAIRN.md — Mentor is conservative." (banner stub TBD in Phase 10) |
| `CAIRN.md` exists but section missing | Treat section as empty list. Mentor's rule logic decides based on remaining sections + L2/L3. |
| `CAIRN.md` parse error (no H1 / corrupt) | Scanner returns `{ exists: true, project_name: null, ... }` with default empty fields, plus an `errors: [...]` array (in `raw_sections._errors`). |

## Cross-refs

- Plan: `docs/superpowers/plans/2026-05-13-mentor-3-layer-decision.md`
- Memory: `cairn-md-protocol` (the architectural source-of-truth)
- Memory: `trust-with-rewind-safety` (product thesis behind Mentor authority)
- Module: `packages/desktop-shell/mentor-project-profile.cjs` (scanner)
- Module: `packages/desktop-shell/mentor-policy.cjs` (consumer)
- Smoke: `packages/desktop-shell/scripts/smoke-mentor-3layer.mjs`
- Dogfood: `packages/desktop-shell/scripts/dogfood-llm-3layer.mjs`
- Repo's own CAIRN.md (dogfood instance): `<repo-root>/CAIRN.md`
