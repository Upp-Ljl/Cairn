# Cairn v0.1 · W5 Phase 3 计划（Outcomes 验收 — 闭环：RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把 Task Capsule 从"可暂停可接力"升级到"可验收"。**Phase 3 唯一目标是把这条状态闭环跑通：`RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED`**——其中 DONE 来自验收通过，RUNNING（验收失败重试）来自验收失败但允许 agent 修后再试，FAILED 来自显式终判。验收手段是**确定性 DSL 评估器**（7 个原语），不调 LLM、不调 grader agent（schema 留 hook 但 v1 不实现）。Phase 3 完成时 W5 闭环 done：Cairn 真的能让一个任务"在 session A 停下、过一晚、在 session B 接力、最后系统自动验收测试是否通过"。

**Architecture**：Phase 1+2 已 schema-complete 状态机（`tasks-state.ts` 含 WAITING_REVIEW 全部 transitions）+ tasks/blockers 仓储 + 8 个 cairn.task.* MCP 工具。Phase 3 新增 `outcomes` 表（migration 010，独立表，**不复用 conflicts/blockers**——LD-2 同一原则；表带 `UNIQUE(task_id)` 约束，**每 task 严格一行 outcome**），仓储层 4 verb 暴露 + 私有 transition helper 复用 Phase 2 范式，DSL parser/evaluator 拆分为 `packages/mcp-server/src/dsl/` 子目录（mcp-server 层因为需要 `child_process` + `fs` 访问；daemon 保持纯 DB），MCP 层 **3 个新工具**：`cairn.task.submit_for_review` / `cairn.outcomes.evaluate` / `cairn.outcomes.terminal_fail`。submit_for_review 是 **upsert**——第一次声明 + transition；retry 时复用 outcome_id、重置 status 为 PENDING、criteria 不变；evaluate 跑评估决定 PASS/FAIL；terminal_fail 是用户主动放弃路径。

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
- **LD-6**：原子性测试用确定性运行时触发，不用 mock。Phase 3 outcomes 的 `submitOutcomesForReview` / `recordEvaluationResult` / `markTerminalFail` 沿用同样思路。
- **LD-7**：仓储动词的状态升级逻辑必须**精确计数**。Phase 3 没有"多 outcome 计数"概念（每个 task 一个 outcome 行，REPLACE 语义），但保留"评估结果决定状态"的精确-决定原则。
- **LD-8**：MCP 不暴露 list/get 类工具。Phase 3 同样**不**暴露 `cairn.outcomes.list` / `cairn.outcomes.get`——所有 outcome 访问通过 `resume_packet` 聚合视图。
- **LD-9**：resume_packet 生成 read-only。Phase 3 把 outcomes_criteria 加入 packet 时同样守 SELECT-only，prepared-statement spy 验证。

### Phase 3 新锁

