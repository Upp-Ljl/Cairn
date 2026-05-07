# Cairn v0.1 · W5 计划（Durable Task Capsule — 长程任务 OS 升级）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把 Cairn 从"session-scoped 安全护栏"升级为**长程任务 OS**。引入一等公民 `Task Capsule`：一个可暂停、可接力、可验收、可回滚的任务胶囊。进程可以死、session 可以断、agent 可以换，**task capsule 必须活着**。本周（W5 Phase 1 / D0）只交付 Task Capsule 的**生命周期骨架**——`tasks` 表、状态机、parent_task_id 树结构、5 个语义动词工具。Blockers / Outcomes 留给 Phase 2 / 3。

**Architecture**：新增一等公民 `tasks` 表（migration 007），承载长程任务的"生命线"（intent / state / lineage / metadata）。`dispatch_requests` 在 migration 008 新增 nullable `task_id`；`scratchpad` / `checkpoints` 已在 migration 002 / 003 带 `task_id` 列（W1/P3 偏离时落的，无 FK——历史债，W5 不补，详见 §9 风险表）。MCP 层暴露**语义动词**而非自由状态改写：`cairn.task.create` / `get` / `list` / `start_attempt` / `cancel`。状态机内化为 daemon 仓储层的 transition guard，agent 只调动词、不写 state。

**Tech Stack**：Node.js 24 / TypeScript strict ESM / `better-sqlite3@^12.9.0` / `@modelcontextprotocol/sdk@^1`。无新依赖。

**Spec 来源**：
- `PRODUCT.md` v2 §0 TL;DR / §3 ICP / §5 四能力（W5 后 PRODUCT.md 主 pitch 升级为长程任务 OS，但 W5 本身不改 §5 四能力）
- `DESIGN_STORAGE.md` §4（schema 现状）/ §17.1（W1 偏离通告，migration 编号）
- `CLAUDE.md` Phase 1-4 落地约定（SESSION_AGENT_ID 自动注入、migration 006 已落地、下一个可用编号 007）
- 本次 plan 上游讨论：2026-05-07 与用户对话锁定的 4 项设计决议（见 §1）

**配套技能**：
- `superpowers:subagent-driven-development` — 每个独立 task 派 fresh sonnet
- `superpowers:writing-plans` — Phase 2 / 3 / 4 子 plan 起草时使用
- `superpowers:verification-before-completion` — Phase 末验收

---

## 1. Locked Decisions（不可在 Phase 1 重新讨论）

以下 4 项已在 2026-05-07 锁定，Phase 1 任何 task 不得绕过或重审。如需调整必须先关 Phase、开 ADR。

### LD-1：Task 是一等公民，不是 processes 的某个状态

`processes` 描述"runner 还活着吗"，`tasks` 描述"work 还活着吗"。两者**生命周期完全独立**：进程退出不影响 task；同一 task 可被多个 process 接力推进。

不允许的设计：
- 把 `SUSPENDED` / `BLOCKED` 加到 `processes.status`
- 用 `dispatch_request_id` 当 task 主键
- 通过 process 反推 task 所有权

允许的设计：
- 新建 `tasks` 表，独立 PK `task_id`
- `dispatch_requests` 在 migration 008 新增 nullable `task_id`（含 FK，如 SQLite ALTER 支持）
- `scratchpad` / `checkpoints` 已带 nullable `task_id`（migration 002 / 003，无 FK，是历史债，W5 不补）
- task 不绑 owner agent；所有权信息从最近 `dispatch_request` 推断

### LD-2：Blockers 独立表，不复用 conflicts

`conflict` = 多 agent 写冲突（contention 语义）。`blocker` = 任务内求证（attention 语义）。两者生命周期、解决者、UI 入口都不同。

Phase 2 直接建 `blockers` 表，**不省两天复用 conflicts 表**——一年后改回来代价更大。

### LD-3：Legacy 数据 nullable + `legacy_orphan` 标签，不强行回填

W4 已有的 `dispatch_requests` / `scratchpad` / `checkpoints` 行（不论 task_id 列是 W4 之前就有还是 W5 新加）没有任何 `task_id` 值，不构造 sentinel "legacy task" 回填。

- 新加的 `dispatch_requests.task_id`（migration 008）为 `TEXT NULL`；既有的 `scratchpad.task_id` / `checkpoints.task_id` 也是 `TEXT NULL`
- 新工具（W5 起）创建的数据**必须**带 `task_id`（在工具层校验，不在 DDL 强制）
- Inspector / list 查询遇到 `task_id IS NULL` 的旧行 → 明确标 `legacy_orphan`，不假装它属于某个任务

### LD-4：Outcomes DSL 第一版含独立 `tests_pass` 原语

Phase 3 的 outcomes DSL 第一版至少 7 个原语：

```
file_exists(path)
command_exits_0(cmd)
scratchpad_key_exists(key)
no_open_conflicts(scope?)
regex_matches(file, pattern)
checkpoint_created_after(timestamp)
tests_pass(target)              ← LD-4 锁定独立
```

`tests_pass` 在实现上 compile 成 `command_exits_0`（v1：从 `package.json` 的 `test` script 推导命令；如果是子目录 target，加 `--workspace` / `cwd`）。但产品语义独立——长程 agent 最常见验收就是"测试是否过"，把它命名出来 demo 和 pitch 都更强。

---

## 2. Out of Scope（Phase 1 硬约束）

