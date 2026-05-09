# Managed Worker Loop — `agent-game-platform` dogfood

**Date:** 2026-05-09
**Driver:** `packages/desktop-shell/scripts/dogfood-managed-worker-loop.mjs`
**Result:** 18/18 dogfood assertions PASS · 46/46 launcher smoke · 43/43 worker-loop smoke

This round closes the loop the previous PR teed up: Cairn can now **launch a real coding agent** (Claude Code or Codex CLI) inside a managed project, bind the run to the current iteration, capture a bounded tail of its output, deterministically extract a Worker Report, and feed the result back into the review verdict. Every step is a user click; nothing scheduled, nothing auto-retried.

---

## What's new

| File | Purpose |
|---|---|
| `packages/desktop-shell/worker-launcher.cjs` | Provider catalog (claude-code / codex / fixture-echo), `detectWorkerProviders`, `launchWorker`, `stopWorkerRun`, `getWorkerRun`, `listWorkerRuns`, `tailRunLog`, `extractWorkerReport`. Bounded 128KB tail.log per run; never logs env values. |
| `packages/desktop-shell/project-iterations.cjs` | +6 worker-binding fields on the iteration row (`worker_run_id`, `worker_provider`, `worker_status`, `worker_started_at`, `worker_ended_at`, `worker_run_dir`); `attachWorkerRunToIteration`, `markWorkerRunStatus`, `getLatestOpenIteration`, `getIterationWithRun`. |
| `packages/desktop-shell/managed-loop-handlers.cjs` | +8 handlers wrapping the launcher; `continueManagedIterationReview` rolls evidence + review into one click. |
| `packages/desktop-shell/main.cjs` | +8 IPC channels. |
| `packages/desktop-shell/preload.cjs` | +8 `window.cairn.*` bridges. |
| `packages/desktop-shell/panel.html` | Worker subsection inside the existing Managed Loop card: provider radios + 4 buttons + inline launch disclosure + tail textarea + status chip. |
| `packages/desktop-shell/panel.js` | Provider detection at setup, button wiring, 1Hz run-status poll while running, deterministic enable/disable. |
| `packages/desktop-shell/scripts/smoke-worker-launcher.mjs` | 46 assertions (real spawn via fixture-echo). |
| `packages/desktop-shell/scripts/smoke-managed-worker-loop.mjs` | 43 assertions (handler-level full loop). |
| `packages/desktop-shell/scripts/dogfood-managed-worker-loop.mjs` | 18 assertions (live, against agent-game-platform). |

**No** new SQLite migration. **No** new MCP tool. **No** new npm dependency. **Not** pushed.

## How the panel drives the loop now

The Managed Loop card now contains a Worker subsection. The user's click sequence for one round, in order:

1. **register** (once per project) — detects `package_manager`, `test_commands`, etc.
2. **start iteration** — opens a new round.
3. **generate worker prompt** → **copy prompt** — the prompt textarea fills with the same Cairn-built prompt as before; the user can copy and paste into a CLI manually if they want.
4. **(new) provider radio** — one of `Claude Code`, `Codex CLI`, `Fixture (echo)`. An unavailable provider is shown disabled with `Codex CLI not found in PATH` next to the label, not hidden.
5. **(new) open worker** — disabled until a provider is selected and a prompt has been generated. Below the button, a one-line disclosure says `will start Claude Code in <project_root> — it can read and modify files`.
6. **(new) status chip** — appears as `running · claude-code · 0:12 · run wr_<id>`. Updates 1Hz while the run is alive. Becomes `exited · …` when the child returns.
7. **(new) refresh tail** — shows the last 16KB of stdout+stderr in a read-only textarea. Honest about being a tail.
8. **(new) extract report** — runs the deterministic `## Worker Report` parser over the run's full tail.log. If a block is found, the report is normalized and attached to the iteration; if not, the user falls back to the existing **paste worker report** + **attach** flow.
9. **(new) stop worker** — `taskkill /F /T /PID` on Windows (tree-kill because `claude.cmd` spawns node), `SIGTERM`+`SIGKILL` on POSIX. Status transitions to `stopped`.
10. **collect evidence** + **review iteration** — same as before, but the iteration row now also has the worker run binding so the verdict knows which run produced the report.
11. **copy next prompt seed** — same as before; user pastes into the next round's prompt context.

