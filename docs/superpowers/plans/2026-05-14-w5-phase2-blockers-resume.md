# Cairn v0.1 · W5 Phase 2 计划（Blockers + Resume Packet — 闭环：RUNNING → BLOCKED → READY_TO_RESUME → RUNNING）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把 Task Capsule 的"暂停-接力"语义从 Phase 1 schema 已支持的概念变成可用的 MCP 动词。**Phase 2 唯一目标是把这一条状态闭环跑通：`RUNNING → BLOCKED → READY_TO_RESUME → RUNNING`**。任何不在这条闭环上的功能（UI、outcomes 验收、dreaming、多轮 blocker 对话、自动派单）都**不做**。Phase 2 完成时 Cairn 真的能让一个任务"在 session A 停下、过一晚、在 session B 接力"，且这条 handoff 通过真实 MCP stdio + 双 child process 实测验证。

**Architecture**：Phase 1 已 schema-complete 状态机（`tasks-state.ts` `VALID_TRANSITIONS` 8 状态全写）+ 6 仓储动词 + 5 MCP 工具。Phase 2 新增 `blockers` 表（migration 009，独立表，**不复用 conflicts**——Phase 1 LD-2 已锁），仓储层 2 verb 暴露 + 私有 helper 复用 Phase 1 `mergeMetadataInTx` 风格，MCP 层 3 个新工具：`cairn.task.block` / `cairn.task.answer` / `cairn.task.resume_packet`。前两者激活 transition；resume_packet 是 read-only 结构化 artifact 生成，不改状态。

**Tech Stack**：与 Phase 1 同——Node.js 24 / TypeScript strict ESM / `better-sqlite3@^12.9.0` / `@modelcontextprotocol/sdk@^1`。无新依赖（resume packet schema 用手写 validator，不引 zod / ajv）。

**Spec 来源**：
- Phase 1 plan：`docs/superpowers/plans/2026-05-07-w5-task-capsule.md`（特别是 §3 状态机、§6 Resume Packet 协议**已冻结**、§9 风险表、§10 DoD）
- Phase 1 dogfood：`docs/superpowers/demos/W5-phase1-task-handoff.md` + `packages/mcp-server/scripts/w5-phase1-dogfood.mjs`
- 既有代码：`packages/daemon/src/storage/tasks-state.ts`（VALID_TRANSITIONS 已含 BLOCKED / READY_TO_RESUME 全部转换，Phase 2 不改）
- 既有代码：`packages/daemon/src/storage/repositories/tasks.ts`（`updateTaskState`、`mergeMetadataInTx` 风格，Phase 2 复用）
- `CLAUDE.md` Phase 1-4 落地约定（SESSION_AGENT_ID 注入、INTEGER unix ms 时间字段）

**配套技能**：
- `superpowers:subagent-driven-development` — 每个独立 task 派 fresh sonnet
- `superpowers:verification-before-completion` — Day 末验收 + 闭环 dogfood 验证
- `superpowers:writing-plans` — Day 5 起草 Phase 3 stub 时使用

---

## 1. Locked Decisions（不可在 Phase 2 重新讨论）

### 从 Phase 1 继承（不重审）

- **LD-1**：Task 是一等公民，进程/会话/agent 都可换。Phase 2 的 blocker 也挂在 task 上，**不**绑某个 agent 实例。
- **LD-2**：Blockers 用独立表，**不复用 conflicts**——本 Phase 兑现这条决定。
- **LD-3**：legacy_orphan 标签策略只在 read 路径用。Phase 2 的 blockers 是**新表**，所有行强制 `task_id NOT NULL`，**不存在** legacy 兼容窟窿。
- **LD-4**：tests_pass 等 outcomes 原语 Phase 2 **不触碰**——是 Phase 3 资产。
- **MCP 层 verb-only**：永不暴露 `update_state` / `set_blocker_status` 等任意状态写工具。Phase 2 新增 3 个工具全部是动词。
- **仓储层 verb-only**：私有 helper 用 `mergeMetadataInTx` 等模块私有函数，公开 API 只暴露动词。

### Phase 2 新锁（首次出现）

- **LD-5**：Resume packet 的 JSON schema 已在 Phase 1 plan §6 冻结。Phase 2 **逐字段实现**，不改字段名、不删字段、不加字段。如发现需要变动，必须开 ADR。
- **LD-6**：`recordBlocker`（仓储 verb）原子写入"`tasks.state` RUNNING→BLOCKED + insert blockers(OPEN)"，二者在同一 `db.transaction()` 内，任一失败都回滚。沿用 Phase 1 `cancelTask` 的原子性测试范式（黑盒：mock 内部 throw，验证两边都没动）。
- **LD-7**：`markAnswered`（仓储 verb）的状态升级逻辑：写完 blocker.ANSWERED 后，**精确**查询该 task 还有几个 OPEN blocker。**0 个**才升 `BLOCKED → READY_TO_RESUME`；**>0** 则 task 状态保持 `BLOCKED`。这一规则把"多 blocker 等多个答复"的语义钉住，未来即使支持多 blocker 场景也不需重写。
- **LD-8**：MCP 层只暴露 3 个工具：`block` / `answer` / `resume_packet`。**不**暴露 `list_blockers` / `get_blocker` —— blocker 的访问只走 `resume_packet`（聚合视图）。这是为了避免给 agent 提供"绕过 task 上下文直接操作 blocker"的口子。
- **LD-9**：Resume packet 生成是 **read-only**。绝不在生成 packet 时附带写操作（如 audit logging、metric counter）。这条保 Inspector 等只读路径调用 packet 生成无副作用。