- **LD-10**：DSL 评估器是**纯函数 + 受限 IO**。每个原语显式声明它访问的资源类（`FILE` / `COMMAND` / `DB`），评估器框架只允许声明列出的访问。**绝不调 LLM**，绝不动 git 状态（不 commit / push / reset），子进程超时强制 kill。
- **LD-11**：Grader agent **不在 Phase 3 v1 实现**。outcomes 表保留 `grader_agent_id` 字段 + 评估器内的 hook 接口（接受一个 `grader?: GraderHook` 参数），但 Phase 3 v1 只走 deterministic DSL 路径，verdict 完全来自 DSL 跑分结果。Hook 真实接入留 v0.2 或 W6+。
- **LD-12**：`cairn.task.submit_for_review` 是 **upsert**——不直接触发评估。
  - **首次调用**（该 task 无 outcomes 行）：① 解析 criteria；② 同一事务里 INSERT outcomes(status='PENDING', criteria_json=冻结的 criteria) + assertTransition(RUNNING → WAITING_REVIEW) + updateTaskState。
  - **重复调用**（task 已有 outcomes 行，UNIQUE(task_id) 命中）：①保留既有 outcome_id；② **不接受新的 criteria** —— 第二次调用必须省略 criteria 参数，或传与既存 criteria_json 字面相等的值（否则 throw `CRITERIA_FROZEN`）；③ 同一事务里 UPDATE outcomes SET status='PENDING', evaluated_at=NULL, evaluation_summary=NULL + updateTaskState(RUNNING → WAITING_REVIEW)。
  - **评估由独立工具 `cairn.outcomes.evaluate(outcome_id)` 触发**：每次 `submit_for_review` 把 outcome 重置回 PENDING 之后**可调用一次**，从 PENDING 走到 PASS 或 FAIL；FAIL 之后 outcome.status 是 FAIL，**不能直接再调 evaluate**——必须先走一次 `submit_for_review` 重置回 PENDING（upsert 路径）才能再 evaluate。每次 evaluate REPLACE outcomes 行的 status / evaluated_at / evaluation_summary 三个字段（criteria_json 永远不变）。
  - **闭环**：evaluate(FAIL) → task=RUNNING + outcome.status=FAIL → agent 修代码 → submit_for_review(task_id) 走 upsert 重置路径 → evaluate 再跑 → PASS → DONE。这条路径每一步都符合 `VALID_TRANSITIONS`，没有状态机违例。
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
WAITING_REVIEW ──► DONE            (cairn.outcomes.evaluate, 验收 PASS)         ◄── 新
WAITING_REVIEW ──► RUNNING         (cairn.outcomes.evaluate, 验收 FAIL)         ◄── 新（重试）
WAITING_REVIEW ──► FAILED          (cairn.outcomes.terminal_fail, 用户终判)     ◄── 新（专用工具）
```

**关键 invariant**：Phase 3 完成后所有 12 条已声明的 transitions 全部激活。`tasks-state.ts` `VALID_TRANSITIONS` 自 Phase 1 起就写好这些 transition，guard 早就 ready，Phase 3 工作只是给它们加上 MCP 触发动词。

**WAITING_REVIEW 不可被直接 cancel**：`tasks-state.ts` 的 `VALID_TRANSITIONS['WAITING_REVIEW']` 是 `{DONE, RUNNING, FAILED}`，**不包含 CANCELLED**。这是有意设计——LD-17 让 evaluate 同步阻塞，WAITING_REVIEW 实际只是 sub-second 中转态；任何"我想中途取消"的需求路径是：等 evaluate 返回（最长 60s/原语），task 落到 RUNNING（FAIL 或 TIMEOUT 都回 RUNNING）或 DONE，然后从 RUNNING 调 `cancel`。`tasks-state.ts` Phase 1 surface 不变。Phase 3 dogfood **不**断言 WAITING_REVIEW → CANCELLED——那条转换不存在。

---

## 4. File Structure（Phase 3）

```
packages/daemon/                                     # exists from Phase 1+2
├── src/
│   └── storage/
│       ├── tasks-state.ts                           # NO CHANGE
│       ├── types.ts                                 # MODIFY (add minimal StoredOutcomeCriterion = { primitive: string; args: unknown }; daemon stays type-erased from mcp-server's typed DSL union per P2.1 boundary)
│       ├── migrations/
│       │   ├── index.ts                             # MODIFY (append 010)
│       │   └── 010-outcomes.ts                      # NEW
│       └── repositories/
│           ├── tasks.ts                             # NO CHANGE
│           ├── blockers.ts                          # NO CHANGE
│           └── outcomes.ts                          # NEW — submitOutcomesForReview (upsert) / recordEvaluationResult / markTerminalFail / getOutcomeByTask + 私有 helper
└── tests/
    └── storage/
        ├── migrations.test.ts                       # MODIFY (append 010 schema test)
        ├── tasks.test.ts                            # MODIFY (append ≥4 WAITING_REVIEW transition cases)
        └── outcomes.test.ts                         # NEW — 仓储 verb + 原子性 + status 转换测试