Phase 1 严格只做 D0。以下属于 Phase 2+，在 Phase 1 任何 task 中不得引入：

- ❌ `blockers` 表 / `cairn.task.block` / `cairn.task.answer` / `cairn.task.resume_packet`（Phase 2）
- ❌ `outcomes` 表 / DSL evaluator / `cairn.outcomes.evaluate` / `cairn.task.submit_for_review`（Phase 3）
- ❌ grader agent 接口（Phase 3+）
- ❌ Dreaming / learnings 表（W6+）
- ❌ Desktop-shell Inspector UI 改动（Phase 1 只做数据模型 + MCP 工具，UI 留 Phase 4）
- ❌ `cairn.task.update_state(state)` 这种自由状态改写工具——**永远不要暴露**，仓储层有 `updateState`，但 MCP 层只暴露语义动词
- ❌ task lineage 的 lead-sub 拆分编排逻辑（schema 支持 parent_task_id，但**不写**派单逻辑——那是 LLM / Claude SDK 的事）
- ❌ 修改 W4 已落地的 5 张表的现有列（只允许 `ALTER TABLE ADD COLUMN`，不改既有列）

---

## 3. State Machine（Phase 1 起 schema-complete，behavior 增量）

`tasks.state` 列的 `CHECK` 约束在 migration 007 一次到位**含全部 8 个状态**——避免后续 phase 再改 schema。但 Phase 1 只暴露**部分 transition**：其他状态 / transition 由 Phase 2 / 3 的工具触发。

### 全状态机（最终态，Phase 1 只激活子集）

```
PENDING ──────────► RUNNING ──┬──► BLOCKED ──────────► READY_TO_RESUME ──► RUNNING
                              │                                         └──► CANCELLED
                              ├──► WAITING_REVIEW ──┬──► DONE
                              │                    ├──► RUNNING (验收不过)
                              │                    └──► FAILED
                              ├──► FAILED
                              └──► CANCELLED

PENDING ──► CANCELLED         (任务还没开始就被取消)
```

### 状态定义

| 状态 | 含义 | 谁能触发进入 |
|---|---|---|
| `PENDING` | 任务已创建，还没有 agent 认领 | `task.create` |
| `RUNNING` | 有 agent 正在推进，或被重新认领 | `task.start_attempt`（Phase 1）/ blocker answered（Phase 2）/ outcomes 不通过重试（Phase 3） |
| `BLOCKED` | 有 open blocker，等用户或其他 agent 答复 | `task.block`（**Phase 2**） |
| `READY_TO_RESUME` | blocker 已答，且当前没有活跃 runner；`resume_packet` 可生成 | `task.answer`（**Phase 2**） |
| `WAITING_REVIEW` | 工作声称完成，正在等 outcomes 验收 | `task.submit_for_review`（**Phase 3**） |
| `DONE` | outcomes 验收通过 | `outcomes.evaluate`（**Phase 3**） |
| `FAILED` | 不可恢复失败（验收终判失败 / 系统错误） | `outcomes.evaluate` / 内部错误（Phase 1 暂不主动写 FAILED，留给后续） |
| `CANCELLED` | 用户主动取消 | `task.cancel`（Phase 1） |

### Phase 1 实际激活的 transitions

```
PENDING ──► RUNNING        (cairn.task.start_attempt)
PENDING ──► CANCELLED      (cairn.task.cancel)
RUNNING ──► CANCELLED      (cairn.task.cancel)
```

其他 transition 在 transition table 中**列出但不可达**——MCP 层没有暴露入口工具。仓储层 `updateState(taskId, to)` 调用时，guard 函数会校验 `from → to` 是否在合法集合内；Phase 1 的合法集合只含上述 3 条 + Phase 2 / 3 预备的全部条目（避免 Phase 2 改 guard）。

### Transition table（TS 常量）

文件：`packages/daemon/src/storage/tasks-state.ts`

```ts
export type TaskState = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'READY_TO_RESUME'
                      | 'WAITING_REVIEW' | 'DONE' | 'FAILED' | 'CANCELLED';

export const VALID_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  PENDING:         new Set(['RUNNING', 'CANCELLED']),
  RUNNING:         new Set(['BLOCKED', 'WAITING_REVIEW', 'FAILED', 'CANCELLED']),
  BLOCKED:         new Set(['READY_TO_RESUME', 'CANCELLED']),
  READY_TO_RESUME: new Set(['RUNNING']),
  WAITING_REVIEW:  new Set(['DONE', 'RUNNING', 'FAILED']),
  DONE:            new Set(),
  FAILED:          new Set(),
  CANCELLED:       new Set(),
};

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!VALID_TRANSITIONS[from].has(to)) {
    throw new Error(`Invalid task state transition: ${from} -> ${to}`);
  }
}
```

终态：`DONE` / `FAILED` / `CANCELLED`——空 set，进入后不可再变。

---

## 4. File Structure（Phase 1）

