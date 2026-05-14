# Mode A / Mode B Reframe — CEO 命题 2026-05-14

> Status: **LIVE PLAN**, opened 2026-05-14 EOD. CEO 鸭总 dictated this
> reframe directly. Supersedes earlier "Mode B Continuous Iteration"
> lane-only definition.
> Authoring agent: lead. Workflow: worktree + subagent审查 mandatory
> per CEO repeated correction this session.

---

## 1. CEO's positioning statement (verbatim)

> 接下来的模式大概是这样：
>
> **Mode A** 可以简单理解为 mentor 模式，也就是类似小白模式：只要能够连接
> 上 github 的项目仓库并且可以推送就说明连接上了，之后 llm mentor 就可以
> 按照项目的 goal 以及 cairn.md 来开始设计方案并且协同用户 agent（cc /
> codex / kiro 等）开始朝着 goal 运行。而且要能够实现**长程任务的执行**，
> 就像我们现在设置的规则一样能够长程执行——即使用户的 cc 没有这样的规则，
> cairn 也能够确保 cc 在任务完成前能够不断。
>
> **Mode B** 那么可以理解为短期的模块化的修改：这个模式也会有 mentor 按
> 照项目管理的一些原则和方法来指导用户，为用户提一些建议——类似下一步待
> 办的性质——然后用户可以在这个排序的模块中**主动选择去委派**哪个任务。
>
> 两种模式均可以在下方的 session 中显示，而且 session 尽量在初期就有个
> 比较清晰的命名，不要直接用用户不友好的 uuid 之类的。
>
> 你最好提前写好 log 的触发，尽量能够通过 log 就知道是哪一步有错，也方
> 便你自己调试。

---

## 2. Mode A — "全自动长程 / 小白模式"

### 2.1 Connect = github push works

- Connection check: panel runs `git -C <project> push --dry-run origin` (or
  `git ls-remote origin HEAD`) once; if returns 0 → connected.
- No PR API, no scopes negotiation, no token wizard. Connection is a
  binary fact about the local git config + network.

### 2.2 Mentor designs from goal + CAIRN.md, no user prompts mid-run

- On Mode-A switch ON: Mentor reads (a) project's active_goal.title +
  desired_outcome + success_criteria, (b) project's CAIRN.md
  (`profile.whole_sentence`, `profile.goal`, `profile.authority.*`,
  `profile.constraints`).
- Mentor drafts an **execution plan**: ordered list of candidate tasks +
  why each fits the goal. Stored as `mode_a_plan/<project_id>/<ulid>`
  scratchpad entry.
- Mentor auto-creates the first N task capsules via `cairn.task.create`
  on behalf of the user. Created tasks are tagged with
  `metadata: { mode: 'A', plan_id: <ulid>, step: <N> }`.

### 2.3 Long-running execution — Cairn forces CC to not stop

The hard requirement: "**即使用户的 cc 没有这样的规则，cairn 也能够确保 cc
在任务完成前能够不断**".

Mechanism (composes existing primitives — no new state objects):

1. **User CC starts a task** (or Cairn dispatches one via `dispatch_requests`).
2. CC hits something it would normally stop on:
   - `cairn.task.block` (asking a question)
   - test failure (no kernel signal yet — handled by Rule B once tail.log
     ships)
   - reached natural end-of-step
3. Mode A's `mentor-tick` Rule D (BLOCKED) runs more aggressively than
   default:
   - **Default**: known_answer match → answer; else escalate to user.
   - **Mode A**: known_answer → answer; **no match** → LLM polish using
     CAIRN.md authority hints → answer with best-effort guess +
     `auto_answered_by_mode_a: true` flag in scratchpad.
   - User can review the auto-answer log later; Mentor never goes silent.
4. CC's `cairn-aware` skill v5: poll `agent_inbox/<session>/...` AND
   poll currently-OPEN `blockers` for `answered_at` filled → if filled,
   read `answer` field and continue from where it stopped.
5. After each task's `outcomes.evaluate` PASS: Mentor advances to next
   step in the Mode A plan automatically (analogous to lane advance, but
   without the user-Approve gate — that's the Mode-A trade-off the user
   opted into).

**Stop conditions** for the long-running loop:
- All planned tasks → DONE (goal achieved per success_criteria)
- A task → TERMINAL_FAIL (Mentor cannot self-resolve after 3 retries)
- User explicitly pauses Mode A (panel toggle → state='PAUSED')
- A hard-stop keyword fires (Rule F — destructive operation detected)

### 2.4 Mode A is opt-in per project

Per-project `mode_a_enabled: boolean` in registry. Default `false` (user
must explicitly trust Mentor with this level of autonomy). Toggle lives
in M2 Mentor module header.

---

## 3. Mode B — "短期模块化 / 用户主导"

### 3.1 What Mentor does

- Watches kernel state (tasks / outcomes / scratchpad / git changes via
  pre-commit hook).
- Applies project management heuristics:
  - "User has 2 RUNNING tasks — suggest finishing one before starting third"
  - "outcomes failed twice — suggest reviewing test setup"
  - "no commit in 30min on RUNNING task — suggest checkpoint"
  - "agent self-proposed X — suggest reviewing"
- Writes **ranked** suggestions to `mentor_todo/<project_id>/<ulid>`
  with `{ ts, label, priority, why }`.

### 3.2 What user does

- Opens panel, sees M2 Mentor 建议 list ranked top-to-bottom.
- Reviews each suggestion, **manually picks** one to dispatch (existing
  `cockpit-todo-dispatch` IPC → `dispatch_requests` table → CC picks it
  up via R1–R6 fallback rules).
- Mentor does NOT auto-dispatch in Mode B.