packages/mcp-server/                                 # exists from Phase 1+2
├── src/
│   ├── tools/
│   │   ├── task.ts                                  # MODIFY (append toolSubmitForReview — upsert)
│   │   └── outcomes.ts                              # NEW — toolEvaluateOutcome + toolTerminalFailOutcome (cairn.outcomes.* 命名空间下两个工具)
│   ├── resume-packet.ts                             # MODIFY (fill outcomes_criteria field; outputs from new outcomes 仓储 read)
│   ├── dsl/                                         # NEW dir
│   │   ├── parser.ts                                # NEW — parseCriteriaJSON → OutcomePrimitive[] IR
│   │   ├── evaluator.ts                             # NEW — evaluateCriteria(IR, ctx) → EvaluationResult
│   │   ├── primitives.ts                            # NEW — 7 个 primitive functions + access-class declarations
│   │   └── types.ts                                 # NEW — IR / EvaluationResult / GraderHook 接口（LD-11 reserved）
│   └── index.ts                                     # MODIFY (register 3 new tools — submit_for_review + evaluate + terminal_fail)
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
    └── stdio-smoke.test.ts                          # MODIFY (25 → 28 tools — Phase 3 adds submit_for_review + evaluate + terminal_fail)

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
    task_id            TEXT    NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
    criteria_json      TEXT    NOT NULL,                                  -- JSON array of { primitive, args }
    status             TEXT    NOT NULL CHECK (status IN ('PENDING','PASS','FAIL','TERMINAL_FAIL')),
    evaluated_at       INTEGER,                                            -- null until first evaluate
    evaluation_summary TEXT,                                                -- markdown — last evaluation's per-primitive results
    grader_agent_id    TEXT,                                                -- LD-11: null in v1, reserved for hook
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    metadata_json      TEXT
  );
  CREATE INDEX idx_outcomes_status ON outcomes(status);
  -- task_id index implicit via UNIQUE constraint
  ```
  - 时间字段 INTEGER unix ms（Phase 1+2 一致）
  - FK CASCADE：task 删除时其 outcome 一并清除
  - **`UNIQUE(task_id)` 是 LD-14 + P1.4 review 锁定的 invariant**：每 task 严格一个 outcome 行；submit_for_review 第一次 INSERT，之后 UPSERT（重置 status=PENDING，criteria_json 不变）
  - **CHECK 含 4 状态全集**：v1 实际写入 PENDING/PASS/FAIL/TERMINAL_FAIL，未来不需 re-migration
- [ ] **Step 2**：在 `migrations/index.ts` `ALL_MIGRATIONS` 数组追加 010
- [ ] **Step 3**：在 `tests/storage/migrations.test.ts` 末尾追加（≥ 5 assertion）：
  - 列存在性 + 类型（PRAGMA table_info）
  - CHECK 接受 4 个状态值，拒绝第 5 个
  - `idx_outcomes_status` index 存在
  - **UNIQUE(task_id)** 约束生效：插入第一个 outcome 成功；第二个 outcome with same task_id → throws `UNIQUE constraint failed`
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
  - bonus：`WAITING_REVIEW → CANCELLED` **应抛错**（VALID_TRANSITIONS['WAITING_REVIEW'] = {DONE, RUNNING, FAILED}，**不含** CANCELLED；P1.2 review 锁，sub-second 中转态无 cancel 需求）
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

  export function submitOutcomesForReview(db: DB, input: {
    task_id: string;
    criteria?: StoredOutcomeCriterion[];   // 第一次必传；upsert 重置时省略 OR 必须与既存 criteria_json 字面相等
  }): { outcome: OutcomeRow; task: TaskRow }
  // **Upsert 语义（LD-12 / P1.1 review）**：
  //   FIRST CALL（该 task 无 outcomes 行）：
  //     1. assert input.criteria 非空数组；else throw 'EMPTY_CRITERIA'
  //     2. 单一事务：INSERT outcomes(outcome_id=newId(), task_id, criteria_json=JSON.stringify(criteria),
  //                                  status='PENDING', created_at, updated_at)
  //        + transitionTaskInTx(task_id, 'WAITING_REVIEW')
  //     3. 任一失败回滚两者。UNIQUE(task_id) 在首次 INSERT 时是 no-op。
  //   REPEAT CALL（task 已有 outcomes 行，UNIQUE 命中）：
  //     1. 如果 input.criteria 给定且 != 既存 criteria_json → throw 'CRITERIA_FROZEN'
  //     2. 单一事务：UPDATE outcomes SET status='PENDING', evaluated_at=NULL, evaluation_summary=NULL,
  //                                       updated_at=Date.now()
  //                  WHERE task_id=?
  //        + transitionTaskInTx(task_id, 'WAITING_REVIEW')         // 通常 currentTaskState='RUNNING'
  //     3. 任一失败回滚两者。outcome_id / criteria_json / created_at 不动。
  // 错误：TASK_NOT_FOUND / INVALID_STATE_TRANSITION / EMPTY_CRITERIA / CRITERIA_FROZEN。

  export function recordEvaluationResult(db: DB, outcome_id: string, result: {
    status: 'PASS' | 'FAIL';
    summary: string;
    evaluated_at?: number;            // 默认 Date.now()
  }): { outcome: OutcomeRow; task: TaskRow }
  // 单一事务：
  //   1. 读 outcome；**assert outcome.status === 'PENDING'**
  //      （PASS / FAIL / TERMINAL_FAIL 都不允许再写；FAIL 之后必须先经 submitOutcomesForReview 重置回
  //       PENDING——这是 P1.1 锁的状态机闭环原则）
  //      else throw 'OUTCOME_NOT_PENDING'
  //   2. UPDATE outcomes SET status, evaluated_at, evaluation_summary, updated_at
  //   3. 根据 result.status 决定 task 状态升级：
  //      - PASS → assertTransition(task.state == 'WAITING_REVIEW' → 'DONE') + transitionTaskInTx
  //      - FAIL → assertTransition(task.state == 'WAITING_REVIEW' → 'RUNNING') + transitionTaskInTx
  // 任一失败回滚全部。

  export function markTerminalFail(db: DB, outcome_id: string, reason: string): { outcome: OutcomeRow; task: TaskRow }
  // 用户主动放弃路径（对应 cairn.outcomes.terminal_fail MCP 工具，P1.3 锁）：
  //   1. 读 outcome；**assert outcome.status === 'PENDING'**
  //      （只允许从 PENDING 终判，即 task 处于 WAITING_REVIEW 时；FAIL 状态下 task 已回到 RUNNING，
  //       此时若用户想放弃应直接调 cairn.task.cancel，不应走 terminal_fail）
  //      else throw 'OUTCOME_NOT_PENDING'
  //   2. UPDATE outcomes SET status='TERMINAL_FAIL', evaluation_summary=reason,
  //                          evaluated_at=Date.now(), updated_at=Date.now()
  //   3. assertTransition(task.state == 'WAITING_REVIEW' → 'FAILED') + transitionTaskInTx

  export function getOutcomeByTask(db: DB, task_id: string): OutcomeRow | null
  // 仓储层公开（mcp-server 的 assembleResumePacket 需要）。
  // **单行返回**——UNIQUE(task_id) 保证 0 或 1 行（P1.4 锁）。
  // LD-8 不通过 MCP 暴露。

  // ─── module-private (NOT exported) ───
  // function transitionTaskInTx(db, task_id, to: TaskState): TaskRow
  //   - 与 Phase 2 blockers.ts 同名同形 helper；Phase 3 outcomes.ts 内部独立实现一份
  //   - 不跨 module 复用 Phase 2 的版本（保持模块内聚）
  ```

  **类型边界（P2.1 review 锁）**：daemon 仓储层和 mcp-server DSL parser 之间通过**类型擦除**对接，单向依赖：
  - **`packages/daemon/src/storage/types.ts` 必须先加最小接口**：
    ```ts
    export interface StoredOutcomeCriterion {
      primitive: string;          // 最小约束，daemon 不知道 7 原语白名单
      args: unknown;
    }
    ```
  - mcp-server `dsl/types.ts` 定义更窄的 `OutcomePrimitive` discriminated union（含 7 原语 + 严格 args 类型）。
  - mcp-server 把 `OutcomePrimitive[]` 写入 daemon 时**直接传**——TS 结构兼容（窄 union 满足宽 interface）。
  - daemon 读出来给 mcp-server 时返回 `StoredOutcomeCriterion[]`；mcp-server 在评估前用 DSL parser 重新校验为 `OutcomePrimitive[]`（防 DB 脏数据，且类型安全自然恢复）。
  - **方向单一**：mcp-server 知道 daemon 的 `StoredOutcomeCriterion`；daemon 不知道 mcp-server 的 `OutcomePrimitive`。依赖方向不反。