---

## 2. Out of Scope（Phase 2 硬约束）

Phase 2 严格只做闭环。以下属于 Phase 3+ 或永久不做：

- ❌ Outcomes 表 / DSL evaluator / grader agent / `cairn.outcomes.evaluate`（**Phase 3**）
- ❌ Inspector UI / desktop-shell 改动（**Phase 4 收尾**或推迟到 W6）
- ❌ Multi-turn blocker conversation（一个 blocker 多轮 Q/A）—— v1 只支持单轮
- ❌ Blocker 自动 SUPERSEDED / 时效过期 / 依赖关系图（v1 不做；schema 留 SUPERSEDED 状态值给未来）
- ❌ Blocker 升级 / 降级（不允许把 ANSWERED 改回 OPEN）
- ❌ 通知机制 / 提醒 / push（Inspector 用户主动看就够了，不发邮件不发 webhook）
- ❌ Dreaming / learnings 表 / pattern extractor（W6+）
- ❌ `cairn.task.list_blockers` / `cairn.task.get_blocker` MCP 工具（LD-8 锁定，所有外部访问走 resume_packet 聚合）
- ❌ Resume packet 自动推送给某个 agent（packet 是结构化 artifact，由调用方决定怎么消费——LLM session、Inspector UI、其他 agent，都行）
- ❌ Audit trail summary 用 LLM 生成（v1 只是 deterministic markdown 拼接，不调模型）
- ❌ 修改 Phase 1 已落地代码（`tasks-state.ts` / `repositories/tasks.ts` / `tools/task.ts` 的现有 export 列表）—— 只允许追加（如 `tools/task.ts` 内部追加 3 个 handler 函数 + 3 个 schema），不允许改既有签名

---

## 3. State Machine — Phase 2 激活子集

Phase 1 把 8 状态 + 全部转换写进 `VALID_TRANSITIONS` 常量。Phase 2 **不改 guard**，只新增动词触发已有的合法转换：

```
[Phase 1 已激活]                                         [Phase 2 新激活]
PENDING ──► RUNNING       (task.start_attempt)
PENDING ──► CANCELLED     (task.cancel)
RUNNING ──► CANCELLED     (task.cancel)
                          RUNNING ──► BLOCKED               (task.block)               ◄── 新
                          BLOCKED ──► READY_TO_RESUME       (task.answer，如所有 blocker 已答)  ◄── 新
                          BLOCKED ──► CANCELLED             (task.cancel —— 已能从 BLOCKED 取消)
                          READY_TO_RESUME ──► RUNNING       (task.start_attempt)        ◄── 新

[仍未激活，留给 Phase 3]
RUNNING ──► WAITING_REVIEW
WAITING_REVIEW ──► DONE / RUNNING / FAILED
```

**关键 invariant**：Phase 2 完成时仍**未激活** WAITING_REVIEW 相关的 4 条转换。dogfood 必须验证：从 `BLOCKED` 调用 `cairn.task.submit_for_review` 应返回 INVALID_STATE_TRANSITION（因为该工具尚不存在于 tools/list；如果有人误注册了，验证即失败）。

`cairn.task.cancel` 在 Phase 1 写时支持从 PENDING / RUNNING 取消；Phase 2 由于 BLOCKED → CANCELLED 是合法 transition，**自动**支持从 BLOCKED 取消（assertTransition 已写）。**不需要改 cancel 工具代码**，但 Phase 2 dogfood 应包含一条"BLOCKED → cancel → CANCELLED + cancel_reason in metadata"的断言，确保这条路径真的通。

---

## 4. File Structure（Phase 2）

```
packages/daemon/                                     # exists from Phase 1
├── src/
│   └── storage/
│       ├── types.ts                                 # NO CHANGE
│       ├── tasks-state.ts                           # NO CHANGE (VALID_TRANSITIONS 已含 BLOCKED / READY_TO_RESUME)
│       ├── migrations/
│       │   ├── index.ts                             # MODIFY (append 009)
│       │   └── 009-blockers.ts                      # NEW
│       └── repositories/
│           ├── tasks.ts                             # NO CHANGE — 现有 6 verb 不动
│           └── blockers.ts                          # NEW — recordBlocker / markAnswered + 私有 helper
└── tests/
    └── storage/
        ├── migrations.test.ts                       # MODIFY (append 009 schema test)
        └── blockers.test.ts                         # NEW — 仓储动词 + 原子性 + 多 blocker 计数

packages/mcp-server/                                 # exists from Phase 1
├── src/
│   ├── tools/
│   │   └── task.ts                                  # MODIFY (append 3 handlers; 现有 5 个 handler 不动)
│   ├── resume-packet.ts                             # NEW — assembleResumePacket service + JSON schema validator
│   └── index.ts                                     # MODIFY (register 3 new tools)
├── scripts/
│   ├── w5-phase1-dogfood.mjs                        # NO CHANGE — 保留作为 Phase 1 baseline
│   └── w5-phase2-dogfood.mjs                        # NEW — 完整闭环
└── tests/
    └── tools/
        ├── task.test.ts                             # MODIFY (append block/answer cases；现有 17 case 不动)
        └── resume-packet.test.ts                    # NEW — packet schema validator + assembly logic

docs/superpowers/
├── demos/
│   └── W5-phase2-task-handoff.md                    # NEW — 闭环 dogfood 输出 + 解读
└── plans/
    └── 2026-05-21-w5-phase3-outcomes.md             # NEW (stub) — Day 5 起草

PRODUCT.md                                           # MODIFY (≤6 line tweak — Phase 1 文案改成 "Phase 1+2 已交付生命线 + 暂停接力")
docs/superpowers/diagrams/w5-task-state.md           # MODIFY (Phase 2 转换从虚线/(Phase 2) 标签改成实线/已激活)
```

