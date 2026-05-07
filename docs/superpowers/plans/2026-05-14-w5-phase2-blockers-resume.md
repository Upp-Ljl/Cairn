# Cairn v0.1 · W5 Phase 2 计划草稿（Blockers + Resume Packet）

> **Status**: 🟡 草稿（stub）— Phase 2 启动时（约 2026-05-14）扩写为完整 plan
> **Predecessor**: Phase 1 已交付（`docs/superpowers/plans/2026-05-07-w5-task-capsule.md` §10 DoD 全绿，2026-05-07）
> **Goal**: 把 Task Capsule 的"暂停-接力"语义从概念变成可用的 MCP 动词。Phase 1 交付了任务生命线；Phase 2 让任务**真的能停下来等答复，再被另一个 agent 接力**。

## Locked from Phase 1（不重审）

- LD-2 ：Blockers 用独立表，**不复用 conflicts** —— Phase 2 落 migration 009
- LD-3 ：legacy_orphan 标签策略已用于读路径，blocker 表加 task_id 时直接强制 NOT NULL（Phase 2 起新数据无 legacy 兼容窟窿）
- §6 Resume Packet JSON schema 已冻结，Phase 2 直接按那个结构实现，不再讨论字段
- 状态机 transitions：`RUNNING → BLOCKED`、`BLOCKED → READY_TO_RESUME`、`BLOCKED → CANCELLED`、`READY_TO_RESUME → RUNNING` 已在 `tasks-state.ts` `VALID_TRANSITIONS` 中——Phase 2 不改 guard，只激活动词

## 范围（Phase 2 ~1w）

### 1. Migration 009 — `blockers` 表

```sql
CREATE TABLE blockers (
  blocker_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  context_keys   TEXT,                       -- JSON array of scratchpad keys
  status         TEXT NOT NULL CHECK (status IN ('OPEN','ANSWERED','SUPERSEDED')),
  raised_by      TEXT,                       -- agent_id who blocked
  raised_at      INTEGER NOT NULL,
  answer         TEXT,                       -- null until answered
  answered_by    TEXT,                       -- agent_id or 'user'
  answered_at    INTEGER,
  metadata_json  TEXT
);
CREATE INDEX idx_blockers_task    ON blockers(task_id);
CREATE INDEX idx_blockers_status  ON blockers(status);
```

**OPEN → ANSWERED**：通过 `cairn.task.answer`。
**OPEN → SUPERSEDED**：当任务被取消或 blocker 被新 blocker 替代时（Phase 2 v1 暂不主动写 SUPERSEDED，留给 Phase 3+）。

### 2. 仓储层 — `repositories/blockers.ts`

按 LD-1 verb-only 原则，导出动词，不导出自由 metadata patch：

```ts
export function recordBlocker(db, input: { task_id, question, context_keys?, raised_by? }): BlockerRow
// 单一事务：assertTransition(taskState, 'BLOCKED') → updateTaskState(BLOCKED) + insert blocker(OPEN)
// 失败任一回滚两者

export function markAnswered(db, blocker_id, input: { answer, answered_by }): BlockerRow
// 单一事务：blocker.OPEN → ANSWERED + 该 task 是否所有 blockers 都 ANSWERED？
//   若是：updateTaskState(taskId, 'READY_TO_RESUME')
//   若否：task 状态保持 BLOCKED

export function listBlockers(db, filter?: { task_id?, status? }): BlockerRow[]
export function getBlocker(db, blocker_id): BlockerRow | null

// module-private（复用 Phase 1 mergeMetadataInTx 风格的私有 helper）
// function transitionToBlockedInTx / transitionToReadyToResumeInTx
```

**关键不变量**：仓储层不暴露 `cancelBlocker` 等"自由 status set"——Phase 2 v1 只有 OPEN 和 ANSWERED 两个外部可达状态，SUPERSEDED 留给 Phase 3。

### 3. MCP 工具层 — `tools/task.ts`（追加）

新增 3 个工具（与 Phase 1 同样的 verb-only 风格 + 结构化 error code）：

