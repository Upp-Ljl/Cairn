# Cairn v0.1 · 个人构建路线（W4-W8 加速版）

> **Goal**：用 4-5 周做完四能力 + Floating Marker，自用为主，不做 packaging。
> **替代**：`docs/superpowers/plans/2026-05-04-wedge-w3.md`（已标 DEPRECATED）
> **决策来源**：`429归档.md` 决策 36（2026-04-29 EOD）

---

## 0. 定位与"自用为主"的边界

v0.2 产品定位不变（Agent OS / 三动词 / 四能力），只是 v0.1 实施节奏精简。

**精简内容**：不做安装包、不做 onboarding 文档、不做大样本统计验证。

**判据降档**：从"用户能装一个 app 用"降低到"作者自己装一遍跑通自己日常工作流"。四个能力各跑一次自测，全 PASS 即 v0.1 可用版本。

**不变的东西**：产品方向（PRODUCT.md 不动）、架构设计（ARCHITECTURE.md 锚点继续回填）、8 工具契约、migration append-only 原则、测试只增不减。

---

## 1. 砍掉清单（与原 13 周 plan 对比）

| 项目 | 砍掉理由 | 未来重启触发条件 |
|---|---|---|
| PoC-4 大样本 dogfood（5 任务 × 15 subagent） | 自己用不需要统计置信度，感知即判据 | 打算给别人用时重跑 |
| D-1（Cursor / Cline / Aider 接入调研） | 用户只用 CC，调研无实际收益 | 确实要支持第二 host 时再做 |
| D-2（daemon 资源 baseline 测量脚本） | 自己机器自己感知，不需要采样脚本 | 发现 memory leak 或用户投诉时补测 |
| D-3（provider 间质量差距，第二 provider 增量 PoC-3） | PoC-3 partial MiniMax 数据已够用；换 provider 那天 30 分钟补跑 | 真的要换 provider 时再跑 |
| D-4（假阳性率精确统计） | 自用阶段自己感知，假阳性多了自然会收紧路径匹配 | 需要对外宣布性能指标时补测 |
| W11-W12 release packaging（npm publish / 安装包 / GitHub release） | 不发布给别人，不需要 | 确定开放给他人使用时再做 |
| 4-persona stress-test（PRODUCT.md 质量门槛） | 自己是唯一用户，stress-test 是给别人读的 | PRODUCT.md 大改并准备公开时恢复 |
| RC / exit criteria 仪式 | 自用模式不需要 | 准备开放给他人使用时再做 |
| W3 整周前置验证收尾 | 已有 PoC-1/2 PASS + PoC-3 partial 足够；直接进编码 | 不重启，已验证够用 |
| 第二 provider 增量 PoC-3 | 见 D-3 | 换 provider 时再补 |

**保留的核心**：四能力实现、Floating Marker（提前到 v0.1 末段）、8 工具契约不破坏、migration append-only、测试只增不减、subagent rotation 工作模式、每能力做完跑 npm test、ARCHITECTURE.md 锚点回填、应用层兜底 4 条。

---

## 2. 不变量（硬约束）

以下约束在任何 task 执行过程中不得破坏：

- **8 个已落地工具接口签名不破坏**：参数只加可选，不改已有参数语义，不删
- **migration append-only**：migration 004 / 005 只新增，不修改已落地的 001-003；checksum guard 会拒绝已落地 migration 的任何修改
- **测试只增不减**：每个能力做完后，`npm test` 数量只多不少；W4 末 daemon ≥ 90 + mcp-server ≥ 42（基准 132），完成时预期 ≥ 160
- **subagent rotation**：每个 task 派一只 fresh sonnet，主 agent 做战略决策 + 验收，不用主 agent 写代码
- **每个能力做完跑 npm test**：两个包都跑，都绿才算能力完成
- **ARCHITECTURE.md 锚点回填**：每个能力做完后，更新对应 §6.x（一到两段话，不重写全节）
- **应用层兜底 4 条必须进 Dispatch v1 acceptance**（来自 ADR-4 PoC-3 partial 结论）：
  1. 不可逆操作（rewind / delete）强制 preview，不依赖 LLM 识别
  2. 调外部 API 类任务强制 user 知情同意提示
  3. 同文件多 agent 并行一律提示串行化
  4. 直接 SQL 操作一律走 cairn 工具路径