每个新文件单一职责。`resume-packet.ts` 承载 packet 组装 + schema validator，**不**写入 DB。

---

## 5. Day-by-day 任务分解（Phase 2，~5 工作日）

### 5.1 Day 1 — Migration 009 + 状态机激活验证

#### Task 5.1.1：起草 migration 009（blockers 表）

**目标**：blockers 表 DDL 落地，FK 到 tasks（CASCADE on delete），CHECK 约束含 3 状态（OPEN/ANSWERED/SUPERSEDED）但 Phase 2 v1 只触发前两个。

- [ ] **Step 1**：起 fresh subagent（sonnet），交付 `packages/daemon/src/storage/migrations/009-blockers.ts`：
  ```sql
  CREATE TABLE blockers (
    blocker_id     TEXT    PRIMARY KEY,
    task_id        TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    question       TEXT    NOT NULL,
    context_keys   TEXT,                               -- JSON array of scratchpad keys
    status         TEXT    NOT NULL CHECK (status IN ('OPEN','ANSWERED','SUPERSEDED')),
    raised_by      TEXT,                               -- agent_id
    raised_at      INTEGER NOT NULL,
    answer         TEXT,                               -- null until answered
    answered_by    TEXT,                               -- agent_id or 'user'
    answered_at    INTEGER,
    metadata_json  TEXT
  );
  CREATE INDEX idx_blockers_task   ON blockers(task_id);
  CREATE INDEX idx_blockers_status ON blockers(status);
  ```
  - 时间字段 INTEGER unix ms（与 Phase 1 一致）
  - FK 用 CASCADE：task 删除时其 blocker 全部清除（与 dispatch / scratchpad / checkpoints 的 SET NULL 不同——blocker 没有"orphan"概念，task 没了 blocker 也无意义）
  - **CHECK 含 SUPERSEDED 是 schema-complete 设计**——Phase 2 v1 不会写入这个值，但保留枚举位避免未来 migration
- [ ] **Step 2**：在 `migrations/index.ts` `ALL_MIGRATIONS` 数组追加 009（不要插队）
- [ ] **Step 3**：在 `tests/storage/migrations.test.ts` 末尾追加 schema 测试（PRAGMA table_info / FK 约束 / CHECK / index 存在性）
- [ ] **Step 4**：CASCADE 行为测试：插入 task + blocker → 删除 task → blocker 应自动消失
- [ ] **Step 5**：`cd packages/daemon && npm test && npx tsc --noEmit` 双绿
- [ ] **DoD**：≥ 5 个 schema assertion；CASCADE 测试通过；FK 拒绝插入 nonexistent task_id

#### Task 5.1.2：状态机激活验证（不改代码，只补单测）

**目标**：Phase 1 的 `tasks-state.test.ts` 已有 79 case 覆盖全部 transitions（包括 Phase 2 即将激活的）。本任务**不改 tasks-state.ts**，但要在 daemon 测试里加几个"集成层"测试，确认 BLOCKED 相关 transition 在 `updateTaskState` 仓储调用下也工作。

- [ ] **Step 1**：在 `tests/storage/tasks.test.ts` 追加（仓储层集成）：
  - `updateTaskState(RUNNING → BLOCKED)` 成功，updated_at 变化
  - `updateTaskState(BLOCKED → READY_TO_RESUME)` 成功
  - `updateTaskState(READY_TO_RESUME → RUNNING)` 成功
  - `updateTaskState(BLOCKED → CANCELLED)` 成功（confirmed cancel 路径仍然合法）
  - `updateTaskState(RUNNING → READY_TO_RESUME)` throws（不合法，必须经过 BLOCKED）
- [ ] **DoD**：5 case 全绿；现有 25 case 零退化

---

### 5.2 Day 2 — blockers 仓储层

#### Task 5.2.1：blockers repository

**目标**：`packages/daemon/src/storage/repositories/blockers.ts` 提供 verb-only 公开 API + 私有 transition helper。原子性沿用 Phase 1 `cancelTask` 范式。

