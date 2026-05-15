# Mode A Harness Upgrade — From Prompt Relay to Execution Harness

> DUCKPLAN four-section format per `docs/workflow/HOWTO-PLAN-PR.md`
> Date: 2026-05-15
> Status: DRAFT (pending CEO review)
> Scope: `packages/desktop-shell/` (Mode A execution path) + `packages/mcp-server/` (tool ACL layer)

---

## 0. Problem Statement

Current Mode A is a **prompt relay**: Scout drafts plan -> each step generates a boot prompt -> `claude-stream-launcher.cjs` spawns CC with `bypassPermissions` -> Cairn waits for outcome PASS/FAIL -> advance. During CC execution, Cairn has near-zero governance:

- No budget enforcement (tokens, duration, tool calls)
- No tool permission scoping (full `bypassPermissions`)
- No mid-execution observation (stream events collected but not analyzed)
- No structured review step (outcome DSL checks files exist, not execution quality)
- No model routing (always spawns same CC)

The CEO's reference doc establishes the **Agent/Harness separation principle**: "Agent is responsible for intelligence, Harness is responsible for control." Cairn's kernel already has the primitives; Mode A just doesn't use them as a Harness should.

### Composition Mandate Check (3 questions per module below)

Every module answers:
1. Which existing primitive carries this?
2. If none, why not?
3. Is the new primitive orthogonal to existing ones?

---

## 1. Plan

Eight modules, prioritized P0/P1/P2. Each module is independently shippable (no module blocks another except where noted). Estimated total: ~2100 LOC new + ~500 LOC modified.

**P0**: Module 1 (Budget) + Module 2 (Tool ACL) + Module 8 (Agent Pool)
**P1**: Module 3 (Reviewer) + Module 4 (Router) + Module 5 (Session, subsumed into Module 8)
**P2**: Module 6 (Trajectory) + Module 7 (Dashboard)

---

### Module 1: Budget Controller (P0) — Size: L

**What**: Real-time execution budget enforcement per plan step. Harness monitors stream events and enforces limits; when budget runs low, it sends a "wrap up" turn via stdin (not kill).

**Composition check**:
1. `stream_events.jsonl` (already collected by `claude-stream-launcher.cjs`) + `ndjson-stream.cjs` (NDJSON parser, already wired) + `cairn-log.cjs` (event logging)
2. Budget state tracking is new — no existing primitive tracks per-step resource consumption. The `outcomes` table tracks pass/fail, not resource usage.
3. Yes, orthogonal: budget is about resource limits; outcomes is about correctness.

**Design**:

```
Budget lifecycle per step:
  INIT (green) -> RUNNING (green) -> YELLOW (75%) -> RED (90%) -> FUSE (100%)

Budget dimensions:
  - max_duration_ms:  default 10min (configurable per step)
  - max_tool_calls:   default 80  (configurable per step)
  - max_tokens_out:   default 50000 (estimated from assistant event content lengths)

State transitions:
  GREEN  -> YELLOW:  log warning, no action
  YELLOW -> RED:     send wrap-up instruction via stdin ("You are at 90% budget.
                      Finish current task, commit progress, submit outcome.")
  RED    -> FUSE:    send final instruction ("Budget exhausted. Save state NOW.
                      Call cairn.task.block if incomplete."), then 30s grace -> SIGTERM
```

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-budget.cjs` | **NEW** | Budget controller: `createBudget(limits)` returns `{ check(event), getState(), sendWrapUp(stdin) }`. Pure state machine + stdin writer. |
| `packages/desktop-shell/claude-stream-launcher.cjs` | MODIFY | Wire budget controller into `parser.on('event')` callback. On each event: `budget.check(ev)`. When budget returns `wrap_up` or `fuse`: write wrap-up turn to `child.stdin`. Replace hardcoded `DEFAULT_IDLE_TIMEOUT_MS` watchdog with budget-aware watchdog. |
| `packages/desktop-shell/mode-a-loop.cjs` | MODIFY | `buildPlan` adds `budget` field to each step (defaults from plan-level config, overridable per step). |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | Pass step budget config to `launchStreamWorker`. |

**Key risks**:
- Token counting from stream events is approximate (we count content chars, not actual API tokens). Acceptable: budget is a guardrail, not billing.
- `child.stdin.write()` of wrap-up message may arrive mid-tool-use. CC handles this gracefully (queues as next turn).

**Not doing**:
- Billing/cost tracking (not a Cairn concern)
- Per-project global budget (only per-step for now)
- Hard kill without grace period (always send wrap-up first)

---

### Module 2: Tool Permission Governance (P0) — Size: XL

**What**: Replace `bypassPermissions` with per-step tool whitelists. High-risk tools require Harness confirmation or CAIRN.md authority routing.

**Composition check**:
1. `claude-mcp-config.cjs` (already builds per-spawn MCP config) + CAIRN.md protocol (`mentor-project-profile.cjs` loads authority section) + `dispatch_requests` (auditable intent)
2. Tool ACL enforcement is new. CC's `--permission-mode` only has `bypassPermissions` / `default` / custom. We need **Cairn as the permission arbiter** via MCP config filtering + CC's `--allowedTools` flag (if available) or via the MCP config itself (only expose allowed tools).
3. Yes, orthogonal: tool ACL is about what the agent CAN do; outcomes DSL is about what the agent DID do.

**Design**:

```
Permission model (3 tiers):

