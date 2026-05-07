# Cairn v0.1 · W5 Phase 3 计划草稿（Outcomes 验收 — RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED）

> **Status**: 🟡 草稿（stub）— Phase 3 启动时（约 2026-05-21）扩写为完整 plan
> **Predecessors**: Phase 1 + 2 已交付（commits `5f688db..d81e762`，截至 2026-05-07）
> **Goal**: 把 Task Capsule 从"可暂停可接力"升级为"可验收"。Phase 3 唯一目标是把这一条状态闭环跑通：`RUNNING → WAITING_REVIEW → DONE / RUNNING / FAILED`，其中"RUNNING（验收失败重试）"和"DONE（验收通过完结）"两条出口由 outcomes 验收结果决定。

## Locked from Phase 1+2（不重审）

- **LD-1**：Task 一等公民。Phase 3 的 outcomes 也挂在 task 上，不绑特定 agent。
- **LD-2**：Blockers 独立表（已落地 migration 009）。Outcomes 同样独立表（migration 010），**不复用 conflicts，不复用 blockers**。
- **LD-3**：legacy_orphan 标签（read 路径）。Phase 3 outcomes 是新表，所有行强制 task_id NOT NULL，无 legacy。
- **LD-4**：Outcomes DSL 第一版含独立 `tests_pass` 原语（本 plan 兑现）。
- **LD-5**：Resume packet schema 已冻结。Phase 3 把 `outcomes_criteria` 字段从空数组填成实际数组，**不改 schema 字段**。
- **LD-6/7/8/9**：仓储动词风格 / 多 blocker 计数 / MCP 不暴露 list/get / read-only 生成 —— Phase 3 沿用同一套纪律。

## Phase 3 新锁（首次出现）

- **LD-10**：DSL 评估器是**纯函数 + 受限 IO**。每个原语显式声明它访问什么（文件 / 命令 / DB），评估器只做声明列出的访问。绝不调 LLM，绝不动 git 状态。
- **LD-11**：Grader agent **不在 Phase 3 v1 实现**。schema 留 `grader_agent_id` 字段 + hook 接口；Phase 3 v1 只有"determinstic DSL evaluator"路径，verdict 来自 DSL 跑分。
- **LD-12**：`cairn.task.submit_for_review` 不直接触发评估。它只把状态从 RUNNING → WAITING_REVIEW，并冻结当前的 outcomes_criteria。评估由独立工具 `cairn.outcomes.evaluate` 触发，可重复调用（重新跑 DSL）直到验收通过或显式终判。
- **LD-13**：DSL 7 原语的解析器 / 评估器分离。解析器输出结构化 IR（`{ primitive, args }`），评估器吃 IR + DB + workspace context 出 verdict。这样可以单测解析器与评估器各自，且未来引入新原语只动评估器。
- **LD-14**：Outcomes 表存"声明"+"最近一次评估结果"。**不**保留全部历史评估（避免无界增长）。如果未来需要审计每次评估，开 `outcome_evaluations` 子表 in 后续 phase。

## 范围（Phase 3 估约 1.5w）

### 1. Migration 010 — `outcomes` 表

```sql
CREATE TABLE outcomes (
  outcome_id        TEXT    PRIMARY KEY,
  task_id           TEXT    NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  criteria_json     TEXT    NOT NULL,                          -- JSON array of { primitive, args }
  status            TEXT    NOT NULL CHECK (status IN ('PENDING','PASS','FAIL','TERMINAL_FAIL')),
  evaluated_at      INTEGER,                                    -- null until first evaluate
  evaluation_summary TEXT,                                      -- markdown — last evaluation's per-primitive results
  grader_agent_id   TEXT,                                        -- null in Phase 3 v1; reserved for grader hook
  metadata_json     TEXT
);
CREATE INDEX idx_outcomes_task   ON outcomes(task_id);
CREATE INDEX idx_outcomes_status ON outcomes(status);
```

`PENDING` = 已声明，未评估。`PASS` / `FAIL` = 单次评估结果。`TERMINAL_FAIL` = 多次评估后人工/系统判终。

### 2. DSL 7 原语

| 原语 | 语义 | 评估方式 |
|---|---|---|
| `tests_pass(target?)` | target 路径下测试通过（默认项目根 package.json 的 `test` script） | 通过 `child_process.spawn` 运行命令；exit 0 = pass |
| `command_exits_0(cmd)` | 任意 shell 命令退出 0 | 同上 |
| `file_exists(path)` | 文件存在 | `fs.existsSync` |
| `regex_matches(file, pattern)` | 文件内容 match 正则 | 读文件 + RegExp.test |
| `scratchpad_key_exists(key)` | scratchpad 表中 key 存在（且关联 task_id 匹配） | SELECT 1 FROM scratchpad |
| `no_open_conflicts(scope?)` | 无 OPEN 状态 conflict（scope 可指定 paths） | SELECT count from conflicts |
| `checkpoint_created_after(timestamp)` | 该 task 在指定时间后有过 READY checkpoint | SELECT count from checkpoints |