- [ ] **Step 1**：交付 `blockers.ts` 暴露**仅 4 个**符号：
  ```ts
  export interface BlockerRow {
    blocker_id: string;
    task_id: string;
    question: string;
    context_keys: string[] | null;       // deserialized
    status: 'OPEN' | 'ANSWERED' | 'SUPERSEDED';
    raised_by: string | null;
    raised_at: number;
    answer: string | null;
    answered_by: string | null;
    answered_at: number | null;
    metadata: Record<string, unknown> | null;
  }

  export function recordBlocker(db: DB, input: {
    task_id: string;
    question: string;
    context_keys?: string[];
    raised_by?: string;
  }): { blocker: BlockerRow; task: TaskRow }
  // 单一事务：assertTransition(currentTaskState, 'BLOCKED') → updateTaskState(task_id, 'BLOCKED')
  //   + INSERT blocker(status='OPEN', raised_at=Date.now())
  // 任一失败回滚两者。
  // 错误：task 不存在 → throw TASK_NOT_FOUND；task 不在 RUNNING → assertTransition throws

  export function markAnswered(db: DB, blocker_id: string, input: {
    answer: string;
    answered_by: string;
  }): { blocker: BlockerRow; task: TaskRow }
  // 单一事务：
  //   1) 读 blocker；assert blocker.status == 'OPEN'；否则 throw BLOCKER_ALREADY_ANSWERED
  //   2) UPDATE blocker SET status='ANSWERED', answer, answered_by, answered_at=Date.now()
  //   3) SELECT COUNT(*) FROM blockers WHERE task_id=? AND status='OPEN'
  //   4) if count == 0: assertTransition(task.state == 'BLOCKED' → 'READY_TO_RESUME') + updateTaskState
  //      if count > 0: task 状态保持 BLOCKED（不动）
  // 返回 { blocker, task }（task 反映本事务后的状态）

  export function listBlockersByTask(db: DB, task_id: string, filter?: {
    status?: BlockerRow['status'] | BlockerRow['status'][];
  }): BlockerRow[]
  // 内部 helper —— 给 resume_packet 组装用。LD-8 锁定**不**通过 MCP 暴露。
  // 默认按 raised_at ASC 排序。

  export function getBlocker(db: DB, blocker_id: string): BlockerRow | null
  // 内部 helper —— 给 markAnswered 用。LD-8 锁定**不**通过 MCP 暴露。
  ```
  - module-private helper：复用 Phase 1 风格，加一个 `transitionTaskInTx(db, task_id, to)` 内部函数，把"读旧 state → assertTransition → 写新 state + updated_at"这一坨打包，让 `recordBlocker` / `markAnswered` 调用时干净
- [ ] **Step 2**：实现细节
  - `blocker_id` 从 `newId()` (ulid)
  - `context_keys` JSON 序列化（与 dispatch_requests.context_keys 同范式）
  - `raised_by` 默认从 `process.env.CAIRN_SESSION_AGENT_ID`（如未传）—— **mcp-server 层注入**，仓储层不读 env
- [ ] **Step 3**：`tests/storage/blockers.test.ts`（≥ 12 case）：
  - `recordBlocker` happy path：RUNNING → BLOCKED，blocker.status='OPEN'，task 与 blocker 一并返回
  - `recordBlocker` from non-RUNNING：PENDING / BLOCKED / CANCELLED 各试一次 → throws via assertTransition
  - `recordBlocker` 原子性：mock `db.prepare` 在 INSERT blocker 时 throw → task.state 不应变 BLOCKED（用 corrupt JSON 风格的 context_keys 触发即可）
  - `markAnswered` 单 blocker happy path：OPEN → ANSWERED，task BLOCKED → READY_TO_RESUME
  - `markAnswered` 多 blocker：task 有 2 个 OPEN，answer 1 个 → task 仍 BLOCKED，剩 1 OPEN；answer 第 2 个 → task → READY_TO_RESUME
  - `markAnswered` already answered：blocker.status='ANSWERED' → throws BLOCKER_ALREADY_ANSWERED
  - `markAnswered` 原子性：mock blocker UPDATE 后 throw → 状态都回滚
  - `markAnswered` 边界：blocker_id 不存在 → throws BLOCKER_NOT_FOUND
  - `listBlockersByTask` 排序：按 raised_at ASC
  - `listBlockersByTask` filter by status
  - `getBlocker` happy / not found
  - CASCADE：删除 task → blocker 全消失（已在 migration 测试中验过，可 skip 这里或重复一遍）
- [ ] **DoD**：≥ 12 case 全绿；`grep "^export" repositories/blockers.ts` 返回**只有** BlockerRow 接口 + 4 个 verb；module-private helper 不导出

---

### 5.3 Day 3 — MCP 工具 + Resume Packet 组装

#### Task 5.3.1：cairn.task.block + cairn.task.answer

**目标**：MCP 层暴露 2 个新动词；沿用 Phase 1 的 `INVALID_STATE_TRANSITION` 错误 code 风格 + SESSION_AGENT_ID 注入风格。

- [ ] **Step 1**：在 `packages/mcp-server/src/tools/task.ts` **追加**（不动既有 5 个 handler 和导出）：
  ```ts
  // cairn.task.block
  // input:  { task_id: string; question: string; context_keys?: string[]; raised_by?: string }
  // output: { blocker: BlockerRow; task: TaskRow }
  //         | { error: { code: 'INVALID_STATE_TRANSITION', from, to: 'BLOCKED', message } }
  //         | { error: { code: 'TASK_NOT_FOUND', task_id, message } }
  // SESSION_AGENT_ID 注入：raised_by 缺省时 fallback 到 ws.agentId

  // cairn.task.answer
  // input:  { blocker_id: string; answer: string; answered_by?: string }
  // output: { blocker: BlockerRow; task: TaskRow }
  //         | { error: { code: 'BLOCKER_NOT_FOUND', blocker_id, message } }
  //         | { error: { code: 'BLOCKER_ALREADY_ANSWERED', blocker_id, message } }
  // SESSION_AGENT_ID 注入：answered_by 缺省时 fallback 到 ws.agentId
  ```