### 3.3 Mode B is the default mode

All existing v0.2.0 functionality (lane / Todolist / dispatch UI) IS Mode B.

---

## 4. Session display — early human name

CEO: "session 尽量在初期就有个比较清晰的命名，不要直接用用户不友好的 uuid".

Current state: A3-part1 added `cairn.session.name` MCP tool. Display
name resolution order:
1. `scratchpad:session_name/<agent_id>` (set by agent on startup)
2. Short hex prefix fallback (`746e4cea` etc.)

Gap: cairn-aware skill v3+ teaches the agent to self-name, but the
agent must execute that step. If the agent doesn't (e.g., a CC session
that loaded the skill but skipped step 2), session shows hex.

**Fix path** (this phase):
- mcp-server startup auto-names from cwd basename if no override set
  (e.g., session in `D:\lll\managed-projects\agent-game-platform\` →
  initial name "agent-game-platform · 14:30")
- Agent can still override via `cairn.session.name` to a meaningful task
- Panel display logic: scratchpad override > startup auto-name > hex

---

## 5. Logging infrastructure — "提前写好 log 的触发"

CEO: "尽量能够通过 log 就知道是哪一步有错，也方便你自己调试".

Design: **structured event log** stored as `~/.cairn/logs/cairn-<date>.jsonl`,
one event per line.

### 5.1 Log event shape

```json
{
  "ts": 1778728000000,
  "ts_iso": "2026-05-14T12:00:00.000Z",
  "level": "info" | "warn" | "error",
  "component": "panel" | "mentor-tick" | "dispatch" | "lane" | "mode-a-loop" | "ipc" | "registry",
  "event": "<short event name>",
  "agent_id": "<session if known>",
  "project_id": "<project if scoped>",
  "details": { /* event-specific fields */ }
}
```

### 5.2 Key events that MUST log

Per CEO mandate "every step has log":

| Component | Event | Triggered when |
|---|---|---|
| `panel/setView` | `view_changed` | Every setView call (with from / to / meta) |
| `panel/ipc` | `ipc_failed` | Any window.cairn.* call returns ok:false |
| `panel/render` | `render_error` | Any render fn throws |
| `mentor-tick` | `rule_decision` | Every rule decision (rule, action, task_id) |
| `mentor-tick` | `tick_failed` | runOnce catches exception |
| `cockpit-state` | `query_failed` | Any DB query throws |
| `registry/save` | `registry_saved` | saveRegistry writes |
| `dispatch` | `dispatch_created` | New dispatch_requests row |
| `lane` | `lane_state_change` | Lane state transition |
| `mode-a-loop` | `step_advanced` | Mode A plan step advance |
| `mode-a-loop` | `auto_answered` | Rule D auto-answered without escalate |
| `mode-a-loop` | `paused` | Mode A toggled off mid-run |
| `session/naming` | `auto_named` | Startup auto-name applied |
| `goal/extract` | `goal_text_failed` | goal field shape mismatch (the recurring bug class) |

### 5.3 Implementation

`packages/desktop-shell/cairn-log.cjs` (new) — minimal helper:

```js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const LOG_DIR = path.join(os.homedir(), '.cairn', 'logs');
const LOG_FILE = () => path.join(LOG_DIR, `cairn-${new Date().toISOString().slice(0,10)}.jsonl`);

let _ready = false;
function _ensure() {
  if (_ready) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  _ready = true;
}

function log(component, event, details = {}, level = 'info') {
  try {
    _ensure();
    const entry = {
      ts: Date.now(),
      ts_iso: new Date().toISOString(),
      level, component, event,
      ...details,
    };
    fs.appendFileSync(LOG_FILE(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (_e) { /* never block on logger failure */ }
}

module.exports = { log };
```

Modules use it: `const { log } = require('./cairn-log.cjs'); log('panel', 'view_changed', { from: ..., to: ... });`

### 5.4 Reading logs

Panel can have a "View log" link (later iteration). For now, manual:

```bash
tail -f ~/.cairn/logs/cairn-2026-05-14.jsonl | jq .
```

Or grep by component:
```bash
grep '"component":"mode-a-loop"' ~/.cairn/logs/cairn-2026-05-14.jsonl
```

---

## 6. Implementation phases (this plan = first 3 phases)

### Phase MA-0 — Foundation (this commit)
- Plan doc (this file)
- `cairn-log.cjs` helper + smoke
- Initial log instrumentation in: setView / mentor-tick / dispatch /
  cockpit-state queries / registry.saveRegistry
- Session auto-name on mcp-server startup (cwd basename + timestamp)

### Phase MA-1 — Mode toggle + per-project state (next worktree)
- `registry.mode_a_enabled` field per project
- Panel M2 Mentor header: "Mode: A | B" toggle (default B)
- Persist via IPC `cockpit-set-mode`

### Phase MA-2 — Mode A long-running loop (next worktree)
- Mentor reads goal + CAIRN.md → drafts plan (LLM polish)
- Auto-create first N tasks
- mentor-tick Rule D: Mode A aggressive auto-answer path
- cairn-aware skill v5: poll for answered blockers + continue

### Phase MA-3 — Mode B suggestion ranking
- mentor-tick adds heuristic-based mentor_todo entries
- Rank by priority field

---

## 7. Stop conditions (when this plan is "done")

(a) `cairn-log.cjs` ships + 10+ instrumented log points + smoke green.
(b) Session auto-name on startup verified by booting a fresh CC.
(c) Plan doc on `origin/main`.
(d) Subagent审查 sign-off on the log API + privacy review (no secret/token in details).

Phases MA-1/2/3 are **separate plans** — this one is foundation only.