```
packages/daemon/                                     # exists
├── src/
│   └── storage/
│       ├── types.ts                                 # MODIFY (add TaskRow, TaskState re-export)
│       ├── tasks-state.ts                           # NEW (state enum + VALID_TRANSITIONS + assertTransition)
│       ├── migrations/
│       │   ├── index.ts                             # MODIFY (append 007 + 008)
│       │   ├── 007-tasks.ts                         # NEW
│       │   └── 008-dispatch-task-id.ts              # NEW (dispatch_requests only)
│       ├── repositories/
│       │   ├── tasks.ts                             # NEW
│       │   └── dispatch-requests.ts                 # MODIFY (add task_id input + row + index)
│       │   # scratchpad.ts        — NO CODE CHANGE (task_id 列已在 migration 002，putScratch 已支持)
│       │   # checkpoints.ts       — NO CODE CHANGE (task_id 列已在 migration 003，createPendingCheckpoint 已支持)
└── tests/
    └── storage/
        ├── migrations.test.ts                       # MODIFY (add 007 + 008 schema verification)
        ├── tasks.test.ts                            # NEW (repository CRUD + transition guard)
        ├── tasks-state.test.ts                      # NEW (state machine pure unit tests)
        ├── dispatch-task-id.test.ts                 # NEW — 新功能：dispatch_requests.task_id round-trip
        ├── scratchpad-task-id.test.ts               # NEW — verify 既有：putScratch task_id round-trip
        └── checkpoints-task-id.test.ts              # NEW — verify 既有：createPendingCheckpoint task_id round-trip

packages/mcp-server/                                 # exists
├── src/
│   ├── tools/
│   │   └── task.ts                                  # NEW (5 tools: create / get / list / start_attempt / cancel)
│   └── index.ts                                     # MODIFY (register task tools)
└── tests/
    ├── tools/
    │   └── task.test.ts                             # NEW (5 acceptance tests)
    └── inspector-legacy-orphan.test.ts              # NEW (verify legacy_orphan label on null task_id)

docs/superpowers/diagrams/                           # NEW dir
└── w5-task-state.svg                                # NEW (state diagram, hand-drawn ok, committed)
```

每个新文件单一职责。`tasks-state.ts` 是纯 TS 常量 + guard，无 I/O，便于 unit test。仓储层 `tasks.ts` 是纯 SQL，状态校验委托 `assertTransition`。

---

## 5. Day-by-day 任务分解（Phase 1，~5 工作日）

### 5.1 Day 1 — Schema + State Machine 骨架

#### Task 5.1.1：起草 migration 007（tasks 表）

**目标**：tasks 表 DDL 落地，CHECK 约束含全部 8 个状态。

- [ ] **Step 1**：起 fresh subagent（sonnet），交付 `packages/daemon/src/storage/migrations/007-tasks.ts`：
  ```sql
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    intent TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','BLOCKED','READY_TO_RESUME','WAITING_REVIEW','DONE','FAILED','CANCELLED')),
    parent_task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by_agent_id TEXT,
    metadata_json TEXT
  );
  CREATE INDEX idx_tasks_state ON tasks(state);
  CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
  CREATE INDEX idx_tasks_created_at ON tasks(created_at);
  ```
- [ ] **Step 2**：在 `migrations/index.ts` 的 `ALL_MIGRATIONS` 数组按 version 顺序追加 007（不要插队）
- [ ] **Step 3**：在 `tests/storage/migrations.test.ts` 末尾追加 schema 测试（`PRAGMA table_info(tasks)` + CHECK 约束验证 + index 存在性）
- [ ] **Step 4**：跑 `cd packages/daemon && npm test` 确认绿
- [ ] **DoD**：`npm test` 全绿；新增至少 4 个 assertion（列存在性 / 类型 / CHECK / index）

#### Task 5.1.2：起草 migration 008（dispatch_requests.task_id）

**目标**：只给 `dispatch_requests` 加 nullable `task_id` + index。`scratchpad.task_id` 已在 migration 002 / `checkpoints.task_id` 已在 migration 003（含 index），都是 W1/P3 偏离时落的，**无 FK，是历史债**——本 plan §9 风险表说明，W5 Phase 1 不补、不重建表。

- [ ] **Step 1**：交付 `packages/daemon/src/storage/migrations/008-dispatch-task-id.ts`：
  ```sql
  ALTER TABLE dispatch_requests ADD COLUMN task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL;
  CREATE INDEX idx_dispatch_requests_task_id ON dispatch_requests(task_id);
  ```
  > **注意**：SQLite `ALTER TABLE ADD COLUMN` 对 FK 约束的支持依赖版本与 pragma 状态（`foreign_keys` 必须开启才生效）。`better-sqlite3@^12.9.0` 一般可用；不可用时降级方案：去掉 `REFERENCES`，依靠应用层校验（写入 task_id 时先在 tasks 表查存在性）。**先尝试带 FK，不行再降级**，降级时在文件 header 注释说明（与 P1 / P2 处理 lanes / checkpoints 历史 FK 偏离同一风格）。
- [ ] **Step 2**：在 `tests/storage/migrations.test.ts` 末尾追加：
  - `dispatch_requests` 有 `task_id` 列、TEXT、可为 NULL；`idx_dispatch_requests_task_id` 索引存在
  - **零退化验证**：`scratchpad.task_id` / `checkpoints.task_id` 列与对应 index（`idx_scratchpad_task_id` / `idx_checkpoints_task_id`）仍存在
- [ ] **Step 3**：写一个 fresh DB 上跑 migration 001-008 的端到端测试（已有 helper）
- [ ] **DoD**：migration 顺序运行成功；`dispatch_requests.task_id` 可写 NULL 也可写有效 task_id；FK 约束（如可用）拦截无效 task_id；scratchpad / checkpoints 既有 task_id 行为零退化

#### Task 5.1.3：state machine 纯单元测试

