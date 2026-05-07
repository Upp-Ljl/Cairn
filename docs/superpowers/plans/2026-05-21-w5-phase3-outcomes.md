# Cairn v0.1 · W5 Phase 3 计划（Outcomes 验收 — 闭环：RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把 Task Capsule 从"可暂停可接力"升级到"可验收"。**Phase 3 唯一目标是把这条状态闭环跑通：`RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED`**——其中 DONE 来自验收通过，RUNNING（验收失败重试）来自验收失败但允许 agent 修后再试，FAILED 来自显式终判。验收手段是**确定性 DSL 评估器**（7 个原语），不调 LLM、不调 grader agent（schema 留 hook 但 v1 不实现）。Phase 3 完成时 W5 闭环 done：Cairn 真的能让一个任务"在 session A 停下、过一晚、在 session B 接力、最后系统自动验收测试是否通过"。

**Architecture**：Phase 1+2 已 schema-complete 状态机（`tasks-state.ts` 含 WAITING_REVIEW 全部 transitions）+ tasks/blockers 仓储 + 8 个 cairn.task.* MCP 工具。Phase 3 新增 `outcomes` 表（migration 010，独立表，**不复用 conflicts/blockers**——LD-2 同一原则），仓储层 4 verb 暴露 + 私有 transition helper 复用 Phase 2 范式，DSL parser/evaluator 拆分为 `packages/mcp-server/src/dsl/` 子目录（mcp-server 层因为需要 `child_process` + `fs` 访问；daemon 保持纯 DB），MCP 层 2 个新工具：`cairn.task.submit_for_review` / `cairn.outcomes.evaluate`。前者激活 transition + 冻结 criteria；后者跑评估 + 决定下一状态。

**Tech Stack**：与 Phase 1+2 同——Node.js 24 / TypeScript strict ESM / `better-sqlite3@^12.9.0` / `@modelcontextprotocol/sdk@^1`。无新依赖（DSL parser 手写，无 antlr / pegjs；validator 手写，无 zod / ajv；child_process 用 node 内置）。

**Spec 来源**：
- Phase 1 plan：`docs/superpowers/plans/2026-05-07-w5-task-capsule.md`（§3 状态机、§6 Resume Packet schema 含 `outcomes_criteria` 字段已留位）
- Phase 2 plan：`docs/superpowers/plans/2026-05-14-w5-phase2-blockers-resume.md`（resume_packet 实现样板、verb-only 仓储 + 原子性测试范式）
- Phase 1 dogfood：`docs/superpowers/demos/W5-phase1-task-handoff.md`
- Phase 2 dogfood：`docs/superpowers/demos/W5-phase2-task-handoff.md`（Phase 3 dogfood fork from this）
- 既有代码：`packages/daemon/src/storage/tasks-state.ts` `VALID_TRANSITIONS`（WAITING_REVIEW transitions 已写好，guard ready）
- `CLAUDE.md` Phase 1-4 落地约定 + 历史 W4 dogfood 报告

**配套技能**：
- `superpowers:subagent-driven-development` — 每个独立 task 派 fresh sonnet
- `superpowers:verification-before-completion` — Day 末验收 + 闭环 dogfood 验证
- `superpowers:writing-plans` — Day 6 起草 Phase 4 stub 时使用

---

## 1. Locked Decisions（不可在 Phase 3 重新讨论）

### 从 Phase 1+2 继承（不重审）

- **LD-1**：Task 一等公民。Phase 3 outcomes 也挂在 task 上（FK CASCADE），不绑特定 agent。
- **LD-2**：Outcomes 用独立表（migration 010），**不复用 conflicts / blockers**。
- **LD-3**：legacy_orphan 标签策略仅 read 路径用。Phase 3 outcomes 是新表，所有行强制 `task_id NOT NULL`。
- **LD-4**：Outcomes DSL 第一版含独立 `tests_pass` 原语。本 plan 兑现，§7 详规。
- **LD-5**：Resume packet schema 已冻结。Phase 3 把 `outcomes_criteria` 字段从空数组填成实际数组，**不改 schema 字段名**。
- **LD-6**：原子性测试用确定性运行时触发，不用 mock。Phase 3 outcomes 的 `declareOutcomes` / `recordEvaluationResult` 沿用同样思路。
- **LD-7**：仓储动词的状态升级逻辑必须**精确计数**。Phase 3 没有"多 outcome 计数"概念（每个 task 一个 outcome 行，REPLACE 语义），但保留"评估结果决定状态"的精确-决定原则。
- **LD-8**：MCP 不暴露 list/get 类工具。Phase 3 同样**不**暴露 `cairn.outcomes.list` / `cairn.outcomes.get`——所有 outcome 访问通过 `resume_packet` 聚合视图。
- **LD-9**：resume_packet 生成 read-only。Phase 3 把 outcomes_criteria 加入 packet 时同样守 SELECT-only，prepared-statement spy 验证。

### Phase 3 新锁

- **LD-10**：DSL 评估器是**纯函数 + 受限 IO**。每个原语显式声明它访问的资源类（`FILE` / `COMMAND` / `DB`），评估器框架只允许声明列出的访问。**绝不调 LLM**，绝不动 git 状态（不 commit / push / reset），子进程超时强制 kill。
- **LD-11**：Grader agent **不在 Phase 3 v1 实现**。outcomes 表保留 `grader_agent_id` 字段 + 评估器内的 hook 接口（接受一个 `grader?: GraderHook` 参数），但 Phase 3 v1 只走 deterministic DSL 路径，verdict 完全来自 DSL 跑分结果。Hook 真实接入留 v0.2 或 W6+。
- **LD-12**：`cairn.task.submit_for_review` 不直接触发评估。它**只**做两件事：① 把 task 状态从 RUNNING → WAITING_REVIEW；② 写一行 outcomes(status='PENDING', criteria_json=冻结的 criteria)。**评估由独立工具 `cairn.outcomes.evaluate(outcome_id)` 触发，可重复调用**——这样 agent 改完代码可以在不重新声明 criteria 的情况下重新评估。每次 evaluate REPLACE outcomes 行的 status / evaluated_at / evaluation_summary 三个字段（criteria_json 不变）。
- **LD-13**：DSL **解析器（parser）与评估器（evaluator）严格分离**。
  - Parser：input `criteria_json` (raw string from MCP arg) → 输出 IR `OutcomePrimitive[]`（结构化 `{ primitive: PrimitiveName, args: ValidatedArgs }[]`）。语法检查 + 参数类型检查在这一层做。
  - Evaluator：input IR + workspace context (`{ db, cwd, env }`) → 输出 `EvaluationResult`（`{ status: 'PASS' | 'FAIL' | 'TIMEOUT', perPrimitive: Array<{ name, status, detail }>, summary: string }`）。
  - 单测各自；未来加新原语只动 evaluator + parser 表，不动接口。
- **LD-14**：outcomes 表存声明 + 最近一次评估结果。**不**保留全部历史评估（避免无界增长）。审计每次评估的需求留给后续 phase 做 `outcome_evaluations` 子表。本 phase 的 evaluation_summary 字段每次 evaluate 被 REPLACE。
- **LD-15**（首次出现）：DSL v1 是**全 AND 语义** —— 所有原语都 PASS 才整体 PASS；任一 FAIL 整体 FAIL。**不**支持 OR / NOT / 嵌套；不支持 partial credit；不支持权重。这是为了 v1 评估器极简，未来 DSL v2 再考虑组合子。
- **LD-16**（首次出现）：每个原语单次执行的 wall-clock timeout = `60s`（可由环境变量 `CAIRN_DSL_PRIMITIVE_TIMEOUT_MS` 覆盖）。超时即记 TIMEOUT verdict，整体评估 FAIL（按 LD-15 AND 语义）。子进程类原语（`tests_pass` / `command_exits_0`）超时必须 SIGTERM → 等 5s → SIGKILL，避免 zombie。
- **LD-17**（首次出现）：`cairn.outcomes.evaluate` 是**同步阻塞**调用——MCP host 等评估完成才收到响应。不引入 job queue / 异步轮询。坏处是长测试套件会阻塞 stdio；好处是 v1 实现极简，可观察性靠"调用方等"。如果某个 task 的测试套件 > 60s 单原语超时窗口，那是 LD-16 的边界，需要 caller 拆分 criteria。