- [ ] **Step 2**：在 `packages/mcp-server/src/index.ts` 的 `TOOLS` 数组追加 2 个 schema descriptor + switch case 分支
- [ ] **Step 3**：`tests/tools/task.test.ts` 追加（不动 Phase 1 的 17 case）：
  - block happy: RUNNING task → block(question) → task.state=BLOCKED, blocker.status=OPEN
  - block from PENDING → INVALID_STATE_TRANSITION 错误 code
  - block on nonexistent task_id → TASK_NOT_FOUND
  - answer happy (single blocker)：OPEN blocker → answer → blocker.ANSWERED, task.READY_TO_RESUME
  - answer with multi blockers：2 blockers, answer 1 → task 仍 BLOCKED；answer 2nd → task READY_TO_RESUME
  - answer on nonexistent blocker_id → BLOCKER_NOT_FOUND
  - answer on ANSWERED blocker → BLOCKER_ALREADY_ANSWERED
  - SESSION_AGENT_ID 注入：raised_by / answered_by 缺省时为 ws.agentId
- [ ] **DoD**：≥ 8 acceptance case 新增；现有 17 case 零退化；`grep "cairn.task" mcp-server/src/index.ts` 显示恰好 7 个工具（5 旧 + 2 新；resume_packet 在 5.3.2 加）

#### Task 5.3.2：cairn.task.resume_packet + assembleResumePacket service

**目标**：read-only 的结构化 packet 生成。逐字段实现 Phase 1 plan §6 schema，**不**改字段名/数量。

- [ ] **Step 1**：交付 `packages/mcp-server/src/resume-packet.ts`：
  ```ts
  export interface ResumePacket {
    task_id: string;
    intent: string;
    current_state: TaskState;
    last_checkpoint_sha: string | null;
    open_blockers: Array<{ blocker_id: string; question: string; context_keys: string[]; raised_at: number }>;
    answered_blockers: Array<{ blocker_id: string; question: string; answer: string; answered_by: string; answered_at: number }>;
    scratchpad_keys: string[];
    outcomes_criteria: Array<{ primitive: string; args: unknown[] }>;  // 空数组 in Phase 2，Phase 3 填充
    audit_trail_summary: string;  // markdown
  }

  export function assembleResumePacket(db: DB, task_id: string): ResumePacket | null
  // 1. getTask(task_id) → null 时返回 null
  // 2. 取 last checkpoint：SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 1
  // 3. listBlockersByTask(status='OPEN') → open_blockers
  // 4. listBlockersByTask(status='ANSWERED') ORDER BY answered_at DESC LIMIT 10 → answered_blockers
  // 5. SELECT key FROM scratchpad WHERE task_id=? → scratchpad_keys
  // 6. outcomes_criteria: [] (Phase 3 前固定为空)
  // 7. audit_trail_summary: 拼一段 markdown
  //    - 任务创建时间 + intent
  //    - dispatch_requests / checkpoints / blockers 时间线（按时间排序，每行一条 "<ISO> <type> <summary>"）
  //    - 不调 LLM，纯字符串拼接（LD-9 read-only 约束）

  export function validateResumePacket(p: unknown): { ok: true; packet: ResumePacket } | { ok: false; errors: string[] }
  // 手写 validator（不引 zod / ajv）。检查所有必需字段类型。dogfood 用它 lock schema。
  ```
- [ ] **Step 2**：在 `tools/task.ts` 追加 `cairn.task.resume_packet` handler：
  - input: `{ task_id: string }`
  - output: `{ packet: ResumePacket } | { error: { code: 'TASK_NOT_FOUND', task_id, message } }`
  - 不改任何状态。每次调用都重新组装。
- [ ] **Step 3**：注册到 `index.ts` TOOLS 数组 + switch
- [ ] **Step 4**：`tests/tools/resume-packet.test.ts`（≥ 8 case）：
  - 单测 `assembleResumePacket`：
    - 任务存在 / 不存在
    - 多个 OPEN blocker → open_blockers 列表完整
    - ANSWERED blocker 数量 > 10 → 截断到 10 + 按 answered_at DESC
    - 含 checkpoint → last_checkpoint_sha 是最新的 sha
    - 无 checkpoint → null
    - 含 scratchpad keys（和 task_id 关联）→ 出现在 scratchpad_keys
    - outcomes_criteria 为空数组（Phase 2 不变）
    - audit_trail_summary 是非空 markdown 字符串
  - `validateResumePacket`：合法 packet 返回 ok=true；缺字段 / 错类型 返回 ok=false + 明确错误描述
  - MCP 工具集成测试：通过 cairn.task.resume_packet 调用得到的 packet 通过 validator
- [ ] **DoD**：≥ 8 case；`assembleResumePacket` 返回的 packet 通过 `validateResumePacket`；resume_packet 不写任何 DB 表（用 spy / mock 验证 prepared statements 仅 SELECT）

---

### 5.4 Day 4 — Live Dogfood（完整闭环）

#### Task 5.4.1：扩写 dogfood 脚本

**目标**：Phase 1 dogfood 跑了"create → start → cross-process get → cancel → guard reject"。Phase 2 dogfood 跑**完整闭环**。

