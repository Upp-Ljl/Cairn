# W2 Exit Criteria 复核 + W3 种子用户分支决策

> 文档来源：W3 计划 T3.1
> 复核日期：2026-04-27（W2 Mon EOD，提前执行 — 用户决定不按日期推进）
> 复核依据：W2 计划 §Exit criteria（9 条）+ `427归档.md`（W2 Day 1 落地清单）

---

## 1. W2 Exit Criteria 9 条逐条状态

| # | 条目 | 状态 | 证据 |
|---|---|---|---|
| 1 | `.mcp.json` 配置由作者本人在自己 Claude Code 里跑通至少 1 次 | ✅ | T2.1 `5d95cdc`：`.mcp.json` 写入 + `.gitignore` 加规则；7 个工具出现在工具列表，三步验证（list/write/read）通过 |
| 2 | `docs/wedge-friction-w1.md` 存在，≥5 条完整记录（5 字段全填） | ✅ | `e6ee28c` 创建模板；后续 dogfood 填充至 10 条；每条 5 字段（场景/期望/实际/严重度/修复 idea）齐全 |
| 3 | 至少 3 个 friction-driven fix commits 进 main | ✅* | `3fa561b`（bug #1 + #2 clean-tree UX）+ `2455770`（bug #3 ISO timestamp + 4 边界测试）= 2 commits，但修复了 3 个 bug；条文按"3 个 fix"理解 ✅，按"3 个 commit"理解 🟡（2 commit 合并修了 3 个 bug，决策 6 已记录是有意合并） |
| 4 | acceptance test 总数从 9 升到 ≥14 | ✅ | mcp-server 9 → 18（+9，超出 ≥14 目标）；新增 5 个边界用例（中文 key / 220KB blob / 非 git / 并发写 / ISO 时间）+ 4 个 fix 配套测试 |
| 5 | daemon 67 tests 100% pass；mcp-server tests ≥14，100% pass | ✅ | daemon 67 + mcp-server 18 = 85，全绿；T2.9 验证 + tsc clean 两包 |
| 6 | 至少 3-5 个种子用户邀请已发出 | ❌ | T2.12-T2.15 暂缓（用户决策 7：先用楔做 cairn 自身开发，暂缓发种子用户）；累计发出 0 |
| 7 | `seed-user-tracking.md` 存在，至少 3 行用户记录 | ❌ | 文件未创建（条目 6 未做 → 无追踪对象）|
| 8 | W3 计划所需输入数据已齐（friction 清单 + 装机率 + 种子用户初次反馈） | 🟡 | friction ✅（10 条）；bug 状态 ✅（5 条，3 已修 / 2 进 P2）；装机率 = 0/0（无邀请发出）；初次反馈 = 无；W3 决策对装机率 + 反馈数据的依赖将受限 |
| 9 | 至少 1 个非作者用户装上了楔 | ❌ | 装机数 0（条目 6 + 7 的连锁结果） |

**汇总**：✅ 5 条 / 🟡 1 条 / ❌ 3 条（条目 6/7/9 同源 = 种子用户暂缓的连锁结果）

---

## 2. 分支决策

**走分支 1（W2 末 0 装机）**。

**决策理由**：
- 条目 9 = ❌（0 装机）是事实，不是漏做 — 用户在决策 7 中明示"先不必发散到用户，我们起码先自己有产品体验再说"
- 条目 6 / 7 是条目 9 的前置依赖，三条同时未达不是计划失败而是计划的"暂缓"分支
- W3 仍尝试发种子用户，但**更针对性**（不撒网，挑 1-2 个高匹配开发者私信），不是 W2 推迟的批量补做

**W3 后续行动锁定到 T3.6a**：
- 阅读本文件的"装机数 = 0"和决策理由
- 挑 1-2 个高匹配开发者（Claude Code 重度用户、friction tolerance 高）做点对点私信
- 文案改用 W2 dogfood 经验 — "我自己用了一周，rewind 跑通了，求你装一下试 5 分钟反馈"
- 发出后记录到 `seed-user-tracking.md`（届时按需创建），不再批量发

---

## 3. §17.3 成功判据 deadline 处理

W2 计划 §kill-criteria-fallback 第 9 条暗含 "§17.3 deadline = W3 末" 的假设。但 PRODUCT.md §17.3 实际只说"3 个非作者用户连续 2 周使用"，未指定具体日期。

**Day 1 决策**：§17.3 deadline 不在 W3 内修订 PRODUCT.md。
- W3 是数据收集 + 决策周，论题不动
- 修订 deadline 留 W4 决策落地后，与"是否触发 §10.2 kill 标准前置讨论"一并处理
- 本周内若装机数仍 0，记入 `docs/w3-baseline-data.md` 的"W3 末快照"段，作为 W4 头几天的输入

---

## 4. 不在本文件做的决策（推迟到对应 task）

- **T3.3 技术债 fix 范围（2 项还是 3 项）**：默认 2 项（按 W3 计划开放问题 Q3 默认建议）。T3.3 执行时由用户在选定具体项目时一并 confirm。
- **T3.6a 私信对象人选**：本周内 T3.6a 启动时由用户提名。

---

## 5. 与 PRODUCT.md / DESIGN_STORAGE.md 的同步

本次 W2 exit review **不更新** PRODUCT.md 和 DESIGN_STORAGE.md：
- §17.3 deadline 留 W4 处理（见第 3 节）
- 楔的 7 工具契约（§17.1）不变
- DESIGN_STORAGE.md §17.1 楔级技术债清单已是 W3 输入，无需更新

---

## 6. 索引

- [W2 计划](superpowers/plans/2026-04-27-wedge-w2.md) — Exit criteria 原文 §358-371
- [W3 计划](superpowers/plans/2026-05-04-wedge-w3.md) — T3.1 / T3.6a / 开放问题 Q1+Q4
- [427 归档](../427归档.md) — W2 Day 1 完成情况
- [PRODUCT.md](../PRODUCT.md) §17.3 — 楔成功判据