---

## 2. Out of Scope（Phase 3 硬约束）

- ❌ Grader agent 实际实现（schema 留 hook，但 Phase 3 v1 不调 LLM 做评估）
- ❌ DSL v2 语法：OR / NOT / 嵌套 / 权重 / partial credit（LD-15 锁）
- ❌ DSL 自定义原语 / plugin 机制（v1 仅 7 个内置；未来要加新原语 = 改 parser 表 + 加 evaluator function，无 plugin loader）
- ❌ outcome 历史评估完整 audit log / `outcome_evaluations` 子表（LD-14 锁）
- ❌ 异步 / 后台 / 自动重新评估（如 file watcher / cron）—— LD-17 锁，v1 用户主动调
- ❌ `cairn.outcomes.list` / `cairn.outcomes.get` MCP 工具（LD-8 锁）
- ❌ MCP 暴露 DSL parser / evaluator 内部 API（只 `submit_for_review` / `evaluate` 两个动词暴露）
- ❌ Inspector UI 改动（Phase 4 收尾或 W6）
- ❌ 修改 Phase 1+2 已落地源码（`tasks.ts` / `tasks-state.ts` / `blockers.ts` / `resume-packet.ts` 现有 export 全部冻结；只允许追加 / 创建新文件）
- ❌ 自动重试机制（评估 FAIL 后系统自动跑第 N 次）—— v1 由 agent / 用户主动决定何时再 evaluate
- ❌ outcomes_criteria 跨 task 共享 / 模板化—— v1 每个 task 自己声明
- ❌ DSL 表达式字符串语法（如 `"tests_pass(packages/daemon) AND no_open_conflicts"`）—— v1 输入是 JSON 数组，参数化结构化，不解析字符串

---

## 3. State Machine — Phase 3 激活子集

Phase 1+2 已激活 8 条 transition。Phase 3 激活剩余 4 条 WAITING_REVIEW 相关：

```
[Phase 1+2 已激活 — 不变]
PENDING ──► RUNNING / CANCELLED
RUNNING ──► BLOCKED / CANCELLED / FAILED                 (FAILED 暂仅备用)
BLOCKED ──► READY_TO_RESUME / CANCELLED
READY_TO_RESUME ──► RUNNING

[Phase 3 新激活 — 4 条]
RUNNING ──► WAITING_REVIEW         (cairn.task.submit_for_review)         ◄── 新
WAITING_REVIEW ──► DONE            (cairn.outcomes.evaluate, 验收 PASS)   ◄── 新
WAITING_REVIEW ──► RUNNING         (cairn.outcomes.evaluate, 验收 FAIL)   ◄── 新（重试）
WAITING_REVIEW ──► FAILED          (cairn.outcomes.evaluate 终判 / 用户主动)  ◄── 新（终判失败）
```

**关键 invariant**：Phase 3 完成后所有 8 状态 + 12 transitions 全部激活。`tasks-state.ts` `VALID_TRANSITIONS` 自 Phase 1 起就写好这些 transition，guard 早就 ready，Phase 3 工作只是给它们加上 MCP 触发动词。

`cairn.task.cancel` 在 Phase 1 写时支持 RUNNING / PENDING；Phase 2 自动支持 BLOCKED；Phase 3 应 verify 它是否也支持 WAITING_REVIEW → CANCELLED（assertTransition 已许可）。**Phase 3 dogfood 应包含一条"WAITING_REVIEW → cancel → CANCELLED"断言**，确保这条路径通。

---

## 4. File Structure（Phase 3）

```
packages/daemon/                                     # exists from Phase 1+2
├── src/
│   └── storage/
│       ├── tasks-state.ts                           # NO CHANGE
│       ├── migrations/
│       │   ├── index.ts                             # MODIFY (append 010)
│       │   └── 010-outcomes.ts                      # NEW
│       └── repositories/
│           ├── tasks.ts                             # NO CHANGE
│           ├── blockers.ts                          # NO CHANGE
│           └── outcomes.ts                          # NEW — declareOutcomes / recordEvaluationResult / markTerminalFail / getOutcomesByTask + 私有 helper
└── tests/
    └── storage/
        ├── migrations.test.ts                       # MODIFY (append 010 schema test)
        ├── tasks.test.ts                            # MODIFY (append ≥4 WAITING_REVIEW transition cases)
        └── outcomes.test.ts                         # NEW — 仓储 verb + 原子性 + status 转换测试

packages/mcp-server/                                 # exists from Phase 1+2
├── src/
│   ├── tools/
│   │   ├── task.ts                                  # MODIFY (append toolSubmitForReview)
│   │   └── outcomes.ts                              # NEW — toolEvaluateOutcome 单独文件 (cairn.outcomes.* 命名空间分离)
│   ├── resume-packet.ts                             # MODIFY (fill outcomes_criteria field; outputs from new outcomes 仓储 read)
│   ├── dsl/                                         # NEW dir
│   │   ├── parser.ts                                # NEW — parseCriteriaJSON → OutcomePrimitive[] IR
│   │   ├── evaluator.ts                             # NEW — evaluateCriteria(IR, ctx) → EvaluationResult
│   │   ├── primitives.ts                            # NEW — 7 个 primitive functions + access-class declarations
│   │   └── types.ts                                 # NEW — IR / EvaluationResult / GraderHook 接口（LD-11 reserved）
│   └── index.ts                                     # MODIFY (register 2 new tools)
├── scripts/
│   ├── w5-phase1-dogfood.mjs                        # NO CHANGE
│   ├── w5-phase2-dogfood.mjs                        # NO CHANGE
│   └── w5-phase3-dogfood.mjs                        # NEW — 完整闭环
└── tests/
    ├── tools/
    │   ├── task.test.ts                             # MODIFY (append submit_for_review acceptance cases)
    │   ├── outcomes.test.ts                         # NEW — outcomes.evaluate acceptance
    │   └── resume-packet.test.ts                    # MODIFY (append outcomes_criteria filled cases + LD-9 read-only re-verify)
    ├── dsl/
    │   ├── parser.test.ts                           # NEW — 解析器单测
    │   ├── evaluator.test.ts                        # NEW — 评估器单测
    │   └── primitives.test.ts                       # NEW — 7 个原语逐个 happy/sad/edge
    └── stdio-smoke.test.ts                          # MODIFY (25 → 27 tools)

docs/superpowers/
├── demos/
│   └── W5-phase3-task-handoff.md                    # NEW — 完整闭环 dogfood 输出
└── plans/
    └── 2026-XX-XX-w5-phase4-closure.md              # NEW (stub) — Day 6 起草

docs/superpowers/diagrams/w5-task-state.md           # MODIFY (Phase 3 4 条 transition 从 (Phase 3) 标签改成已激活)
PRODUCT.md                                           # MODIFY (≤6 行 W5 收尾段)
```

**新文件分布**：daemon 层 1 仓储 + 1 migration + 1 测试；mcp-server 层 1 工具 + 1 resume-packet 修改 + 4 DSL 文件 + 4 测试 + 1 dogfood 脚本；docs 4 文档。

---

## 5. Day-by-day 任务分解（Phase 3，~6 工作日）