- [ ] **Step 1**：交付 `packages/mcp-server/scripts/w5-phase2-dogfood.mjs`（可 fork phase1 的；不要改 phase1 那个）：

  脚本步骤：
  1. session A: `cairn.task.create` → PENDING
  2. session A: `cairn.task.start_attempt` → RUNNING
  3. session A: `cairn.task.block({ question: "保留旧 sync API 吗？", context_keys: ["scratchpad/T/old-api-survey"] })` → BLOCKED
  4. session A 关闭（process A exit）
  5. session B（new child process, same DB）: `cairn.task.resume_packet({ task_id })` → packet 含 1 个 open_blocker
  6. session B: `cairn.task.answer({ blocker_id, answer: "保留，加 deprecation 注释" })` → blocker.ANSWERED, task.READY_TO_RESUME
  7. session B: `cairn.task.resume_packet({ task_id })` → packet 含 0 open_blocker, 1 answered_blocker
  8. session B: `cairn.task.start_attempt({ task_id })` → RUNNING
  9. session B: 加一个 multi-blocker 验证（可选，看时间）：再 block 2 个 → answer 第 1 个（task 仍 BLOCKED）→ answer 第 2 个（task READY_TO_RESUME）
  10. session B: `cairn.task.cancel({ task_id, reason: "demo done" })` → CANCELLED
  11. session A 重新连接（new child process again）: `cairn.task.get` → CANCELLED + cancel_reason in metadata（验证 Phase 1 atomic write 仍然工作）

  Assertions（≥ 14）：
  - 状态在每步后是预期值
  - blocker 在每步后 status 是预期值
  - resume_packet 字段完整且通过 validator
  - cross-process 一致性（在 session A 看到 session B 的写）
  - multi-blocker 计数逻辑：剩 OPEN > 0 时 task 不升级
  - cancel 仍然 atomic（reason 写进 metadata）

- [ ] **Step 2**：跑 `node scripts/w5-phase2-dogfood.mjs` 在 `packages/mcp-server` 下，捕获完整输出
- [ ] **DoD**：所有 assertion PASS；任意 1 步失败必须 root cause + 修，**不能跳**

#### Task 5.4.2：Phase 2 demo 文档

**目标**：把 dogfood 输出写成文档。沿用 Phase 1 demo 文档格式。

- [ ] **Step 1**：交付 `docs/superpowers/demos/W5-phase2-task-handoff.md`：
  - "What this proves" 段：Phase 2 兑现"task 跨 session 真接力"，强调多 blocker 计数 + cross-process resume_packet 一致性
  - 11 步表格 + 实际 JSON 输出 excerpts
  - "What's verified, what isn't"：明确 Phase 3 outcomes 不在覆盖范围
  - 复现命令
- [ ] **DoD**：文档完整；所有 11 步都贴了真实 MCP 响应

---

### 5.5 Day 5 — 最终验收 + Phase 3 stub + 状态图更新 + PRODUCT.md

#### Task 5.5.1：状态图更新

**目标**：把 `docs/superpowers/diagrams/w5-task-state.md` 里 Phase 2 转换从"标 (Phase 2)"改成"已激活"。Phase 3 转换仍标 (Phase 3)。

- [ ] **Step 1**：编辑 Mermaid 块，去掉 BLOCKED / READY_TO_RESUME 相关 transition 的 (Phase 2) 后缀
- [ ] **Step 2**：更新文档底部 legend：现在 Phase 1 + Phase 2 = 8 条已激活 transition
- [ ] **DoD**：图覆盖最新状态；diff 行数 ≤ 20

#### Task 5.5.2：PRODUCT.md tweak

- [ ] **Step 1**：将 §0 W5 段改成（diff ≤ 4 行）：
  > **W5 Phase 1+2 已交付**：Task Capsule 生命线 + 暂停接力闭环。一个任务可以在 session A 停下、过一晚、在 session B 接力。Phase 3 加 outcomes 验收（grader agent + tests_pass DSL），完成后产品 pitch 落地为 **Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**
- [ ] **DoD**：diff ≤ 4 行

#### Task 5.5.3：Phase 3 stub

**目标**：起草 `docs/superpowers/plans/2026-05-21-w5-phase3-outcomes.md`，按 Phase 1/2 同样的"locked decisions + scope + day-by-day"骨架，≥ 60 行框架。

预定 Phase 3 内容（Phase 2 不实施，只 stub）：
- migration 010：outcomes 表
- DSL：7 原语（含 LD-4 锁定的 tests_pass）
- 工具：`cairn.task.submit_for_review` / `cairn.outcomes.evaluate`
- 状态机激活：RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED
- Grader agent 接口预留（不实现，留 hook）
- Demo：声明 success criteria → 验收 → 不过则回 RUNNING

- [ ] **DoD**：stub ≥ 60 行；Phase 1/2 已交付的资产清单（tasks / blockers / resume_packet）明确列出可复用项

#### Task 5.5.4：最终验证 + commit

- [ ] **Step 1**：跑全套：
  ```
  cd packages/daemon && npm test && npx tsc --noEmit
  cd packages/mcp-server && npm test && npx tsc --noEmit
  cd packages/mcp-server && node scripts/w5-phase2-dogfood.mjs
  ```
  全绿。
- [ ] **Step 2**：检查 `update_state` / `set_blocker_status` / `mergeMetadataInTx` 等私有/禁用名称不出现在公共 API 表面：
  ```
  grep -r "update_state" packages/mcp-server/src           # 应只有注释
  grep -r "set_blocker_status\|setStatus" packages/mcp-server/src   # 应零结果
  grep "^export" packages/daemon/src/storage/repositories/blockers.ts  # 应只有 4 个
  ```
- [ ] **Step 3**：commit Day 5 + (可选) commit Day 1-4 各自如果还没 commit
- [ ] **DoD**：所有验证全绿；commit chain 干净（每 day 单独 commit，与 Phase 1 节奏一致）

---

