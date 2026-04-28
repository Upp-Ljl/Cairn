# W4 路径决策书

> 决策日期：2026-04-27（W2 EOD，W3 计划简化执行）
> 决策人：用户
> 简化模式：本周决策走简化流程（半天 preread + 本文档），不走 W3 计划原定的 5 天对比评审。理由：用户指令已隐含选定路径，跑完整流程是仪式
> 引用 spec：PRODUCT.md §4.4 / §8.2 / §9.1 / §12 A5；DESIGN_STORAGE.md §17.1

---

## 1. 用户先验倾向（决策前的输入约束）

> "实现原子操作的可逆，其它都可以推迟。优先以实现产品功能为主。"

把这条指令翻译为可验证标准：

- 选定路径必须直接产出 PRODUCT.md §4.4 US-4 的 AC（rewind preview + 文件 / git 回到 t1）
- 任何 infrastructure / polish / 文档治理类工作 default 推迟
- 对"产品功能"的认定要回到 PRODUCT.md F-1 ~ F-7 / US-1 ~ US-4，不接受"间接前置"

---

## 1.5 v0.1 范围扩张：memory checkpoint 纳入 + ship 推迟到 W15

2026-04-28 用户敲定：

- **L1（scratchpad memory checkpoint）** 纳入 v0.1：checkpoint.create 时同步快照 scratchpad 表，rewind.to 时同步 restore
- **L2（conversation truncate memory checkpoint）** 纳入 v0.1：W4-W5 daemon 设计**必须包含 conversation persistence schema**，以便 checkpoint 时快照对话、rewind 时按 checkpoint 时刻 truncate 对话
- **L3（Agent 完整内部态 memory checkpoint）** 仍推迟 v0.2

代价：v0.1 ship 时间从 PRODUCT.md §9.1 原计划的 W13 推到 **W15**（+2 周用于 L2 设计与实施）。理由：§4.4 边界"对话仍然留着它后来的发言"是用户感知最强的产品边界，关掉它产品力上一个台阶。

阻断条件：W4-W5 daemon 阶段如发现某些 LLM API（如 OpenAI Assistants API thread）的 conversation 不能精确 truncate，记录在 §5 硬风险并讨论降级方案（最坏情况：L2 推回 v0.2，仅 L1 留 v0.1，ship 仍推 W14）。

---

## 2. 选定路径：A（P2 完整 checkpoint）

### 2.1 路径定义

路径 A 执行 `docs/superpowers/plans/2026-04-23-storage-p2.md` 所描述的 P2 计划：在已有 git-stash backend 基础上，补全 rsync snapshot backend、`captureCheckpoint` 两阶段提交 helper、CORRUPTED checkpoint 扫描、`backend_data TEXT` 列（含 stash SHA 迁移脚本），并为 `rewind.preview` 加 `paths` 参数。主分支：`feat/storage-p2`。

### 2.2 决策理由

1. **直接命中 PRODUCT.md §4.4 US-4 AC**：该 AC 要求"rewind 操作前必须弹 preview，显示'本次回滚会影响 N 个文件，git 会回到 commit X'"，rewind 完成后"UI 明示文件与 git 已回到 t1"。这两条要求 checkpoint 层在技术上可靠；当前 git-stash backend 已可回滚，但 `size_bytes` 总是 0（bug #4）、label 带 `::stash:<sha>` 注入（bug #5）、clean-tree checkpoint 是无用 artifact（friction #2），说明可靠性不足，路径 A 直接修这些。
2. **baseline 数据支撑**：`docs/w3-baseline-data.md` §3.1 显示数据库中 4 条 checkpoint 的 label 全部带 `::stash:` 后缀（`before-readme-edit::stash:clean` / `after-jsdoc-dirty-tree-test::stash:19f29845...`），是 P2 必须清理的副作用；§3.3 观察 5 指出 clean-tree 浪费（4 个 checkpoint 中 2 个是无用 artifact），friction #2 长期方案（git_head 兜底）仅路径 A 之后才能根本解。
3. **用户指令"原子操作可逆"在 v0.1 范围 = 路径 A 范围**：PRODUCT.md §12 A5 明确 v0.1 rewind 仅覆盖"文件系统 + git 状态"，外部副作用（HTTP 请求、PR）是"不可回滚域"，用二次确认保护。路径 A 恰好覆盖且仅覆盖这个范围——补全 rsync backend + 两阶段提交，使文件+git 回滚在崩溃场景下也可靠。
4. **装机率 = 0，路径 C 验证条件不成立**：`docs/w3-baseline-data.md` §4 显示邀请已发出 0、已装上 0。lanes / ops 行数 = 0（§3.1），outward agent + lanes 监控（路径 C）没有真实用户数据可观测，本周启动无意义。