**目标**：`tasks-state.ts` + `tasks-state.test.ts` 落地，确保 Phase 2 / 3 改不动 transition 逻辑（除非 Phase 2 / 3 显式扩展）。

- [ ] **Step 1**：交付 `packages/daemon/src/storage/tasks-state.ts`（按 §3 中的代码）
- [ ] **Step 2**：交付 `packages/daemon/tests/storage/tasks-state.test.ts`：
  - 8 个状态各自的合法 transition 全部通过
  - 每个状态至少 2 条非法 transition 被 throw 拦截
  - 终态（DONE / FAILED / CANCELLED）任何 transition 都被拦截
- [ ] **DoD**：≥ 30 个 assertion；`npm test` 全绿

---

### 5.2 Day 2 — tasks 仓储层

#### Task 5.2.1：tasks repository

**目标**：`packages/daemon/src/storage/repositories/tasks.ts` 提供纯 SQL 接口，状态变更走 `assertTransition`。

- [ ] **Step 1**：交付 `tasks.ts` 暴露（**仅以下 5 个 verb**；任何"自由 metadata patch" / "自由 state set" API 都不导出）：
  ```ts
  export function createTask(db, input: { intent: string; parent_task_id?: string; created_by_agent_id?: string; metadata?: Record<string, unknown> }): TaskRow
  export function getTask(db, taskId: string): TaskRow | null
  export function listTasks(db, filter?: { state?: TaskState | TaskState[]; parent_task_id?: string | null; limit?: number }): TaskRow[]
  export function updateTaskState(db, taskId: string, to: TaskState): TaskRow      // pure: assertTransition + 写 state/updated_at，不动 metadata
  export function cancelTask(db, taskId: string, reason?: string): TaskRow         // verb: 单一事务内 state→CANCELLED + metadata.cancel_reason / cancelled_at
  export function getTaskTree(db, rootTaskId: string): TaskRow[]                   // BFS, 含根

  // ⚠️ NOT exported (module-private)：
  // function mergeMetadataInTx(db, taskId, patch): void
  //   - 给 verb-specific repo function 内部组合"state + metadata 原子写"用
  //   - Phase 2 的 recordBlocker / markAnswered 等 verb 复用此 helper
  //   - 不暴露通用 metadata patch API，避免重新打开"自由 metadata 写"后门（与 MCP 层不暴露 update_state 同一原则）
  ```
- [ ] **Step 2**：`createTask` 默认 state = 'PENDING'，自动生成 `task_id`（沿用 `ulid` / 现有 `ids.ts` 风格）；`created_at` / `updated_at` 写 `Date.now()`（INTEGER unix ms，与现有所有表一致）
- [ ] **Step 3a**：`updateTaskState` 在事务里读旧 state → 调 `assertTransition(old, to)` → 写新 state + `updated_at`（**不动 metadata**）
- [ ] **Step 3b**：实现 module-private `mergeMetadataInTx(db, taskId, patch)`：在事务里读旧 metadata_json → deep-merge patch → 写回 + 更新 `updated_at`（不变 state）
- [ ] **Step 3c**：实现 `cancelTask(db, taskId, reason?)`：在**单一事务**内调 `updateTaskState(taskId, 'CANCELLED')` + `mergeMetadataInTx(taskId, { cancel_reason: reason ?? null, cancelled_at: Date.now() })`。事务失败时**两个写都回滚**（不允许 state=CANCELLED 而 metadata 没记下 reason 的撕裂态）
- [ ] **Step 4**：交付 `tests/storage/tasks.test.ts`：
  - createTask + getTask round-trip（metadata JSON 序列化、created_at/updated_at 为 number）
  - listTasks 三种 filter（state / parent_task_id / limit）
  - updateTaskState 合法 transition 写入成功
  - updateTaskState 非法 transition throw
  - cancelTask happy path × 2（PENDING→CANCELLED / RUNNING→CANCELLED）：state 变 + cancel_reason 写入 + cancelled_at 写入
  - cancelTask 从终态（DONE/FAILED/CANCELLED）调用 → throw（assertTransition 兜住）
  - cancelTask 事务原子性：mock `mergeMetadataInTx` 内 throw → state 不应留在 CANCELLED（验证回滚）
  - getTaskTree 返回根 + 所有后代（造 3 层树验证）
  - parent_task_id 设为不存在的 task → FK 约束拒绝（如果 FK 可用）
- [ ] **DoD**：≥ 14 个 test case；`mergeMetadataInTx` 不出现在 `tasks.ts` 的 export list（grep 验证）；`npm test` 全绿

#### Task 5.2.2：dispatch_requests 加 task_id；scratchpad/checkpoints 既有行为补测

**目标**：
- `dispatch_requests`：新增 task_id 写入路径（仓储接口 + 类型 + raw row）
- `scratchpad` / `checkpoints`：task_id 列已存在（migration 002 / 003），`putScratch` / `createPendingCheckpoint` 已支持。本任务**不改这两个仓储源码**，只补 round-trip 测试（防回归 + 给 LD-3 legacy_orphan 标签留靠谱基线）

- [ ] **Step 1**：修改 `repositories/dispatch-requests.ts`：
  - `CreateDispatchRequestInput` 增加 `taskId?: string | null`
  - `createDispatchRequest` 写入时带 task_id；不传则写 NULL（legacy 兼容）
  - `DispatchRequestRowRaw` 与 `DispatchRequest` 类型加 `task_id: string | null`
  - `toDispatchRequest` 透传 task_id