## 6. Resume Packet 协议 — Phase 1 §6 verbatim 实现

Phase 1 plan §6 已冻结 schema。Phase 2 实现**逐字段一致**：

```jsonc
{
  "task_id": "ulid",
  "intent": "原始用户意图",
  "current_state": "BLOCKED" | "READY_TO_RESUME" | "RUNNING" | ...,
  "last_checkpoint_sha": "git stash sha 或 null",
  "open_blockers": [
    { "blocker_id": "...", "question": "...", "context_keys": ["scratchpad/..."], "raised_at": 1778... }
  ],
  "answered_blockers": [
    { "blocker_id": "...", "question": "...", "answer": "...", "answered_by": "agent_id|user", "answered_at": 1778... }
  ],
  "scratchpad_keys": ["subagent/.../result", ...],
  "outcomes_criteria": [],          // Phase 2 始终空数组；Phase 3 填充 [{ primitive, args }]
  "audit_trail_summary": "markdown 字符串"
}
```

**与 Phase 1 §6 一处微调**：原 spec 时间字段写 `"raised_at": "ISO"`，但 Phase 1 落地时所有 timestamp 都是 INTEGER unix ms。本 plan 把 packet 里的时间字段改成 INTEGER（与全 codebase 一致）。这是**implementation 选择**，schema 字段名仍逐字一致。如果未来需要给 UI 提供 ISO 字符串，由调用方自己 `new Date(unix_ms).toISOString()`。

**重要**（重申 Phase 1）：这是 **structured artifact**，不是 prompt。Cairn 不生成自然语言 prompt 喂给 agent——那是 framework 的事。`audit_trail_summary` 是 markdown，但是 deterministic 字符串拼接（每条历史一行格式化），**不调 LLM**。

---

## 7. Demo 闭环（Phase 2 收尾时跑通的故事）

Phase 1 dogfood 证明了 task identity 跨进程存活。Phase 2 dogfood 证明 task 真的能跨 session **接力**：

> **场景**：用户启动一个跨天的复杂重构任务，agent 中途遇到决策点，过一晚另一个 agent 接力。
>
> 1. 用户：`task.create({ intent: "重构 daemon lanes 模块" })` → `T-001`，PENDING
> 2. Claude session A：`task.start_attempt(T-001)` → RUNNING
> 3. session A 做了一半发现需要决策："要不要保留旧的 sync API？"
> 4. session A：`task.block(T-001, question="保留旧 sync API 吗？", context_keys=["scratchpad/T-001/old-api-survey"])` → BLOCKED
> 5. **session A 退出**（用户去睡觉了）
> 6. 第二天，用户在 Inspector / 新 session 调：`task.answer(blocker_id, "保留，加 deprecation 注释")` → READY_TO_RESUME
> 7. Claude session B（不同机器/不同 agent）：`task.resume_packet(T-001)` → 拿到结构化 packet（含 intent / 已答 question+answer / scratchpad keys / last checkpoint sha）
> 8. session B：`task.start_attempt(T-001)` → RUNNING（依据 packet 内容继续工作）
> 9. session B 完成代码：`task.cancel(T-001, reason="demo")` → CANCELLED（Phase 3 才会有 submit_for_review；Phase 2 demo 用 cancel 收尾）
>
> 全程 task_id `T-001` 是唯一的"任务身份"。session、agent、机器全可换。

**这条 demo 跑通时，Phase 2 Pitch 落地：**

> **Cairn 把"agent 中途求证"从会话内的对话变成了任务级别的持久 blocker——session 可以死，但问题留在那里等答复，任何 agent 都能接续。**

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `markAnswered` 多 blocker 计数逻辑错（在还有 OPEN 时误升 READY_TO_RESUME） | 中 | 高 | LD-7 锁定行为；blockers.test.ts 必须有 multi-blocker 计数测试 ≥ 3 种 |
| `recordBlocker` 与 `markAnswered` 的事务不真正原子（state 写了但 blocker insert 失败） | 中 | 高 | 沿用 Phase 1 cancelTask 的黑盒原子性测试；mock 内部 throw 验证回滚 |
| Resume packet schema 偏离 Phase 1 §6 | 低 | 中 | LD-5 锁定；validator 单测对每个字段都断言 |
| MCP 层暴露了不该暴露的 list/get blocker 工具 | 低 | 中 | LD-8 锁定；Day 5 grep 验证 |
| Resume packet 生成意外写 DB | 低 | 中 | LD-9 锁定；测试用 prepared-statement spy 验证 SELECT-only |
| Phase 1 既有代码被误改 | 低 | 高 | "只追加不修改" 约束在 §2；每个文件操作明确 NEW vs MODIFY；CI 之外用 git diff 抽查 tasks.ts / tasks-state.ts 应无变化 |
| Phase 2 周期超 1 周 | 中 | 低 | 5 个 day 任务可分派；超时砍 5.4.1 的 multi-blocker step 9（推到 Phase 3 demo） |
| `audit_trail_summary` markdown 拼接膨胀（拉太多历史） | 中 | 低 | v1 限定最多 50 行 / 按时间倒序截断；Phase 3 再优化（可能改成分页） |

---

## 9. Phase 2 完成判据（DoD 总览）

全部满足才算 Phase 2 done：

