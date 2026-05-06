# W3 Baseline Data — friction / bugs / 工具调用 / 技术债清单

> 文档来源：W3 计划 T3.2
> Snapshot 时间：2026-04-27 EOD（W2 Day 1 完成后）
> 用途：W3 全周决策的数据底座，避免决策时 "回忆数据"。本文件最末有 "W3 末快照" 段，由 T3.14 周末更新。

---

## 1. Friction Top 5（按 severity + 重复出现频次）

源文件：`docs/wedge-friction-w1.md`（10 条全集）。下方仅列影响 W3/W4 决策的 5 条。

| # | 标题 | 严重度 | 状态 | W4 决策相关性 |
|---|---|---|---|---|
| #2 | Clean 工作树下 checkpoint 是无用 artifact | 高 | ✅ W2 已修文案，但 git_head 兜底回滚长期方案待 W4 决策 | **路径 A 直接相关**：P2 加 `backend_data` 列后才能根本解 |
| #10 | `rewind.preview` 暴露"stash 捕获范围 ≠ 用户当前关注范围" | 中 | 🟡 文档化，代码层 paths 参数推 W3 决策 | **路径 A 间接**：P2 后能加 `paths` 参数 |
| #8 | Subagent-driven dogfood 的隔层感（楔不下传） | 中 | ✅ 已 README 文档化为产品定位 | **路径 B 直接相关**：daemon 主进程 + IPC 后 subagent 可间接访问 |
| #1 | Subagent 调不到楔（架构级） | 中 | ✅ 已 README 说明 = 产品定位 | **路径 B 直接相关**：与 #8 同源 |
| #7 | `scratchpad.list` `updated_at` 是 unix ms 不可读 | 中 | ✅ W2 已修（`updated_at_iso` 字段） | 与决策无关，已闭环 |

**汇总**：10 条 friction → 5 条已修 / 1 条文档化 / 4 条非 friction（正面信号或定位）。
**对决策的影响**：剩 #10 是唯一"未闭环 + 影响代码"的 friction，其修补方向直接绑定 W4 路径选择。

---

## 2. Bug 状态汇总

源文件：`docs/wedge-bugs-w1.md`（5 条全集）。

| # | 模块 | 严重度 | 状态 | 推后到 |
|---|---|---|---|---|
| #1 | checkpoint clean-tree 无警告 | 高 | ✅ W2 已修（`3fa561b`，warning 字段 + 文案） | 长期 git_head 兜底 → W4 决策 |
| #2 | rewind.preview 错误信息内部术语 | 中 | ✅ W2 已修（`3fa561b`，文案重写） | 闭环 |
| #3 | scratchpad.list `updated_at` unix ms | 中 | ✅ W2 已修（`2455770`，加 `updated_at_iso`） | 闭环 |
| #4 | checkpoint.size_bytes 总是 0 | 低 | ⏸ 进 P2 | 路径 A 启动后修（需真实 snapshot backend） |
| #5 | checkpoint.label 被注入 `::stash:<sha>` | 低 | ⏸ 进 P2 | 路径 A 启动后修（DESIGN_STORAGE.md §17.1，需 `backend_data` 列） |

**汇总**：5 条 bug → 3 已修 / 2 推 P2。**没有未决 bug**。

---

## 3. 工具调用分布（dogfood 期间累计）

数据来源：`~/.cairn/cairn.db`（W2 Day 1 dogfood 全期累计）+ commit 注释回忆。
注：W1/W2 楔无 telemetry，写入类工具（write/create）有 db 行数可查；读取类工具（read/list/preview/rewind.to）无持久记录，估算自会话 transcript。

### 3.1 持久层数据（db 行数 = 真实写入次数）

```sql
-- ~/.cairn/cairn.db
checkpoints  | 4 行
scratchpad   | 4 行
lanes        | 0 行 (P4 范围,W1 不写)
ops          | 0 行 (同上)
```

### 3.2 工具调用估算（dogfood 累计）

| 工具 | 估算调用次数 | 说明 |
|---|---:|---|
| `cairn.scratchpad.write` | 4 | db 实际写入数（key: test, session-handoff, readme-edit-reason, jsdoc-decisions） |
| `cairn.scratchpad.read` | 2-3 | T2.1 验证 + 后续读 session-handoff |
| `cairn.scratchpad.list` | 2-3 | T2.1 接通验证 + dogfood 期间偶尔查 |
| `cairn.checkpoint.create` | 4 | db 实际写入数（before-readme-edit / before-jsdoc / after-jsdoc-dirty-tree-test / rewind-demo-v1） |
| `cairn.checkpoint.list` | 1-2 | dogfood 偶尔验证 |
| `cairn.rewind.preview` | 3 | T2.3 README 改动 + T2.4 JSDoc 改动 + T2.5 e2e 演示 |
| `cairn.rewind.to` | 1 | **T2.5 e2e 演示 — 唯一一次真实回滚** |

### 3.3 关键观察（W4 决策输入）

1. **`rewind.to` 仅被调用 1 次**（T2.5 demo）。这是楔的核心卖点 — PRODUCT.md §17.3 成功判据的核心信号。**自用环境下用户从未真实"反悔过"**，只在故意搞坏的演示场景触发。这意味着 §17.3 判据"用户主动 rewind"在 W2 末数据上 = 0/0
2. **`scratchpad` vs `checkpoint` 比例 ≈ 1:1**：4:4。说明两类工具被使用频率相当，但 scratchpad 的 4 次都是"我自己存"，checkpoint 的 4 次有 2 次是 clean-tree（friction #2 验证完成后没用上）
3. **db 中 4 个 checkpoint 的 label 全部带 `::stash:` 后缀**：bug #5 的真实数据可见 — `before-readme-edit::stash:clean` / `after-jsdoc-dirty-tree-test::stash:19f29845...`。这是 P2 一定要清理的副作用
4. **lanes / ops = 0**：W4-W13 outward agent / lanes 监控的范围未在 W1/W2 接触；schema 已就位（migration 001），但无业务调用
5. **clean-tree 浪费**：4 个 checkpoint 中 2 个是 clean-tree（label 后缀 `::stash:clean`），它们在 W1 楔内是"无效 artifact"。W2 已加 warning 字段缓解，但**长期方案（git_head 兜底）的真实需求还是存在**