### 5.1 Day 1 — Migration 010 + 状态机激活验证

#### Task 5.1.1：起草 migration 010（outcomes 表）

**目标**：outcomes 表 DDL 落地，FK CASCADE，4-status CHECK，INTEGER 时间字段。

- [ ] **Step 1**：交付 `packages/daemon/src/storage/migrations/010-outcomes.ts`：
  ```sql
  CREATE TABLE outcomes (
    outcome_id         TEXT    PRIMARY KEY,
    task_id            TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    criteria_json      TEXT    NOT NULL,                                  -- JSON array of { primitive, args }
    status             TEXT    NOT NULL CHECK (status IN ('PENDING','PASS','FAIL','TERMINAL_FAIL')),
    evaluated_at       INTEGER,                                            -- null until first evaluate
    evaluation_summary TEXT,                                                -- markdown — last evaluation's per-primitive results
    grader_agent_id    TEXT,                                                -- LD-11: null in v1, reserved for hook
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    metadata_json      TEXT
  );
  CREATE INDEX idx_outcomes_task   ON outcomes(task_id);
  CREATE INDEX idx_outcomes_status ON outcomes(status);
  ```
  - 时间字段 INTEGER unix ms（Phase 1+2 一致）
  - FK CASCADE：task 删除时其 outcome 一并清除（与 blockers 同策略）
  - **CHECK 含 4 状态全集**：v1 实际写入仅 PENDING/PASS/FAIL/TERMINAL_FAIL，但全部在 CHECK 里就位，未来不需 re-migration
- [ ] **Step 2**：在 `migrations/index.ts` `ALL_MIGRATIONS` 数组追加 010
- [ ] **Step 3**：在 `tests/storage/migrations.test.ts` 末尾追加（≥ 5 assertion）：
  - 列存在性 + 类型（PRAGMA table_info）
  - CHECK 接受 4 个状态值，拒绝第 5 个
  - 两个 index 存在
  - **CASCADE**：插入 task + outcome → 删除 task → outcome 应自动消失
  - **FK 拒绝**：插入 outcome with nonexistent task_id → throws
- [ ] **Step 4**：`cd packages/daemon && npm test && npx tsc --noEmit` 双绿
- [ ] **DoD**：≥ 5 schema assertion，CASCADE 测试通过，FK 拒绝 nonexistent task_id

#### Task 5.1.2：状态机激活验证（不改源码，补集成测试）

**目标**：Phase 1 已写 `tasks-state.test.ts` 覆盖全部 transitions（unit）。本任务在 `tasks.test.ts` 集成层补 4 case 确认 WAITING_REVIEW transitions 经过 `updateTaskState` 真的工作。

- [ ] **Step 1**：在 `tests/storage/tasks.test.ts` 追加 describe block "Phase 3 WAITING_REVIEW transitions"，含 ≥ 4 case：
  - `RUNNING → WAITING_REVIEW` 成功
  - `WAITING_REVIEW → DONE` 成功
  - `WAITING_REVIEW → RUNNING` 成功（验收失败重试路径）
  - `WAITING_REVIEW → FAILED` 成功（终判路径）
  - bonus：`WAITING_REVIEW → CANCELLED` 成功（用户中途取消，cancelTask 路径已支持）
  - bonus：`PENDING → WAITING_REVIEW` 拒绝（必须经过 RUNNING）
- [ ] **DoD**：≥ 4 case 全绿；现有 tasks.test.ts case 零退化；`tasks-state.ts` / `repositories/tasks.ts` git diff 为空

---

### 5.2 Day 2 — outcomes 仓储层

#### Task 5.2.1：outcomes repository

**目标**：`repositories/outcomes.ts` verb-only 公开接口，沿用 Phase 2 `blockers.ts` 范式（私有 `transitionTaskInTx` helper + 原子事务）。

- [ ] **Step 1**：交付 `outcomes.ts` 暴露**恰好 6 个 named export**（与 Phase 2 blockers 同口径）：1 type alias + 1 接口 + 4 verb：
  ```ts
  export type OutcomeStatus = 'PENDING' | 'PASS' | 'FAIL' | 'TERMINAL_FAIL';

  export interface OutcomeRow {
    outcome_id: string;
    task_id: string;
    criteria: OutcomePrimitive[];     // deserialized from criteria_json
    status: OutcomeStatus;
    evaluated_at: number | null;
    evaluation_summary: string | null;
    grader_agent_id: string | null;
    created_at: number;
    updated_at: number;
    metadata: Record<string, unknown> | null;
  }

  export function declareOutcomes(db: DB, input: {
    task_id: string;
    criteria: OutcomePrimitive[];     // 已通过 DSL parser 校验过的 IR
  }): { outcome: OutcomeRow; task: TaskRow }
  // 单一事务：assertTransition(currentTaskState, 'WAITING_REVIEW') → updateTaskState(task_id, 'WAITING_REVIEW')
  //   + INSERT outcomes(status='PENDING', criteria_json=JSON.stringify(criteria), created_at, updated_at).
  // 任一失败回滚两者。
  // 错误：task 不存在 → throw 'TASK_NOT_FOUND'；task 不在 RUNNING → assertTransition throws；
  //       criteria 为空数组 → throw 'EMPTY_CRITERIA'（v1 不允许声明空 outcomes，强制至少 1 个原语）

  export function recordEvaluationResult(db: DB, outcome_id: string, result: {
    status: 'PASS' | 'FAIL';
    summary: string;
    evaluated_at?: number;            // 默认 Date.now()
  }): { outcome: OutcomeRow; task: TaskRow }
  // 单一事务：
  //   1. 读 outcome；assert outcome.status == 'PENDING' || 'FAIL'（允许 PENDING 或上次 FAIL 后重新 evaluate）；
  //      else throw 'OUTCOME_TERMINAL_OR_DONE'（PASS 已通过、TERMINAL_FAIL 已终判，禁止再写）
  //   2. UPDATE outcomes SET status, evaluated_at, evaluation_summary, updated_at
  //   3. 根据 result.status 决定 task 状态升级：
  //      - PASS → assertTransition(task.state == 'WAITING_REVIEW' → 'DONE') + updateTaskState
  //      - FAIL → assertTransition(task.state == 'WAITING_REVIEW' → 'RUNNING') + updateTaskState
  //              （task 回 RUNNING，agent 可以修代码后再调 evaluate）
  // 任一失败回滚全部。

  export function markTerminalFail(db: DB, outcome_id: string, reason: string): { outcome: OutcomeRow; task: TaskRow }
  // 用户/系统终判失败：
  //   1. 读 outcome；assert status in ('PENDING', 'FAIL')；else throw
  //   2. UPDATE outcomes SET status='TERMINAL_FAIL', evaluation_summary=reason, evaluated_at, updated_at
  //   3. assertTransition(task.state == 'WAITING_REVIEW' → 'FAILED') + updateTaskState

  export function getOutcomesByTask(db: DB, task_id: string): OutcomeRow[]
  // 内部 helper —— 给 resume_packet 组装用。LD-8 不通过 MCP 暴露。
  // 排序按 created_at ASC（v1 每 task 通常只一行，但保留可扩展性）。

  // ─── module-private (NOT exported) ───
  // function transitionTaskInTx(db, task_id, to: TaskState): TaskRow
  //   - 与 Phase 2 blockers.ts 同名同形 helper；Phase 3 outcomes.ts 内部独立实现一份
  //   - 不跨 module 复用 Phase 2 的版本（保持模块内聚）
  ```

  **OutcomePrimitive type** 定义在 `packages/mcp-server/src/dsl/types.ts`，daemon 这里通过同包内 type 引用：
  ```ts
  // 但 daemon 不能 import mcp-server 代码（依赖方向反了）
  // 所以 daemon 仓储用 DSL 的 IR 时，从 mcp-server 反向调用
  ```
  → **方案修正**：DSL types 文件放在共享处。建议在 `packages/daemon/src/storage/types.ts` 加一个最小接口 `OutcomePrimitive { primitive: string; args: unknown[] }`（最小约束，不含 7 原语联合类型），让 daemon 只关心结构。mcp-server 的 DSL parser 输出更窄类型 `OutcomePrimitiveTyped`，但传给 daemon 时类型擦除到结构层。