- [ ] **Step 2**：实现细节
  - `outcome_id` 从 `newId()` (ulid)，仅在首次 INSERT 时生成；upsert 重置路径不变 outcome_id
  - `criteria_json` JSON 序列化；`getOutcomeByTask` 反序列化为 `StoredOutcomeCriterion[]`（不重新校验为窄 union；那是 mcp-server 评估器的事）
  - `metadata_json` v1 始终 null
  - 私有 `transitionTaskInTx` 与 Phase 2 同名实现（每 module 自己一份，不跨模块共享 helper）
  - **首次 vs 重置判定**：在事务里先 `SELECT outcome_id FROM outcomes WHERE task_id = ?`；命中 = repeat，未命中 = first
  - **类型边界**（P2.1）：`packages/daemon/src/storage/types.ts` 必须先加 `StoredOutcomeCriterion` 接口，本任务 Step 1 的 import 才能 type-check 过

- [ ] **Step 3**：`tests/storage/outcomes.test.ts`（≥ 16 case，比 Phase 2 blockers 多 2 case 覆盖 upsert 路径）：
  1. `submitOutcomesForReview` first-call happy: RUNNING + criteria → WAITING_REVIEW + outcome.status='PENDING' + criteria_json 反序列化正确
  2. `submitOutcomesForReview` from PENDING 抛错（assertTransition）
  3. `submitOutcomesForReview` from BLOCKED 抛错
  4. `submitOutcomesForReview` first-call empty criteria 数组 → throws 'EMPTY_CRITERIA'
  5. **`submitOutcomesForReview` first-call 原子性**（确定性触发，无 mock）：用 `criteria_json` JSON.stringify 时撞 circular-ref 或 raw column NOT NULL violation；验证 task.state 仍是 RUNNING + outcomes count = 0
  6. `submitOutcomesForReview` repeat 路径 happy: 完成 first-call → recordEvaluationResult(FAIL) → task=RUNNING → submitOutcomesForReview(task_id) without criteria → outcome.status 重置为 PENDING + outcome_id 不变 + criteria_json 不变 + task.state=WAITING_REVIEW
  7. `submitOutcomesForReview` repeat with conflicting criteria → throws 'CRITERIA_FROZEN'
  8. `submitOutcomesForReview` repeat with same criteria（字面相等）→ 成功，行为同省略 criteria
  9. `recordEvaluationResult(PASS)` happy: PENDING → PASS + task WAITING_REVIEW → DONE
  10. `recordEvaluationResult(FAIL)` happy: PENDING → FAIL + task WAITING_REVIEW → RUNNING（重试路径）
  11. `recordEvaluationResult` on FAIL outcome → throws 'OUTCOME_NOT_PENDING'（必须先经 submitOutcomesForReview 重置）
  12. `recordEvaluationResult` on PASS outcome → throws 'OUTCOME_NOT_PENDING'
  13. **`recordEvaluationResult` 原子性**（确定性触发）：raw SQL 把 task.state 改成 RUNNING 后调 recordEvaluationResult(PASS)，期望 assertTransition('RUNNING' → 'DONE') throws，验证 outcome.status 仍是 PENDING + evaluated_at 仍 null（rollback）
  14. `markTerminalFail` happy: PENDING → TERMINAL_FAIL + task WAITING_REVIEW → FAILED
  15. `markTerminalFail` from FAIL → throws 'OUTCOME_NOT_PENDING'（FAIL 时 task 已在 RUNNING，应走 cancel 不应走 terminal_fail）
  16. `getOutcomeByTask` 返回 0 或 1 行：无 outcome 任务返回 null；有 outcome 任务返回单一行
  17. CASCADE：删 task → outcome 消失
  18. **UNIQUE 约束**：raw SQL 尝试给同一 task_id INSERT 两个 outcome → throws UNIQUE constraint failed（仓储层不应触发，但底层约束兜底）