---

## 3. 4-5 周分解

**总时间线（2026-05-06 起计）**

| 周次 | 天数 | 内容 |
|---|---|---|
| Week 1 | 5-7 天 | 冲突可见 v1 |
| Week 2-3 | 10-14 天 | 需求可派 + Inspector |
| Week 3-4 | 3-5 天 | 消息可达 v1 |
| Week 4-5 | 5-7 天 | Floating Marker v1（Tauri） |

---

### 3.1 Week 1（约 5-7 天）：冲突可见 v1

**Goal**：从 ARCHITECTURE.md §6.1 数据流落地到可跑的代码，包括进程总线 + 冲突检测 + git hook + 安装命令。

**Spec 来源**：ARCHITECTURE.md §6.1 / §4.3 / ADR-1 / ADR-5；DESIGN_STORAGE.md §processes + §conflicts。

---

#### 3.1.1 migration 004：processes + conflicts 表

**目标**：新增两张表，不改已有 001-003。

- 参考 ARCHITECTURE.md §4.3 DDL（`processes` 表 + `conflicts` 表，含 CHECK 约束和索引）
- 写 `packages/daemon/src/storage/migrations/004-processes-conflicts.ts`
- 在 `migrations/index.ts` 的 `ALL_MIGRATIONS` 数组末尾插入
- 在 `tests/storage/migrations.test.ts` 追加 schema 测试（PRAGMA table_info 验证各列）
- 运行 `npm test`，确认绿

**时间盒**：0.5 天

---

#### 3.1.2 进程总线 4 工具

**目标**：实现 ARCHITECTURE.md §5.2 中的进程总线工具集。

4 个工具：
- `cairn.process.register(agent_id, agent_type, capabilities)` — INSERT OR REPLACE，初始 status='ACTIVE'
- `cairn.process.heartbeat(agent_id)` — UPDATE last_heartbeat，DEAD 的重激活为 ACTIVE
- `cairn.process.list()` — 返回 ACTIVE + IDLE，过滤掉 TTL 超时变 DEAD 的（lazy GC：查时计算）
- `cairn.process.status(agent_id)` — 返回单个 agent 状态

**实现位置**：
- `packages/daemon/src/repositories/ProcessRepo.ts`
- `packages/mcp-server/src/tools/process-*.ts`（或按已有工具拆分方式）
- 对应测试文件

**时间盒**：1.5 天

---

#### 3.1.3 冲突检测应用层

**目标**：在 checkpoint.create 写入路径上叠加 in-flight 路径比对逻辑。

核心逻辑（参照 ARCHITECTURE.md §6.1 MCP-call 级数据流）：
- `daemon` 在执行 `CheckpointRepo.create` 前，查询 `processes` 表中其他 ACTIVE/IDLE agent 最近 N 分钟的 in-flight 文件路径（通过 checkpoint 表的 paths_json 字段）
- 若路径集合有交集：INSERT INTO conflicts（conflict_type='FILE_OVERLAP'，记录 agent_a/agent_b/paths_json）
- 冲突检测不阻断 checkpoint 创建（只记录 + 返回 conflict_id 给调用方）
- 新增 `cairn.conflict.list([since])` 工具（参照 §5.2 规划工具）

**时间盒**：1.5 天

---

#### 3.1.4 git hook + cairn install 命令

**目标**：让 git pre-commit hook 可以调用冲突检测。

- `packages/daemon/src/cli/install.ts`（或脚本）：把 hook 模板写入 `.git/hooks/pre-commit`；已有 hook 时追加而非覆盖
- hook 模板：调用本地 `packages/daemon/scripts/poc-2-conflict-check.mjs`（复用，只更新查询逻辑）；fail-open（DB 缺失时 exit 0）
- 在 `package.json` 或 bin 里暴露 `cairn install` 命令
- 测试：mock git hook 路径，验证 install 幂等性

**时间盒**：1 天

---

#### 3.1.5 Week 1 自测

**场景**：派 2 subagent 同时改同一个文件（如 `packages/daemon/src/storage/db.ts`），派前先 register 两个 agent_id，各自 checkpoint.create 时带相同路径。

**PASS 判据**：
- `conflicts` 表有一条 FILE_OVERLAP 记录
- `cairn.conflict.list()` 能返回该记录
- `npm test` 两个包都绿