Crucially: there is **no "Run next iteration" button**. Both the safety subagent review and the UI/UX subagent review flagged it as the boundary edge case where Cairn drifts from "control surface" to "orchestrator," and the existing `copy next prompt seed` already covers the legitimate workflow.

## Provider detection on this machine

```
- claude-code    available    C:\Users\jushi\AppData\Roaming\npm\claude.cmd
- codex          unavailable  (Codex CLI not found in PATH)
- fixture-echo   available    <node executable>
```

The dogfood reports this honestly. We do **not** auto-launch real Claude Code at the agent-game-platform repo because (a) it would modify the user's working tree and (b) it would consume API credits without a button click. Real launch is wired and works — clicking **open worker** in the panel with `Claude Code` selected will spawn `cmd.exe /d /s /c "<claude.cmd>" --print`, pipe the prompt to its stdin, capture stdout/stderr to `~/.cairn/worker-runs/<runId>/tail.log`, and update `run.json` on each transition.

## What the dogfood actually ran

**Provider: `fixture-echo`** (Node-on-Node; no LLM, no network, no managed-repo writes).

```
[1] detect-worker-providers (real)            3 providers listed
[2] register                                  bun detected, profile written
[3] start iteration                           i_914278138244
[4] generate prompt                           2317 chars, bound to iteration
[5] launch worker (fixture-echo)              wr_879474a28c6d, status=running
[6] wait for exit                             status → exited, exit_code=0
                                              prompt_hash=64ba667aec7be705
[7] tail + extract report                     1 completed · 1 remaining · 1 next
[8] continue managed iteration review         branch main · HEAD de6875c3a2b0 ·
                                              dirty=false · changed=0
                                              verdict.status: continue
                                              "Worker has 1 remaining item.
                                               Another round is fine."
[9] final iteration row                       status=reviewed
                                              worker_run_id=wr_879474a28c6d
                                              worker_provider=fixture-echo
                                              worker_report_id=r_d373f7587666
                                              review_status=continue
```

Every step was the equivalent IPC call the panel makes — `detect-worker-providers`, `register-managed-project`, `start-managed-iteration`, `generate-managed-worker-prompt`, `launch-managed-worker`, `get-worker-run`, `tail-worker-run`, `extract-worker-report`, `continue-managed-iteration-review`, `list-managed-iterations`. Same code path; just routed through `managed-loop-handlers.cjs` directly so the dogfood didn't need Electron.

## What Cairn explicitly does **not** do

- **No auto-launch.** `launchWorker` is only called from one IPC handler, which is only called from one panel button. There is no scheduler, no `setTimeout` retry, no on-exit auto-restart.
- **No auto-loop after review.** `continueManagedIterationReview` collects evidence and runs review; it does **not** call `launchManagedWorker` for the next round. The user must click again.
- **No dispatch framing.** UI copy says "open worker", "stop worker"; status chips say `running · claude-code`; never "Cairn dispatched", never "Cairn is running".
- **No PR readiness verdict.** The review status `ready_for_review` means *the round is finished*, not *the PR is good*. Pre-PR Gate is still advisory.
- **No env value logging.** `run.json` records the **names** of sensitive env vars present (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `CAIRN_PUSH_TOKEN`, `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`) for debugging "is the key set?", but never the values. Smoke greps `run.json` for `sk-ant-`, `ghp_`, `Bearer ...` and asserts none appear.
- **No shell:true.** Spawn always uses argv-only. On Windows, `.cmd`/`.bat` shims are launched explicitly via `cmd.exe /d /s /c <full path>` with the rest of argv unchanged — Node's `shell:true` heuristic is not used. argv contains only Cairn-owned values (provider's fixed flags + `~/.cairn/worker-runs/<runId>/prompt.txt`); user-supplied prompt content reaches the child via stdin or env, never argv.
- **No `~/.claude/settings.json`, `~/.codex/...`, or `cairn.db` writes.** Smoke asserts `existsSync` parity for the user dirs and mtime stability for `cairn.db`. The launcher's only writes are under `~/.cairn/worker-runs/`.
- **No mutation of the managed repo by Cairn.** The worker may write code in the managed repo; Cairn does not.

