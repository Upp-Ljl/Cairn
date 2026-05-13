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

## Skeleton

```markdown
# <Project Name>

## Goal
<one sentence — what "success" looks like>

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

## Current phase
**Last updated**: YYYY-MM-DD
- Phase: <name>
- This week: <line>
- Next week: <line>
```

All sections are **optional**. A missing section is valid — the scanner
returns the empty list / null for it, and Mentor falls back to conservative
default-escalate behavior for the affected category.

## Section semantics

### `## Goal`

One sentence stating the project's success criterion. Free prose. Mentor uses
this in L3 LLM polish prompts as the "what is success" anchor.

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

### `## Current phase`

A loose section. The scanner extracts:

- `**Last updated**: <date>` → `current_phase.last_updated`
- Any line starting with `- Phase:` → `current_phase.phase`
- `- This week:` / `- Next week:` similarly

All optional. Used in agent briefs to anchor the agent's current-context POV.

## Scanner output shape

`mentor-project-profile.cjs::scanCairnMd(filePath)` returns:

```ts
type Profile = {
  version: 1,
  source_path: string,           // abs path scanned (may not exist)
  exists: boolean,               // false ⇒ all fields below are defaults
  source_mtime_ms: number | null,
  source_sha1: string | null,    // sha1 of file content (truncated 16-hex)
  scanned_at: number,            // Date.now() at scan time
  project_name: string | null,   // first H1, trimmed
  goal: string | null,
  is_list: string[],
  is_not_list: string[],
  authority: {
    auto_decide: string[],       // ✅ lines
    decide_and_announce: string[], // ⚠️ lines
    escalate: string[],          // 🛑 lines
  },
  constraints: string[],
  known_answers: Array<{ pattern: string, answer: string }>,
  current_phase: {
    last_updated: string | null,
    phase: string | null,
    this_week: string | null,
    next_week: string | null,
  },
  raw_sections: Record<string, string>, // section header → body text, for debug
};
```

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