- [ ] **Step 2**：**确认**（不改源码）`repositories/scratchpad.ts` 的 `putScratch` / `PutScratchInput` 已支持 `task_id`（已确认见 W1 落地）；如发现回归则修，否则源码 git diff 应为空
- [ ] **Step 3**：**确认**（不改源码）`repositories/checkpoints.ts` 的 `createPendingCheckpoint` 已支持 `task_id`；同上
- [ ] **Step 4**：新建 3 个测试文件：
  - `tests/storage/dispatch-task-id.test.ts`（**新功能**）：不传 task_id → NULL；传有效 task_id → round-trip；传不存在 task_id → FK 拒绝（如可用）
  - `tests/storage/scratchpad-task-id.test.ts`（**verify 既有**）：putScratch 传 task_id → 读回值匹配；不传 → NULL；W4 旧测试零退化
  - `tests/storage/checkpoints-task-id.test.ts`（**verify 既有**）：createPendingCheckpoint 传 task_id → 读回值匹配；不传 → NULL；W4 旧测试零退化
- [ ] **DoD**：3 个新测试文件每个 ≥ 3 个 case；W4 已有测试零退化；**`packages/daemon/src/storage/repositories/scratchpad.ts` 和 `checkpoints.ts` 的 git diff 为空**（git status 验证）

---

### 5.3 Day 3 — MCP 工具层（5 个语义动词）

#### Task 5.3.1：cairn.task.create / get / list

**目标**：MCP 暴露 3 个 read/create 工具。

- [ ] **Step 1**：交付 `packages/mcp-server/src/tools/task.ts`，定义 schema + handler：
  - `cairn.task.create` — input: `{ intent: string; parent_task_id?: string; metadata?: object }` → output: `{ task: TaskRow }`
  - `cairn.task.get` — input: `{ task_id: string }` → output: `{ task: TaskRow | null }`
  - `cairn.task.list` — input: `{ state?: TaskState | TaskState[]; parent_task_id?: string | null; limit?: number }` → output: `{ tasks: TaskRow[] }`
- [ ] **Step 2**：所有工具用 SESSION_AGENT_ID 自动注入逻辑（见 CLAUDE.md "Phase 1-4 落地约定"）作为 `created_by_agent_id` 默认值
- [ ] **Step 3**：注册到 `mcp-server/src/index.ts` 的 tool list
- [ ] **Step 4**：写 acceptance test `tests/tools/task.test.ts`：
  - create → get round-trip
  - create with parent_task_id → list with parent filter 命中
  - list with state filter 命中 / 不命中
- [ ] **DoD**：3 个 acceptance test；`cd packages/mcp-server && npm test` 全绿

#### Task 5.3.2：cairn.task.start_attempt / cancel

**目标**：暴露 Phase 1 仅有的 2 个状态变更动词。**绝不暴露 update_state**。

- [ ] **Step 1**：在 `tools/task.ts` 追加：
  - `cairn.task.start_attempt` — input: `{ task_id: string }` → 调 `updateTaskState(task_id, 'RUNNING')`（依赖 transition guard 保证只能从 PENDING / READY_TO_RESUME 进入）→ output: `{ task: TaskRow }`
  - `cairn.task.cancel` — input: `{ task_id: string; reason?: string }` → 调**仓储动词** `cancelTask(task_id, reason)`（不调 `updateTaskState`，否则 metadata 不会被原子写入）；guard 拒绝从终态取消（throw 友好错误）→ output: `{ task: TaskRow }`
- [ ] **Step 2**：错误路径必须 user-friendly：transition 拒绝时返回 `{ error: { code: 'INVALID_STATE_TRANSITION', from, to, message } }` 不直接 throw 到 stdio
- [ ] **Step 3**：acceptance test：
  - PENDING → start_attempt → RUNNING
  - RUNNING → start_attempt → 拒绝（错误 code 正确）
  - PENDING → cancel → CANCELLED
  - RUNNING → cancel → CANCELLED（reason 写入 metadata）
  - DONE/FAILED/CANCELLED → cancel → 拒绝
- [ ] **DoD**：5 个 acceptance test；错误 code 统一为 `INVALID_STATE_TRANSITION`；`update_state` 不出现在 tool list 中（`grep -r "update_state" packages/mcp-server/src` 应零结果）

---

### 5.4 Day 4 — Legacy Orphan 标签 + Inspector 兼容

#### Task 5.4.1：Inspector 查询的 legacy_orphan 标记

**目标**：现有 `cairn.inspector.query` 返回 dispatch / scratchpad / checkpoint 行时，`task_id IS NULL` 的行附加 `_label: 'legacy_orphan'`。

- [ ] **Step 1**：定位现有 inspector 工具（`packages/mcp-server/src/tools/inspector.ts`），在结果序列化前添加：
  ```ts
  function annotateLegacy(row: { task_id: string | null }) {
    return row.task_id == null
      ? { ...row, _label: 'legacy_orphan' }
      : row;
  }
  ```
- [ ] **Step 2**：scratchpad / dispatch / checkpoint 三类查询都套上 annotateLegacy
- [ ] **Step 3**：交付 `tests/inspector-legacy-orphan.test.ts`：
  - 在 fresh DB 上手动写一条 task_id = NULL 的 scratchpad → query 返回带 `_label: 'legacy_orphan'`
  - 写一条 task_id 有值的 → 不带 `_label`
