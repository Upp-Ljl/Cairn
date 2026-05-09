# Managed Loop Panel Wiring — `agent-game-platform` dogfood

**Date:** 2026-05-09
**Driver:** `packages/desktop-shell/scripts/dogfood-managed-loop-panel.mjs`
**Result:** 18/18 dogfood assertions PASS · 60/60 panel-handler smoke PASS

This round wires the managed-loop modules from the previous PR into the actual desktop panel. The user can now drive the whole loop from the Project detail card — register → start iteration → generate worker prompt → copy prompt → attach report → collect evidence → review → copy next prompt seed — without leaving the panel.

---

## What changed

| File | Purpose |
|---|---|
| `packages/desktop-shell/managed-loop-handlers.cjs` | New thin coordinator over the 5 managed-loop modules. main.cjs IPC forwards here, smoke + dogfood call it directly. |
| `packages/desktop-shell/main.cjs` | +9 IPC handlers (`list-managed-projects`, `register-managed-project`, `get-managed-project-profile`, `start-managed-iteration`, `generate-managed-worker-prompt`, `attach-managed-worker-report`, `collect-managed-evidence`, `review-managed-iteration`, `list-managed-iterations`). |
| `packages/desktop-shell/preload.cjs` | +9 `window.cairn.*` bridges. |
| `packages/desktop-shell/panel.html` | New `#managed-card` between Recovery and Coordination strips. ~50 lines of CSS, ~40 lines of compact HTML. |
| `packages/desktop-shell/panel.js` | New `renderManagedCard` / `setupManagedCard`; wired into the L2 poll loop. |
| `packages/desktop-shell/scripts/smoke-managed-loop-panel.mjs` | 60 assertions: handlers + IPC channel coverage + read-only invariants. |
| `packages/desktop-shell/scripts/dogfood-managed-loop-panel.mjs` | Live end-to-end against the cloned `agent-game-platform`. |

No new schema, no new MCP tool, no new npm dep. Panel still strictly read-only against `cairn.db` (only mutation: pre-existing dev-flag `resolveConflict`).

## How the UI works (in plain English)

The Managed Loop card sits in Project detail, just below Recovery. Default state is **collapsed** with one status chip (`unmanaged` / `managed` / `no profile`) and a one-line meta (package manager · languages · default branch). Click `expand ▸` to open the body.

The body has four parts, top to bottom:

1. **Profile summary** — repo URL, detected test/build/lint commands, docs.
2. **Latest iteration line** — round id, current status, attached-report and changed-files counts.
3. **Action row (7 buttons)** — every button is user-clicked; nothing fires automatically:
   - **register** — call `registerManagedProject` (defaults `local_path` to the registry's `project_root`).
   - **start iteration** — disabled until a profile is detected.
   - **generate worker prompt** — disabled until there's an open iteration. Builds the prompt from the project's goal + rules + cached Pre-PR Gate result + recent worker reports.
   - **copy prompt** — clipboard copy.
   - **collect evidence** — read-only git probe (`rev-parse`, `status --short`, `diff --stat`, `log -1`). No `push`/`fetch`/`checkout`/`reset`/`clean`/`stash`.
   - **review iteration** — runs the deterministic verdict; persists the result on the iteration row.
   - **copy next prompt seed** — clipboard copy of the seed text.
4. **Three textareas** — worker prompt (read-only output), paste-report area (with inline `attach` link), next prompt seed (read-only).

The card fetches `getManagedProjectProfile` + `listManagedIterations(1)` once per second alongside the existing pulse / summary / coord poll, so the latest iteration line stays live without per-button refresh.

## Concrete worker handoff (what to give Claude / Codex)

After clicking **generate worker prompt** with a managed `agent-game-platform` registered:

1. The prompt textarea fills with ~2,200 characters in this exact order:
   ```
   You are a coding agent working under Cairn project rules.
   Cairn is a project control surface (read-only); it does not write
   code or dispatch you. The user is asking you to take the next round
   of work.

   # Goal
   Goal: Improve agent-game-platform — panel-driven loop
   Desired outcome: A small, verifiable improvement each round.

   # Managed project
   Repo: https://github.com/anzy-renlab-ai/agent-game-platform.git
   Local path basename: agent-game-platform
   Default branch: main
   Package manager: bun
   Languages: javascript, typescript
   Detected test commands:
     - bun run test
     - bun run test:watch
   Detected build commands:
     - bun run build
   Detected lint commands:
     - bun run lint
   Docs to skim: CLAUDE.md, DESIGN.md, TODO.md
   Cairn iteration id: i_3a11fc002c69

   # Context summary
   …
   # Project rules
   …
   # Acceptance checklist
   - Report `completed` / `remaining` / `blockers` / `next_steps` …
   - Do not push or merge unless the user explicitly authorizes.
   - Do not expand scope beyond the listed non-goals.
   - Before claiming done, run: bun run test
   - …

   # Non-goals (do NOT cross these)
   - No unauthorized push; no scope creep.
   - Cairn does not write code; you (the agent) write code.
   - …
   ```
2. The user clicks **copy prompt**, switches to Claude Code or Codex, pastes, and runs.
3. The agent works — Cairn doesn't watch. The user copies the agent's final summary back.

## Concrete report flow (what to paste back)

When the agent finishes:

1. The agent's final message follows the structure required in the prompt: `Completed:` / `Remaining:` / `Blockers:` / `Next:` sections (markdown headings or `## ` style both supported by `parseReportText`).
2. The user pastes the entire summary into the Managed Loop card's report textarea and clicks **attach**.
3. `attachManagedWorkerReport` parses it, normalizes via `worker-reports.normalizeReport`, appends to `~/.cairn/project-reports/<projectId>.jsonl`, and links the report id to the latest open iteration.
4. The card's iteration line updates to show `report attached`.

Free-form paste is fine; the parser is robust to malformed input and just stores whatever it can extract. The first line becomes the title if no `# Heading` is provided.

## Evidence + review — how Cairn judges the round

After the report is attached:

1. **collect evidence** runs the read-only git probes and shows a compact line:
   ```
   branch main · HEAD de6875c3a2b0 · dirty: false · changed: 0 ·
   last: feat(sound): drama-tag fanfares per tone
   ```
   The full evidence (with `diff --stat`, errors, etc.) is also attached to the iteration as a summary; the panel only displays the headline.
2. **review iteration** combines: the iteration record + the worker report + the evidence summary + (optional) the cached Pre-PR Gate result + the project's goal + rules. The deterministic verdict is one of `continue` / `ready_for_review` / `blocked` / `needs_evidence` / `unknown`.
3. The card shows the verdict status chip (color-coded), the summary line, up to 5 next-attention bullets, and the `next_prompt_seed`.

For this dogfood (fixture report says one item complete, one remaining; clean tree; tests not run):
- Status: **continue**
- Summary: *Worker has 1 remaining item. Another round is fine.*
- Next attention: *Pick up: Confirm CHANGELOG entry; add e2e test for the config switch.*
- Next prompt seed: *Carry over the remaining items from the previous round's worker report.*

Click **copy next prompt seed**, paste into the report area for the next round's prompt context, and the loop continues.

## What Cairn explicitly does **not** do (still)

- **No auto-launch.** Every action is user-triggered. The "generate prompt" button produces text; nothing is sent.
- **No mutation of the managed repo.** Whitelisted `git` argv only. Push / fetch / checkout / reset / clean / stash / rebase are rejected before `spawnSync`.
- **No installs / no test execution by default.** `allow_run_tests` is wired but the panel never sets it; `bun run test` would only run if a future control surface explicitly toggles it on.
- **No writes to `cairn.db` / `~/.claude` / `~/.codex`.** Smoke asserts existence-stability; the only writes are to `~/.cairn/managed-projects/`, `~/.cairn/project-iterations/`, and `~/.cairn/project-reports/`, which were explicitly authorized.
- **Status verdict cannot be flipped by an LLM.** Even with `forceDeterministic: false` (not used by this panel today), the underlying review module discards LLM output that tries to change `status` or smuggle `auto-dispatch` / `push without authorization` items.

## Tests / smokes / dogfood run

```
node packages/desktop-shell/scripts/smoke-managed-loop-panel.mjs        60/60 PASS
node packages/desktop-shell/scripts/dogfood-managed-loop-panel.mjs      18/18 PASS
node packages/desktop-shell/scripts/smoke-managed-project-profile.mjs   29/29 PASS
node packages/desktop-shell/scripts/smoke-project-iterations.mjs        21/21 PASS
node packages/desktop-shell/scripts/smoke-project-evidence.mjs          30/30 PASS
node packages/desktop-shell/scripts/smoke-managed-loop-review.mjs       20/20 PASS
node packages/desktop-shell/scripts/smoke-managed-loop-prompt.mjs       16/16 PASS
node packages/desktop-shell/scripts/smoke-worker-reports.mjs            58/58 PASS
node packages/desktop-shell/scripts/smoke-pre-pr-gate.mjs               65/65 PASS
node packages/desktop-shell/scripts/smoke-goal-loop-prompt-pack.mjs     95/95 PASS
node packages/desktop-shell/scripts/smoke-electron-boot.mjs             PASS
```

## What's still missing before "user-authorized auto-launch worker"

The loop is now driveable from the panel for someone willing to copy/paste between Cairn and Claude Code / Codex. To take the next step (a single click that actually launches the worker), Cairn would need:

1. **A worker adapter contract.** Something like `launchClaudeCodeWith({ cwd, prompt })` that knows how to invoke Claude Code or Codex CLI with the right argv + env, and returns a session id. The desktop-shell would expose it as a guarded IPC channel; the panel would gate it behind a one-time-per-session "I authorize Cairn to launch workers" toggle. No such adapter exists yet.
2. **A way to bind the worker's session id back to the iteration.** Today's iteration record has a `worker_prompt_id` (Cairn-issued opaque) and `worker_report_id` (the user attaches). For auto-launch the iteration would need a `worker_session_id` field too, and the worker's stdout/stderr would need to be tailed into a cap-bounded log file so the user can watch.
3. **A worker shutdown contract.** Cairn would need to know when "this round" ends — either a marker the worker prints, a timeout, or an explicit user click. Without one, "review" can't fire automatically.
4. **An authorization scope.** Per-project? Per-session? Always-allow? The default must be off; the policy needs deciding before the toggle is even drawn in the UI.

Today's product boundary (PRODUCT.md §1.3 #4 / §7) is "user pastes prompt, Cairn doesn't launch." Crossing that boundary is a real product decision, not a wiring task. The panel as it ships today gives the user the *full pasting workflow* in one card, which is the natural staging ground: once the user has copied/pasted the loop a few times themselves, the auto-launch toggle becomes a one-keypress optimization rather than a leap of trust.
