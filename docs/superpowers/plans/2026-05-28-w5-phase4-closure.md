# Cairn v0.1 · W5 Phase 4 计划（Closure — release polish + W1-W5 全景文档）

> **状态**：stub，启动时再 expand
> **触发条件**：Phase 3 已 done（commits cd20159 / 887dbd7 / f8190d1 / 06b9500 / 13a42f2 / Day 6 收尾），dogfood 32/32 PASS，daemon 411 + mcp-server 329 全绿
> **For agentic workers**：当 Phase 4 启动时，按 `superpowers:writing-plans` 把本 stub 展开成 day-by-day 任务序列；不要在 stub 状态实施

**Goal**：W5 收尾。**不再开发新核心能力**——Phase 4 是 release polish + 文档体系整理 + 已知技术债盘点，让 v0.1 进入"可对外讲清楚"的状态。

**Out of Scope（Phase 4 硬约束）**：
- ❌ 任何 Phase 1-3 已锁的源码改动（tasks-state.ts / repositories/* / DSL stack / outcomes 工具）
- ❌ grader agent 实现（LD-11 留 v0.2）
- ❌ DSL v2 语法扩展（LD-15 锁）
- ❌ outcome_evaluations 子表 / 评估历史（LD-14 锁）
- ❌ Inspector UI 大改（除非有时间，且不能影响其他 W5 闭环）
- ❌ desktop-shell 美术资源（spritesheet.webp 仍是 W4 遗留 untracked，Phase 4 不动）

---

## 1. 候选工作项

### 1.1 v0.1 release 准备
- 写 CHANGELOG.md：聚合 W1-W5 关键里程碑（楔 / W4 Phase 1-4 / W5 Phase 1-3）
- VERSION 文件 / 各 package.json `version` 字段对齐到 0.1.0
- `git tag w5-complete` 或 `v0.1.0`（人话标签）；不强求 push

### 1.2 ARCHITECTURE.md 整理 W1-W5 全景
- 当前 ARCHITECTURE.md 主体写在 W4 dogfood 之后，W5 内容散落在 plan 文件里
- 整理一节 §X：「W5 Task Capsule + outcomes 闭环」，引用 plan/demo 不复述
- 更新 §3.4 包间依赖规则，确认 mcp-server/dsl 与 daemon outcomes 之间的单向依赖
- 更新 ADR 列表：可能需要新 ADR 记录 LD-12 upsert / LD-15 AND-only / LD-17 sync blocking

### 1.3 W4 dogfood 报告 update
- `docs/w4-dogfood-report.md` 末尾加一段「W5 后续进展」：链 Phase 1+2+3 的 demo doc + commit hash 列表
- 不重写报告本体，只追加 1-2 段

### 1.4 Inspector UI（如果有时间，否则推 v0.2）
- desktop-shell 里加 outcomes 状态显示（PENDING / PASS / FAIL / TERMINAL_FAIL）
- 状态机映射到现有 sprite 动画：WAITING_REVIEW / DONE / FAILED 各对应一个动画状态
- 这是 nice-to-have，不阻塞 release

### 1.5 已知技术债清单（写到 ARCHITECTURE.md 或新文件 docs/known-debt.md）
候选条目：
- W1 stash SHA 暂存于 `checkpoints.label` 字段（W1 技术债，未清）
- mcp-server 直接 import daemon `dist/`（pnpm workspace 治理推到 v0.2）
- spritesheet.webp / spritesheet.v0.webp pre-existing 工作区改动（不属任何 phase）
- DSL workspace 推导：`tests_pass.target` 仅支持单 package.json，monorepo 多 root 需 v0.2
- POSIX 平台 spawn-utils 实测验证缺位（Day 3 §7.1.6 仅 Windows 验过，POSIX 待 Linux/macOS 触达时补）
- recordEvaluationResult 历史完整 audit 缺位（LD-14 锁，留 v0.2 加 outcome_evaluations 子表）

### 1.6 v0.2 路线预告（≤1 页）
不做实施，只列方向：
- grader agent v1（LD-11 hook 兑现）
- DSL v2（OR/NOT 组合子）
- outcome_evaluations 子表（评估历史）
- 多 host handoff（跨机协作，本地优先松动）
- L3-L6 memory checkpoint（对话 truncate / 工具 trace / agent 内部态 / subagent 树）

---

## 2. 时长预估

3-5 天，主要文档 + release polish 工作。如果 Inspector UI 做，加 2-3 天。

## 3. DoD（启动 Phase 4 时再细化）

最少必须完成：
- [ ] CHANGELOG.md + VERSION 对齐
- [ ] ARCHITECTURE.md 整合 W5 段
- [ ] 已知技术债清单成文
- [ ] daemon + mcp-server 测试 + tsc 全绿（不动现有任何源码也应保持绿）
- [ ] git tag 候选标签创建（push 留给用户授权）

可选：
- [ ] W4 dogfood 报告 update 段落
- [ ] Inspector UI outcomes 状态显示
- [ ] v0.2 路线预告草稿

## 4. 不变量（Phase 4 必须守）

- Phase 1+2+3 已交付的 12 条 transition / 28 个 MCP 工具 / outcomes UNIQUE(task_id) 等核心 invariants 不动
- mcp-server `npm run build` 持续绿（`dist/` 是 stdio MCP 启动入口）
- DSL stack 文件 grep 约束保持：`child_process` 仅在 spawn-utils.ts；primitives 不绕过 path-utils
- 不引新 npm 依赖（除非用户授权）

## 5. 启动方式

待 Phase 3 收尾报告确认后，由用户拍板启动 Phase 4，或决定先休整、先回应反馈再说。Phase 4 stub 写完即此 plan 的全部职责，**stub 状态下不实施**。