**EOD 自测验收**：
- [ ] `npm test`（daemon + mcp-server 两包，各自独立跑）全绿
- [ ] `npx tsc --noEmit`（两包）无报错
- [ ] 自测场景跑通（手动调工具验证）
- [ ] ARCHITECTURE.md §6.1 对应锚点更新

---

### 3.2 Week 2-3（约 10-14 天）：需求可派 + Inspector

**Goal**：Dispatch v1 可以从 NL 派单到 agent，Inspector 可以用确定性 SQL 查状态。

**Spec 来源**：ARCHITECTURE.md §6.3 / §4.3 / ADR-4 / §5.2；PoC-3 partial 结论（应用层兜底 4 条）。

---

#### 3.2.1 migration 005：dispatch_requests 表

- 参考 ARCHITECTURE.md §4.3 DDL（`dispatch_requests` 表，含 status CHECK 约束）
- 写 `packages/daemon/src/storage/migrations/005-dispatch-requests.ts`
- 在 `migrations/index.ts` 末尾插入
- 追加 schema 测试
- 运行 `npm test`，确认绿

**时间盒**：0.5 天

---

#### 3.2.2 LLM 客户端抽象

**目标**：把 PoC-3 runner 的 OpenAI-compat 调用代码抽象成可复用模块。

**参考**：`packages/daemon/scripts/poc-3-llm-runner.mjs`（433 行，已验证 MiniMax-M2.7 可跑）

**产出**：`packages/daemon/src/dispatch/llm-client.ts`
- `LlmClientConfig`：`{ endpoint, apiKey, model, temperature?, maxTokens? }`
- `completionWithRetry(messages, config)`：含重试逻辑（3 次，指数 backoff）+ timeout（默认 30s）+ reasoning model think 块剥离（`<think>...</think>` 剥离逻辑复用 poc-3 代码）
- 配置来源：读 `~/.cairn/config.json`；缺失时 throw ConfigNotFoundError（不内嵌默认凭证）
- 单元测试：mock fetch，测重试 / timeout / think 块剥离

**时间盒**：1.5 天

---

#### 3.2.3 cairn.dispatch.request / confirm

**目标**：实现需求可派核心流程（ARCHITECTURE.md §6.3 数据流）。

`cairn.dispatch.request(nl_intent)` 流程：
1. 调 LLM 解析意图（llm-client.ts）
2. 确定性 SQL 检索相关 scratchpad keys（按关键词，不走 LLM）
3. 查 processes 表选目标 agent（ACTIVE，只有一个时直接选）
4. 生成 agent prompt（含 nl_intent + 历史上下文 + 应用层兜底 4 条 instruction）
5. INSERT dispatch_requests（status='PENDING'）
6. 返回 request_id + generated_prompt 供用户审查

`cairn.dispatch.confirm(request_id)` 流程：
1. 验证 status='PENDING'
2. UPDATE status='CONFIRMED'
3. 写 scratchpad key `dispatch/{request_id}/prompt`（目标 agent 读取后执行）
4. 返回 scratchpad key 和摘要

**应用层兜底 4 条 acceptance**（每条写进对应工具的 handler，不依赖 LLM 判断）：
- 生成的 prompt 若含 rewind / delete 相关意图，强制在 prompt 里附 preview 指令
- 生成的 prompt 若含外部 API 调用，强制附 user 知情同意提示
- 若 processes 表有多个 ACTIVE agent 且目标路径有重叠，强制建议串行化
- generated_prompt 写入 scratchpad 而非直接 SQL 写 dispatch_requests 字段（已满足，结构性保证）

**时间盒**：3 天

---

#### 3.2.4 cairn.inspector.query 基础版

**目标**：NL 查询状态，v0.1 走确定性 SQL（不走 LLM）。

实现思路：
- 关键词匹配映射到预定义 SQL 模板（例："active agents" → `SELECT * FROM processes WHERE status='ACTIVE'`，"recent conflicts" → `SELECT * FROM conflicts ORDER BY detected_at DESC LIMIT 10`，"checkpoints for task X" → `SELECT * FROM checkpoints WHERE task_id=?`）
- 约 10-15 个关键词 → SQL 映射覆盖最常见查询
- 无匹配时返回 `{ matched: false, suggestion: "try: ..." }`
- 测试：各关键词映射的单元测试