- [ ] **Step 2**：实现细节
  - `outcome_id` 从 `newId()` (ulid)
  - `criteria_json` JSON 序列化；getOutcomesByTask 反序列化
  - `metadata_json` v1 始终 null
  - 私有 `transitionTaskInTx` 与 Phase 2 同名实现（每 module 自己一份，不跨模块共享 helper）

- [ ] **Step 3**：`tests/storage/outcomes.test.ts`（≥ 14 case，与 Phase 2 blockers 同体量）：
  1. `declareOutcomes` happy path: RUNNING → WAITING_REVIEW + outcome.status='PENDING' + criteria 反序列化正确
  2. `declareOutcomes` from PENDING 抛错（assertTransition）
  3. `declareOutcomes` from BLOCKED 抛错
  4. `declareOutcomes` empty criteria 数组 → throws 'EMPTY_CRITERIA'
  5. **`declareOutcomes` 原子性（确定性触发，无 mock）**：传 `task_id: 'NONEXISTENT'` → FK throws → 验证 task 状态未变（虽然 task 不存在没什么可变，但 outcomes count = 0）。或：用 `criteria_json: null as any` 撞 NOT NULL，验证 task.state 仍是 RUNNING
  6. `recordEvaluationResult(PASS)` happy: PENDING → PASS + task WAITING_REVIEW → DONE
  7. `recordEvaluationResult(FAIL)` happy: PENDING → FAIL + task WAITING_REVIEW → RUNNING（重试路径）
  8. `recordEvaluationResult(PASS)` 二次调用 on PASS → throws OUTCOME_TERMINAL_OR_DONE
  9. `recordEvaluationResult(PASS)` after FAIL（重新评估通过）：FAIL → PASS + task RUNNING → ... 等下，state 已经是 RUNNING 不是 WAITING_REVIEW，需要 agent 先调 submit_for_review 再 evaluate；这条 case 应该是 "submit again → evaluate again → PASS"
  10. **`recordEvaluationResult` 原子性（确定性触发）**：raw SQL 把 task.state 改成 RUNNING 后调 recordEvaluationResult(PASS)，期望 assertTransition('RUNNING' → 'DONE') throws，验证 outcome.status 仍是 PENDING（rollback）
  11. `markTerminalFail` happy: PENDING → TERMINAL_FAIL + task → FAILED
  12. `markTerminalFail` from PASS → throws
  13. `getOutcomesByTask` 返回 task 的所有 outcome（v1 单 task 通常只有一行，但 case 测两行的多次声明场景）
  14. CASCADE：删 task → outcome 消失（migration 已测，repo 这里再验一遍）

- [ ] **DoD**：≥ 14 case 全绿；`grep "^export" outcomes.ts` = 6 行（同 Phase 2 blockers 口径）；module-private `transitionTaskInTx` 不导出（grep 验证）

---

### 5.3 Day 3 — DSL parser + evaluator + 7 原语

#### Task 5.3.1：DSL types + parser

**目标**：`packages/mcp-server/src/dsl/types.ts` + `parser.ts` 落地。Parser 严格——拒绝未知原语、参数类型错误、多余字段。

- [ ] **Step 1**：交付 `packages/mcp-server/src/dsl/types.ts`：
  ```ts
  export type PrimitiveName =
    | 'tests_pass'
    | 'command_exits_0'
    | 'file_exists'
    | 'regex_matches'
    | 'scratchpad_key_exists'
    | 'no_open_conflicts'
    | 'checkpoint_created_after';

  // Discriminated union — each primitive's args shape is type-checked at call site
  export type OutcomePrimitive =
    | { primitive: 'tests_pass';                args: { target?: string } }
    | { primitive: 'command_exits_0';           args: { cmd: string; cwd?: string } }
    | { primitive: 'file_exists';               args: { path: string } }
    | { primitive: 'regex_matches';             args: { file: string; pattern: string; flags?: string } }
    | { primitive: 'scratchpad_key_exists';     args: { key: string; task_id?: string } }
    | { primitive: 'no_open_conflicts';         args: { scope_paths?: string[] } }
    | { primitive: 'checkpoint_created_after';  args: { timestamp: number; task_id?: string } };

  // Resource access class — declared per primitive for LD-10 enforcement
  export type AccessClass = 'FILE' | 'COMMAND' | 'DB';
  export const PRIMITIVE_ACCESS: Record<PrimitiveName, AccessClass[]> = {
    tests_pass:                ['COMMAND', 'FILE'],   // reads package.json, runs cmd
    command_exits_0:           ['COMMAND'],
    file_exists:               ['FILE'],
    regex_matches:             ['FILE'],
    scratchpad_key_exists:     ['DB'],
    no_open_conflicts:         ['DB'],
    checkpoint_created_after:  ['DB'],
  };

  export interface EvaluationResultPerPrimitive {
    primitive: PrimitiveName;
    args: unknown;
    status: 'PASS' | 'FAIL' | 'TIMEOUT';
    detail: string;                   // brief human-readable; e.g. "tests passed in 12.3s" or "FAIL: 2 tests red"
    elapsed_ms: number;
  }

  export interface EvaluationResult {
    status: 'PASS' | 'FAIL';          // overall, AND of all primitives (LD-15)
    perPrimitive: EvaluationResultPerPrimitive[];
    summary: string;                  // markdown for evaluation_summary
  }

  // LD-11: reserved hook for future grader agent integration
  export interface GraderHook {
    evaluate(criteria: OutcomePrimitive[], ctx: { task_id: string }): Promise<EvaluationResult>;
  }
  ```

- [ ] **Step 2**：交付 `packages/mcp-server/src/dsl/parser.ts`：
  ```ts
  export function parseCriteriaJSON(raw: unknown): { ok: true; criteria: OutcomePrimitive[] } | { ok: false; errors: string[] }
  // 1. 必须是数组；空数组 → ok=false（criteria 至少 1 项；与 declareOutcomes 同 invariant）
  // 2. 每个元素必须有 primitive (string) + args (object)
  // 3. primitive 必须在 PrimitiveName 联合内（白名单）
  // 4. args 形状按 PrimitiveName 验证（discriminated union 每分支必填字段）
  // 5. 多余字段（额外 keys）不允许，拒绝
  // 返回 ok=true 的 IR 是已经类型安全的
  ```

- [ ] **Step 3**：`tests/dsl/parser.test.ts`（≥ 12 case）：
  - 7 个 happy path（每原语一个最小有效 IR）
  - 不是数组 → fail
  - 空数组 → fail（criteria-empty）
  - 未知 primitive → fail
  - args 缺必填字段 → fail（每原语至少一个）
  - args 多余字段 → fail
  - args 类型错误（如 `tests_pass.target` 传 number）→ fail

- [ ] **DoD**：≥ 12 case 全绿；parser 拒绝所有非法输入；happy path 输出 IR 通过 TS strict 类型检查

#### Task 5.3.2：7 个 primitive evaluator

**目标**：`packages/mcp-server/src/dsl/primitives.ts` 实现每个原语的评估函数。每个函数接 `{ args, ctx }` 返回 `Promise<EvaluationResultPerPrimitive>`。