- [ ] **DoD**：≥ 16 case 全绿；`grep "^export" outcomes.ts` = 6 行（1 type + 1 接口 + 4 verb：submitOutcomesForReview / recordEvaluationResult / markTerminalFail / getOutcomeByTask）；module-private `transitionTaskInTx` 不导出（grep 验证）

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
  // 1. 必须是数组；空数组 → ok=false（criteria 至少 1 项；与 submitOutcomesForReview 同 invariant）
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
  - **`tests_pass`**（P2.2 锁单一语义）：`target` 是 cwd 的子目录路径（默认 = cwd 自身）。在 `<cwd>/<target>` 目录下读 `package.json` 的 `scripts.test`，从该目录 spawn 该命令；exit 0 = PASS，非 0 = FAIL，超时 = TIMEOUT。target 缺失或不在 cwd 子树（path traversal）→ FAIL with detail。**禁**接受任意 shell 命令——那是 `command_exits_0` 的工作。superintendent 杀进程链于超时
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

#### Task 5.4.1：cairn.task.submit_for_review（追加到 tools/task.ts，**upsert 语义**）

**目标**：MCP 暴露 submit_for_review。LD-12 + P1.1 锁：只做 transition + criteria 冻结/重置；**不**触发 evaluate；首次 INSERT、retry UPSERT。

- [ ] **Step 1**：在 `tools/task.ts` 追加 `toolSubmitForReview(ws, args)`：
  - input: `{ task_id: string; criteria?: unknown }` —— criteria **首次必传**；retry 调用可省略或传与既存字面相等
  - 流程：
    1. 若 `args.criteria` 给定 → `parseCriteriaJSON(args.criteria)` → 失败返回 `{ error: { code: 'INVALID_DSL', errors, message } }`
    2. parser 通过（或省略 criteria） → 调 daemon `submitOutcomesForReview(ws.db, { task_id, criteria: parsedOrUndefined })`
    3. 成功 → `{ outcome, task }`，task.state 应是 'WAITING_REVIEW'
    4. 失败映射：`TASK_NOT_FOUND` / `INVALID_STATE_TRANSITION` / `EMPTY_CRITERIA` / `CRITERIA_FROZEN`（首次未传 criteria 也走 EMPTY_CRITERIA 路径）
- [ ] **Step 2**：在 `src/index.ts` TOOLS 数组追加 schema descriptor + switch case
- [ ] **Step 3**：smoke test 25 → 26（evaluate 加完 27；terminal_fail 加完 28，最终 28）
- [ ] **DoD**：acceptance test ≥ 6 case：(a) first-call happy, (b) repeat-call without criteria happy（task 从 RUNNING 回 WAITING_REVIEW + outcome 重置 PENDING）, (c) repeat-call with conflicting criteria → CRITERIA_FROZEN, (d) first-call without criteria → EMPTY_CRITERIA, (e) from PENDING → INVALID_STATE_TRANSITION, (f) TASK_NOT_FOUND

#### Task 5.4.2：cairn.outcomes.evaluate（新文件 tools/outcomes.ts）

**目标**：MCP 暴露 evaluate。LD-17 锁：同步阻塞调用。**只接受 PENDING outcome**——FAIL/PASS/TERMINAL_FAIL 都拒绝（FAIL 必须先经 submit_for_review 重置回 PENDING；P1.1 锁的状态机闭环）。

- [ ] **Step 1**：交付 `packages/mcp-server/src/tools/outcomes.ts`，含 `toolEvaluateOutcome`：
  ```ts
  export async function toolEvaluateOutcome(ws, args: { outcome_id: string }): Promise<...> {
    // 1. SELECT outcome from outcomes WHERE outcome_id=?；not found → { error: { code: 'OUTCOME_NOT_FOUND', ... } }
    // 2. **assert outcome.status === 'PENDING'**（只接受 PENDING）
    //    若 PASS → { error: { code: 'OUTCOME_ALREADY_PASSED', ... } }
    //    若 FAIL → { error: { code: 'OUTCOME_NEEDS_RESUBMIT', message: 'call cairn.task.submit_for_review first' } }
    //    若 TERMINAL_FAIL → { error: { code: 'OUTCOME_TERMINAL_FAIL', ... } }
    // 3. defensive re-parse criteria_json with DSL parser; corrupt → { error: { code: 'CORRUPT_OUTCOME', ... } }
    // 4. evaluateCriteria(criteria, { db, cwd, env, timeoutMs: 60_000, task_id }) → EvaluationResult
    // 5. recordEvaluationResult(db, outcome_id, { status: result.status, summary: result.summary }) → { outcome, task }
    // 6. 返回 { outcome, task, evaluation: result } —— 把 perPrimitive 结果也返回，方便 agent 看哪一项失败
  }
  ```
- [ ] **Step 2**：注册到 `src/index.ts` TOOLS + switch（`cairn.outcomes.evaluate`）
- [ ] **Step 3**：smoke test 26 → 27 tools；新加 `cairn.outcomes.evaluate` 在 sorted 位置
- [ ] **Step 4**：`tests/tools/outcomes.test.ts`（≥ 8 case）：
  - happy: 真实 fixture cwd + tmp DB + criteria=[file_exists("README.md")] → result.status='PASS'，task → DONE
  - FAIL path: criteria=[file_exists("nonexistent.txt")] → result.status='FAIL'，task 回 RUNNING
  - 重新 evaluate 路径（**P1.1 完整闭环**）：FAIL → 改 fixture 让 file 存在 → 调 submit_for_review（无 criteria，触发 upsert 重置）→ outcome.status 回 PENDING + task 回 WAITING_REVIEW → evaluate again → PASS → DONE
  - OUTCOME_NOT_FOUND
  - **OUTCOME_NEEDS_RESUBMIT**：在 FAIL 状态直接调 evaluate（跳过 submit_for_review 重置）→ 错误 code 提示 "call submit_for_review first"
  - OUTCOME_ALREADY_PASSED（在 PASS 之后再调 evaluate）
  - 子进程 timeout：fixture 用 `command_exits_0("sleep 120")` → 期望 TIMEOUT verdict 在 perPrimitive，整体 FAIL
  - LD-11 验证：grader_agent_id 当前 v1 留 null