**时间盒**：1 天

---

#### 3.2.5 应用层兜底 4 条 acceptance 测试

**目标**：把 ADR-4 PoC-3 partial 结论里的 4 条硬要求写成可运行的 acceptance 测试。

- 测试 1：dispatch.request 含 rewind 意图时，generated_prompt 包含 preview 指令
- 测试 2：dispatch.request 含外部 API 意图时，generated_prompt 包含 warn 文本
- 测试 3：多 ACTIVE agent + 路径重叠时，dispatch.request 返回 warning flag
- 测试 4：dispatch.confirm 走 scratchpad 写入路径（不绕过工具层）

**时间盒**：0.5 天

---

#### 3.2.6 Week 2-3 自测

**场景**：自然语言派单端到端跑通。在日常工作里输入 "把 packages/daemon/src/repositories/CheckpointRepo.ts 里的 findByTaskId 方法加上 LIMIT 参数" → dispatch.request → 审查 generated_prompt → dispatch.confirm → 对应 agent 读到 scratchpad key 并执行。

**PASS 判据**：
- `dispatch_requests` 表有 CONFIRMED 状态的记录
- `scratchpad` 里有对应 dispatch key，prompt 含原始 NL 意图 + 应用层兜底 instruction
- `inspector.query("recent dispatch requests")` 能返回该记录
- `npm test` 两包全绿（包含应用层兜底 4 条 acceptance）

**EOD 自测验收**：
- [ ] `npm test`（两包）全绿，总数量较 Week 1 末有增加
- [ ] `npx tsc --noEmit` 无报错
- [ ] 端到端自测跑通（手动走一次 dispatch.request → confirm）
- [ ] ARCHITECTURE.md §6.3 + ADR-4 锚点更新

---

### 3.3 Week 3-4（约 3-5 天）：消息可达 v1

**Goal**：把 scratchpad IPC 约定文档化，固化 key 命名规范，让主 agent 和 subagent 通信有章可循。

**Spec 来源**：ARCHITECTURE.md §6.4 / §9.3（PRODUCT.md）；无新工具，复用 scratchpad CRUD。

---

#### 3.3.1 prompt 模板文档化

**产出**：`docs/cairn-subagent-protocol.md`（新建）

内容：
- subagent 任务结束前的 `cairn.scratchpad.write` 调用模板（英文 + 中文双语，paste-ready）
- task_id 传递约定（主 agent 生成，prompt 里明示给 subagent）
- 最小报告内容规范（完成摘要 2-5 句 + 关键决策列表 + 未解决问题 + 建议后续步骤，≥50 字）
- 反例（只写一句话 / 未写 task_id / 写错 key 格式）

**时间盒**：0.5 天

---

#### 3.3.2 key 命名规范固化

**产出**：在 `docs/cairn-subagent-protocol.md` 里加"Key 命名规范"一节，并在 ARCHITECTURE.md §6.4 加引用指针。

key 规范（参照 ARCHITECTURE.md §6.4 现有 Key 前缀表，固化并补充）：
- `subagent/{agent_id}/result` — subagent 完成结果（必须写）
- `session/{session_id}/{key}` — 会话级别共享数据
- `dispatch/{request_id}/prompt` — 由 dispatch.confirm 写入（系统级，agent 只读）
- `conflict/{conflict_id}/summary` — 由冲突检测写入（系统级）
- 禁止：不带前缀的裸 key（不报错，但协议层视为 legacy）

**时间盒**：0.5 天

---

#### 3.3.3 Week 3-4 自测

**场景**：用 cairn 跑一个真实的多 subagent 任务（选日常工作中的实际需求）。

**PASS 判据**：
- 每个 subagent 退出前写了对应的 `subagent/{agent_id}/result` key
- 主 agent 能用 `cairn.scratchpad.list(task_id=...)` 拿到所有 subagent 的结果
- `cairn.scratchpad.read(key)` 内容完整（含关键决策 + 后续步骤，不是空洞摘要）

**注意**：消息可达不是技术实现，是约定。如果 subagent 没写，不是 bug，是 prompt 模板需要调整。自测时关注的是模板有效性，不是强制机制。

---

### 3.4 Week 4-5（约 5-7 天）：Floating Marker v1（Tauri）