- `cairn.task.block` — 输入 `{ task_id, question, context_keys? }` → 调 `recordBlocker` → 返回 blocker + 更新后的 task
  - 错误：`INVALID_STATE_TRANSITION`（task 不在 RUNNING）/ `TASK_NOT_FOUND`
- `cairn.task.answer` — 输入 `{ blocker_id, answer }` → 调 `markAnswered` → 返回 blocker + task
  - 错误：`BLOCKER_NOT_FOUND` / `BLOCKER_ALREADY_ANSWERED`
- `cairn.task.resume_packet` — 输入 `{ task_id }` → 读取 task / blockers / 关联 scratchpad / outcomes（如 Phase 3 已落则带；Phase 2 阶段 outcomes 字段为空数组）→ 返回结构化 packet（按本 plan §6 schema）
  - **read-only**，不改状态。允许在任何状态下调用（READY_TO_RESUME 是常规用途；BLOCKED / WAITING_REVIEW / RUNNING 也允许，方便观察状态）

### 4. 测试

- `tests/storage/blockers.test.ts`（≥ 12 case）
- `tests/tools/task-block-answer.test.ts`（≥ 8 acceptance case；含跨 process 通过 dogfood 脚本）
- `tests/tools/resume-packet.test.ts`（≥ 6 case，schema validator 校验输出结构与 §6 一致）

### 5. Live dogfood

扩展 `packages/mcp-server/scripts/w5-phase1-dogfood.mjs` 为 `w5-phase2-dogfood.mjs`：
session A 创建任务 → start_attempt → block(question="X?") → 退出 → session B 启动 → answer(blocker_id, "Y") → resume_packet → start_attempt → cancel。
9+ assertions。

## Out of Scope（明确不在 Phase 2 做）

- ❌ Outcomes / DSL / grader（Phase 3）
- ❌ blocker 主动 SUPERSEDED / 时效过期机制
- ❌ resume_packet 自动喂给某个 agent —— packet 是 structured artifact，调用方自己决定怎么消费
- ❌ Inspector UI 改动（desktop-shell / Inspector 留 Phase 4 收尾）
- ❌ blocker 上的对话线程（多轮问答）—— Phase 2 v1 只支持单轮 question/answer

## DoD（Phase 2 完成判据）

- [ ] migration 009 + blockers 仓储 + 单测全绿
- [ ] 3 个新 MCP 工具 + acceptance 测试全绿；`grep` 验证 `update_state` / `setStatus` 类自由动词不存在
- [ ] resume_packet 输出结构与本 plan §6 严格一致（JSON schema validator 锁住）
- [ ] Phase 2 dogfood 脚本所有 assertion PASS
- [ ] PRODUCT.md §0 W5 段从"Phase 1 已交付任务生命线骨架"改成"Phase 1+2 已交付生命线 + 暂停接力"
- [ ] Phase 3（Outcomes）plan 草稿 ≥ 50 行框架

---

## 附：Phase 2 与 Phase 1 的依赖关系

| Phase 1 资产 | Phase 2 复用 |
|---|---|
| `tasks` 表 / `tasks-state.ts` / `VALID_TRANSITIONS` | 直接用，不改 |
| `tasks` 仓储的 `mergeMetadataInTx` 模块私有 helper | Phase 2 内部复用同一模式实现 blocker 的原子写 |
| `cancelTask` 动词风格 | Phase 2 的 `recordBlocker` / `markAnswered` 沿用 |
| `INVALID_STATE_TRANSITION` 错误 code 风格 | Phase 2 错误 code 沿用同一 schema |
| `legacy_orphan` 注解（read 路径） | Phase 2 的 blocker 不需要 legacy 兼容（新表新数据） |
| MCP stdio dogfood 脚本范式 | Phase 2 dogfood 直接 fork w5-phase1-dogfood.mjs |

> **本草稿状态**: Phase 2 启动时按上述大纲扩写为执行 plan（每个 task 拆 day-by-day step + DoD）。当前不打开实施。