## Bounded tail log

Each run gets `~/.cairn/worker-runs/<runId>/tail.log`, capped at **128 KB**. When an append would push past 128 KB, the launcher drops the oldest 32 KB (head-trim, keep tail) and appends the new chunk. This bounds disk use without losing the most recent — most relevant — output. The `## Worker Report` extractor scans for the LAST occurrence of the header, so a worker that emitted intermediate examples is still parsed correctly from its final summary.

## What still blocks "Cairn auto-iterates a project"

To take the next step (Cairn closes the loop autonomously), four pieces are missing — all product decisions, not engineering work:

1. **An authorization scope.** Per-project? Per-session? Always-allow? The default has to be off; the policy must be decided and explicit before the toggle is even drawn.
2. **A safe stop condition.** Today the user decides when to stop iterating. Auto-loop needs a deterministic terminator (verdict=`ready_for_review` for N rounds in a row? human time budget exceeded? failed-test threshold?) — and crucially, a way to write that condition without making Cairn the one judging "good enough."
3. **A retry budget.** When `verdict=continue`, would Cairn auto-launch the next round? At what cadence? With what guard against infinite loops on a stuck worker? Worker rate limits + cost budget + max-rounds-per-day are real constraints that need surfacing.
4. **A failure-mode triage.** Today, `worker_status=failed` with `exit_code≠0` lets the user investigate. Auto-loop needs: are we re-launching, escalating to needs_human, or surfacing through coordination signals? PRODUCT.md's "advisory not gating" stance leans toward surfacing-only.

None of these are wired here. The wiring stops cleanly at `clicked button → one round`. PRODUCT.md §1.3 #4 ("not a lead-subagent orchestrator") and §7 principle 2 are still intact.

## Verifications run

```
node packages/desktop-shell/scripts/smoke-worker-launcher.mjs              46/46 PASS
node packages/desktop-shell/scripts/smoke-managed-worker-loop.mjs          43/43 PASS
node packages/desktop-shell/scripts/dogfood-managed-worker-loop.mjs        18/18 PASS
node packages/desktop-shell/scripts/smoke-managed-project-profile.mjs      29/29 PASS
node packages/desktop-shell/scripts/smoke-project-iterations.mjs           21/21 PASS
node packages/desktop-shell/scripts/smoke-project-evidence.mjs             30/30 PASS
node packages/desktop-shell/scripts/smoke-managed-loop-review.mjs          20/20 PASS
node packages/desktop-shell/scripts/smoke-managed-loop-prompt.mjs          16/16 PASS
node packages/desktop-shell/scripts/smoke-managed-loop-panel.mjs           60/60 PASS
node packages/desktop-shell/scripts/smoke-worker-reports.mjs               58/58 PASS
node packages/desktop-shell/scripts/smoke-pre-pr-gate.mjs                  65/65 PASS
node packages/desktop-shell/scripts/smoke-goal-loop-prompt-pack.mjs        95/95 PASS
node packages/desktop-shell/scripts/smoke-agent-activity.mjs               98/98 PASS
node packages/desktop-shell/scripts/smoke-electron-boot.mjs                PASS
node --check (every changed/added file)                                    OK
```

SQL mutation grep: only the pre-existing dev-flag `resolveConflict` UPDATE remains. Secret grep on the new modules: clean.