**Goal**：屏幕右下角桌面悬浮标，静物模式，显示活跃 agent 数 / 最近冲突计数 / 最近 checkpoint 标签。

**Spec 来源**：PRODUCT.md §8.2；ARCHITECTURE.md ADR-8（Tauri 技术栈决策）。

**决策背景（决策 29/30，429归档.md）**：Floating Marker 原计划 v0.2 主形态，本次决策 36 提前到 v0.1 末段。技术栈 ADR-8 = Tauri（Rust + WebView，~5-10MB，启动 < 200ms）。

---

#### 3.4.1 packages/desktop-shell/ skeleton

- 新增 `packages/desktop-shell/`（Tauri 项目骨架）
- `src-tauri/`：Rust Tauri 配置（window 位置 / 大小 / always_on_top / 无标题栏 / 透明背景）
- `src/`：前端 WebView（Vanilla JS 或 Svelte，体积小为主）
- `package.json`：`npm run tauri dev` / `tauri build`
- Tauri 版本：1.x 或 2.x（选时确认 Windows 11 + Rust stable toolchain 兼容性）

**前置确认**：`cargo --version` 检查 Rust toolchain 是否已装；未装则先走 `rustup` 安装（5 分钟，不算任务时间）。

**降级方案**（Rust 工具链装不上）：改用 Electron（接受体积增大 ~80MB），或推迟 Floating Marker 到 v0.2 单独处理。

**时间盒**：1.5 天（含环境搭建）

---

#### 3.4.2 静物 marker（数据展示层）

**目标**：右下角小窗口，展示三个数字/标签，5 秒自动刷新。

UI（极简，优先功能）：
- 活跃 agent 数（`SELECT COUNT(*) FROM processes WHERE status='ACTIVE'`）
- 最近冲突计数（`SELECT COUNT(*) FROM conflicts WHERE detected_at > ? AND status='OPEN'`，最近 1 小时）
- 最近 checkpoint 标签（`SELECT label FROM checkpoints ORDER BY created_at DESC LIMIT 1`）
- 点击展开：显示最近 3 条 conflict 摘要 + 最近 3 个 checkpoint

**交互**：
- 左键点击：展开/收起详情
- 右键：菜单（退出 / 刷新间隔调整：5s / 30s / 60s）
- 无需求接收（不弹通知，不接受 NL 输入）

**时间盒**：1 天

---

#### 3.4.3 与 daemon 共享 SQLite 读取

**目标**：v0.1 简化方案——desktop-shell 直接用 `better-sqlite3` 只读打开 `~/.cairn/cairn.db`（不走 MCP，不走 IPC）。

实现方式：
- Tauri sidecar（Node.js 子进程）或 Rust 直接读 SQLite（用 `rusqlite` crate）
- WAL 模式下只读不锁写（PoC-1 已验证 WAL 读写并发安全）
- 每 5 秒 poll 一次（不用 file watcher，简单可靠）

**v0.2 候选**：改成 daemon 的 HTTP / WebSocket IPC，去掉直连 SQLite。

**时间盒**：1 天

---

#### 3.4.4 Week 4-5 自测

**场景**：让 Floating Marker 在屏幕右下角跑一天（或半天），同时跑几个日常工作任务。

**PASS 判据**：
- Marker 可见，数字实时更新（每 5s 刷新一次）
- 活跃 agent 数在 subagent register / heartbeat 后正确变化
- 最近冲突计数在冲突产生后的下一个刷新周期更新
- 不卡（CPU 占用不超过 5%，内存 < 50MB）

---

## 4. 自测判据（取代 dogfood 大样本）

四个能力的最小自测：

| 能力 | 自测场景 | PASS 判据 |
|---|---|---|
| 冲突可见 | 派 2 subagent register 后，各自 checkpoint.create 带相同路径 | `conflicts` 表有一条 FILE_OVERLAP 记录；`cairn.conflict.list()` 能返回；npm test 全绿 |
| 需求可派 | 输入 NL："帮我把 src/foo.ts 里的 findX 方法加 LIMIT 参数" | `dispatch_requests` 表有 PENDING 记录，generated_prompt 含原始 NL + 应用层兜底；confirm 后 scratchpad 有 dispatch key |
| 消息可达 | 派 3 subagent 跑独立任务，每个都带 subagent protocol prompt | 主 agent 能从 scratchpad list(task_id=...) 读到所有 3 份报告，内容 ≥50 字 |
| Floating Marker | 跑一天（或半天），期间产生至少 1 次冲突和 3 个 checkpoint | 数字实时更新，不卡死，不崩溃 |