- [ ] **Step 1**：交付 `primitives.ts` —— 每原语一个 async function。统一接口：
  ```ts
  type PrimitiveFn = (args: unknown, ctx: EvalContext) => Promise<EvaluationResultPerPrimitive>;

  interface EvalContext {
    db: DB;
    cwd: string;                                  // 通常是 ws.cwd
    env: NodeJS.ProcessEnv;
    timeoutMs: number;                            // LD-16: 60_000 默认
    task_id?: string;                             // 用于 scratchpad / checkpoint 类原语的 task_id 默认值
  }
  ```

  实现要点：
  - **`tests_pass`**：从 `<cwd>/package.json` 读 `scripts.test`；spawn 该 cmd（默认 `npm test` 如未声明）；`target` 参数若给定，append 到 cmd（如 `npm test -- packages/daemon`）；exit 0 = PASS，非 0 = FAIL，超时 = TIMEOUT；超时杀进程链
  - **`command_exits_0`**：直接 `child_process.spawn` cmd（用 `bash -c` 或 PowerShell `-Command`，跨平台见 CLAUDE.md），exit 0 = PASS
  - **`file_exists`**：`fs.existsSync(path.resolve(cwd, args.path))`
  - **`regex_matches`**：读文件 + 构造 RegExp（args.flags 默认 ''）+ test。文件不存在 → FAIL
  - **`scratchpad_key_exists`**：`SELECT 1 FROM scratchpad WHERE key = ? [AND task_id = ?]`（task_id 来自 args 或 ctx.task_id）
  - **`no_open_conflicts`**：`SELECT COUNT(*) FROM conflicts WHERE status = 'OPEN' [AND ... scope filter]`；scope_paths 用 LIKE 匹配 conflict.paths_json
  - **`checkpoint_created_after`**：`SELECT COUNT(*) FROM checkpoints WHERE task_id = ? AND created_at > ? AND snapshot_status = 'READY'`
  - 子进程类原语**必须**使用 `child.kill('SIGTERM')` + 5s grace + `SIGKILL`，避免 zombies（LD-16）
  - 子进程 `cwd: ctx.cwd, env: { ...ctx.env, CI: '1' }` —— 强制 CI mode 让 npm test 不开 watch / interactive

- [ ] **Step 2**：`tests/dsl/primitives.test.ts`（≥ 21 case，每原语 ≥ 3 case：happy / FAIL / edge）：
  - 用 vitest 的 tmp 目录 + makeTmpDb helper 设置 cwd / DB
  - tests_pass：跑一个有真测试的 fixture / 跑一个有 failing 测试的 fixture / 超时 fixture（用 sleep 命令模拟）
  - command_exits_0：echo 0 / false / 不存在的命令
  - file_exists：存在 / 不存在 / 路径包含 ../
  - regex_matches：match / 不 match / 文件不存在 / 无效正则
  - scratchpad_key_exists：存在 / 不存在 / task_id 过滤命中 / 不命中
  - no_open_conflicts：0 OPEN / 有 OPEN / scope 过滤
  - checkpoint_created_after：READY 后 / 仅 PENDING / 无 checkpoint

- [ ] **DoD**：≥ 21 case 全绿；子进程类原语在超时情况下不留 zombie 进程（用 process list 验证）

#### Task 5.3.3：DSL evaluator（聚合层）

**目标**：`packages/mcp-server/src/dsl/evaluator.ts` 接 IR + ctx → 调度每个 primitive → AND 聚合。

- [ ] **Step 1**：交付 `evaluator.ts`：
  ```ts
  export async function evaluateCriteria(criteria: OutcomePrimitive[], ctx: EvalContext, options?: {
    grader?: GraderHook;       // LD-11: reserved, but v1 ignores
  }): Promise<EvaluationResult>
  // 1. 串行跑每个 primitive（不并发——简化 stdio 输出 + 资源使用可预测）
  // 2. 每个 primitive 的 timeout 单独控制（LD-16）
  // 3. AND 聚合（LD-15）：所有 PASS 才整体 PASS；任一 FAIL/TIMEOUT 整体 FAIL
  // 4. summary 为 markdown：
  //    "## Evaluation result: {PASS|FAIL}\n\n"
  //    + 每个 primitive 一行 "- [{✓|✗|⏱}] {primitive}({args}) — {detail} ({elapsed_ms}ms)"
  // 5. 不调 grader hook（LD-11）— hook 参数收到也无视，输出 PASS/FAIL 来自 deterministic primitives only
  ```

- [ ] **Step 2**：`tests/dsl/evaluator.test.ts`（≥ 8 case）：
  - 单原语 PASS → 整体 PASS
  - 单原语 FAIL → 整体 FAIL
  - 多原语全 PASS → PASS
  - 多原语含 FAIL → 整体 FAIL（验证 AND）
  - 多原语含 TIMEOUT → 整体 FAIL
  - summary markdown 格式包含每原语一行
  - elapsed_ms 单调累加（评估器跑得对）
  - grader hook 传入但 v1 忽略 → 输出仍来自 deterministic（验证 LD-11）

- [ ] **DoD**：≥ 8 case；evaluator 不并发（避免 child_process 资源竞争）；AND 聚合正确

---

### 5.4 Day 4 — MCP 工具 + resume_packet 升级

#### Task 5.4.1：cairn.task.submit_for_review（追加到 tools/task.ts）

**目标**：MCP 暴露 submit_for_review。LD-12 锁：只做 transition + criteria 冻结，**不**触发 evaluate。

- [ ] **Step 1**：在 `tools/task.ts` 追加 `toolSubmitForReview(ws, args)`：
  - input: `{ task_id: string; criteria: unknown }`（criteria 是 raw JSON-ish，由 parser 校验）
  - 流程：
    1. `parseCriteriaJSON(args.criteria)` → 失败返回 `{ error: { code: 'INVALID_DSL', errors: [...], message } }`
    2. parser 通过 → 调 daemon `declareOutcomes(ws.db, { task_id, criteria: parsed })`
    3. 成功 → `{ outcome: ..., task: ... }`
    4. 失败：`TASK_NOT_FOUND` / `INVALID_STATE_TRANSITION` / `EMPTY_CRITERIA`（重新映射 daemon throws）

- [ ] **Step 2**：在 `src/index.ts` TOOLS 数组追加 schema descriptor + switch case
- [ ] **Step 3**：smoke test 25 → 26（暂时；evaluate 加完是 27）
- [ ] **DoD**：单工具 acceptance test ≥ 5 case（happy / 各错误路径）

#### Task 5.4.2：cairn.outcomes.evaluate（新文件 tools/outcomes.ts）

**目标**：MCP 暴露 evaluate。LD-17 锁：同步阻塞调用。

- [ ] **Step 1**：交付 `packages/mcp-server/src/tools/outcomes.ts`：
  ```ts
  export async function toolEvaluateOutcome(ws, args: { outcome_id: string }): Promise<...> {
    // 1. SELECT outcome from outcomes table where outcome_id = ?
    //    not found → { error: { code: 'OUTCOME_NOT_FOUND', ... } }
    // 2. assert outcome.status in ('PENDING', 'FAIL') —— PASS / TERMINAL_FAIL 不允许重新 evaluate
    //    若不允许 → { error: { code: 'OUTCOME_TERMINAL_OR_DONE', ... } }
    // 3. parse criteria from outcome.criteria_json (should already be valid since declareOutcomes parsed once;
    //    but defensive re-parse — if fails → { error: { code: 'CORRUPT_OUTCOME', ... } } )
    // 4. evaluateCriteria(criteria, { db: ws.db, cwd: ws.cwd, env: process.env, timeoutMs: 60_000, task_id })
    //    → EvaluationResult
    // 5. recordEvaluationResult(db, outcome_id, { status: result.status, summary: result.summary })
    //    → { outcome, task }
    // 6. 返回 { outcome, task, evaluation: result } —— 把 perPrimitive 结果也返回，方便 agent 看哪一项失败
  }
  ```

