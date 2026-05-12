# Multi-Agent Mentor → Conflict-Capable Demo (real Claude Code workers)

**Date:** 2026-05-12
**Plan:** [`docs/superpowers/plans/2026-05-12-multi-agent-mentor-conflict-demo.md`](../plans/2026-05-12-multi-agent-mentor-conflict-demo.md)
**Driver:** `packages/desktop-shell/scripts/dogfood-multi-agent-mentor-demo.mjs`
**Cross-engine validator:** `packages/desktop-shell/scripts/dogfood-multi-agent-mentor-validate.mjs`
**Target:** `D:/lll/managed-projects/agent-game-platform` ([`anzy-renlab-ai/agent-game-platform`](https://github.com/anzy-renlab-ai/agent-game-platform))
**Pre-flight HEAD:** `de6875c3a2b0faea20d581a43e5754e406432ab2` (unchanged post-flight)
**Result:** 36/36 demo assertions PASS, 3/3 FEATURE-VALIDATION gates hard-match.

---

## What this demonstrates

Two real `claude` workers, in two separate `git worktree` checkouts of the same project, did real engineering work in parallel. Cairn — the **kernel** underneath them — kept track of both as distinct sessions, captured each worker's output to scratchpad, and surfaced a cross-agent file conflict to the legacy Inspector for a user-driven resolve. The target repo's `main` was never touched.

This is the demo the plan §1 asked for. Per plan §6 the audience is internal team/partner alignment; not for marketing.

| Capability | Evidence |
|---|---|
| Cairn sees two agents | `processes` table grew 2 rows, capabilities tagged `cwd:<worktree>` / `role:demo-mentor-worker` — verified by all three FEATURE-VALIDATION gates returning `demo_processes_count: 2`. |
| Each agent has durable state | 2 `tasks` rows created, both reachable via `cairn.task.resume_packet` after the run; each packet's `scratchpad_keys` correctly references its own agent's `subagent/{id}/result` entry. |
| Pre-commit hook surfaces overlap | Mechanism smoke seeded an OPEN conflict on `tests/engine/COVERAGE_AUDIT_A.md`; worker A's amend-commit triggered the hook, which wrote a `PENDING_REVIEW` row matching both agent IDs. Hook stderr captured below. |
| Read-only invariant holds | `agent-game-platform` `main` HEAD identical pre/post; commits live only on `demo/multi-agent-mentor-2026-05-12-{a,b}` branches inside the worktrees. |
| Workers never leak credentials | 8 secret-leak regex sweeps on both tails — all clean (ANTHROPIC_API_KEY / OpenAI sk- / GitHub PAT / Bearer). |

---

## The two agents and what they actually produced

Both prompts were built deterministically from `buildPrompt(role, taskId)` in the driver — no Mentor LLM call this round (Mentor's recommendation is already captured as the Phase 6 finding: "`equity.ts` is the only engine module without coverage"). The two tasks are the **two arms-length follow-ups** that finding implies.

| | Worker A | Worker B |
|---|---|---|
| Cairn agent id  | `cairn-session-9dd055c6824b` | `cairn-session-4b7d84c5a2d8` |
| Cairn task id   | `01KRD96CXWKYBF03K7K79SBZ0M` | `01KRD96CY2Z8EC5QPNN320E0WC` |
| Run id          | `wr_ebe07b9b3cce` | `wr_83a792835e47` |
| Branch          | `demo/multi-agent-mentor-2026-05-12-a` | `demo/multi-agent-mentor-2026-05-12-b` |
| Worktree        | `agent-game-platform/.cairn-demo-worktrees/agent-a` | `agent-game-platform/.cairn-demo-worktrees/agent-b` |
| Goal            | Audit `src/lib/engine/*.ts` test coverage, write a markdown proposal | Add unit tests for `src/lib/engine/equity.ts` |
| Output file     | `tests/engine/COVERAGE_AUDIT_A.md` (28 lines) | `tests/engine/equity.test.ts` (61 lines, 3 vitest cases) |
| Commit          | `563e340 demo(A): engine coverage audit` | `530799f demo(B): add equity.test.ts skeleton` |
| Wall time       | ~50s | ~98s |

### Worker A's output (excerpt)

```markdown
# Engine Test Coverage Audit (demo)

5 of 6 engine modules in `src/lib/engine/` have a paired `*.test.ts` file under
`tests/engine/`. One module — `equity.ts` — is currently untested.

| Engine module    | Test file               |
| ---------------- | ----------------------- |
| betting.ts       | betting.test.ts         |
| cards.ts         | cards.test.ts           |
| deck.ts          | deck.test.ts            |
| equity.ts        | (missing)               |
| evaluator.ts     | evaluator.test.ts       |
| orchestrator.ts  | orchestrator.test.ts    |
```

(Followed by two concrete suggestions for the highest-value missing test.) Worker A independently re-discovered the Phase 6 finding without being told the answer — useful evidence that a fresh worker arriving at this codebase will, in fact, see the same coverage gap.

### Worker B's output (excerpt)

```typescript
import { test, expect, describe } from "bun:test";
import { equity, isNuts, type Contestant } from "../../src/lib/engine/equity";
import { parseCard, type Card } from "../../src/lib/engine/cards";

describe("equity", () => {
  test("single contestant trivially wins 100%", () => {
    const contestants: Contestant[] = [{ seatIdx: 0, hole: hand("As", "Ks") }];
    const result = equity(contestants, [], [], 10);
    expect(result.get(0)).toBe(100);
  });
  // …two more cases: full-board deterministic showdown + sum-to-100 sanity…
});
```

The file imports the real `equity` / `isNuts` exports and uses `parseCard` to construct hands — Worker B read both `src/lib/engine/equity.ts` and `tests/engine/cards.test.ts` (its declared "style guide") to match the project's test idiom.

---

## How Cairn surfaced the conflict (mechanism smoke)

Plan §1 step 6 said "Cairn's pre-commit hook fires on staged-path overlap." That is the visible behavior, but the hook's actual logic is narrower: it surfaces overlap of staged paths against **existing OPEN** `conflicts` rows. The hook does not autonomously detect inter-agent overlap in real time — it requires someone (a higher-level coordinator, or a prior detection pass) to have written an OPEN row first.

The demo's mechanism-smoke segment exercises this contract honestly:

1. After both workers finished, the driver seeded one OPEN conflict row scoped to `tests/engine/COVERAGE_AUDIT_A.md` (the file worker A had just committed), with `agent_a = <A's id>` and `agent_b = <B's id>`.
2. The driver then made a no-op edit to that file inside worker A's worktree, staged it, and committed.
3. The pre-commit hook (`cairn-precommit-check.mjs`) ran on the staged path, found the OPEN row, and inserted a new `PENDING_REVIEW` row.

The hook's stderr from this segment (captured by the driver):

```
cairn: ⚠️  Cairn 检测到这些路径最近有冲突记录，请 review 后再 commit
  • tests/engine/COVERAGE_AUDIT_A.md  [FILE_OVERLAP, 0m ago,
    agents: cairn-session-9dd055c6824b ↔ cairn-session-4b7d84c5a2d8 —
    [demo 2026-05-12] simulated overlap between worker A and B on
    tests/engine/COVERAGE_AUDIT_A.md]
  Run `cairn conflict list` to see full history.
```

Post-segment `conflicts` table state (verified by Gate 3):
- `total conflicts: 2`
- `PENDING_REVIEW: 1` ← inserted by the hook
- our `OPEN` seed: 1

The driver intentionally does **not** auto-resolve. To finish the live demo, run:

```powershell
$env:CAIRN_DESKTOP_ENABLE_MUTATIONS = "1"
cd D:\lll\cairn\packages\desktop-shell
npm run inspector
# In the legacy Inspector UI: find the PENDING_REVIEW row → click Resolve.
# Expected: status transitions to RESOLVED.
```

> The plan §1 wording ("hook fires on overlap") was tightened in this doc to match the actual code path. A separate Later-scoped feature could add an autonomous inter-agent overlap detector that writes the OPEN row pre-emptively; that's out of this demo's MVP scope (PRODUCT.md v3 §12 D10).

---

## FEATURE-VALIDATION 1+2+3 (cross-engine hard-match)

Per `docs/workflow/FEATURE-VALIDATION.md`. All three gates answered the same question:

> *How many `processes` rows have `role:demo-mentor-worker`? How many `conflicts` are `PENDING_REVIEW`? What `scratchpad` keys match `subagent/%/result`?*

Three independent answers:

| Gate | Engine | Result |
|---|---|---|
| **Gate 1** | `claude --model haiku -p` (single-shot, Node-spawned via cmd.exe `claude.cmd`) | `{ demo_processes_count: 2, conflicts_count_pending_review: 1, scratchpad_subagent_keys_sorted: ["subagent/cairn-session-4b7d84c5a2d8/result", "subagent/cairn-session-9dd055c6824b/result"] }` |
| **Gate 2** | `Agent(general-purpose)` subagent, fresh context, instructed to read the DB directly via better-sqlite3 | Identical to Gate 1. |
| **Gate 3** | Real run: Node + daemon storage handle (`packages/daemon/dist/storage/db.js`), three `prepare(...).get()/all()` calls. | Identical to Gates 1 & 2. |

Hard match output:

```
=== Hard match ===
  ok   Gate1 (haiku)    == Gate3 (real)
  ok   Gate2 (2nd-eng)  == Gate3 (real)
  ok   Gate1 (haiku)    == Gate2 (2nd-eng)
```

> Note: the validator on this Windows host had to be taught two Windows-specific quirks before Gate 1 ran clean: (a) `where claude` returns the bash-sh wrapper first, which Node's `spawnSync` can't execute — prefer `.cmd`; (b) `.cmd` shims must be invoked via `cmd.exe /d /s /c`, matching `worker-launcher.cjs:694`. These are documented in `dogfood-multi-agent-mentor-validate.mjs:whichClaude` for future probes.

---

## Acceptance gates (plan §3)

| Gate | Required | Observed |
|---|---|---|
| **Hard floor** — 2 processes rows | ✅ | 2 rows tagged `role:demo-mentor-worker`, capabilities include `cwd:<worktree>` |
| **Hard floor** — legacy Inspector renders conflict row IF present | ✅ | 1 `PENDING_REVIEW` row written by hook, queryable via desktop-shell `conflicts` view |
| **Hard floor** — user can manually click Resolve (transition to RESOLVED) | NOT EXECUTED in this driver run | Resolve is user-driven; smoke that the IPC works is `smoke-conflict-surface.mjs`. Live recording will exercise this step. |
| **Middle gate** — both agents recoverable via `cairn.task.resume_packet` | ✅ | Both packets return non-null, `task_id` matches, `scratchpad_keys` references correct agent_id |
| **High gate** — Mode B auto-redispatches new worker after RESOLVED | SKIPPED (out of scope per plan §3) | — |

---

## What was explicitly *not* done

Asserted by the driver (post-flight):
- `agent-game-platform` main HEAD unchanged: `de6875c3` before and after.
- No `git push` to any remote on `agent-game-platform` (driver never invokes `git push`).
- No write under `D:/lll/cairn/` from the workers — workers' `cwd` was a per-agent worktree of `agent-game-platform`, far from Cairn's checkout.

Held by construction (worker prompt rules):
- Worker A only edited `tests/engine/COVERAGE_AUDIT_A.md`.
- Worker B only created `tests/engine/equity.test.ts`.
- No `git push` / `git fetch` / `npm install` / `bun install` issued by either worker (prompt forbids; tail logs confirm).
- No `--no-verify` (workers were instructed not to bypass the hook).

Not exercised:
- Mode B auto-redispatch after RESOLVED (plan §3 high gate, skipped).
- Cairn × Agent View side-by-side (plan §9, captured for a future demo).
- Reading `~/.claude/daemon/roster.json` (plan §9 lock — cross-tool neutrality).

---

## How to reproduce

```powershell
# 0. Pre-flight — target repo must be on main, clean.
cd D:\lll\managed-projects\agent-game-platform
git switch main
git status --short   # expect empty (modulo .cairn-demo-worktrees/)

# 1. Cairn must be built (daemon/dist + mcp-server/dist).
cd D:\lll\cairn\.cairn-worktrees\__lead__\packages\daemon
.\node_modules\.bin\tsc -p tsconfig.json
cd ..\mcp-server
.\node_modules\.bin\tsc -p tsconfig.json

# 2. Run the demo (~106s, burns ~$0.50 of sonnet × 2).
cd D:\lll\cairn\.cairn-worktrees\__lead__
node packages\desktop-shell\scripts\dogfood-multi-agent-mentor-demo.mjs
# Expect: 36/36 assertions PASS.

# 3. Cross-engine validation. Gate 2 needs a second engine — easiest is
#    asking a general-purpose subagent to run the equivalent SQL and
#    dump JSON to C:\Users\jushi\AppData\Local\Temp\cairn-demo-gate2.json.
node packages\desktop-shell\scripts\dogfood-multi-agent-mentor-validate.mjs --gate2-from=C:/Users/jushi/AppData/Local/Temp/cairn-demo-gate2.json
# Expect: three ok lines, all equal.

# 4. Probe-resume mode (read-only, asserts packets still readable).
node packages\desktop-shell\scripts\dogfood-multi-agent-mentor-demo.mjs --probe-resume
# Expect: 8/8 probe assertions PASS.

# 5. Live-demo follow-up — open the legacy Inspector and click Resolve.
$env:CAIRN_DESKTOP_ENABLE_MUTATIONS = "1"
cd D:\lll\cairn\packages\desktop-shell
npm run inspector
```

State left behind by a successful run:

- `~/.cairn/cairn.db` gains:
  - 2 new `processes` rows (one per worker; expire after their heartbeat TTL).
  - 2 new `tasks` rows.
  - 2 new `scratchpad` entries under `subagent/<agent_id>/result`.
  - 2 new `conflicts` rows (1 OPEN seed + 1 PENDING_REVIEW from the hook).
- `~/.cairn/worker-runs/wr_<id>/{prompt.txt,tail.log,run.json}` for both workers.
- `~/.cairn/demo-multi-agent-state.json` — driver's bookkeeping for `--probe-resume`.
- `D:/lll/managed-projects/agent-game-platform/.git/hooks/pre-commit` — installed by the driver, points at this Cairn checkout's `cairn-precommit-check.mjs`. Persists; re-run `cairn install` (or another driver invocation) to overwrite.
- Two branches in `agent-game-platform`: `demo/multi-agent-mentor-2026-05-12-{a,b}` with the workers' commits. Driver does NOT push them; the user decides whether to push as audit artifact (plan §6 round 2 decision: real commits, on a demo branch, user pushes).

---

## Cleanup (when team viewing is done)

```bash
# Remove the worktrees and demo branches.
cd D:/lll/managed-projects/agent-game-platform
git worktree remove --force .cairn-demo-worktrees/agent-a
git worktree remove --force .cairn-demo-worktrees/agent-b
git branch -D demo/multi-agent-mentor-2026-05-12-a demo/multi-agent-mentor-2026-05-12-b
rmdir .cairn-demo-worktrees

# Optional: clear the Cairn rows for this demo (does NOT touch the schema).
node -e "
  const D = require('D:/lll/cairn/packages/daemon/node_modules/better-sqlite3');
  const db = new D(require('os').homedir() + '/.cairn/cairn.db');
  db.prepare(\"DELETE FROM scratchpad WHERE key LIKE 'subagent/cairn-session-%/result'\").run();
  db.prepare(\"DELETE FROM conflicts WHERE summary LIKE '%[demo 2026-05-12]%'\").run();
  db.prepare(\"DELETE FROM conflicts WHERE summary LIKE '%[demo %] simulated overlap%'\").run();
  db.prepare(\"DELETE FROM tasks WHERE intent LIKE '[demo 2026-05-12 %]%'\").run();
  db.prepare(\"DELETE FROM processes WHERE capabilities LIKE '%role:demo-mentor-worker%'\").run();
  db.close();
"
```
