# Managed Project Loop — `agent-game-platform` dogfood

**Date:** 2026-05-09
**Target repo:** https://github.com/anzy-renlab-ai/agent-game-platform.git
**Local checkout:** `D:/lll/managed-projects/agent-game-platform`
**Driver:** `packages/desktop-shell/scripts/dogfood-managed-project-loop.mjs`
**Result:** 21/21 assertions PASS; one full round of the managed loop completed against the live repo.

This is the first end-to-end demo of Cairn managing an **external** project — a real Next.js + bun + Sentry app — rather than Cairn itself. It exercises every step of the loop the user authorized in `D:/lll/Xproduct.md` style framing: register → profile → goal/rules → iteration → worker prompt → worker report → evidence → review → next-prompt seed.

---

## What Cairn managed in this round

Cairn behaved as a **project control surface**, not a coding agent:

- It **registered** the `agent-game-platform` checkout as a managed project (`p_dogfood_agp`).
- It **detected the project profile** by reading `package.json`, lockfile, `tsconfig.json`, and root markdown files. No installs, no scripts run.
- It **set a goal** ("Improve agent-game-platform safely under Cairn-managed loops") and a **ruleset** (testing policy uses the detected `bun run test`, no unauthorized push, no scope creep).
- It **started an iteration** and persisted it as a JSONL line under `~/.cairn/project-iterations/p_dogfood_agp.jsonl`.
- It **generated a worker prompt** — a copy-pasteable text the user can hand to Claude Code / Codex / Cursor.
- It **collected read-only git evidence**: branch, HEAD, dirty status, diff stat, last commit subject. No mutating git command.
- It **reviewed** the iteration and produced a deterministic verdict: `continue`, with one carry-over item from the worker report.
- It **wrote a `next_prompt_seed`** the next round can build on.

## What Cairn explicitly did **not** do

- It **did not write code** in `agent-game-platform`.
- It **did not** `npm install` / `bun install` / `pip install` anything.
- It **did not run** `bun run test` (the profile detected the command; the gate did not auto-execute it). The dogfood explicitly passed `allow_run_tests: false`.
- It **did not push, fetch, checkout, reset, clean, or stash**. The evidence collector enforces an exact-argv whitelist.
- It **did not auto-dispatch** an agent. The prompt is only generated; nothing was sent.
- It **did not write to `cairn.db`, `~/.claude`, or `~/.codex`**. Verified by source-level grep + mtime checks in the smokes.

## Profile detected

The profile detection is a pure read of `package.json` + lockfile + root probe files. For `agent-game-platform` it produced:

```
package_manager:  bun
languages:        javascript, typescript
test_commands:    bun run test | bun run test:watch
build_commands:   bun run build
lint_commands:    bun run lint
scripts (count):  9
docs:             CLAUDE.md, DESIGN.md, TODO.md
default_branch:   main
```

The detected commands flow into:
1. The **rules** (`testing_policy: ["Before claiming done, run: bun run test"]`).
2. The **worker prompt's "Managed project" section** — so the agent receives the project's *real* test command, not a generic placeholder.
3. The **evidence collector's `tests_suggested` list** for downstream review.

## Worker prompt shape

The full prompt is 2,751 chars. The new managed-project section is injected between `# Goal` and `# Context summary`:

```
# Managed project
Repo: https://github.com/anzy-renlab-ai/agent-game-platform.git
Local path basename: agent-game-platform
Default branch: main
Package manager: bun
Languages: typescript, javascript
Detected test commands:
  - bun run test
  - bun run test:watch
Detected build commands:
  - bun run build
Detected lint commands:
  - bun run lint
Docs to skim: CLAUDE.md, DESIGN.md, TODO.md
Cairn iteration id: i_0f44be6cd7fc
```

The rest of the prompt — `# Goal`, `# Project rules`, `# Coordination signals`, `# Acceptance checklist`, `# Non-goals`, `# When you finish` — is identical to the in-repo Goal Loop Prompt Pack v1, so the worker contract (no auto-push, must report completed/remaining/blockers/next_steps) is preserved.

Privacy: the prompt carries the **basename** of the local path, not the full Windows path. Smoke `smoke-managed-loop-prompt.mjs` asserts `C:\\Users\\...` never appears.

## Fixture worker report

This dogfood does **not** invoke an actual coding agent. Instead it appends one fixture report (clearly tagged) to exercise the rest of the loop:

```
title:     [FIXTURE] Round 1 — wired Sentry sample rate config
completed: 1 item
remaining: 1 item ("Confirm CHANGELOG entry; add e2e test for the config switch.")
blockers:  0
next_steps: 1
needs_human: false
```

The `[FIXTURE]` prefix in the title marks this row as not-a-real-agent for any future archaeology. Nothing was actually changed in `agent-game-platform`.

## Evidence collected

Read-only git probes ran against the cloned repo:

```
branch:        main
git_short:     de6875c3a2b0
dirty:         false
changed_files: 0
last_commit:   feat(sound): drama-tag fanfares per tone
errors:        (none)
```