- [ ] **Step 2**：注册到 `src/index.ts` TOOLS + switch（这是 `cairn.outcomes.*` 命名空间下第一个工具，不在 cairn.task.* 下）
- [ ] **Step 3**：smoke test 26 → 27 tools；新加 `cairn.outcomes.evaluate` 在 sorted 位置
- [ ] **Step 4**：`tests/tools/outcomes.test.ts`（≥ 8 case）：
  - happy: 真实 fixture cwd + tmp DB + criteria=[file_exists("README.md")] → result.status='PASS'，task → DONE
  - FAIL path: criteria=[file_exists("nonexistent.txt")] → result.status='FAIL'，task 回 RUNNING
  - 重新 evaluate 路径：FAIL → 改 fixture 让 file 存在 → submit again → evaluate again → PASS
  - OUTCOME_NOT_FOUND
  - OUTCOME_TERMINAL_OR_DONE（在 PASS 之后再调 evaluate）
  - 子进程 timeout：fixture 用 `tests_pass` 跑一个 sleep 命令 → 期望 TIMEOUT verdict 在 perPrimitive，整体 FAIL
  - SESSION_AGENT_ID：grader_agent_id 当前 v1 留 null（不注入；hook 留给未来）—— 验证 outcome.grader_agent_id is null

- [ ] **DoD**：≥ 8 acceptance case；timeout path 杀掉 child process（无 zombie）

#### Task 5.4.3：resume_packet 升级填充 outcomes_criteria

**目标**：assembleResumePacket 现在为 task 取最新 outcome 的 criteria，填到 packet.outcomes_criteria 字段。

- [ ] **Step 1**：修改 `packages/mcp-server/src/resume-packet.ts`：
  - import `getOutcomesByTask` from daemon
  - 在 assemble 流程中加一步：
    ```ts
    const outcomes = getOutcomesByTask(db, task_id);
    const latest = outcomes.length > 0 ? outcomes[outcomes.length - 1] : null;
    const outcomes_criteria = latest ? latest.criteria : [];
    ```
  - **LD-9 read-only 仍生效**：getOutcomesByTask 内部只 SELECT；新读不引入任何 INSERT/UPDATE
- [ ] **Step 2**：在 `tests/tools/resume-packet.test.ts` 追加：
  - 任务有 outcome 且 criteria 含 2 个原语 → packet.outcomes_criteria 长度 = 2，结构匹配
  - 任务无 outcome → packet.outcomes_criteria = [] (Phase 2 行为不变)
  - LD-9 read-only spy test 重新跑：现在多了 SELECT outcomes 也都是 SELECT，无 mutation
- [ ] **DoD**：3 个新 case 全绿；既有 13 case 零退化；spy 验证只 SELECT

---

### 5.5 Day 5 — Live dogfood（完整闭环）

#### Task 5.5.1：起 Phase 3 dogfood 脚本

**目标**：扩展 Phase 2 dogfood 加 submit/evaluate 循环；含 retry-on-fail。

- [ ] **Step 1**：交付 `packages/mcp-server/scripts/w5-phase3-dogfood.mjs`（fork phase2 的；不要改 phase1/phase2 那两个）：

  脚本 12 步：
  1-8. 复用 Phase 2 闭环（A1: create / start / block / exit；B: resume_packet / answer / start_attempt → RUNNING）
  9. B: `cairn.task.submit_for_review({ task_id, criteria: [{ primitive: 'file_exists', args: { path: 'WILL_NOT_EXIST.tmp' } }] })` → outcome PENDING + task WAITING_REVIEW
  10. B: `cairn.outcomes.evaluate({ outcome_id })` → result.status='FAIL' + task 回 RUNNING + evaluation_summary 含 "✗ file_exists ..."
  11. B: 创建该文件（用 fs.writeFileSync from script，模拟 agent 修代码）；再次 submit + evaluate → PASS + task=DONE
  12. A2 (re-spawned): `cairn.task.get` → DONE + 完整 audit trail（cancel_reason 字段不再适用，但 metadata 应反映任务通过验收完成）

  Assertions（≥ 14）：
  - 步 9：task.state = WAITING_REVIEW；outcome.status = PENDING
  - 步 10：result.status = FAIL；task.state = RUNNING；outcome.status = FAIL；evaluation_summary 含 file_exists 名字
  - 步 11：result.status = PASS；task.state = DONE
  - 步 12：cross-process A2 看到 DONE
  - 边界：在 outcome PASS 之后再调 evaluate → OUTCOME_TERMINAL_OR_DONE
  - 边界：用空 criteria submit → INVALID_DSL（empty）
  - LD-8 wall：`cairn.outcomes.list` / `cairn.outcomes.get` 不在 tools/list

- [ ] **Step 2**：build mcp-server dist + 运行脚本，捕获输出
- [ ] **DoD**：所有 ≥ 14 assertion PASS；任意 1 步失败必须 root-cause + 修

#### Task 5.5.2：Phase 3 demo 文档

**目标**：fork Phase 2 demo 文档，写完整闭环。

- [ ] **Step 1**：交付 `docs/superpowers/demos/W5-phase3-task-handoff.md`：
  - "What this proves" 段：Phase 3 兑现"Cairn 真的能验收 agent 的工作"
  - 12 步表格 + 实际 JSON 输出 excerpts
  - "What's verified, what isn't"：明确 grader agent / DSL v2 / 自动重评估不在覆盖
  - 复现命令
- [ ] **DoD**：文档完整；所有 12 步贴真实 MCP 响应

---

### 5.6 Day 6 — 状态图 + PRODUCT.md + Phase 4 stub + 最终验收

#### Task 5.6.1：状态图更新

**目标**：4 条 Phase 3 transition 从 (Phase 3) 标签改为已激活。Phase 1+2+3 合计 12 条 transition 全部 active。

- [ ] **Step 1**：编辑 `docs/superpowers/diagrams/w5-task-state.md`：
  - Mermaid 块：去掉 (Phase 3) 后缀
  - Legend：新增"Phase 3 已激活" 4 条；Phase 1+2 transition 表移到 archive 段或合并
- [ ] **DoD**：图覆盖全部 12 条 transition；diff 行数 ≤ 25

#### Task 5.6.2：PRODUCT.md 收尾

**目标**：把 W5 段从"Phase 1+2 已交付"升级为"W5 完整闭环 done"。这是 W5 收尾的最大产品文案动作。

- [ ] **Step 1**：将 §0 W5 段改成（diff ≤ 6 行）：
  > **W5 完整闭环已交付**：Task Capsule 现在是一等公民——可暂停、可接力、可验收、可回滚。一个任务可以在 session A 停下、过一晚、由 session B 接力，最后由 outcomes DSL 自动验收（tests_pass / file_exists / 等 7 原语，AND 语义，确定性评估）。**Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**

- [ ] **DoD**：diff ≤ 6 行；W5 pitch 升级到"完整闭环已交付"

#### Task 5.6.3：Phase 4 stub

**目标**：起草 `docs/superpowers/plans/2026-XX-XX-w5-phase4-closure.md`，按 stub 风格 ≥ 60 行框架。

预定 Phase 4 内容（不实施）：
- v0.1 整体 release 准备（CHANGELOG / version bump / git tag）
- Inspector UI 改动（如果 desktop-shell 团队 / 自己有时间）
- W4 dogfood 报告 update 反映 W5 落地
- 整理 W1-W5 的整体 ARCHITECTURE.md
- 可选：grader agent v1（LD-11 hook 兑现）—— 但更可能推迟到 v0.2
- 可选：DSL v2（OR/NOT 组合子）—— 同上