- [ ] **DoD**：2 个 case 通过；其他 inspector 测试零退化

#### Task 5.4.2：State diagram 落盘

**目标**：把 §3 的状态机画成 SVG，承诺这是产品契约的一部分。

- [ ] **Step 1**：起 `docs/superpowers/diagrams/` 目录
- [ ] **Step 2**：用 Mermaid 或手画 SVG 都可。建议 Mermaid（文本可 diff）：
  ```mermaid
  stateDiagram-v2
      [*] --> PENDING : task.create
      PENDING --> RUNNING : task.start_attempt
      PENDING --> CANCELLED : task.cancel
      RUNNING --> BLOCKED : task.block (Phase 2)
      RUNNING --> WAITING_REVIEW : task.submit_for_review (Phase 3)
      RUNNING --> CANCELLED : task.cancel
      RUNNING --> FAILED : (system)
      BLOCKED --> READY_TO_RESUME : task.answer (Phase 2)
      BLOCKED --> CANCELLED : task.cancel
      READY_TO_RESUME --> RUNNING : task.start_attempt
      WAITING_REVIEW --> DONE : outcomes.evaluate pass (Phase 3)
      WAITING_REVIEW --> RUNNING : outcomes.evaluate fail (Phase 3)
      WAITING_REVIEW --> FAILED : outcomes terminal fail (Phase 3)
      DONE --> [*]
      FAILED --> [*]
      CANCELLED --> [*]
  ```
- [ ] **Step 3**：commit 进 `docs/superpowers/diagrams/w5-task-state.md`（Mermaid 在 markdown 里渲染最方便）
- [ ] **DoD**：图覆盖 §3 全部 transition；Phase 1 激活的 transition 用实线，Phase 2 / 3 引入的用虚线或注明 (Phase X)

---

### 5.5 Day 5 — Live Dogfood + 文档收尾

#### Task 5.5.1：Live dogfood — 跨 process 任务接力（半模拟）

**目标**：Phase 1 的最小可演示场景：用 `cairn.task.create` 创建一个任务、让一个 mcp client 调 `start_attempt`、用另一个 client 调 `cancel`、确认两端看到一致的状态。**不要靠单测交差**（参见 memory: live dogfood beats unit tests）。

- [ ] **Step 1**：跑实际场景（在你自己的开发会话中）：
  1. 起 mcp-server (`node packages/mcp-server/dist/index.js`)
  2. 在 Claude Code session A 调 `cairn.task.create({ intent: "demo: refactor utils" })` → 得 task_id
  3. 在 session A 调 `cairn.task.start_attempt(task_id)` → 状态 PENDING → RUNNING
  4. 在 session B（重启 mcp client 或用 inspector）调 `cairn.task.get(task_id)` → 看到 RUNNING
  5. 在 session B 调 `cairn.task.cancel(task_id, "demo cancel")` → CANCELLED
  6. 在 session A 重新 `get` → 看到 CANCELLED + reason in metadata
- [ ] **Step 2**：把上述 6 步写成 `docs/superpowers/demos/W5-phase1-task-handoff.md`，每步贴实际 MCP 调用 + 返回 JSON
- [ ] **DoD**：demo 文档存在；6 步全部成功；任意 1 步失败必须 root-cause + 修，**不能跳**

#### Task 5.5.2：PRODUCT.md pitch 微调（仅一段）

**目标**：在 PRODUCT.md §0 TL;DR 或 §5 末尾追加一句新 pitch，预告 W5 全部完成后的产品故事。**不大改 PRODUCT.md**——大改留 W5 Phase 4 收尾时统一。

- [ ] **Step 1**：找 PRODUCT.md §0 TL;DR 末尾，追加一段（中文）：
  > **W5 起，Cairn 进入"长程任务 OS"阶段**：每个长程任务建模为可暂停、可接力、可验收、可回滚的 Task Capsule。当前 Phase 1 已交付任务生命线骨架（`tasks` 表 + 5 个语义动词）；Phase 2 加 blockers + resume packet，Phase 3 加 outcomes 验收。最终 pitch：**Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**
- [ ] **Step 2**：不要改 §3 / §5 / §6 / §10 的现有内容——那是 W4 dogfood 9.9/10 验过的，留待 W5 全部完成再更新
- [ ] **DoD**：PRODUCT.md 仅加一段；`git diff PRODUCT.md` 行数 ≤ 6

#### Task 5.5.3：Phase 1 验收 + Phase 2 plan 草稿

- [ ] **Step 1**：跑全套：
  ```
  cd packages/daemon && npm test && npx tsc --noEmit
  cd packages/mcp-server && npm test && npx tsc --noEmit
  ```
  两边都要绿。
- [ ] **Step 2**：起草 `docs/superpowers/plans/2026-05-14-w5-phase2-blockers-resume.md`（仅大纲，详细 plan Phase 2 启动时写）：
  - blockers 表 schema
  - resume_packet JSON 协议（已在本 plan §6 草拟）
  - 5 个新工具：block / answer / resume_packet / list_blockers / get_blocker
  - Phase 1 → Phase 2 数据迁移（应该是零迁移，blockers 是新表）
- [ ] **DoD**：测试 + tsc 全绿；Phase 2 草稿 ≥ 50 行框架

---

## 6. Resume Packet 协议（Phase 2 预定义，Phase 1 仅占位）