每条原语都声明它访问什么类型的资源（FILE / COMMAND / DB），评估器只允许声明的访问。LD-10 守这条线。

### 3. 仓储层 — `repositories/outcomes.ts`

verb-only 公开接口：

```ts
export interface OutcomeRow { ... }
export type OutcomeStatus = 'PENDING' | 'PASS' | 'FAIL' | 'TERMINAL_FAIL';

export function declareOutcomes(db, task_id, criteria: OutcomeCriterion[]): OutcomeRow
// 与 cairn.task.submit_for_review 同时调用：写 outcomes 行 + assertTransition(RUNNING → WAITING_REVIEW)
// + updateTaskState。原子事务。

export function recordEvaluationResult(db, outcome_id, result: { status: 'PASS' | 'FAIL'; summary: string }): { outcome: OutcomeRow; task: TaskRow }
// 单一事务：写评估结果 + 根据 result.status 决定状态：
//   PASS  → assertTransition(WAITING_REVIEW → DONE)  + updateTaskState
//   FAIL  → assertTransition(WAITING_REVIEW → RUNNING) + updateTaskState（让 agent 修后再验）

export function markTerminalFail(db, outcome_id, reason: string): { outcome: OutcomeRow; task: TaskRow }
// 用户主动终判失败：WAITING_REVIEW → FAILED + outcome.status='TERMINAL_FAIL'

export function getOutcomesByTask(db, task_id): OutcomeRow[]
// 给 resume_packet 用。LD-8 不暴露为 MCP 工具。
```

### 4. MCP 工具层

新增 2 个工具（与 Phase 1+2 同样的 verb-only + 结构化 error code）：

- `cairn.task.submit_for_review` — 输入 `{ task_id, outcomes_criteria: [{ primitive, args }] }` → 调 `declareOutcomes` → 返回 outcome + task
  - 错误：INVALID_STATE_TRANSITION（task 不在 RUNNING）/ INVALID_DSL（criteria 解析失败）/ TASK_NOT_FOUND
- `cairn.outcomes.evaluate` — 输入 `{ outcome_id }` → 跑 DSL 评估 → 调 `recordEvaluationResult` → 返回 outcome + task
  - 错误：OUTCOME_NOT_FOUND / OUTCOME_ALREADY_TERMINAL / EVALUATOR_TIMEOUT（默认 60s 单原语 timeout）

### 5. resume_packet 升级

`assembleResumePacket` 多读一步：
```sql
SELECT criteria_json FROM outcomes WHERE task_id=? ORDER BY created_at DESC LIMIT 1
```
反序列化 → 填进 packet 的 `outcomes_criteria` 字段（之前 Phase 2 始终是空数组）。**read-only 仍守住**——评估在 `cairn.outcomes.evaluate` 走，不在 resume_packet 路径。

### 6. Live dogfood — 完整闭环（plan §8 故事）

扩展 `packages/mcp-server/scripts/w5-phase3-dogfood.mjs`：
1. A: create + start_attempt → RUNNING
2. A: submit_for_review(task_id, criteria=[tests_pass("packages/daemon")]) → WAITING_REVIEW
3. A: outcomes.evaluate(outcome_id) → 假设 PASS → DONE
4. B (单独 case): submit_for_review with intentionally failing criteria → outcomes.evaluate FAIL → 回 RUNNING
5. B: agent 修代码（用 scratchpad 写 fix marker）+ 再 submit_for_review → evaluate PASS → DONE

≥ 12 assertions。

### 7. PRODUCT.md 升级

W5 段从 "Phase 1+2 已交付" 改成 "Phase 1+2+3 全部交付，W5 闭环完成"。最终 pitch line 不变。

## Out of Scope（Phase 3 硬约束）

- ❌ Grader agent 实际实现（schema 留 hook，但 Phase 3 v1 不调 LLM 做评估）
- ❌ DSL 自定义原语 / plugin 机制（v1 仅 7 个内置）
- ❌ Outcomes 历史评估完整 audit log（只存"最近一次"；如需可在 Phase 4+）
- ❌ `cairn.outcomes.list` / `cairn.outcomes.get` MCP 工具（沿用 LD-8，访问只走 resume_packet 聚合）
- ❌ 自动重新评估（如 file watcher / periodic）—— v1 用户主动调 `cairn.outcomes.evaluate`
- ❌ Multi-criteria partial credit（DSL v1 是 AND 语义：所有原语 PASS 才整体 PASS）
- ❌ Inspector UI 改动（Phase 4 收尾或 W6）
- ❌ 修改 Phase 1/2 已落地代码的现有 export