Tier 1 — ALWAYS ALLOWED (read-only):
  Read, Glob, Grep, Bash(read-only patterns),
  all cairn.scratchpad.read, cairn.task.resume_packet,
  cairn.process.status, cairn.session.name

Tier 2 — STEP-DECLARED (must be in step.tools whitelist):
  Write, Edit, Bash(write patterns),
  cairn.task.create, cairn.task.submit_for_review,
  cairn.outcomes.evaluate, cairn.checkpoint.create

Tier 3 — ESCALATE (requires Harness confirm or CAIRN.md authority):
  Bash(rm/git push/npm publish/chmod patterns),
  cairn.rewind.to, cairn.outcomes.terminal_fail,
  Any tool matching CAIRN.md ## Authority escalate entries
```

**Implementation approach**:

CC's permission model doesn't support Cairn-as-arbiter natively. Two viable paths:

**Path A (recommended): MCP config filtering + `--permission-mode` with `allowedTools`**
- CC supports `--allowedTools` flag (comma-separated tool names). Build the allowed list per step from the tier model.
- For MCP tools (cairn-wedge namespace): filter the tools exposed by mcp-server. Add a `CAIRN_ALLOWED_TOOLS` env var that mcp-server reads at boot to restrict which tools it registers.
- For CC built-in tools (Read/Write/Bash/etc.): use `--allowedTools` or `--disallowedTools` if CC supports it. **RESEARCH NEEDED**: verify CC CLI supports tool filtering flags. If not, fall back to prompt-based guardrails (less reliable but functional).

**Path B (fallback): Prompt-based + post-hoc audit**
- Keep `bypassPermissions` but inject strict tool-use instructions in boot prompt.
- Post-step trajectory analyzer (Module 6) flags violations.
- Less reliable but zero CC CLI dependency.

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-tool-acl.cjs` | **NEW** | Tool ACL engine: `resolveAllowedTools(step, profile)` returns `{ allowed: string[], escalate: string[], blocked: string[] }`. Reads step.tools + CAIRN.md authority. |
| `packages/desktop-shell/claude-mcp-config.cjs` | MODIFY | Accept `allowedCairnTools` option. When set, write a filtered MCP config that only exposes the allowed cairn-wedge tools. |
| `packages/mcp-server/src/index.ts` | MODIFY | Read `CAIRN_ALLOWED_TOOLS` env var. If set, only register tools in the allow list. ~20 LOC gating in the tool registration loop. |
| `packages/desktop-shell/claude-stream-launcher.cjs` | MODIFY | Accept `allowedTools` / `disallowedTools` in input. Thread into CC argv if supported; otherwise inject into prompt. |
| `packages/desktop-shell/mode-a-loop.cjs` | MODIFY | `buildPlan` / `planStepsFromGoal`: each step gets a `tools` field (default: tier 1+2; scout can customize). |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | Thread step.tools through to launcher. |
| `packages/desktop-shell/mode-a-scout.cjs` | MODIFY | Scout prompt instructs MiniMax to declare `tools_needed` per step. |

**Key risks**:
- CC CLI may not support `--allowedTools` flag. **Must research first.** If unsupported, Path B (prompt-based) is the fallback with trajectory audit as safety net.
- MCP tool filtering via env var is a new mcp-server surface. Must not break existing non-Mode-A usage (env var absent = all tools registered, backward compat).