Phase 2 才实现，但为了 Phase 1 的工具签名稳定，**协议在本 plan 中先冻结**。Phase 2 直接按这个 schema 实现，不另开讨论。

```jsonc
{
  "task_id": "ulid",
  "intent": "原始用户意图（来自 tasks.intent）",
  "current_state": "BLOCKED" | "READY_TO_RESUME" | "WAITING_REVIEW",
  "last_checkpoint_sha": "git stash sha 或 null",
  "open_blockers": [
    { "blocker_id": "...", "question": "...", "context_keys": ["scratchpad/..."], "raised_at": "ISO" }
  ],
  "answered_blockers": [
    { "blocker_id": "...", "question": "...", "answer": "...", "answered_by": "agent_id|user", "answered_at": "ISO" }
  ],
  "scratchpad_keys": ["subagent/.../result", ...],
  "outcomes_criteria": [
    { "primitive": "tests_pass", "args": ["packages/daemon"] }, ...
  ],
  "audit_trail_summary": "markdown 字符串，自动从 dispatch_requests + checkpoints + conflicts 拼"
}
```

**重要**：这是 **structured artifact**，不是 prompt。调用方（Claude session / Codex / Inspector UI）自己决定怎么消费。Cairn 不生成自然语言 prompt 喂给 agent——那是 framework 的事。

---

## 7. Phase 2-4 概览（W5 全周计划，详细 plan 各自启动时写）

### Phase 2（~1w）：Blockers + Resume Packet

- migration 009：blockers 表（独立，**不复用 conflicts**）
- 工具：`cairn.task.block` / `answer` / `resume_packet`
- transition 激活：RUNNING → BLOCKED → READY_TO_RESUME → RUNNING
- resume_packet 按 §6 协议实现 + JSON validator
- Demo：跨天/跨 session 的 block-answer-resume 闭环

### Phase 3（~1.5w）：Outcomes

- migration 010：outcomes 表 + criteria DSL JSON
- 7 个原语 evaluator（含 LD-4 锁定的 `tests_pass`）
- 工具：`cairn.task.submit_for_review` / `cairn.outcomes.evaluate`
- transition 激活：RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED
- Grader agent 接口预留 hook（不实现）
- Demo：声明 success criteria → 自动验收 → 不过则回 RUNNING

### Phase 4（3-5d）：完整闭环 Demo + 文档收尾

- 跑通完整故事：用户发起重构 → task.create → checkpoint → agent block → 跨天 → 接力 agent resume → submit_for_review → outcomes.evaluate (tests_pass) → 不过则 rewind 重试
- 写成 `docs/superpowers/demos/W5-task-capsule.md`（取代 Phase 1 的 demo）
- PRODUCT.md 主 pitch 升级（这次大改）
- Inspector UI 改动（如果 desktop-shell 团队 / 你自己有时间）—— 可推迟到 W6

---

## 8. Demo 闭环（Phase 4 收尾时跑通的故事）

这条故事跑通即 W5 整体 done。Phase 1 不需要支撑全程，但每个 Phase 末必须能跑到对应里程碑。

> **场景**：用户启动一个跨天的复杂重构任务。
>
> 1. 用户：`task.create({ intent: "把 daemon 的 lanes 模块重构成 trait 风格", outcomes: [tests_pass("packages/daemon"), no_open_conflicts()] })` → task_id `T-001`，PENDING
> 2. Claude session A：`task.start_attempt(T-001)` → RUNNING；做了一半发现需要决策："要不要保留旧的 sync API？"
> 3. session A：`task.block(T-001, question="保留旧 sync API 吗？", context_keys=["scratchpad/T-001/old-api-survey"])` → BLOCKED
> 4. **session A 退出**（用户去睡觉了）
> 5. 第二天，用户：`task.answer(blocker_id, "保留，加 deprecation 注释")` → READY_TO_RESUME
> 6. Claude session B（不同机器、不同 agent）：`task.resume_packet(T-001)` → 拿到结构化 packet → `task.start_attempt(T-001)` → RUNNING
> 7. session B 完成代码：`task.submit_for_review(T-001)` → WAITING_REVIEW
> 8. Cairn 自动跑 `outcomes.evaluate(T-001)` → `tests_pass("packages/daemon")` 失败（有 1 个 test red）→ 回 RUNNING + 自动写 conflict（验收失败的证据）
> 9. session B 修测试 → submit_for_review → outcomes 通过 → DONE
>
> 全程 task_id `T-001` 是唯一的"任务身份"。session、agent、机器全可换。

**这条 demo 跑通时，Cairn 的 pitch 升级落地：**