---

## 3. 拒绝路径 B / C 的理由

### 路径 B：daemon 主进程骨架 — 不选

PRODUCT.md §9.1 明确 W4-5 才是"daemon 骨架、任务模型、子 Agent 调度"的时间段，§8.2 要求 daemon 和 ui 进程分离作为 step-away-safe 的硬要求。路径 B 是 W5 自然顺位的工作，不直接产生 US-4 可感知的"文件 + git 回到 t1"功能，在 checkpoint 层尚不可靠的情况下先做 daemon 骨架会让 daemon 跑着但 checkpoint 崩，顺序必须 A → B；推迟到 W5 启动。

### 路径 C：outward agent + lanes 监控 — 不选

PRODUCT.md §12 A5 明确外部副作用（已发出的 HTTP 请求、已创建的 PR）在 v0.1 是"不可回滚域"，处理方式是执行前二次确认而非事后补偿；lanes / ops / compensations 表（`docs/w3-baseline-data.md` §3.1 显示当前行数 = 0）需要装机用户产生真实调用才有观测意义，当前 0 装机条件下启动该路径无法验证。推迟到装机 ≥ 3 且 W7 之后再评估。

---

## 4. W4 第一周（2026-05-04 ~ 2026-05-10）的范围承诺

### Day 1 草案（每条 ≤ 1 行）

- Task 1：技术债收尾 — `mcp-server` 改用 `@cairn/daemon` barrel 替代 deep dist/ 路径
- Task 2：起 `feat/storage-p2` 分支
- Task 3：写 migration 004 — schema-once 一次到位
  - `checkpoints` 表加 `backend_data TEXT`（snapshot 物理路径 / stash sha / rsync 路径等）
  - `checkpoints` 表加 `kind TEXT CHECK (kind IN ('manual','auto-write','auto-rewind','restore-from-rewind'))`
    （受 GitButler OperationType 启发，给时间线节点结构化分类，不再只靠 label 前缀）
  - `checkpoints` 表加 `conversation_snapshot_id TEXT`（指向 conversation 持久层的快照 id，为 L2 memory checkpoint 服务）
  - 数据迁移脚本：把现有 4 条 `::stash:<sha>` label 解码到 `backend_data`，顺手把 label 还原成纯用户可读字符串
  - 这是 schema-once 原则的总爆发：以后不再加 checkpoint schema 列
- Task 4：跑 daemon + mcp-server 全套测试 + tsc clean，确认无 regression

### Day 2-7 主轴（不细到 task）

- rsync snapshot backend（`packages/daemon/src/storage/snapshots/rsync.ts`）+ `pickSnapshotBackend(opts)` 接口（P2 计划 §OQ-2 推荐 rsync 为跨平台基线）
- clean-tree `git checkout HEAD -- <files>` 兜底（friction #2 长期方案 b）
- `captureCheckpoint` 两阶段提交 helper + CORRUPTED scan（DESIGN_STORAGE.md §8）
- `rewind.preview` 加 `paths` 参数（friction #10）
- 全程：每一项 fix 先写 failing test，TDD 约束承袭 W2/W3
- conversation persistence schema 设计 + 实现（`conversations` / `messages` / `conversation_snapshots` 三表）
- L1 memory checkpoint：checkpoint.create 同步快照 scratchpad；rewind.to 同步 restore
- L2 memory checkpoint：checkpoint.create 同步快照 conversation；rewind.to 同步 truncate（含 LLM API 兼容层）
- rsync backend 带可配置 size cap 的 gitignored 覆盖（兑现 cairn 的"bash 副作用层" niche，不再被 stash 范围限死）

### W4 末预期 exit criteria（每条二值）

- [ ] migration 004 落地（数据迁移成功，旧 4 条 checkpoint 可读，label 已脱注入）
- [ ] checkpoints 表 `kind` 字段全行有值（旧行回填为 'manual'）
- [ ] rsync backend 通过 acceptance test（与 git-stash 等价捕获/还原 + gitignored 在 size cap 内能恢复）
- [ ] clean-tree checkpoint + rewind 真正可用（friction #2 已在 W2 EOD 关闭，本条仅复测无回归）
- [ ] L1 + L2 memory checkpoint 通过端到端 acceptance test（rewind 后 scratchpad 与 conversation 都同步回退）
- [ ] daemon + mcp-server 全套测试 ≥ 当前数量（126，不减）
- [ ] conversation persistence schema 设计稿 + 至少 1 份 LLM API 兼容性 spike（验证 truncate 可行）