The evidence collector uses an **exact-argv whitelist** for `git`. Anything outside that list (push, fetch, checkout, reset, clean, stash, rebase, or even `git status --short --ignore-submodules`) is rejected before `spawnSync`. Smoke `smoke-project-evidence.mjs` asserts each.

## Review verdict

The managed-loop reviewer combined the iteration, the fixture report, the evidence summary, the (synthetic `ready_with_risks`) Pre-PR-Gate result, and the goal:

```
status:           continue
summary:          Worker has 1 remaining item. Another round is fine.
risks:            0
next_attention:   Pick up: Confirm CHANGELOG entry; add e2e test for the config switch.
next_prompt_seed: Carry over the remaining items from the previous round's worker report.
```

The status came from the deterministic rules (`continue` because the report has remaining items, no failed tests, no blocker). An LLM is not in the loop for this dogfood (the smoke asserts a hostile LLM cannot flip the deterministic status).

## Why this verdict, in plain English

- The Pre-PR-Gate was advisory `ready_with_risks` (no open Cairn blockers, but no positive evidence either — there's no Cairn DB context for an external repo).
- The fixture report claimed completion of one item but flagged one **remaining** item. Rule: "report has remaining → `continue`".
- The git evidence showed a clean tree (`dirty=false`, 0 changed files, 0 tests run). If the report had instead claimed *fully done* with no diff and no tests, the verdict would have been `needs_evidence` (smoke asserts this case too).

## How the next round picks up

Two outputs feed the next loop:

1. **`next_prompt_seed`** — short text the user can paste into a new prompt-pack call: *"Carry over the remaining items from the previous round's worker report."*
2. **The persisted iteration row** — `~/.cairn/project-iterations/p_dogfood_agp.jsonl` carries `worker_report_id`, `evidence_summary`, `review_status`, `next_attention[]`. A future round can read this with `latestIteration(projectId)` and quote the carry-over items verbatim in the new prompt.

## Reproducing this dogfood

```bash
# clone the target (one-time, anywhere on disk)
mkdir -p D:/lll/managed-projects && cd D:/lll/managed-projects
git clone https://github.com/anzy-renlab-ai/agent-game-platform.git

# from the cairn repo root
node packages/desktop-shell/scripts/dogfood-managed-project-loop.mjs
```

The dogfood runs sandboxed by default — it sets HOME to a tmpdir, so the real `~/.cairn` is never touched. Pass `--use-real-home` to write into your actual managed-projects state.

## Files added in this round

| Path | Purpose |
|---|---|
| `packages/desktop-shell/managed-project.cjs` | Profile detection + register flow + clone helper |
| `packages/desktop-shell/project-iterations.cjs` | JSONL iteration records (start / patch / fold) |
| `packages/desktop-shell/project-evidence.cjs` | Read-only git evidence with argv whitelist |
| `packages/desktop-shell/managed-loop-review.cjs` | Deterministic verdict + LLM polish |
| `packages/desktop-shell/managed-loop-prompt.cjs` | Adapter that injects managed context into the prompt pack |
| `packages/desktop-shell/scripts/smoke-managed-project-profile.mjs` | 29 assertions |
| `packages/desktop-shell/scripts/smoke-project-iterations.mjs` | 21 assertions |
| `packages/desktop-shell/scripts/smoke-project-evidence.mjs` | 30 assertions |
| `packages/desktop-shell/scripts/smoke-managed-loop-review.mjs` | 20 assertions |
| `packages/desktop-shell/scripts/smoke-managed-loop-prompt.mjs` | 16 assertions |
| `packages/desktop-shell/scripts/dogfood-managed-project-loop.mjs` | 21 assertions; live against agent-game-platform |
| `docs/superpowers/demos/managed-project-loop-agent-game-platform.md` | This doc |

No new npm dependency. No new SQLite migration. No new MCP tool. UI surface (panel.js) was deliberately not modified in this round — the loop runs end-to-end through the dogfood script. Wiring the panel to the new loop is a follow-up.

## Open questions / unfinished

- **Panel UI not yet wired.** The "Managed Loop" card in Project detail (Start / Generate prompt / Attach report / Collect evidence / Review) is described in the plan but not implemented. All capability lives in the cjs modules; only IPC + DOM wiring is missing. Doable in a follow-up round without schema changes.
- **`allow_run_tests` is wired but unused in the demo.** The collector accepts the flag and runs the first detected test command via `spawnSync(..., { shell: true })`. The dogfood passes `false`. Enabling it from the panel is a deliberate user choice — not the default.
- **No automatic worker dispatch.** The user must paste the prompt into Claude Code / Codex by hand. This is the explicit product boundary; the dogfood does not propose changing it.
- **Profile re-detect is a write.** Every `registerManagedProject` call re-detects and overwrites the JSON file. For very active loops this is fine (writes are tiny + atomic). If iteration history of profiles becomes interesting later, switch the file to JSONL like iterations.