> **Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| SQLite ALTER TABLE ADD COLUMN 不支持 FK | 中 | 中 | Migration 008 先尝试带 FK；不行降级为应用层校验，文件 header 注明 |
| 既有 `scratchpad.task_id` / `checkpoints.task_id` 无 FK（W1/P3 历史债） | 高（已存在） | 低 | **W5 Phase 1 不补 FK，也不重建表**——SQLite 给已有列补 FK 需要 table rebuild，超出 Phase 1 schema-safe 改动原则。新写入路径靠应用层校验存在性；新 `dispatch_requests.task_id` 是否带 FK 以 SQLite ALTER 支持情况为准，统一走应用层 fallback。FK 全面补全留 v0.2 表重建窗口 |
| Transition guard 漏写某条合法 transition | 中 | 高 | tasks-state.test.ts 至少 30 个 assertion，覆盖 8×8 矩阵的关键格子 |
| Phase 1 暴露了不该暴露的状态改写 / metadata 改写动词 | 低 | 高 | DoD 明确 grep `update_state` 在 mcp tool list 应零结果；`mergeMetadataInTx` 在 `repositories/tasks.ts` export list 应零结果（保持模块私有）；code review 强制查两份 list |
| Legacy orphan 标记泄漏到生产数据写入 | 低 | 中 | annotateLegacy 仅在读路径用，写路径不接受 `_label`；test 显式验 |
| Phase 1 周期超 1 周 | 中 | 中 | 5 个 task 单独可派 fresh sonnet，并行不依赖；超期立刻砍 5.4.2 状态图（推迟到 Phase 2） |
| Resume packet 协议 Phase 2 改动 | 中 | 低 | §6 协议**冻结在本 plan**，Phase 2 不重新讨论；如需调整必须开 ADR |
| `tests_pass` 原语在 monorepo 多 workspace 下推导命令困难 | 中 | 低 | Phase 3 v1 直接读项目根 `package.json` 的 `test` script；workspace 支持留 v2 |

---

## 10. Phase 1 完成判据（DoD 总览）

全部满足才算 Phase 1 done：

- [ ] migration 007 + 008 落地，daemon 测试全绿（含 ≥ 6 个新 schema test）
- [ ] `tasks-state.ts` + 单测 ≥ 30 assertion 全绿
- [ ] `repositories/tasks.ts` + 单测 ≥ 14 case 全绿（含 cancelTask 原子性回滚测试）
- [ ] `cancelTask` 通过仓储动词暴露；`mergeMetadataInTx` 保持模块私有（grep `tasks.ts` export list 验证）
- [ ] `dispatch_requests` 仓储层新增 task_id 接受路径；`scratchpad` / `checkpoints` 仓储**源码 git diff 为空**（既有 task_id 行为只补测试）；3 个新测试文件全绿，W4 旧测试零退化
- [ ] `cairn.task.create / get / list / start_attempt / cancel` 5 个 MCP 工具落地，acceptance test ≥ 8 case 全绿
- [ ] `update_state` 工具**不存在**于 MCP tool list（grep 验证）
- [ ] Inspector legacy_orphan 标签生效，test ≥ 2 case 通过
- [ ] State diagram 落 `docs/superpowers/diagrams/w5-task-state.md`
- [ ] Live dogfood 6 步全部跑通，写入 `docs/superpowers/demos/W5-phase1-task-handoff.md`
- [ ] PRODUCT.md 追加 1 段 W5 预告（≤ 6 行 diff）
- [ ] `cd packages/daemon && npm test && npx tsc --noEmit` 绿
- [ ] `cd packages/mcp-server && npm test && npx tsc --noEmit` 绿
- [ ] Phase 2 plan 草稿框架 ≥ 50 行

---

## 附录 A：Tool 动词与状态机映射（Phase 1-3 全景）

| 工具 | Phase | from | to | 备注 |
|---|---|---|---|---|
| `cairn.task.create` | 1 | (none) | PENDING | 入口 |
| `cairn.task.start_attempt` | 1 | PENDING | RUNNING | 首次启动 |
| `cairn.task.start_attempt` | 2 | READY_TO_RESUME | RUNNING | resume 后接力 |
| `cairn.task.cancel` | 1 | PENDING/RUNNING/BLOCKED/READY_TO_RESUME/WAITING_REVIEW | CANCELLED | Phase 1 暂只测前两种，但 schema 支持 |
| `cairn.task.block` | 2 | RUNNING | BLOCKED | 求证 |
| `cairn.task.answer` | 2 | BLOCKED | READY_TO_RESUME | 答复 |
| `cairn.task.resume_packet` | 2 | (read-only) | (read-only) | 不改状态，生成结构化 packet |
| `cairn.task.submit_for_review` | 3 | RUNNING | WAITING_REVIEW | 声称完成 |
| `cairn.outcomes.evaluate` | 3 | WAITING_REVIEW | DONE / RUNNING / FAILED | grader 决断 |

**永不暴露**：`cairn.task.update_state` —— 任何允许任意状态改写的工具都是反模式。

---

## 附录 B：Migration 编号（DESIGN_STORAGE.md §17.1 同步）

| Migration | 主题 | 状态 |
|---|---|---|
| 001 | init (lanes / ops / compensations) | ✅ 已落地 |
| 002 | scratchpad（含 task_id 列，无 FK） | ✅ 已落地 |
| 003 | checkpoints（含 task_id 列，无 FK） | ✅ 已落地（W1 偏离） |
| 004 | processes / conflicts | ✅ 已落地（W4 Day 1） |
| 005 | dispatch_requests | ✅ 已落地（W4 Day 1） |
| 006 | conflicts.PENDING_REVIEW | ✅ 已落地（W4 Phase 2） |
| **007** | **tasks** | **🟡 W5 Phase 1（本 plan）** |
| **008** | **dispatch_requests.task_id**（scratchpad/checkpoints 在 002/003 已带 task_id 列，W5 Phase 1 不重建） | **🟡 W5 Phase 1（本 plan）** |
| 009 | blockers | 🔵 W5 Phase 2（计划中） |
| 010 | outcomes | 🔵 W5 Phase 3（计划中） |

W5 Phase 1 完成后，下一个可用 migration 编号是 **009**。