- [ ] **DoD**：stub ≥ 60 行；明确"Phase 4 不再开发新核心能力，主要是 release polish"

#### Task 5.6.4：最终验证 + commit

- [ ] **Step 1**：跑全套：
  ```
  cd packages/daemon && npm test && npx tsc --noEmit
  cd packages/mcp-server && npm run build && npm test && npx tsc --noEmit
  cd packages/mcp-server && node scripts/w5-phase3-dogfood.mjs
  ```
  全绿。
- [ ] **Step 2**：grep 验证：
  ```
  grep -r "cairn\.outcomes\.(list|get)" packages/mcp-server/src    # must be EMPTY (LD-8)
  grep -r "cairn\.task\.update_state" packages/mcp-server/src      # must be EMPTY
  grep "^export" packages/daemon/src/storage/repositories/outcomes.ts    # must be 6 (1 type + 1 interface + 4 verb)
  grep -E "^\s*(INSERT|UPDATE|DELETE|ALTER)" packages/mcp-server/src/resume-packet.ts    # must be EMPTY (LD-9)
  ```
- [ ] **Step 3**：Phase 1+2 既有源码 git diff 抽查（应全为空）：
  ```
  git diff <Phase 2 final commit>..HEAD -- packages/daemon/src/storage/tasks-state.ts packages/daemon/src/storage/repositories/tasks.ts packages/daemon/src/storage/repositories/blockers.ts
  ```
- [ ] **Step 4**：Day 6 单独 commit + 5-day commit chain 干净
- [ ] **DoD**：所有验证全绿；commit chain 与 Phase 1+2 节奏一致（Day-by-Day single commits）

---

## 6. Phase 3 Demo 闭环（最终故事）

> **场景**：用户启动一个跨天的复杂重构任务，agent 中途求证、过一晚另一个 agent 接力，最后系统自动验收。
>
> 1. 用户：`task.create({ intent: "重构 daemon lanes 模块" })` → `T-001`，PENDING
> 2. session A：`task.start_attempt(T-001)` → RUNNING
> 3. session A 做了一半："要不要保留旧 sync API？"
> 4. session A：`task.block(T-001, question, context_keys)` → BLOCKED
> 5. session A 退出
> 6. 第二天，用户：`task.answer(blocker_id, "保留，加 deprecation 注释")` → READY_TO_RESUME
> 7. session B（不同机器）：`task.resume_packet(T-001)` → packet 含 intent + 已答 question + scratchpad keys
> 8. session B：`task.start_attempt(T-001)` → RUNNING
> 9. session B 完成代码：`task.submit_for_review(T-001, criteria=[tests_pass("packages/daemon"), no_open_conflicts()])` → WAITING_REVIEW
> 10. session B：`outcomes.evaluate(outcome_id)` → 跑测试，1 个 test red → outcomes.status=FAIL → task 回 RUNNING + evaluation_summary 写明哪个 test 失败
> 11. session B：agent 看 evaluation_summary，修测试，再 submit + evaluate → PASS → task=DONE
> 12. session A 重新连接 `task.get(T-001)` → DONE + 完整 audit trail

**这条故事 dogfood 跑通时，W5 完整闭环 done。最终 pitch 完全落地：**

> **Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**

---

## 7. DSL 7 原语详细规范

| 原语 | 输入 | PASS 语义 | 访问 | 关键边界 |
|---|---|---|---|---|
| `tests_pass` | `{ target?: string }` | 在 cwd（或 target 子路径）下跑 `package.json scripts.test` 或默认 `npm test`，exit 0 = PASS | COMMAND, FILE | timeout 60s；CI=1 强制非交互；监听器须 exit |
| `command_exits_0` | `{ cmd: string; cwd?: string }` | spawn cmd（bash/PowerShell wrapper），exit 0 = PASS | COMMAND | 同上；cwd 必须在 ws.cwd 子树（防止 ../../etc/passwd） |
| `file_exists` | `{ path: string }` | `fs.existsSync(path.resolve(cwd, path))` 真 = PASS | FILE | path 解析后必须仍在 ws.cwd 子树（path traversal guard） |
| `regex_matches` | `{ file: string; pattern: string; flags?: string }` | 文件可读 + RegExp(pattern, flags).test(content) = PASS | FILE | 文件不存在 = FAIL（不抛错）；正则编译失败 = FAIL with detail |
| `scratchpad_key_exists` | `{ key: string; task_id?: string }` | `SELECT 1 FROM scratchpad WHERE key=? [AND task_id=?]` 命中 = PASS | DB | task_id 缺省取 ctx.task_id；命中行为是"存在即 PASS"，不读 value |
| `no_open_conflicts` | `{ scope_paths?: string[] }` | OPEN 状态 conflict 数量 = 0 = PASS；scope_paths 给定时按 LIKE 过滤 conflicts.paths_json | DB | scope 过滤是 best-effort 字符串包含；非 SQL injection 风险 |
| `checkpoint_created_after` | `{ timestamp: number; task_id?: string }` | 该 task 在 timestamp 之后存在 ≥ 1 个 READY checkpoint = PASS | DB | timestamp 是 unix ms；只看 READY，不看 PENDING/CORRUPTED（与 resume_packet 同口径） |

**评估器框架要求**（LD-10 enforcement）：
- 每个原语函数声明它需要的 access classes（`PRIMITIVE_ACCESS` 表）
- 评估器在调用 primitive 前可（v1 不强制）做安全检查：cwd containment、命令白名单
- 子进程类原语在超时时**必须**杀进程链：`SIGTERM → 5s grace → SIGKILL`
- 子进程 stdout/stderr 限制最多 64KB（避免 OOM 写入 evaluation_summary）

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 子进程超时未真正 kill，留 zombie | 中 | 高 | LD-16 强制 SIGTERM + 5s + SIGKILL；测试用 ps / process list 验证 |
| `tests_pass` 在 monorepo 推导命令困难 | 高 | 中 | v1 仅读项目根 `package.json scripts.test`；workspace 支持留 v2；target 参数允许传 cwd 子路径作为 `npm test -- <target>` 后缀 |
| Path traversal in `file_exists` / `regex_matches` | 中 | 中 | 解析后 `path.resolve` + 检查 `.startsWith(ws.cwd)`；越界返回 FAIL with detail |
| 评估器并发 child_process 资源竞争 | 低 | 中 | LD-15 / 评估器**串行**跑每个 primitive，避免并发资源使用 |
| `evaluation_summary` markdown 过长（test 输出灌爆 DB 列） | 中 | 低 | 子进程 stdout/stderr 限 64KB；summary 按 primitive 一行，max 200 字 detail |
| Phase 1+2 既有源码被误改 | 低 | 高 | "只追加不修改" §2 锁；Day 6 git diff 抽查 |
| LD-12 被违反（submit 直接触发 evaluate） | 低 | 高 | submit_for_review 仅调 declareOutcomes；任何 primitive 调用代码必须只在 toolEvaluateOutcome 路径里出现；grep 验证 |
| LD-13 被违反（parser 与 evaluator 耦合） | 中 | 中 | 强制 parser 输出 IR、evaluator 吃 IR；IR 类型在 types.ts 单独文件，不允许循环 import |
| `cairn.outcomes.evaluate` 同步阻塞拖慢 stdio（LD-17） | 中 | 低 | 已知 v1 限制；超时 60s 兜底；caller 拆分 criteria 是 escape hatch |
| Phase 3 周期超 1.5w | 中 | 中 | 6 day 任务可派 fresh sonnet；超时砍 5.5.1 多原语 case（保留单原语 happy + 失败重试，删 multi-primitive） |
| DSL v1 表达能力被用户拉去做更多事 | 中 | 低 | LD-15 AND-only / LD-13 parser 严格白名单；扩展只能加新原语，不能加组合子（v1 不接受 PR） |