- [ ] **DoD**：≥ 8 acceptance case；timeout path 杀掉 child process（无 zombie）

#### Task 5.4.3：cairn.outcomes.terminal_fail（追加到 tools/outcomes.ts）

**目标**（P1.3 review 锁）：MCP 暴露 terminal_fail。包装仓储动词 `markTerminalFail`。**只允许从 PENDING 状态终判**——FAIL 状态下 task 已回 RUNNING，用户应直接 cancel。

- [ ] **Step 1**：在 `tools/outcomes.ts` 追加 `toolTerminalFailOutcome(ws, args: { outcome_id: string; reason: string })`：
  ```ts
  // 1. SELECT outcome；not found → OUTCOME_NOT_FOUND
  // 2. 调 markTerminalFail(db, outcome_id, reason)
  // 3. 失败映射：'OUTCOME_NOT_PENDING'（status != PENDING）→ { error: { code: 'OUTCOME_NOT_PENDING', current_status, message: 'terminal_fail only valid for PENDING outcomes; for FAIL state cancel the task instead' } }
  // 4. 成功 → { outcome, task }，task.state='FAILED'
  ```
- [ ] **Step 2**：注册到 `src/index.ts` TOOLS + switch（`cairn.outcomes.terminal_fail`）
- [ ] **Step 3**：smoke test 27 → 28 tools；`cairn.outcomes.terminal_fail` sorted 位置
- [ ] **Step 4**：acceptance test ≥ 4 case：
  - happy: PENDING outcome + task in WAITING_REVIEW → terminal_fail → outcome.TERMINAL_FAIL + task.FAILED + reason in evaluation_summary
  - 在 FAIL 状态调 terminal_fail → OUTCOME_NOT_PENDING + 错误信息提示走 cancel
  - 在 PASS 状态调 → OUTCOME_NOT_PENDING
  - OUTCOME_NOT_FOUND
- [ ] **DoD**：≥ 4 case 全绿；smoke test 总 28 tools 通过

#### Task 5.4.4：resume_packet 升级填充 outcomes_criteria

**目标**：assembleResumePacket 为 task 取唯一 outcome 行的 criteria，填到 packet.outcomes_criteria 字段（P1.4 锁：单行模型，不是 array）。

- [ ] **Step 1**：修改 `packages/mcp-server/src/resume-packet.ts`：
  - import `getOutcomeByTask`（**注意单数**）from daemon
  - 在 assemble 流程中加一步：
    ```ts
    const outcome = getOutcomeByTask(db, task_id);
    const outcomes_criteria = outcome ? outcome.criteria : [];
    ```
  - **LD-9 read-only 仍生效**：getOutcomeByTask 内部只 SELECT
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

  脚本 13 步（带 retry 闭环 + terminal_fail 边界）：
  1-8. 复用 Phase 2 闭环（A1: create / start / block / exit；B: resume_packet / answer / start_attempt → RUNNING）
  9. B: `cairn.task.submit_for_review({ task_id, criteria: [{ primitive: 'file_exists', args: { path: 'WILL_NOT_EXIST.tmp' } }] })` → outcome PENDING（**首次**）+ task WAITING_REVIEW
  10. B: `cairn.outcomes.evaluate({ outcome_id })` → result.status='FAIL' + task 回 RUNNING + outcome.status=FAIL + evaluation_summary 含 "✗ file_exists ..."
  11. B（边界 #1）: 在 FAIL 状态直接再调 evaluate → 错误 OUTCOME_NEEDS_RESUBMIT（说明必须先 submit_for_review 重置）
  12. B（**P1.1 闭环路径**）: 创建该文件（fs.writeFileSync 模拟 agent 修代码）→ `cairn.task.submit_for_review({ task_id })`（**省略 criteria**，触发 upsert 重置）→ outcome.status 回 PENDING + outcome_id 不变 + criteria_json 不变 + task=WAITING_REVIEW
  13. B: 再次 evaluate → result.status='PASS' + task=DONE
  14. B（边界 #2）: 在 PASS 之后再调 evaluate → OUTCOME_ALREADY_PASSED
  15. **第二个 task 演示 terminal_fail 路径**（P1.3 锁）：B create + start_attempt + submit_for_review([fail-criteria]) → terminal_fail(reason="demo terminal") → outcome.TERMINAL_FAIL + task.FAILED
  16. A2 (re-spawned): `cairn.task.get` 第一个 task → DONE；第二个 task → FAILED + reason in evaluation_summary

  Assertions（≥ 16）：
  - 步 9：task.state=WAITING_REVIEW；outcome.status=PENDING；outcome_id 记下
  - 步 10：result.status=FAIL；task.state=RUNNING；outcome.status=FAIL；outcome_id 不变
  - 步 11：错误 code=OUTCOME_NEEDS_RESUBMIT
  - 步 12：upsert 后 outcome.status=PENDING；outcome_id 与步 9 相同；criteria_json 字面相同；task.state=WAITING_REVIEW
  - 步 13：result.status=PASS；task.state=DONE
  - 步 14：错误 code=OUTCOME_ALREADY_PASSED
  - 步 15：terminal_fail 后 outcome.status=TERMINAL_FAIL；task.state=FAILED；evaluation_summary='demo terminal'
  - 步 16：A2 (cross-process) 看到第一个 DONE + 第二个 FAILED
  - LD-8 wall：tools/list **不**包含 `cairn.outcomes.list` / `cairn.outcomes.get`
  - LD-12 边界：**首次** submit_for_review 不传 criteria → INVALID_DSL（empty）
  - LD-12 边界：repeat submit_for_review 传**不同的** criteria → CRITERIA_FROZEN