**Not doing**:
- Runtime tool interception (CC decides tool use; we scope what's available, not intercept mid-call)
- Per-file path ACLs (too granular for v0; step-level is sufficient)
- Dynamic tool permission changes mid-step (step boundary is the re-evaluation point)

---

### Module 3: Worker + Reviewer Dual-Agent (P1) — Size: L

**What**: After Worker CC completes a step, Harness dispatches a **Reviewer CC**（独立 Claude Code session，read-only 权限）to verify the output. Reviewer failure -> Worker gets structured feedback + retry (not blind retry).

**CEO decision (2026-05-15)**: Reviewer 统一用 CC（不用 MiniMax）。原因：MiniMax 只能看文本，CC reviewer 能实际读文件、跑测试、看 diff。

**Composition check**:
1. `outcomes` table (PASS/FAIL with `evaluation_summary`) + `tasks` state machine (WAITING_REVIEW -> RUNNING retry loop) + Agent Pool (Module 8, see below) for reviewer session lifecycle
2. Reviewer orchestration is new, but the state transitions already exist: `submit_for_review` -> `WAITING_REVIEW` -> `outcomes.evaluate` -> PASS/RUNNING.
3. Orthogonal to existing: currently outcomes.evaluate runs deterministic DSL only. Adding a review agent between submit and evaluate adds a quality gate without changing the state machine.

**Design**:

```
Current flow:
  Worker CC -> cairn.task.submit_for_review -> cairn.outcomes.evaluate (DSL) -> PASS/FAIL

New flow:
  Worker CC -> cairn.task.submit_for_review -> WAITING_REVIEW
    |
    v
  Harness detects WAITING_REVIEW (mentor-tick)
    |
    v
  [Reviewer phase]:
    Agent Pool acquires a REVIEWER slot (or reuses idle reviewer session)
    -> spawn/resume CC with:
       - read-only tools only (Read, Glob, Grep, Bash(read-only), cairn tools)
       - Worker's git diff (staged changes)
       - Step's success criteria
       - Trajectory analysis flags (if Module 6 available)
    -> Reviewer runs tests / checks files / validates against criteria
    -> Returns structured verdict
    |
    v
  Reviewer verdict: { pass: bool, feedback: string, issues: string[] }
    |
    +--> PASS: cairn.outcomes.evaluate(PASS) -> DONE -> advance
    +--> FAIL: write feedback to scratchpad(reviewer_feedback/<task_id>)
              -> cairn.outcomes.evaluate(FAILED) -> RUNNING (retry)
              -> next Worker spawn includes reviewer feedback in boot prompt
```

**Reviewer CC identity**:
- `agent_type: 'reviewer'` in processes table
- Separate `CAIRN_SESSION_AGENT_ID` (e.g. `cairn-reviewer-<12hex>`)
- Read-only permission set: `--allowedTools "Read,Glob,Grep,Bash(cat *),Bash(git diff *),Bash(git log *),Bash(npm test *)"` + all `cairn.*` read tools
- **No** Write / Edit / `cairn.rewind.*` / `cairn.conflict.resolve`
- Reviewer session 可被 Agent Pool 复用（同一 plan 内多次 review 复用同一 reviewer CC）

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-reviewer.cjs` | **NEW** | Reviewer engine: `reviewStep(db, pool, step, workerDiff, profile)`. Acquires reviewer slot from Agent Pool, constructs review prompt with diff + criteria + trajectory flags, spawns/resumes CC, parses verdict. Returns `{ pass, feedback, issues }`. ~250 LOC. |
| `packages/desktop-shell/mentor-tick.cjs` | MODIFY | In Mode A WAITING_REVIEW detection: trigger `harness-reviewer` instead of waiting for agent self-evaluate. ~30 LOC. |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | On retry (step.retry_count > 0): read `scratchpad:reviewer_feedback/<task_id>` and inject into boot prompt as structured feedback block. ~15 LOC. |
| `packages/desktop-shell/mode-a-loop.cjs` | MODIFY | `advanceOnComplete`: handle reviewer-injected outcomes. Add `review_verdict` field to step state. ~10 LOC. |

**Depends on**: Module 8 (Agent Pool) for reviewer session lifecycle; Module 2 (Tool ACL) for reviewer's read-only permission set.

**Key risks**:
- CC reviewer adds 2-5min per step. Acceptable: quality > speed for autonomous execution. Agent Pool reuse mitigates cold-start cost.
- Reviewer CC may itself hallucinate issues. Mitigation: reviewer prompt is highly constrained (structured JSON output, specific criteria checklist, must cite evidence).

**Not doing**:
- Multi-round review dialogue (single review pass; if fails twice, escalate to user via task.block)
- Reviewer modifying code directly (reviewer is read-only; worker does fixes)
- Human-in-the-loop review (already handled by WAITING_REVIEW + panel; this is automated review)

---

### Module 4: Agent Routing (P1) — Size: M

**What**: Route plan steps to appropriate model based on complexity. Simple file operations -> haiku/fast model. Complex architecture work -> opus. Uses CAIRN.md authority signals + step metadata from Scout.

**Composition check**:
1. `mode-a-scout.cjs` (Scout already classifies steps with `rationale`) + `mentor-project-profile.cjs` (CAIRN.md profile) + `claude-stream-launcher.cjs` (spawn with configurable model)
2. Model routing logic is new, but the plumbing exists: CC CLI accepts `--model` flag.
3. Orthogonal: routing decides WHO executes; budget decides HOW MUCH; ACL decides WHAT they can do.

**Design**:

```
Routing table:
  step.complexity = 'trivial'  -> --model haiku    (file rename, config edit, doc update)
  step.complexity = 'standard' -> --model sonnet   (feature impl, test writing, refactoring)
  step.complexity = 'complex'  -> --model opus     (architecture, multi-file refactor, security)

Complexity sources (priority order):
  1. Scout explicit tag: step.complexity field (if Scout classified it)
  2. CAIRN.md hints: ## Authority escalate entries -> complex
  3. Heuristic: step label keyword analysis (trivial: "rename/move/update docs";
     complex: "architect/refactor/security/migrate")
  4. Default: 'standard' (sonnet)
```

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-router.cjs` | **NEW** | `routeModel(step, profile)` -> `{ model: string, reasoning: string }`. Pure function, ~80 LOC. |
| `packages/desktop-shell/claude-stream-launcher.cjs` | MODIFY | Accept `model` in input. Thread `--model <value>` into CC argv. ~5 LOC. |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | Call `harness-router.routeModel()` before spawn. Pass result to launcher. ~10 LOC. |
| `packages/desktop-shell/mode-a-scout.cjs` | MODIFY | Scout prompt asks MiniMax to tag each step with `complexity: 'trivial'|'standard'|'complex'`. ~10 LOC in prompt template. |

**Key risks**:
- CC CLI `--model` flag behavior with `--resume`: does changing model mid-session work? **Must verify.** If not, model is locked per plan (not per step) when using resume.
- Haiku may be too weak for some "trivial" steps. Mitigation: if step fails with haiku, retry with sonnet (automatic escalation via retry_count).

**Not doing**:
- Cost optimization (not tracking spend per model)
- Custom fine-tuned models (only Anthropic model tiers)
- Per-provider routing (only CC CLI; no direct API calls to Anthropic)

---

### Module 5: Persistent Long-Form Session (P1) — Size: M

**What**: Use a single persistent CC session across all steps in a plan, sending each step as a new turn via stdin. Currently half-implemented via `--resume`.

**Composition check**:
1. `claude-stream-launcher.cjs` (stdin already held open, `makeInputEnvelope` exists) + `mode-a-session-store.cjs` (persists session_id per plan) + `--resume` argv support
2. The plumbing exists but is unused for multi-turn: currently each step spawns a NEW CC process (even with resume, it's a new process). True persistent session = keep ONE child process alive across steps.
3. Not orthogonal to existing session store; this is completing the half-built feature.

**Design**:

Two modes, configurable per plan:

**Mode A (default): Resume-based persistence**
- Keep current spawn-per-step model.
- Session store captures session_id from step N.
- Step N+1 spawns with `--resume <session_id>`.
- CC picks up the same context window.
- **Already 80% implemented.** Main gap: step advance doesn't reliably trigger next spawn with resume.

**Mode B (experimental): Keep-alive persistence**
- Single `child_process` stays alive across steps.
- After step N completes (result event), Harness writes step N+1's prompt as a new turn via `child.stdin.write(makeInputEnvelope(nextPrompt))`.
- Budget controller resets per step.
- Session dies on plan completion or fuse.

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-session.cjs` | **NEW** | Session lifecycle manager: `createSession(plan)` / `advanceStep(stepIdx, prompt)` / `getChild()` / `terminate()`. Wraps claude-stream-launcher for keep-alive mode. ~150 LOC. |
| `packages/desktop-shell/claude-stream-launcher.cjs` | MODIFY | Expose `child` handle + `writeNextTurn(prompt)` method on the return object (for keep-alive mode). Currently child is captured in closure; needs to be accessible. ~20 LOC. |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | Check if session manager has an active child for this plan. If yes, write next turn instead of spawning. ~25 LOC. |
| `packages/desktop-shell/mentor-tick.cjs` | MODIFY | When step advances and keep-alive session exists, call `session.advanceStep()` instead of waiting for next tick's spawn logic. ~15 LOC. |

**Key risks**:
- Keep-alive mode: CC may accumulate context and degrade over long plans (10+ steps). Mitigation: auto-restart (kill + resume) after configurable step count (default 5).
- Keep-alive mode: if CC crashes mid-step, session manager must detect and fall back to spawn mode for remaining steps.

**Not doing**:
- Session forking (no parallel step execution within one session)
- Context window management (CC handles its own compaction)

**Note**: Module 5 is subsumed into Module 8 (Agent Pool). Persistent session is one capability of the pool, not a standalone module.

---

### Module 8: Agent Pool / Session Lifecycle Manager (P0) — Size: L

**What**: Centralized agent lifecycle management. Instead of blindly spawning a new CC for every task, Harness maintains a **pool of typed agent slots** with explicit creation, reuse, and teardown.

**CEO decision (2026-05-15)**: 每个小任务都 spawn 一个新 CC 不合理。不同身份的 agent（worker / reviewer）的 session 创建和销毁应该由 Harness 统一管理。

**Composition check**:
1. `processes` table (already tracks agent_id / status / heartbeat) + `mode-a-session-store.cjs` (already persists session_id per plan) + `claude-stream-launcher.cjs` (child process lifecycle)
2. Pool management is new. `processes` table tracks presence but not intent (worker vs reviewer vs scout). `session-store` persists session_id but doesn't manage child process handles or slot allocation.
3. Orthogonal to existing: processes = "who is alive"; pool = "who should be alive, doing what, and can I reuse them".

**Design**:

```
Agent slot types:
  WORKER     — executes plan steps. One per project (persistent across steps).
  REVIEWER   — reviews worker output. One per project (reusable across reviews).
  SCOUT      — plans (MiniMax, not CC). Stateless, no slot needed.

Pool lifecycle per project:
  Plan starts:
    -> Pool creates WORKER slot (spawn CC, keep stdin open)
    -> REVIEWER slot lazy-created on first review

  Step N executes:
    -> Pool.getWorker() returns existing child (send new turn via stdin)
       OR spawns if crashed / first step / context too large (auto-restart threshold)
    -> Worker executes, stream events flow to budget controller

  Step N review:
    -> Pool.getReviewer() returns existing reviewer CC
       OR spawns with read-only permissions
    -> Reviewer reads diff, runs checks, returns verdict

  Step N+1:
    -> Same WORKER child receives next turn (no cold start)
    -> Budget controller resets per step

  Plan completes / fails:
    -> Pool.teardown() sends graceful shutdown to all slots
    -> Waits for exit (30s grace), then SIGTERM
    -> Cleans up temp MCP configs
    -> Updates processes table: status=IDLE

  Crash recovery:
    -> mentor-tick detects ACTIVE process with no heartbeat > 2×TTL
    -> Pool marks slot as DEAD, next getWorker()/getReviewer() spawns fresh

Slot state machine:
  EMPTY -> SPAWNING -> READY -> BUSY -> READY -> ... -> TEARDOWN -> EMPTY
                                  |
                                  +-> DEAD (crash detected) -> EMPTY (re-spawn)

Reuse policy:
  - WORKER: reuse across steps in same plan. Auto-restart after N steps
    (default 5) to prevent context degradation. Uses --resume for context
    continuity across restarts.
  - REVIEWER: reuse across reviews in same plan. No restart needed (each
    review is a short turn).
  - Cross-plan: teardown all slots when plan changes (goal supersession).
```

**Session identity**:
- Each slot has a typed agent_id: `cairn-worker-<12hex>` / `cairn-reviewer-<12hex>`
- Processes table gains a semantic `agent_type` field (already exists in schema: `agent_type TEXT`)
- Pool writes `agent_type = 'worker'` or `'reviewer'` on register

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-pool.cjs` | **NEW** | Agent Pool: `createPool(project)` / `getWorker()` / `getReviewer()` / `teardown()`. Manages child process handles, slot states, auto-restart, crash recovery. Wraps `claude-stream-launcher.cjs`. ~300 LOC. |
| `packages/desktop-shell/claude-stream-launcher.cjs` | MODIFY | Expose `child` handle + `writeNextTurn(prompt)` method. Add `onExit` callback for pool crash detection. ~25 LOC. |
| `packages/desktop-shell/mode-a-spawner.cjs` | MODIFY | Replace direct `launchStreamWorker` call with `pool.getWorker()`. Pool decides spawn vs reuse. ~30 LOC refactor. |
| `packages/desktop-shell/harness-reviewer.cjs` | MODIFY (Module 3) | Use `pool.getReviewer()` instead of direct spawn. ~10 LOC. |
| `packages/desktop-shell/mentor-tick.cjs` | MODIFY | On plan completion/fail: call `pool.teardown()`. On step advance with keep-alive: `pool.getWorker().writeNextTurn()`. ~20 LOC. |

**Key risks**:
- Child process handle management across async ticks. Mitigation: pool is the single owner of all child handles; nobody else spawns CC directly.
- Auto-restart threshold tuning (too low = lose context, too high = context degradation). Start with 5 steps, tune from real data.
- `--resume` across process restarts: CC creates a new process but picks up the same conversation. **Already verified working** in current Mode A.

**Not doing**:
- Cross-project agent sharing (pool is per-project)
- Dynamic pool sizing (fixed: 1 worker + 1 reviewer per project)
- Agent migration between projects
- Parallel workers within one plan (single-worker-at-a-time; parallel execution is a separate plan)

---

### Module 6: Trajectory Evaluation (P2) — Size: M

**What**: Post-step analysis of execution trajectory. Not just "did the file appear" (outcome DSL) but "how did the agent get there" (tool call patterns, loops, violations).

**Composition check**:
1. `stream_events.jsonl` (raw events already persisted per run) + `ndjson-stream.cjs` (parser) + `cairn-log.cjs` (findings logged) + `outcomes` table (final verdict)
2. Trajectory analysis is new. Outcomes DSL checks postconditions (file_exists, grep_match). Trajectory checks the execution path itself.
3. Orthogonal: outcomes = "what is the world state after"; trajectory = "how did the agent behave during".

**Design**:

```
Trajectory analyzer runs AFTER worker completes, BEFORE reviewer (Module 3).

Checks:
  1. Tool call count anomaly: > 3x median for similar steps -> flag
  2. Loop detection: same tool called with same args > 3 times -> flag
  3. Permission violation: tool calls outside step.tools whitelist -> flag (requires Module 2)
  4. Scope creep: files modified outside step's declared scope -> warn
  5. Error cycling: > 3 consecutive Bash failures -> flag

Output: { score: 0-100, flags: string[], summary: string }
  score < 50 -> auto-fail (don't even run reviewer)
  score 50-80 -> reviewer gets flags as context
  score > 80 -> clean pass to reviewer
```

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/harness-trajectory.cjs` | **NEW** | `analyzeTrajectory(runId, step, opts)` -> reads `stream_events.jsonl`, runs 5 checks, returns `{ score, flags, summary }`. ~200 LOC. |
| `packages/desktop-shell/harness-reviewer.cjs` | MODIFY (if Module 3 exists) | Feed trajectory flags into reviewer context. ~10 LOC. |
| `packages/desktop-shell/mentor-tick.cjs` | MODIFY | After step completes, before review: run trajectory analyzer. Log results. ~15 LOC. |

**Depends on**: Module 2 (for permission violation check) and Module 3 (for feeding flags to reviewer). Can run standalone without them (checks 1,2,4,5 don't need ACL data).

**Key risks**:
- stream_events.jsonl can be large (10+ MB for complex steps). Analyzer must stream-read, not load-all. Use `ndjson-stream.cjs` on a file read stream.
- Scoring thresholds need tuning from real execution data. Start conservative (score < 30 = auto-fail).

**Not doing**:
- Real-time trajectory monitoring during execution (post-hoc only for P2; budget controller handles real-time)
- ML-based anomaly detection (rule-based heuristics only)
- Historical trajectory comparison (no baseline DB; each step evaluated independently)

---

### Module 7: Real-Time Dashboard (P2) — Size: S

**What**: Panel sidebar shows live execution metrics for the currently running step: token estimate, tool call count, elapsed time, budget zone (green/yellow/red), active flags.

**Composition check**:
1. `panel.html` (existing panel surface) + `stream_events.jsonl` (raw data source) + `cairn-log.cjs` (event stream) + budget controller state (Module 1)
2. Dashboard rendering is new panel UI. Data source is budget controller's in-memory state.
3. Orthogonal to existing panel modules (state strip / activity feed / safety net). This is a new "live execution" card.

**Design**:

```
Data flow:
  Budget controller (Module 1) maintains in-memory counters
    -> Electron main process exposes via IPC: ipcMain.handle('harness:getStepMetrics')
    -> panel.html polls every 2s (same pattern as existing 1s tray poll)
    -> Renders: progress bar + tool call list + elapsed timer + budget zone badge

Panel card layout:
  +-----------------------------------------+
  | Step 3/7: "Implement auth middleware"    |
  | Model: sonnet | Budget: [====----] 62%  |
  | Tools: 23 calls | Time: 4m 12s          |
  | Zone: GREEN                             |
  | Last tool: Write src/auth/middleware.ts  |
  +-----------------------------------------+
```

**Files to change**:

| File | Action | What |
|------|--------|------|
| `packages/desktop-shell/panel.html` | MODIFY | Add "Live Execution" card to Mode A project view. ~80 LOC HTML/CSS/JS. |
| `packages/desktop-shell/main.cjs` | MODIFY | Add `ipcMain.handle('harness:getStepMetrics')` that reads budget controller state. ~15 LOC. |
| `packages/desktop-shell/harness-budget.cjs` | MODIFY (Module 1) | Export `getMetrics()` returning current counters for IPC consumption. ~10 LOC. |

**Depends on**: Module 1 (budget controller provides the data).

**Constraints**: desktop-shell stack frozen (raw HTML/CSS/JS, no React/Vue/Tailwind). Panel is read-only (D9 lock).

**Key risks**:
- 2s polling may miss fast tool calls. Acceptable: dashboard is for human glancing, not real-time debugging.
- Budget controller state is per-process (in-memory). If Electron restarts, state is lost until next step starts.

**Not doing**:
- Historical metrics view (only current step)
- Alerting/notifications (budget controller handles FUSE -> log; panel just reflects state)
- Tool call detail drill-down (just name + count, not full args)

---

## 2. Expected Outputs

After all modules are implemented:

### New files (8):
- `packages/desktop-shell/harness-budget.cjs` — Budget controller (~200 LOC)
- `packages/desktop-shell/harness-tool-acl.cjs` — Tool ACL engine (~180 LOC)
- `packages/desktop-shell/harness-reviewer.cjs` — Worker/Reviewer orchestrator (~250 LOC)
- `packages/desktop-shell/harness-router.cjs` — Model routing (~80 LOC)
- `packages/desktop-shell/harness-pool.cjs` — Agent Pool / Session lifecycle manager (~300 LOC)
- `packages/desktop-shell/harness-trajectory.cjs` — Post-step trajectory analyzer (~200 LOC)
- `packages/desktop-shell/scripts/smoke-harness.mjs` — End-to-end smoke test (~300 LOC)
- ~~`packages/desktop-shell/harness-session.cjs`~~ — subsumed into `harness-pool.cjs`

### Modified files (8):
- `packages/desktop-shell/claude-stream-launcher.cjs` — Budget wiring + model flag + child handle exposure
- `packages/desktop-shell/claude-mcp-config.cjs` — Tool filtering support
- `packages/desktop-shell/mode-a-loop.cjs` — Step budget/tools/complexity fields + review verdict
- `packages/desktop-shell/mode-a-spawner.cjs` — Budget/ACL/router/session threading
- `packages/desktop-shell/mode-a-scout.cjs` — Scout prompt: tools_needed + complexity per step
- `packages/desktop-shell/mentor-tick.cjs` — Reviewer trigger + trajectory analysis + session advance
- `packages/desktop-shell/panel.html` — Live execution card
- `packages/mcp-server/src/index.ts` — CAIRN_ALLOWED_TOOLS env var gating

### No new migrations needed.
Budget/ACL/trajectory state is ephemeral (in-memory during execution, logged to JSONL). Reviewer feedback goes to existing `scratchpad` table. No new schema.

### No new npm dependencies.
All modules use Node.js stdlib + existing `llm-client.cjs` for MiniMax calls.

---

## 3. How To Verify

### Per-module smoke tests:

```bash
# Module 1: Budget Controller
node packages/desktop-shell/scripts/smoke-harness.mjs --module budget
# expect: budget transitions green->yellow->red->fuse on simulated events
# expect: wrap-up message written to mock stdin at RED
# expect: SIGTERM sent at FUSE after grace period
# assert count: ~20

# Module 2: Tool ACL
node packages/desktop-shell/scripts/smoke-harness.mjs --module acl
# expect: resolveAllowedTools returns correct tiers for sample steps
# expect: CAIRN.md authority entries map to tier 3
# expect: MCP config filtering produces correct subset
# assert count: ~25

# Module 3: Reviewer
node packages/desktop-shell/scripts/smoke-harness.mjs --module reviewer
# expect: MiniMax review returns { pass, feedback } for sample diffs
# expect: failed review writes feedback to scratchpad
# expect: retry boot prompt includes reviewer feedback
# assert count: ~15

# Module 4: Router
node packages/desktop-shell/scripts/smoke-harness.mjs --module router
# expect: trivial steps route to haiku
# expect: complex steps route to opus
# expect: CAIRN.md escalate entries force complex
# assert count: ~12

# Module 5: Session
node packages/desktop-shell/scripts/smoke-harness.mjs --module session
# expect: keep-alive writes next turn to existing child stdin
# expect: session auto-restarts after 5 steps
# expect: crash recovery falls back to spawn mode
# assert count: ~15

# Module 6: Trajectory
node packages/desktop-shell/scripts/smoke-harness.mjs --module trajectory
# expect: loop detection flags 3+ identical tool calls
# expect: scope creep flags files outside declared scope
# expect: score < 50 auto-fails
# assert count: ~18

# Module 7: Dashboard
# Manual verification: run Mode A on a test project, observe panel
# Live execution card appears, updates every 2s, shows budget zone
```

### Integration smoke (full pipeline):

```bash
# End-to-end: Scout -> Budget -> ACL -> Worker -> Trajectory -> Reviewer -> Advance
node packages/desktop-shell/scripts/smoke-harness.mjs --integration
# Uses fake-claude binary (same pattern as smoke-mode-a-spawn-resume.mjs)
# expect: plan drafted with budget/tools/complexity per step
# expect: worker spawned with filtered MCP config + model flag
# expect: budget transitions logged during execution
# expect: trajectory analyzed post-completion
# expect: reviewer verdict determines advance/retry
# assert count: ~40
```

### Existing tests must stay green:

```bash
cd packages/daemon && npm test           # 439 tests
cd packages/mcp-server && npm test       # 424 tests
```

---

## 4. Probes

```bash
# Probe 1: Budget controller state machine correctness
claude --model haiku -p \
  "Given this budget controller code: $(cat packages/desktop-shell/harness-budget.cjs | head -100), \
   output JSON {states: string[], transitions: {from,to,trigger}[], has_wrap_up: bool, has_fuse: bool}" \
  > /tmp/probe-budget-haiku.json

claude --model sonnet -p \
  "Same prompt..." > /tmp/probe-budget-sonnet.json

diff /tmp/probe-budget-haiku.json /tmp/probe-budget-sonnet.json
# expect: zero diff (state machine is deterministic)

# Probe 2: Tool ACL tier classification
claude --model haiku -p \
  "Given this ACL module: $(cat packages/desktop-shell/harness-tool-acl.cjs | head -80), \
   output JSON {tier1_count: number, tier2_count: number, tier3_count: number, \
   escalate_patterns: string[]}" \
  > /tmp/probe-acl-haiku.json

claude --model sonnet -p \
  "Same prompt..." > /tmp/probe-acl-sonnet.json

diff /tmp/probe-acl-haiku.json /tmp/probe-acl-sonnet.json
# expect: zero diff

# Probe 3: Trajectory analyzer check list
claude --model haiku -p \
  "Given this trajectory analyzer: $(cat packages/desktop-shell/harness-trajectory.cjs | head -80), \
   output JSON {checks: string[], score_range: [number,number], auto_fail_threshold: number}" \
  > /tmp/probe-traj-haiku.json

claude --model sonnet -p \
  "Same prompt..." > /tmp/probe-traj-sonnet.json

diff /tmp/probe-traj-haiku.json /tmp/probe-traj-sonnet.json
# expect: zero diff
```

---

## 5. Implementation Order

```
Phase 1:  Module 1 (Budget) + Module 8 (Agent Pool)
          - Budget is P0 foundation; Pool is P0 (agent lifecycle)
          - Pool replaces direct spawn with managed slots
          - Deliverable: Mode A steps have budget enforcement + worker reuse (no cold start per step)

Phase 2:  Module 2 (Tool ACL) + Module 4 (Router)
          - --allowedTools confirmed available (no research needed)
          - ACL replaces bypassPermissions; Router picks model per step
          - Deliverable: scoped permissions + model routing

Phase 3:  Module 3 (Reviewer)
          - Reviewer CC uses Pool's reviewer slot
          - Worker retry includes structured feedback
          - Deliverable: automated code review gate

Phase 4:  Module 6 (Trajectory) + Module 7 (Dashboard)
          - Both are P2 observability
          - Deliverable: post-step analysis + live panel card

Integration smoke + dogfood across all modules after Phase 4.
```

---

## 6. Cross-Cutting Concerns

### 6.1 Backward Compatibility
- All harness features are **opt-in per project** via `cockpit_settings.harness`. Mode A without harness config behaves exactly as today (bypassPermissions, no budget, no reviewer).
- Existing Mode B path (`worker-launcher.cjs` with `--print`) is completely untouched.

### 6.2 Logging
- Every harness decision (budget transition, ACL check, reviewer verdict, trajectory flag, routing choice) is logged via `cairn-log.cjs` under component `'harness-*'`.
- `stream_events.jsonl` remains the raw event store; harness adds structured summaries to `cairn-log`.

### 6.3 CAIRN.md Integration
- Module 2 (ACL) reads `## Authority` section for escalation patterns.
- Module 4 (Router) reads `## Authority` for complexity hints.
- Module 3 (Reviewer) reads `## Whole` for goal alignment checking.
- All go through existing `mentor-project-profile.cjs::loadProfile()`.

### 6.4 Failure Modes
- Budget fuse -> step marked FAILED, plan continues to next step (or BLOCKED if critical).
- ACL violation detected post-hoc -> step flagged but not auto-failed (trajectory score impact).
- Reviewer crash -> fall back to DSL-only outcomes evaluation (existing path).
- Router error -> default to sonnet (safe fallback).
- Session crash -> fall back to spawn-per-step (existing path).

---

## 7. What This Plan Does NOT Cover

1. ~~**CC CLI capabilities research**~~: **RESOLVED** — `--allowedTools` confirmed in official docs (https://code.claude.com/docs/en/headless). Supports prefix matching e.g. `Bash(git diff *)`. Also supports `--permission-mode acceptEdits` / `dontAsk` for step-level lockdown. Module 2 Path A is viable.
2. **Multi-agent parallel execution**: This plan is single-worker-at-a-time. Parallel step execution is a separate plan.
3. **Cost tracking / billing**: Budget is about resource limits, not spend accounting. Note: starting June 15, 2026, `claude -p` usage draws from a separate **Agent SDK credit** (not interactive limits). This makes Module 1 even more critical — without budget control, Mode A will burn Agent SDK credits unchecked.
4. **New MCP tools**: No new tools added to the 29-tool surface. Harness operates at the desktop-shell layer, not the kernel layer.
5. **New migrations**: All state is ephemeral or stored in existing scratchpad.
6. **Mode B / Mode C changes**: Harness is Mode A only.
7. **prompt caching / context optimization**: CC handles its own context management.