---

## 5. 已识别的硬风险（W4 启动前必须记录）

### 风险 1：migration 004 必须配套数据迁移

- 当前数据：`docs/w3-baseline-data.md` §3.3 标记 4 条 checkpoint 行，label 带 `::stash:<sha>`（`before-readme-edit::stash:clean` / `after-jsdoc-dirty-tree-test::stash:19f29845...`）
- 迁移脚本必须在 migration 004 落地的同一个 commit 里把 stash sha 解码写入 `backend_data` 列
- 迁移后旧 label 字段保留向后兼容（不删 `::stash:` 子串），由代码侧弃用读取（避免双写期间崩溃）
- 测试用例必须覆盖："旧 4 条 + 新 1 条" 混合 db 的 rewind 路径

### 风险 2：路径 A 单独不能 step-away-safe

- 路径 A 解锁的是"checkpoint 技术上可靠"
- "daemon 常驻、UI 关闭任务不中断"是路径 B 的范围（PRODUCT.md §8.2 daemon 与 ui 分离是 step-away-safe 的硬要求）
- 顺序必须 A → B，互换会让 daemon 跑着但 checkpoint 崩
- 预期：W4 完成 A → W5-W6 启动 B（对齐 PRODUCT.md §9.1 "W4-5 daemon 骨架"时间线）

### 风险 3：L2 memory checkpoint 受限于 LLM API 形态
- 部分 LLM API 的 conversation 是 append-only（OpenAI Assistants API 的 thread）或仅接受完整 history（Anthropic Messages API）
- truncate 必须由 cairn 自己控制 message 序列（client-side conversation store 而非 thread API），W4-W5 daemon 设计需提前选定路线
- 触发降级：若实施期发现某关键 LLM API 不支持，L2 推回 v0.2，仅留 L1 在 v0.1，ship 推 W14（不是 W15）

---

## 6. 简化决策的论据（防 W5 之后被翻案）

为什么不走 W3 计划 T3.8 ~ T3.12 的 5 天对比评审：

1. 用户指令"原子操作的可逆 + 产品功能优先"已隐含选定路径 A
2. 三路径对齐度评估（已由 strategy subagent 完成）：A=9/10、B=3/10、C=2/10
3. 装机率 = 0（`docs/w3-baseline-data.md` §4）→ 路径 C 验证条件不成立
4. PRODUCT.md §9.1 W4-5 已规划 daemon 骨架在 W5 → 路径 B 自然顺位
5. W3 计划本身的 T3.12 Step 3 允许"选定路径 + 理由 + 拒绝路径理由"作为最低输出 → 本文档已满足

如未来翻案（"早知道选 B/C"），翻案理由必须引用本文档"已识别的硬风险"中没列的新数据点，否则视为浪费时间。

2026-04-28 EOD 修订：本决策书在 W3 启动前敲定 W4 路径 A 选择，然后在 W2 EOD 楔阶段超额完成、用户敲定 v0.1 范围扩张（L1+L2 memory checkpoint）后，于 §1.5 / §4 / §5 修订 W4 范围与 W3 末 ship 预估。**修订仍维持选择路径 A 的原始决策**（A 是这些扩张的天然容器），仅扩张 A 的范围。

---

## 7. 与 PRODUCT.md / DESIGN_STORAGE.md 的对齐

- PRODUCT.md §9.1 W4-5 描述 = 本决策对齐（W4 做 checkpoint 层，W5 做 daemon 骨架）
- PRODUCT.md §4.4 US-4 AC = 本决策直接服务（rewind preview + 文件/git 回到 t1）
- DESIGN_STORAGE.md §17.1 第 1 条（`backend_data` 列）= W4 Day 1 落地（stash SHA 从 label 迁出）
- 不需要修改 PRODUCT.md / DESIGN_STORAGE.md（仅引用）；W4 Day 1 不动 schema 之外的产品 spec

---

## 8. 决策落锁

- [x] 选定路径 A
- [x] 拒绝路径 B（推迟 W5）
- [x] 拒绝路径 C（推迟 W7+）
- [x] W4 Day 1 草案已列
- [x] 硬风险已记录
- [x] 与 PRODUCT.md / §9.1 时间线对齐

**本决策于 2026-04-27 EOD 落锁，W4 Day 1（2026-05-04）按本文档执行。**