- [ ] **Step 2**：build mcp-server dist + 运行脚本，捕获输出
- [ ] **DoD**：所有 ≥ 16 assertion PASS；任意 1 步失败必须 root-cause + 修

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
| `tests_pass` | `{ target?: string }` | `target` 是 cwd 子目录（默认 = cwd）；在 `<cwd>/<target>` 读 `package.json scripts.test` 并从该目录 spawn；exit 0 = PASS（P2.2 单一语义：仅此一种行为；任意命令走 `command_exits_0`） | COMMAND, FILE | timeout 60s；CI=1 强制非交互；target 必须 path-resolve 后仍在 cwd 子树否则 FAIL |
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
| `tests_pass` 在 monorepo 推导命令困难 | 中 | 中 | P2.2 锁：v1 单一语义—— target 是 cwd 子目录；读该目录自己的 `package.json scripts.test`；不再有"append 参数 / workspace 推导"等可选路径，避免 caller 困惑；任意命令需求一律 `command_exits_0` |
| Path traversal in `file_exists` / `regex_matches` | 中 | 中 | 解析后 `path.resolve` + 检查 `.startsWith(ws.cwd)`；越界返回 FAIL with detail |
| 评估器并发 child_process 资源竞争 | 低 | 中 | LD-15 / 评估器**串行**跑每个 primitive，避免并发资源使用 |
| `evaluation_summary` markdown 过长（test 输出灌爆 DB 列） | 中 | 低 | 子进程 stdout/stderr 限 64KB；summary 按 primitive 一行，max 200 字 detail |
| Phase 1+2 既有源码被误改 | 低 | 高 | "只追加不修改" §2 锁；Day 6 git diff 抽查 |
| LD-12 被违反（submit 直接触发 evaluate） | 低 | 高 | submit_for_review 仅调仓储 `submitOutcomesForReview`；任何 DSL primitive 调用代码必须只在 `toolEvaluateOutcome` 路径里出现；grep 验证 |
| **P1.1 retry 状态机违例**（recordEvaluationResult 在 task=RUNNING 时被调用） | 中 | 高 | recordEvaluationResult **只接受 PENDING outcome**；FAIL 之后 outcome.status=FAIL，必须先经 submitOutcomesForReview 重置为 PENDING + task 回 WAITING_REVIEW，evaluate 才能再跑；测试 #11 / #13 + dogfood 步 11 验证错误 code OUTCOME_NEEDS_RESUBMIT |
| LD-13 被违反（parser 与 evaluator 耦合） | 中 | 中 | 强制 parser 输出 IR、evaluator 吃 IR；IR 类型在 types.ts 单独文件，不允许循环 import |
| `cairn.outcomes.evaluate` 同步阻塞拖慢 stdio（LD-17） | 中 | 低 | 已知 v1 限制；超时 60s 兜底；caller 拆分 criteria 是 escape hatch |
| Phase 3 周期超 1.5w | 中 | 中 | 6 day 任务可派 fresh sonnet；超时砍 5.5.1 多原语 case（保留单原语 happy + 失败重试，删 multi-primitive） |
| DSL v1 表达能力被用户拉去做更多事 | 中 | 低 | LD-15 AND-only / LD-13 parser 严格白名单；扩展只能加新原语，不能加组合子（v1 不接受 PR） |

---

## 9. Phase 3 完成判据（DoD 总览）

全部满足才算 Phase 3 done：