---

## 4. Dogfood 工具调用分布

个人构建路线，无外部装机数据。决策依据为 dogfood 实测结果。

**对 W4 决策的影响**：
- 三条路径中，**路径 C（outward agent + lanes 监控）** 需要更多 dogfood 积累再评估
- 路径 A 和 B 可直接从 dogfood 数据推进

---

## 5. 楔级技术债清单（W3 决策候选 + W4 决策依赖）

源文件：`DESIGN_STORAGE.md` §17.1 + `427归档.md` §5。

### 5.1 W3 候选 fix（不动 schema、可独立 commit）

| 项 | 严重度 | 估时 | T3.3 强候选排序 |
|---|---|---|---|
| `packages/daemon/src/index.ts` 仅 1 行注释 placeholder（`// @cairn/daemon main entry point`） | 低 | 0.5 h | 1（最简，热身用） |
| `mcp-server` 直接 import daemon `dist/`/`src/` 路径不一致风险 | 中 | 1-2 h | 2（加测试或 import 路径文档；无 schema 变更） |
| `checkpoints.size_bytes` 总是 0（git-stash backend 写真实大小） | 低 | 1-2 h | 3（只改写入逻辑；T3.5 须先扫描旧 size_bytes 断言防 regression — 见 W3 计划 T3.5 Step 1.5） |

**Q3 默认建议（W3 计划开放问题）= 修 2 项**。按强候选 1 + 2 执行（最简的 placeholder + 中等的 import 路径），第 3 项（`size_bytes`）推到 W4 或下次。

### 5.2 进 P2 推后（需 schema 改动 = `checkpoints.backend_data` 列加上后才动）

| 项 | 阻塞原因 | 解锁条件 |
|---|---|---|
| bug #4：`size_bytes` 真实值 | 需要 rsync/APFS backend 才有"目录大小"概念 | 路径 A 启动 |
| bug #5：`label::stash:` 注入 | 需要 `backend_data` 列存 stash sha，从 label 迁出 | 路径 A 启动；P2 起手第一改动 |

### 5.3 待 W4 决策走向才能 fix

| 项 | 依赖路径 |
|---|---|
| friction #10：`rewind.preview` 加 `paths` 参数 | 路径 A 后 |
| friction #2 长期方案 b：clean-tree `git_head` 兜底回滚 | 路径 A 后（涉及 stash backend 抽象） |

### 5.4 已知次要事项（不在 W3 处理）

- `packages/daemon/src/index.ts` 仅 1 行注释 placeholder（已列入 5.1 候选）
- mcp-server 与 daemon 的 import 路径不一致风险（已列入 5.1 候选）

---

## 6. W3 决策硬约束摘要

从 PRODUCT.md / DESIGN_STORAGE.md / W3 计划提取，作为决策时的硬边界：

- **§17.1 7 工具契约不变**（W3 不加第 8 个工具）
- **schema 不变**（migration 001/002/003 不动；P2 加 `backend_data` 列才动）
- **§17.3 deadline 不在 W3 修订** PRODUCT.md（决策见 `docs/w2-exit-review.md` §3）
- **W3 不重构**（friction-driven fix OK，整体 rewrite 不行）
- **W4 路径决策必须书面**（`docs/w4-path-decision.md`，含拒绝两条路径的理由）

---

## 7. W3 末快照（T3.14 周末填充，本节当前为 placeholder）

> 由 T3.14（W3 计划 Day 6-7）周末更新。模板已就位。

### 7.1 W3 末数据点

| 指标 | W2 EOD | W3 EOD | 差值 |
|---|---|---|---|
| 累计装机数 | 0 | (待填) | (待填) |
| `rewind.to` 累计调用 | 1 | (待填) | (待填) |
| daemon tests | 67 | (待填) | (待填) |
| mcp-server tests | 18 | (待填) | (待填) |
| friction 已修 / 已记录但未修 | 5 / 5 | (待填) | (待填) |
| bugs 已修 / 推 P2 | 3 / 2 | (待填) | (待填) |
| 已清理技术债数（T3.3 选定项） | 0 / 2 | (待填) | (待填) |

### 7.2 工具调用分布变化（如有）

（T3.14 填充：哪些工具被调用更多 / 第一次被调用 / 完全没被用）

### 7.3 触发的 kill criteria（如有）

（参照 W3 计划 §Kill criteria 兜底，如有触发条件落地，列在此）

---

## 8. 索引

- [W2 计划](superpowers/plans/2026-04-27-wedge-w2.md) — Exit criteria 全集
- [W3 计划](superpowers/plans/2026-05-04-wedge-w3.md) — T3.2 / T3.3 / T3.14
- [W2 Exit Review](w2-exit-review.md) — 9 条 W2 exit 状态 + 分支决策
- [Friction 全集](wedge-friction-w1.md) — 10 条
- [Bugs 全集](wedge-bugs-w1.md) — 5 条
- [427 归档](../427归档.md) — W2 Day 1 落地清单
- [DESIGN_STORAGE.md](../DESIGN_STORAGE.md) §17.1 — 楔级技术债通告
- [PRODUCT.md](../PRODUCT.md) §17.3 — 楔成功判据