## Phase 3 完成判据（DoD 框架）

- [ ] migration 010 落地 + ≥ 5 schema test
- [ ] `repositories/outcomes.ts` ≥ 4 verb + ≥ 12 case 单测
- [ ] DSL 解析器 + 评估器单测：每个原语 happy / sad / edge ≥ 3 case，总 ≥ 21 case
- [ ] `cairn.task.submit_for_review` / `cairn.outcomes.evaluate` 2 MCP 工具 + ≥ 10 acceptance case
- [ ] resume_packet `outcomes_criteria` 字段填充正确（不再总是空数组），read-only 仍生效
- [ ] Phase 3 dogfood ≥ 12 assertion 全 PASS
- [ ] State diagram 更新：4 条 Phase 3 transition 从 (Phase 3) 标签改成已激活
- [ ] PRODUCT.md §0 W5 段升级（diff ≤ 4 行）
- [ ] daemon + mcp-server 测试 + tsc 双绿
- [ ] Phase 1/2 既有源码 git diff 抽查全为零

## Phase 1/2 资产复用清单

| 已有资产 | Phase 3 复用 |
|---|---|
| `tasks-state.ts` `VALID_TRANSITIONS` 已含 WAITING_REVIEW transitions | guard 已就绪，只要工具触发 |
| `repositories/tasks.ts` `updateTaskState` | declareOutcomes / recordEvaluationResult 内部调用 |
| `mergeMetadataInTx` 风格（私有 helper） | outcomes 仓储沿用同一原子写思路 |
| `cancelTask` / `recordBlocker` / `markAnswered` 的 verb-only + 原子性测试范式 | declareOutcomes + recordEvaluationResult 沿用 |
| MCP `INVALID_STATE_TRANSITION` 错误 code 形状 | submit_for_review / evaluate 错误沿用 |
| SESSION_AGENT_ID 注入 | grader_agent_id 缺省时 fallback 到 ws.agentId |
| Phase 2 dogfood 脚本范式（`@modelcontextprotocol/sdk` Client + N child） | Phase 3 dogfood 直接 fork |
| resume_packet 路径 + JSON validator | 加 outcomes_criteria 字段非空填充 |

## Demo 故事（Phase 3 收尾时跑通）

> 用户启动一个跨天的复杂重构任务，agent 中途求证、过一晚另一个 agent 接力，**最后系统自动验收"测试是否过"**：
>
> 1-8. （继承 Phase 2 dogfood：create / start / block / answer / resume / start_attempt → RUNNING）
> 9. session B：`cairn.task.submit_for_review(T, criteria=[tests_pass("packages/daemon")])` → WAITING_REVIEW + outcomes 行（PENDING）
> 10. session B：`cairn.outcomes.evaluate(outcome_id)` → 跑测试，假设 1 个 test red → outcomes.status=FAIL → task 回 RUNNING + evaluation_summary 写明哪个 test 失败
> 11. session B：agent 看 evaluation_summary，修测试，再 `submit_for_review` → `outcomes.evaluate` → PASS → task=DONE
> 12. session A 重新连接 `task.get` → DONE + 完整 audit trail

> **W5 闭环 done 时，最终 pitch 落地：**
> **Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**

## 风险预览（Phase 3 启动时扩写为完整风险表）

- DSL 评估器对长跑命令（npm test 大型项目）超时如何处理？默认 60s 太紧或太松？
- `tests_pass` 如何在 monorepo 推导命令？v1 直接读项目根 `package.json` 的 `test` script，workspace 支持留 v2
- 评估器跑 child_process 时的 cwd / env 隔离 / 资源泄漏（zombies）
- 用户在 evaluate 半路改代码：评估快照怎么定义？v1 简单方案——每次 evaluate 看当前 working tree
- TERMINAL_FAIL 转换是否需要专门 MCP 工具，还是 reuse cancel？

## 启动 Phase 3 时需要的 plan 扩写工作

本 stub 是骨架。Phase 3 启动时按 Phase 1/2 plan 的同样深度扩写：

- §1 Locked decisions 完整列出 LD-10 ~ LD-14 + 沿用 LD-1 ~ LD-9
- §2 Out of Scope 详写
- §3 状态机激活子集图
- §4 file structure 详细
- §5 Day-by-day（5-7 天估计）
- §6-§8 DSL 原语规范 / Demo 故事 / 风险表全表
- §10 DoD 14+ 项

> **本草稿状态**：Phase 3 启动时按上述大纲扩写为完整执行 plan。当前不打开实施。