**四个 PASS = v0.1 自用版本可用。**

---

## 5. 文档同步精简规则

**保留**：
- 每个能力做完更新 ARCHITECTURE.md §6.x（一两段，不重写；只加实测结论和已落地标记）
- 每个能力做完后追加一段到当前归档（或新建工作日归档，按密度决定）
- migration 加 schema 测试（不变量）

**不做**：
- 不写 v0.1 → v0.2 ramp 文档
- 不写 release-packaging-plan
- 不写 v0.2 MVP plan
- 不写 d1/d2 research 报告
- 不重写 PRODUCT.md / ARCHITECTURE.md 正文（只加 🚧 → ✓ 回填）

---

## 6. 失败时退路（精简版）

| 情景 | 退路 |
|---|---|
| Week 1 冲突检测假阳性多到自己受不了 | 收紧到完全相同路径（string 精确匹配），不做模糊匹配；降低噪音先于准确率 |
| Week 2 LLM 调用 timeout 频繁 | llm-client.ts 加重试 3 次；降级方案：inspector.query 全走确定性 SQL，dispatch 生成 prompt 改为模板化（不走 LLM，只做 slot-filling） |
| Week 4 Tauri Rust 工具链装不上 | 先用 Electron skeleton（接受体积）跑通逻辑；Tauri 改到真的有时间处理时再迁移；或整个 Floating Marker 推迟到 v0.2 |
| 任何能力做着发现 ARCHITECTURE.md §6 设计有 bug | 修 ARCHITECTURE.md 对应段，commit `docs(arch): fix §N from impl`，不因为"要保持一致"而继续错的实现 |
| Week 2-3 dispatch 逻辑比预期复杂 | 砍掉 inspector.query 的 LLM 路径（全走模板），dispatch 降级为模板化派单（不走 LLM intent 解析），先让流程通，质量问题 v0.2 再提升 |

---

## 7. 与 v0.2/v0.3 的关系

v0.1 personal-build 完成后，v0.2 议题**保留但不排期**：
- agent 市场 / 多用户 / 跨机器协作
- 反汇总（层 3，PRODUCT.md §5.4 L3）
- 路径 (b) Task tool wrapper（PoC-4 < 70% 时的备选设计）
- 高级 Inspector GUI（Floating Marker 上的完整查询面板）
- Floating Marker v2（daemon IPC 替代直连 SQLite）

需要 release packaging 时**再单独起 plan**，不在 v0.1 personal-build 范围内。

---

## 8. W3 plan 的处置

`docs/superpowers/plans/2026-05-04-wedge-w3.md` 已标 DEPRECATED，保留作 reference：
- PoC-4 任务设计 + system prompt 模板（§7.2）可在未来恢复 dogfood 时参考
- D-1 调研方法（§3.2.2）在需要支持第二 host 时参考
- Day-by-day 节奏风格可在需要严格验证时参考
- 失败退路表（§5）的部分逻辑沿用到本文 §6

---

## 9. 文件结构（此 plan 期间会创建或修改的）

```
packages/
├── daemon/
│   └── src/
│       ├── storage/migrations/004-processes-conflicts.ts   (Week 1)
│       ├── storage/migrations/005-dispatch-requests.ts     (Week 2)
│       ├── repositories/ProcessRepo.ts                     (Week 1)
│       ├── repositories/ConflictRepo.ts                    (Week 1)
│       ├── repositories/DispatchRepo.ts                    (Week 2)
│       └── dispatch/llm-client.ts                          (Week 2)
├── mcp-server/
│   └── src/tools/
│       ├── process-{register,heartbeat,list,status}.ts     (Week 1)
│       ├── conflict-list.ts                                (Week 1)
│       ├── dispatch-{request,confirm}.ts                   (Week 2)
│       └── inspector-query.ts                              (Week 2)
└── desktop-shell/                                          (Week 4-5, NEW)
    ├── src-tauri/
    └── src/

docs/
└── cairn-subagent-protocol.md                              (Week 3, NEW)

ARCHITECTURE.md                                             (每能力完成后锚点回填)
```