- [ ] migration 010 落地，daemon 测试全绿（≥ 6 个新 schema test，含 CASCADE + FK + **UNIQUE(task_id)** 约束）
- [ ] `repositories/outcomes.ts` + 单测 ≥ 16 case 全绿（含 submitOutcomesForReview upsert / recordEvaluationResult / markTerminalFail 各自的原子性测试 + upsert 重置路径）
- [ ] `outcomes.ts` 公开 API 恰好 6 个 named export（1 type + 1 interface + 4 verb：**`submitOutcomesForReview` / `recordEvaluationResult` / `markTerminalFail` / `getOutcomeByTask`**）；module-private helper 不导出（grep 验证）
- [ ] `packages/daemon/src/storage/types.ts` 含 `StoredOutcomeCriterion` 接口（**P2.1 锁的类型边界**）
- [ ] `tasks.test.ts` 追加 ≥ 4 个 WAITING_REVIEW transition 集成 case 全绿（**含 WAITING_REVIEW → CANCELLED 必须抛错的反向 case**，P1.2 锁）
- [ ] `dsl/parser.ts` + 单测 ≥ 12 case 全绿（白名单严格、未知/缺字段/多余字段拒绝）
- [ ] `dsl/primitives.ts` + 单测 ≥ 21 case 全绿（每原语 happy/sad/edge ≥ 3）
- [ ] `dsl/evaluator.ts` + 单测 ≥ 8 case 全绿（AND 聚合 + grader hook 忽略验证）
- [ ] 子进程类原语在 timeout 路径下不留 zombie（process list 验证）
- [ ] **3 个新 MCP 工具落地**：`cairn.task.submit_for_review` (≥ 6 case，含 upsert) / `cairn.outcomes.evaluate` (≥ 8 case，含 OUTCOME_NEEDS_RESUBMIT 边界) / **`cairn.outcomes.terminal_fail`** (≥ 4 case)
- [ ] `outcomes_criteria` field of resume_packet 正确填充（**通过单数 `getOutcomeByTask`**，不再 `outcomes.length-1`），LD-9 read-only 通过 vi.spyOn 验证
- [ ] `cairn.outcomes.list` / `cairn.outcomes.get` MCP 工具**不存在**（grep 验证 LD-8）
- [ ] Smoke test 25 → **28** tools，3 个新工具都在 sorted 位置
- [ ] Live Phase 3 dogfood ≥ 16 assertion 全 PASS through real MCP stdio + 至少 2 child mcp-server 进程（含 P1.1 完整 retry 闭环 + P1.3 terminal_fail 路径 + LD-12 边界）
- [ ] State diagram 更新：3 条 Phase 3 transition（DONE / RUNNING / FAILED out of WAITING_REVIEW）从 (Phase 3) 标签改成已激活；**WAITING_REVIEW → CANCELLED 不在图中**（P1.2 锁，VALID_TRANSITIONS 不许）
- [ ] PRODUCT.md §0 W5 段升级（diff ≤ 6 行）
- [ ] `cd packages/daemon && npm test && npx tsc --noEmit` 绿
- [ ] `cd packages/mcp-server && npm test && npx tsc --noEmit` 绿
- [ ] Phase 4 stub ≥ 60 行
- [ ] Phase 1+2 既有源码 git diff 抽查全为零（`tasks-state.ts` / `tasks.ts` / `blockers.ts` / `resume-packet.ts` 现有 export 不动；**`tasks-state.ts` `VALID_TRANSITIONS` 不动——WAITING_REVIEW 出口仍是 {DONE, RUNNING, FAILED}**）

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
| `repositories/tasks.ts` 6 个 verb | submitOutcomesForReview / recordEvaluationResult / markTerminalFail 内部用 updateTaskState |
| Phase 2 `transitionTaskInTx` 模块私有 helper 模式 | outcomes.ts 内独立实现一份同名 helper（不跨模块共享） |
| Phase 2 `cancelTask` / `recordBlocker` / `markAnswered` 原子性测试范式（确定性触发） | submitOutcomesForReview / recordEvaluationResult 测试逐字模仿 |
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
| `cairn.task.cancel` | 1+2 | PENDING / RUNNING / BLOCKED / READY_TO_RESUME | CANCELLED | **不**支持从 WAITING_REVIEW（P1.2 锁；VALID_TRANSITIONS 不许；evaluate 是 sync 中转态，超时返 RUNNING 后再 cancel） |
| `cairn.task.block` | 2 | RUNNING | BLOCKED | |
| `cairn.task.answer` | 2 | BLOCKED | READY_TO_RESUME | 仅当 0 OPEN blocker (LD-7) |
| `cairn.task.resume_packet` | 2 | (read-only) | (read-only) | Phase 3 内容升级（outcomes_criteria 填充） |
| **`cairn.task.submit_for_review`** | **3** | **RUNNING** | **WAITING_REVIEW** | **新；upsert—— 首次 INSERT outcome，retry UPDATE outcome 重置 PENDING + criteria 冻结 (P1.1 + LD-12)** |
| **`cairn.outcomes.evaluate`** | **3** | **WAITING_REVIEW** | **DONE / RUNNING** | **新；只接受 status=PENDING 的 outcome；PASS→DONE / FAIL→RUNNING（retry 必须先 submit_for_review 重置）** |
| **`cairn.outcomes.terminal_fail`** | **3** | **WAITING_REVIEW** | **FAILED** | **新；专用工具（P1.3 锁）；只允许从 PENDING outcome 终判；FAIL 状态用户应直接 cancel** |

**永不暴露**：`cairn.task.update_state` / `cairn.outcomes.list` / `cairn.outcomes.get` / `cairn.task.list_blockers` / `cairn.task.get_blocker` / `cairn.task.set_blocker_status`。

**`cairn.task.cancel` 在 Phase 3 不增加新源状态**。WAITING_REVIEW → CANCELLED 不存在于 `VALID_TRANSITIONS`，且 P1.2 锁定不去改 Phase 1 的状态机常量。用户中途想放弃路径有两条：(a) 等 evaluate 返回（最长 60s/原语），落到 RUNNING/DONE 后再 cancel；(b) 在 evaluate 之前的 PENDING 状态调 `cairn.outcomes.terminal_fail`。

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