---

## 9. Phase 3 完成判据（DoD 总览）

全部满足才算 Phase 3 done：

- [ ] migration 010 落地，daemon 测试全绿（≥ 5 个新 schema test，含 CASCADE + FK）
- [ ] `repositories/outcomes.ts` + 单测 ≥ 14 case 全绿（含 declareOutcomes / recordEvaluationResult 各自的原子性测试）
- [ ] `outcomes.ts` 公开 API 恰好 6 个 named export（与 Phase 2 blockers 同口径：1 type + 1 interface + 4 verb）；module-private helper 不导出（grep 验证）
- [ ] `tasks.test.ts` 追加 ≥ 4 个 WAITING_REVIEW transition 集成 case 全绿
- [ ] `dsl/parser.ts` + 单测 ≥ 12 case 全绿（白名单严格、未知/缺字段/多余字段拒绝）
- [ ] `dsl/primitives.ts` + 单测 ≥ 21 case 全绿（每原语 happy/sad/edge ≥ 3）
- [ ] `dsl/evaluator.ts` + 单测 ≥ 8 case 全绿（AND 聚合 + grader hook 忽略验证）
- [ ] 子进程类原语在 timeout 路径下不留 zombie（process list 验证）
- [ ] `cairn.task.submit_for_review` MCP 工具 + acceptance ≥ 5 case 全绿
- [ ] `cairn.outcomes.evaluate` MCP 工具 + acceptance ≥ 8 case 全绿（含 timeout / 重试 / TERMINAL 边界）
- [ ] `outcomes_criteria` field of resume_packet 正确填充（不再总是空数组），LD-9 read-only 通过 vi.spyOn 验证
- [ ] `cairn.outcomes.list` / `cairn.outcomes.get` MCP 工具**不存在**（grep 验证 LD-8）
- [ ] Live Phase 3 dogfood ≥ 14 assertion 全 PASS through real MCP stdio + 至少 2 child mcp-server 进程
- [ ] State diagram 更新：4 条 Phase 3 transition 从 (Phase 3) 标签改成已激活
- [ ] PRODUCT.md §0 W5 段升级（diff ≤ 6 行）
- [ ] `cd packages/daemon && npm test && npx tsc --noEmit` 绿
- [ ] `cd packages/mcp-server && npm test && npx tsc --noEmit` 绿
- [ ] Phase 4 stub ≥ 60 行
- [ ] Phase 1+2 既有源码 git diff 抽查全为零（`tasks-state.ts` / `tasks.ts` / `blockers.ts` / `resume-packet.ts` 现有 export 不动）

---

## 10. Phase 4 概览（W5 收尾，详细 plan Phase 4 启动时写）

Phase 4 不再开发新核心能力，主要是 release polish：

- v0.1 release 准备：CHANGELOG / VERSION bump / git tag
- ARCHITECTURE.md 整理 W1-W5 全景
- Inspector UI 显示 outcomes 状态（如果 desktop-shell / 自己有时间）
- W4 dogfood 报告 update 反映 W5 落地
- 已知技术债清单（含 Phase 1 inspector defensive guard / spritesheet.webp / DSL workspace 推导 / 等）
- 可选 v0.2 路线预告（grader agent / DSL v2 / outcome_evaluations 子表 / 多 host handoff）

时长：3-5 天，主要文档 + release 工作。

---

## 附录 A：Phase 1+2+3 资产复用全景

| Phase 1+2 资产 | Phase 3 复用方式 |
|---|---|
| `tasks` 表 + `tasks-state.ts` `VALID_TRANSITIONS` | 直接读，不改；WAITING_REVIEW transitions 已在常量内 |
| `repositories/tasks.ts` 6 个 verb | declareOutcomes / recordEvaluationResult 内部用 updateTaskState |
| Phase 2 `transitionTaskInTx` 模块私有 helper 模式 | outcomes.ts 内独立实现一份同名 helper（不跨模块共享） |
| Phase 2 `cancelTask` / `recordBlocker` / `markAnswered` 原子性测试范式（确定性触发） | declareOutcomes / recordEvaluationResult 测试逐字模仿 |
| Phase 1+2 `INVALID_STATE_TRANSITION` / `TASK_NOT_FOUND` 错误 code | submit_for_review / evaluate 错误 code 沿用 |
| SESSION_AGENT_ID 注入（`ws.agentId`） | grader_agent_id 缺省 null（LD-11 v1 不写）；evaluate 内部不需 agent_id |
| Phase 2 dogfood 脚本范式（`@modelcontextprotocol/sdk` Client + N child + JSON 比对断言） | Phase 3 dogfood fork phase2 改步骤 |
| Phase 2 resume_packet read-only spy 测试 | Phase 3 spy 测试覆盖新加的 SELECT outcomes 路径 |
| Phase 1 ULID `newId()` | outcome_id 用同函数 |
| Phase 1+2 INTEGER unix ms 时间字段 | outcomes.created_at / evaluated_at / updated_at 一致 |

## 附录 B：Tool 动词 / 状态机映射（Phase 1+2+3 全景）

| 工具 | Phase | from | to | 备注 |
|---|---|---|---|---|
| `cairn.task.create` | 1 | (none) | PENDING | |
| `cairn.task.start_attempt` | 1 | PENDING / READY_TO_RESUME | RUNNING | 同工具，不同源状态 |
| `cairn.task.cancel` | 1+2 | PENDING / RUNNING / BLOCKED / WAITING_REVIEW | CANCELLED | Phase 3 自动支持 WAITING_REVIEW → CANCELLED |
| `cairn.task.block` | 2 | RUNNING | BLOCKED | |
| `cairn.task.answer` | 2 | BLOCKED | READY_TO_RESUME | 仅当 0 OPEN blocker (LD-7) |
| `cairn.task.resume_packet` | 2 | (read-only) | (read-only) | Phase 3 内容升级（outcomes_criteria 填充） |
| **`cairn.task.submit_for_review`** | **3** | **RUNNING** | **WAITING_REVIEW** | **新；冻结 criteria + 只 transition** |
| **`cairn.outcomes.evaluate`** | **3** | **WAITING_REVIEW** | **DONE / RUNNING** | **新；FAIL 路径回 RUNNING 让 agent 重试** |
| **`cairn.outcomes.evaluate`**（终判） | **3** | **WAITING_REVIEW** | **FAILED** | **markTerminalFail 走相同 evaluate 工具或单独 verb；v1 倾向单独 verb 减少误判** |

**永不暴露**：`cairn.task.update_state` / `cairn.outcomes.list` / `cairn.outcomes.get` / `cairn.task.list_blockers` / `cairn.task.get_blocker` / `cairn.task.set_blocker_status`。

> **TERMINAL_FAIL 触发动词决策**：v1 建议加单独工具 `cairn.outcomes.terminal_fail({ outcome_id, reason })` 而不是把它压到 evaluate 路径里——避免误把"暂时失败"当终判。Day 4 实现时确认。

## 附录 C：Migration 编号

| Migration | 主题 | 状态 |
|---|---|---|
| 001-006 | W1-W4 既有 | ✅ 已落地 |
| 007 | tasks | ✅ 已落地（W5 Phase 1） |
| 008 | dispatch_requests.task_id | ✅ 已落地（W5 Phase 1） |
| 009 | blockers | ✅ 已落地（W5 Phase 2） |
| **010** | **outcomes** | **🟡 W5 Phase 3（本 plan）** |
| 011 | (Phase 4 / v0.2 起 — 暂无规划) | 🔵 待定 |

W5 Phase 3 完成后，下一个可用 migration 编号是 **011**。
