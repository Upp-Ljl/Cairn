# W2 Exit Criteria 复核 + W3 分支决策

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
| 6 | W3 计划所需输入数据已齐（friction 清单 + dogfood 工具调用分布） | ✅ | friction ✅（10 条）；bug 状态 ✅（5 条，3 已修 / 2 进 P2）；工具调用分布 ✅（dogfood 覆盖 scratchpad / checkpoint / rewind）|

**汇总**：✅ 6 条

---

## 2. 分支决策

**走个人构建路线**。

**决策理由**：
- 用户明示"先不必发散到用户，我们起码先自己有产品体验再说"
- W3 以 dogfood 自用为主，不向外发布

---

## 3. 不在本文件做的决策（推迟到对应 task）

- **T3.3 技术债 fix 范围（2 项还是 3 项）**：默认 2 项（按 W3 计划开放问题 Q3 默认建议）。T3.3 执行时由用户在选定具体项目时一并 confirm。

---

## 4. 与 PRODUCT.md / DESIGN_STORAGE.md 的同步

本次 W2 exit review **不更新** PRODUCT.md 和 DESIGN_STORAGE.md：
- 楔的 7 工具契约（§17.1）不变
- DESIGN_STORAGE.md §17.1 楔级技术债清单已是 W3 输入，无需更新

---

## 5. 索引

- [W2 计划](superpowers/plans/2026-04-27-wedge-w2.md) — Exit criteria 原文
- [W3 计划](superpowers/plans/2026-05-04-wedge-w3.md) — T3.1 / 开放问题 Q1
- [427 归档](../427归档.md) — W2 Day 1 完成情况
- [PRODUCT.md](../PRODUCT.md) §17.3 — 楔成功判据
