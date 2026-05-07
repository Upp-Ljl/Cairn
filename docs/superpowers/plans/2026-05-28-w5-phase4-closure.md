# Cairn v0.1 · W5 Phase 4（Closure — Product Unification + Release Polish）

> **状态**：✅ **DONE**（2026-05-28）— 6 个 docs commit 落地，core docs 统一为 host-level multi-agent coordination kernel framing
> **Commit chain**：`f748e58` (CLAUDE) / `835513a` (PRODUCT) / `77670b8` (README) / `1e01597` (ARCHITECTURE) / `71ebbf6` (RELEASE_NOTES + demos/README) / `<this commit>` (Phase 4 closeout)

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

## 3. DoD — actual delivery

**Done in this batch (6 docs commits)**:
- ✅ CLAUDE.md baseline + positioning unified (`f748e58`) — test counts 411 / 329, W5 P1+P2+P3 done, new contributor entry-point
- ✅ PRODUCT.md unified (`835513a`) — §6.1 capabilities table corrected (F-6/7/8/9 ✅), F-10/11/12/13/14 added, §6.1.1 8 host-level state objects table, §10 timeline updated
- ✅ README.md onboarding refresh (`77670b8`) — 30-second summary leads with canonical positioning, tool count 17 → 28, Task Capsule + Blockers + Outcomes sub-sections, sample workflow
- ✅ ARCHITECTURE.md kernel framing (`1e01597`) — system diagram updated, §1.1 / §1.2 / §1.3 new sections (8 state objects + two state loops + architectural veto list), migration table 006 → 010
- ✅ RELEASE_NOTES.md + demos/README.md (`71ebbf6`) — release narrative organized by 4 stories; dogfood index of W5 Phase 1/2/3 demos
- ✅ Phase 4 closeout (this commit) — final tests + grep audit + closure plan update
- ✅ daemon + mcp-server 测试 + tsc 全绿 (411 / 329 / both tsc 0)
- ✅ Phase 1+2+3 frozen surface diff empty since this batch began (only docs touched)

**Deferred to a separate, future-phase commit (out of scope for this batch)**:
- ❌ git tag `v0.1.0` — release decision, awaits user authorization
- ❌ npm publish — release decision
- ❌ LICENSE selection — open question, requires user decision
- ❌ Inspector UI outcomes status — v0.2 unless future capacity allows
- ❌ POSIX spawn-utils experiment fixture — needs Linux/macOS dev session
- ❌ spritesheet.webp / spritesheet.v0.webp working-tree dirty file decision — explicit hold per Phase 4 instructions

## 4. 不变量（Phase 4 必须守）

- Phase 1+2+3 已交付的 12 条 transition / 28 个 MCP 工具 / outcomes UNIQUE(task_id) 等核心 invariants 不动
- mcp-server `npm run build` 持续绿（`dist/` 是 stdio MCP 启动入口）
- DSL stack 文件 grep 约束保持：`child_process` 仅在 spawn-utils.ts；primitives 不绕过 path-utils
- 不引新 npm 依赖（除非用户授权）

## 5. 启动方式

✅ Phase 3 收尾报告 + 用户拍板（"Phase 3 接受，质量达标"）→ Phase 4 在 2026-05-28 同会话中执行 → 6 docs commit 落地（`f748e58..<this>`）→ Phase 4 closeout commit 标本 plan ✅ DONE。

下一步候选（用户拍板）：
1. push 6 docs commits 到 origin（参 CLAUDE.md §推送）
2. 决策 spritesheet 工作区 dirty file 去留
3. 决策 git tag `v0.1.0` 打不打、打在哪个 SHA、是否 push
4. 启动外部 dogfood 邀请（≥ 3 multi-agent 用户）
5. 其余技术债 / v0.2 路线讨论
