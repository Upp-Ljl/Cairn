# Phase 6 — Agent Poker Arena Full Demo (real Claude Code worker)

**Date:** 2026-05-12
**Target:** https://github.com/anzy-renlab-ai/agent-game-platform.git (`arean.renlab.ai`)
**Local checkout:** `D:/lll/managed-projects/agent-game-platform`
**Driver:** `packages/desktop-shell/scripts/dogfood-real-claude-managed-loop.mjs`
**Result:** 22/22 assertions PASS. One full Cairn-managed round with a REAL Claude Code worker that ran against the live repo, reported back, was reviewed, and seeded the next round — without mutating the target repo.

This is the end-to-end demo the Phase 6 task in `docs/workflow/ROADMAP.md` asked for. Unlike the earlier `2026-05-09` dogfood (fixture worker report), this round invoked a real Claude Code process and got a real, useful finding back.

---

## What Cairn did

Cairn behaved as the **project control surface**, not a coding agent. The lifecycle drove by `managed-loop-handlers.cjs` IPC handlers (the same surface the panel's "Managed Loop" card calls):

| Step | Handler | Result |
|---|---|---|
| 1 | `detectWorkerProviders` | claude-code available |
| 2 | `registerManagedProject` + `startManagedIteration` + `generateManagedWorkerPrompt` | iteration started; prompt 3935 chars (1251 project rules + 2684 prompt pack) |
| 3 | `launchManagedWorker(provider=claude-code, prompt=...)` | spawned real `claude` CLI in `D:/lll/managed-projects/agent-game-platform` |
| 4 | poll `getWorkerRun` until terminal | finished in <4 min, status `exited` |
| 5 | `tailWorkerRun` | tail log non-empty; secret-leak guards confirmed (no ANTHROPIC_API_KEY / sk- / Bearer in tail) |
| 6 | `extractManagedWorkerReport` | structured Worker Report parsed from worker stdout |
| 7 | `collectManagedEvidence` + `reviewManagedIteration` | deterministic verdict; next-round prompt seed produced |
| 8 | iteration persisted | `worker_run_id=wr_14a833e1eb94`, `worker_report_id=r_73e304db0f16`, `review_status=continue` |

## What the real worker found

The worker prompt was deliberately read-only (no commits, no installs). It got this:

```
GOAL:    audit Agent Poker Arena test coverage
DONE:
  - Listed 20 test files under `tests/` (api, engine, housebot, protocol);
    opened only `tests/engine/cards.test.ts` to verify quality.
  - Cross-checked `src/lib/engine/*.ts` against `tests/engine/*.test.ts`:
    every engine module has a matching test EXCEPT `src/lib/engine/equity.ts`.
REMAINING:
  - Audit assertion density of remaining 19 test files (api/, protocol/,
    housebot/) without opening more than 2 per round.
BLOCKERS: (none)
NEXT:
  - Add `tests/engine/equity.test.ts` covering `src/lib/engine/equity.ts` —
    it is the only engine module without coverage.
```

**This is a real, actionable finding.** `equity.ts` is the only engine module without a paired test file — a genuine coverage gap a human reviewer would also flag.

## What Cairn's review verdict said

```
status:           continue
summary:          Worker has 1 remaining item. Another round is fine.
risks:            0
next_attention:   Pick up: Audit assertion density of remaining 19 test
                  files (api/, protocol/, housebot/) without opening more
                  than 2 per round.
next_prompt_seed: Carry over the remaining items from the previous round's
                  worker report.
```

Deterministic rule: report has `remaining` ≥ 1 → verdict = `continue`. No LLM in the verdict (a hostile LLM cannot flip the deterministic status — smoke asserts this elsewhere).

## What Cairn explicitly did NOT do

Verified post-flight:

- `agent-game-platform` HEAD unchanged: `de6875c3a2b0faea20d581a43e5754e406432ab2` before and after
- `agent-game-platform` working tree unchanged: 0 dirty files post-run
- Real `~/.cairn/cairn.db` mtime unchanged (writes were sandboxed to a tmpdir)
- No `git push` / `git commit` / `git fetch` against the target repo
- No `npm install` / `bun install` / `pip install` against the target repo
- No mutation of `~/.claude` or `~/.codex`

## Worker contract honored

The prompt baked in:
- "read-only round (no file mutations)"
- "no git commit / push"
- "no installs"
- "must emit a `## Worker Report` block at the end"

The worker honored all four. The `extractManagedWorkerReport` handler parsed the structured block out of the tail log. Cairn never had to read the worker's raw stdout — it consumed the structured fields only.

## Why this matters for production maturity

The four claims `docs/workflow/ROADMAP.md` makes about Phase 6 are now all true:

- ✅ Real, non-fixture Claude Code round on the live testbed
- ✅ The full IPC surface (panel buttons → managed-loop-handlers → cairn-managed iteration) runs end-to-end
- ✅ Cairn's read-only product boundary holds under a real worker (no mutation observed)
- ✅ Output is reviewable: structured report + deterministic verdict + carry-over seed; not a chat transcript

## Reproducing

```bash
# clone target once
mkdir -p D:/lll/managed-projects && cd D:/lll/managed-projects
git clone https://github.com/anzy-renlab-ai/agent-game-platform.git

# from any Cairn checkout (worktree or main)
node packages/desktop-shell/scripts/dogfood-real-claude-managed-loop.mjs
# expect: 22/22 assertions pass
```

Add `--use-real-home` to let the run land in your actual `~/.cairn` so the desktop panel can see the iteration on next open.

## Cost

One real Claude Code invocation, sonnet model, ~2400 input tokens (prompt) + ~1100 output tokens (worker report). Single round. The verdict logic and review pass run in Node, no LLM.

## Open items (Later-scope)

- Auto-trigger next round when verdict is `continue` (currently user picks)
- Optional `allow_run_tests: true` path so the worker actually runs `bun test` and Cairn captures it as evidence
- A Mode B Continuous Iteration version where Scout → Worker → Review chains within explicit authorization (handlers exist; needs end-to-end script parity with this managed-loop dogfood)