- [ ] migration 009 落地，daemon 测试全绿（≥ 5 个 schema test，含 CASCADE 与 FK）
- [ ] `repositories/blockers.ts` + 单测 ≥ 12 case 全绿（含 `recordBlocker` 与 `markAnswered` 各自的原子性测试 + multi-blocker 计数 ≥ 3 case）
- [ ] `repositories/blockers.ts` 公开 API 恰好 4 个符号（1 接口 + 3 verb）；module-private helper 不导出（grep 验证）
- [ ] `cairn.task.block` / `answer` / `resume_packet` 3 个 MCP 工具落地，acceptance test ≥ 12 case 全绿；现有 17 case 零退化
- [ ] `update_state` / `set_blocker_status` / `list_blockers` / `get_blocker` 工具**不存在**于 MCP tool list（grep 验证）
- [ ] `assembleResumePacket` + `validateResumePacket` 单测 ≥ 8 case 全绿；packet 字段与 Phase 1 §6 schema 一一对应（除 timestamp 类型由 ISO 改为 INTEGER）
- [ ] resume_packet 生成是 read-only：测试用 prepared-statement spy 验证仅有 SELECT
- [ ] Live dogfood 11 步全部跑通，写入 `docs/superpowers/demos/W5-phase2-task-handoff.md`，含真实 MCP 响应捕获
- [ ] 状态图更新：BLOCKED / READY_TO_RESUME 转换从 (Phase 2) 标记改为已激活；Phase 3 转换继续标 (Phase 3)
- [ ] PRODUCT.md §0 W5 段升级（diff ≤ 4 行）
- [ ] `cd packages/daemon && npm test && npx tsc --noEmit` 绿
- [ ] `cd packages/mcp-server && npm test && npx tsc --noEmit` 绿
- [ ] Phase 3 plan 草稿框架 ≥ 60 行
- [ ] Phase 1 既有代码 git diff 抽查：`packages/daemon/src/storage/tasks-state.ts` / `packages/daemon/src/storage/repositories/tasks.ts` 全程零修改

---

## 附录 A：Phase 2 与 Phase 1 资产复用表

| Phase 1 资产 | Phase 2 复用方式 |
|---|---|
| `tasks` 表 + `tasks-state.ts` `VALID_TRANSITIONS` | 直接读，不改 |
| `repositories/tasks.ts` 6 个 verb | `recordBlocker` / `markAnswered` 内部调 `updateTaskState` 实现状态升级 |
| `mergeMetadataInTx` module-private 模式 | Phase 2 加 `transitionTaskInTx` 私有 helper，遵循同一不暴露原则 |
| `cancelTask` 原子性测试范式（黑盒 mock throw） | Phase 2 `recordBlocker` / `markAnswered` 的原子性测试逐字模仿 |
| `INVALID_STATE_TRANSITION` 结构化错误 code | block / answer 错误 code 沿用同一 schema |
| SESSION_AGENT_ID 注入（`ws.agentId`） | block.raised_by / answer.answered_by 缺省时同样从 ws.agentId 取 |
| MCP stdio dogfood 脚本范式（`@modelcontextprotocol/sdk` Client + 双 child） | Phase 2 dogfood 直接 fork w5-phase1-dogfood.mjs 改步骤 |
| `legacy_orphan` annotation（read 路径） | blockers 是新表无 legacy 数据；inspector 不需要 annotate blocker 行 |

## 附录 B：Tool 动词 / 状态机映射（Phase 1+2 全景）

| 工具 | Phase | from | to | 备注 |
|---|---|---|---|---|
| `cairn.task.create` | 1 | (none) | PENDING | 入口 |
| `cairn.task.start_attempt` | 1 | PENDING | RUNNING | 首次启动 |
| **`cairn.task.start_attempt`** | **2** | **READY_TO_RESUME** | **RUNNING** | **resume 后接力（同一工具，不同源状态）** |
| `cairn.task.cancel` | 1 | PENDING / RUNNING | CANCELLED | Phase 1 暴露 |
| **`cairn.task.cancel`** | **2** | **BLOCKED** | **CANCELLED** | **Phase 2 自动支持（assertTransition 已许可，cancel 工具代码不动）** |
| **`cairn.task.block`** | **2** | **RUNNING** | **BLOCKED** | **新工具** |
| **`cairn.task.answer`** | **2** | **BLOCKED** | **READY_TO_RESUME** | **新工具，仅当所有 blocker ANSWERED 才升级** |
| **`cairn.task.resume_packet`** | **2** | (read-only) | (read-only) | **新工具，无状态变化** |
| `cairn.task.submit_for_review` | 3 | RUNNING | WAITING_REVIEW | 仍未实现 |
| `cairn.outcomes.evaluate` | 3 | WAITING_REVIEW | DONE / RUNNING / FAILED | 仍未实现 |

**永不暴露**（Phase 1 + Phase 2 同一原则）：`cairn.task.update_state` / `cairn.task.set_blocker_status` / `cairn.task.list_blockers` / `cairn.task.get_blocker`。任何"自由状态写"或"绕过 task 上下文操作 blocker" 的 API 都是反模式。

## 附录 C：Migration 编号

| Migration | 主题 | 状态 |
|---|---|---|
| 001-006 | W1-W4 既有 | ✅ 已落地 |
| 007 | tasks | ✅ 已落地（W5 Phase 1） |
| 008 | dispatch_requests.task_id | ✅ 已落地（W5 Phase 1） |
| **009** | **blockers** | **🟡 W5 Phase 2（本 plan）** |
| 010 | outcomes | 🔵 W5 Phase 3（计划中） |

W5 Phase 2 完成后，下一个可用 migration 编号是 **010**。
