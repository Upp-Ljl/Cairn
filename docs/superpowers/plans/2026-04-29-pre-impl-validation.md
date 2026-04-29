# Cairn v0.1 实施前验证计划（pre-impl-validation）

> 版本：v1
> 日期：2026-04-29
> 状态：待执行——四能力编码启动前的硬门槛
> 作者：subagent（sonnet）

---

## 0. 文档定位

### 0.1 三份文档的关系

| 文档 | 定位 | 本文与它的关系 |
|---|---|---|
| `PRODUCT.md` v2 | 产品定义，"做什么 / 为什么做" | 本文的验证目标来自 PRODUCT.md §5 四能力 + §9.2 三路径 + §11 风险 |
| `ARCHITECTURE.md` | 实现设计，"怎么做" | 本文的 PoC 编号与 ARCHITECTURE.md 里的 🚧 锚点共享同一套 ID（见 §2 表格） |
| 本文 | 实施前验证 plan，"动手前先验什么" | 本文是 PRODUCT.md → ARCHITECTURE.md → 编码之间的防护层 |

### 0.2 本文是什么

本文是 **v0.1 四能力（冲突可见 / 状态可逆 / 需求可派 / 消息可达）动手实现之前的硬验证计划**。

v2 是一次 major pivot：从"桌面宠物单 agent"切换到"multi-agent 协作内核（Agent OS）"。这次切换引入了多条在 v1 阶段从未被验证的技术假设。4-persona stress-test 已经暴露 PRODUCT.md 的若干弱点——如果不先验后写，就会把同样的弱点固化到代码里，返工成本是 1-2 周起跳。

本文的格式是可执行清单：**每个验证项有目的、步骤、通过判据、失败应对、时间盒**。不是调研报告，是检查清单。

### 0.3 "做前验证完成"的定义

以下条件全部满足时，本文的任务完成，四能力编码可以启动：

1. PoC-1 和 PoC-4 出数据，且通过判据满足 **或** 失败应对方案明确；
2. PoC-2 和 PoC-3 出数据；
3. D-1 和 D-2 有结论；
4. ARCHITECTURE.md 里所有 🚧 锚点被回填，或显式标注"v0.2 议题"；
5. 产出 `docs/superpowers/plans/YYYY-MM-DD-impl-kickoff.md`，开始 W3+ 编码。

---

## 1. 验证目标与哲学

### 1.1 为什么 v2 转向需要这一轮验证

v1→v2 是路线切换，不是迭代修订（见 PRODUCT.md §13）。v1 的核心假设是"单 agent + step-away-safe"，技术路径相对成熟。v2 的核心假设是：

- **假设 A**：subagent 被 prompt 引导后，会稳定调用 `cairn.scratchpad.write`（消息可达路径 a 的基础）；
- **假设 B**：SQLite WAL + 单 daemon 在 N 个 agent 并发写时，不会产生漏报冲突的 race window（冲突可见的基础）；
- **假设 C**：git pre-commit hook 调 daemon IPC 的延迟在 200ms 以内，且 daemon down 时不阻塞 commit（commit-after 双层的基础）；
- **假设 D**：7B 本地模型做 NL 意图解析的效果与 Sonnet 在 80% 以上（Dispatch 的成本可控性）。

这四条假设在 v1 时代不存在；v2 定位引入了全部四条。没有一条已被数据支撑。

### 1.2 "先 PoC 后落代码"的成本账

| 路径 | 耗时估算 | 风险 |
|---|---|---|
| 先验证（4 PoC × 0.5-1 天） | 2-4 天净工作量 | 低：发现错误在最早可能的时机 |
| 先编码，出问题再改 | 1-2 周返工（假设 1 个假设错误）+ 可能重构 ARCHITECTURE.md | 高：架构假设被固化到代码后，改动牵连面宽 |

4 天验证换 1-2 周返工保险，这笔账是划算的。

### 1.3 不验证会发生什么

4-persona stress-test（US-A 的张涛场景、US-S 的 Jess 场景）已经暴露 PRODUCT.md 的弱点——消息丢失不是"subagent 忘了说"而是"主 agent 上下文被压缩"，冲突检测不是"Cairn 自动感知"而是"依赖 agent 主动调工具"。

如果不验证就动手：
- **假设 A 错误** → US-S 整条路径失效，v0.1 的"消息可达"能力是空壳；
- **假设 B 错误** → 冲突检测有静默漏报，比没有检测更危险（给用户错误的安全感）；
- **假设 C 错误** → commit-after 双层要么延迟无法接受，要么需要砍掉，PRODUCT.md §5.1.1 要重写；
- **假设 D 错误** → Dispatch 的 LLM 选型决策延迟到 W5-W7 才暴露，届时变更成本更高。

---

## 2. 关键不确定性总表

下表是全部 8 条不确定性的一眼速览，同时给出 ARCHITECTURE.md 的 🚧 锚点对应关系。

| ID | 类型 | 核心问题 | 影响的能力 | 不验证的最差情况 |
|---|---|---|---|---|
| **PoC-1** | 代码 PoC | SQLite WAL 在 N 并发写时是否有漏报 race window | 冲突可见 | 检测有静默漏洞，给用户错误安全感 |
| **PoC-2** | 代码 PoC | git pre-commit hook 调 daemon IPC 延迟是否可接受 | 冲突可见（commit-after 层） | 双层保障退化为单层，或延迟无法接受 |
| **PoC-3** | 数据收集 | 7B 本地模型能否达到 Sonnet 80% 的意图解析质量 | 需求可派 | Dispatch LLM 选型延迟，W5+ 被迫重构 |
| **PoC-4** | dogfood 实测 | subagent 在 prompt 引导下的实际调用率是否 ≥ 90% | 消息可达 | 路径 (a) 不可靠，v0.1 核心能力是空壳 |
| **D-1** | 调研 | Cursor / Cline 的非 MCP-aware host 接入路径是否存在 | 冲突可见（非 CC 场景） | v0.1 ICP 被迫收窄为 CC-only |
| **D-2** | 测量 | daemon idle / busy 时的资源占用是否在基线内 | 所有能力（基础设施稳定性） | 上线后用户报告资源占用过高，UX 破坏 |
| **D-3** | 对比 | MCP-aware vs non-aware 接入工作量差是多少 | 接入策略 | v0.2 的 wrapper 工作量被低估 |
| **D-4** | dogfood 数据 | 冲突检测假阳性率是否 < 5% | 冲突可见（用户体验） | 通知刷屏，用户关闭通知，检测功能失效 |

---

## 3. PoC 详细计划

### 3.1 PoC-1：MCP-call race window 压测

**目的**

确定两个 agent 同时调用 cairn 工具时，daemon 的 in-flight 元数据对比是否会漏报或重复报冲突。这是"冲突可见"能力的技术地基——race window 没解决，就动手写冲突检测等于在沙上建楼。

**关联假设**：假设 B（SQLite WAL + 单 daemon 单线程在并发写下不漏报）

**前提条件**

- daemon 已启动，SQLite WAL mode 已开启（packages/daemon 现状）
- Node.js 环境可用（v24.14.0）

**步骤**

1. 写并发压测脚本（Node.js），开 N 个并发 worker，每个 worker 通过 MCP stdio 协议调 `cairn.checkpoint.create`，paths 均触及同一目标文件（如 `src/auth.ts`）。
2. 测 N = 2 / 5 / 10 / 50 四档并发量，每档跑 1000 次，记录：
   - conflict 表写入次数（是否正确）；
   - 漏报次数（两端都写成功但 conflict 表没记录）；
   - 重复报次数（同一冲突被写入 conflict 表多次）；
   - 每次调用的 p50 / p95 / p99 延迟。
3. 测 daemon down 时（关掉 daemon 进程）调用的行为：是否报错清晰 / 是否 hang。

**数据收集**

- 每档 N：漏报率（%）/ 重复报率（%）/ p50 延迟（ms）/ p99 延迟（ms）
- 输出一份 CSV，行 = 并发档 N，列 = 以上四维度

**通过判据**

| 指标 | 通过门槛 |
|---|---|
| 漏报率（全档） | < 0.1%（1000 次中漏 < 1 次） |
| 重复报率（全档） | < 1% |
| p99 延迟（MCP-call 整端到端） | < 100ms |

**失败应对**

- 漏报率超标 → 加 SQLite 显式行锁（`BEGIN EXCLUSIVE`）；或在 daemon 内存层维护 in-flight set，利用单线程 event loop 保证原子性，绕开 SQLite 并发问题。
- 延迟超标（p99 > 100ms） → 把 conflict 记录改为异步写入：daemon 先返回"已接收"，后台写 conflict 表，不阻塞 MCP-call 返回。
- daemon down 时 hang → 增加 IPC 超时（500ms cutoff），超时后以 warn 日志记录，不 block。

**时间盒**：1 天

---

### 3.2 PoC-2：git pre-commit hook 原型

**目的**

验证 commit-after 检测路径（PRODUCT.md §5.1.1 双层之一）的延迟和稳定性。MCP-call 级检测在 agent 调工具时触发；commit-after 在 `git commit` 时触发——两层互补，共同覆盖"agent 调了工具但还没 commit"的窗口期。

**关联假设**：假设 C（pre-commit hook 调 daemon IPC 的开销 < 200ms，且 daemon down 时不阻塞 commit）

**步骤**

1. 在测试 repo 写 `.git/hooks/pre-commit`，调 cairn daemon 的本地 IPC（Windows 用 named pipe，Unix 用 Unix socket）：
   - hook 携带 `git diff --cached --name-only` 的输出（改动文件列表）；
   - daemon 查询这些 path 是否有其他 agent 的 in-flight checkpoint 记录，如有则输出冲突信息到 stderr。
2. 测三档场景：
   - 干净仓库（0 个文件改动，只跑 hook 本身）；
   - 100 个文件改动；
   - 1000 个文件改动。
3. 每档跑 20 次，记录 hook 耗时（从 `git commit` 到 hook 返回）。
4. 单独测 daemon down 时的 hook 行为：hook 必须在 500ms 内超时并以 exit code 0 返回（fail open，不阻塞 commit）。

**数据收集**

- 每档：p50 / p99 延迟（ms）
- daemon down 时：hook 是否 fail open / 超时时间

**通过判据**

| 条件 | 门槛 |
|---|---|
| p99 延迟，小改动（0-100 文件） | < 200ms |
| p99 延迟，大改动（1000 文件） | < 1s |
| daemon down 时 hook 行为 | fail open，不阻塞 commit，exit code 0 |

**失败应对**

- 延迟超标 → hook 改为异步触发：pre-commit 立刻 exit 0，同时发一个异步信号给 daemon，daemon 后台分析，有冲突时通过系统通知告知用户（牺牲实时性换不阻塞 commit）。
- IPC 通道在 Windows 上不稳定 → 退化为只依赖 MCP-call 单层（删掉 commit-after 这一层），在 PRODUCT.md §5.1.1 的表格里把 commit-after 状态改为"v0.2"，并在 ARCHITECTURE.md 的 PoC-2 锚点注明。

**时间盒**：0.5 天

---

### 3.3 PoC-3：Dispatch NL 意图解析对比实验

**目的**

决定 Dispatch 的 LLM 选型：Claude Sonnet 薄壳 vs 本地 7B 模型（Llama 3.1 8B / Qwen 2.5 7B）。这影响 Dispatch 的隐私性（本地 vs 外部 API）、成本（token 费用 vs 本地推理）、和 v0.1 能否在隐私敏感用户中成立。

**关联假设**：假设 D（7B 本地模型意图解析效果 ≥ Sonnet 的 80%）

**步骤**

1. 准备 20 条真实 NL 派单需求（来源：4-persona stress-test 反馈 + 手工补充），覆盖三类意图：
   - **方向纠错**：`"auth 改的方向不对，和上周五我说的需求不一致，帮我找对的 agent 重做"`；
   - **任务指派**：`"去看看 issue #142，能 20 行改完就让 CC 做"` / `"把 utils_v2 全 repo 改名为 string_helpers"`；
   - **上下文关联**：`"subagent B 的结果和 subagent A 的 schema 对不上，把 schema 那边让 CC 修一遍"`。
2. 对每条 NL，跑三个模型：Claude Sonnet 4.5 / Llama 3.1 8B / Qwen 2.5 7B。Prompt 结构相同，要求输出：意图标签（纠错 / 指派 / 查询）+ 抽取的 paths（如有）+ agent 选型 + 生成的 prompt 文本 + 历史检索关键词。
3. 人工对每条输出按 5 维度打分（每维度 0-2 分，满分 10 分）：
   - 意图分类是否正确；
   - agent 选型是否合理；
   - 生成的 prompt 质量（是否能直接发给 agent）；
   - 历史检索关键词是否准确；
   - 风险提示（是否识别出需要 preview / 确认的危险操作）。

**数据收集**

- 每条 NL × 三模型 × 五维度：共 300 个打分点
- 输出表格：20 行 × (Sonnet 均分, Llama 均分, Qwen 均分, Llama/Sonnet 比值, Qwen/Sonnet 比值)

**通过判据与决策矩阵**

| 7B 均分 / Sonnet 均分 | 决策 |
|---|---|
| ≥ 80% | 用 7B 本地模型（隐私 + 零 API 成本） |
| 50%-80% | 双引擎：本地 7B 默认，Sonnet 作为 fallback（需用户显式开启）；v0.1 以 Sonnet 为主 |
| < 50% | v0.1 用 Sonnet 薄壳，本地模型推迟到 v0.2 |

**失败应对**

- 如果 Sonnet 和 7B 均低于 7 分均分（20 条均 < 7/10） → 意图解析任务比预期复杂，v0.1 Dispatch 改为**模板化派单**：用户填预设字段（agent 选择 + 目标描述 + paths），Cairn 只做格式化和历史检索，不做 NL 解析。
- 如果打分者间一致性低（两个评分者分歧 > 30%）→ 先统一评分标准再重跑。

**时间盒**：1 天

---

### 3.4 PoC-4：dogfood subagent 调用率实测

**目的**

验证 PRODUCT.md §9.2 路径 (a)（MCP-native）的实际可靠性：Claude Code 在合理 prompt 引导下，spawn 出来的 subagent 是否真的会在任务结束前调 `cairn.scratchpad.write` 写完整报告。这是"消息可达"能力 L1（持久化）和 L2（可查询）的前提。

**关联假设**：假设 A（subagent 被 prompt 引导后调用率 > 90%）

**前提条件**

- 本机已配置 `.mcp.json`，接入 cairn mcp-server（packages/mcp-server）；
- Claude Code 已加载 cairn 工具；
- 可以使用 Task tool 派出 subagent。

**步骤**

1. 设计 system prompt 模板，加入明确约定（中英双语，降低 subagent 遗漏概率）：

   ```
   每个被派出的 subagent 在任务结束前必须调用 cairn.scratchpad.write，
   key 格式为 subagent/{agent_id}/result，
   内容为完整报告（包含：完成内容摘要、关键决策、未解决问题、建议后续步骤）。
   不调用此工具视为任务未完成。
   ```

2. 运行 5 个真实开发任务（选当前 cairn 项目真实待做事项，如补测试 / 写文档 / 代码 review），每个任务通过 Task tool spawn 3+ subagent，共 15+ subagent 样本。

3. 每个 subagent 完成后，通过 `cairn.scratchpad.list` 检查：
   - 是否存在对应 `subagent/{agent_id}/result` 的 key；
   - 如有，内容是否完整（是否包含决策项，而不是空报告）。

4. 记录每个 subagent 的调用结果：调用 / 未调用 / 调用但内容空洞（< 50 字）。

**数据收集**

- 总 subagent 数；
- 完整调用数（内容 ≥ 50 字）；
- 未调用数；
- 未调用的原因分析（任务太短、prompt 被截断、subagent 未读到 system prompt？）。

**通过判据与决策矩阵**

| 调用率 | 决策 |
|---|---|
| ≥ 90% | 路径 (a) 可行，按 PRODUCT.md §9.2 设计 v0.1 |
| 70%-90% | 路径 (a) 可行，但需要兜底机制：主 agent 在读 scratchpad 前先 check "哪些 subagent 没写"，主动提示用户 |
| < 70% | 路径 (a) 不可靠，v0.1 必须提前做路径 (b) wrapper（Task tool wrapper，原计划 v0.2 工作前置） |

**失败应对**

- 调用率 < 70% → 在 v0.1 W3-W5 期前置路径 (b)：给 Claude Code 的 Task tool 写一个 prompt template wrapper，subagent 启动时自动注入"任务结束前调 cairn.scratchpad.write"的约定，不依赖主 agent 每次手动写进 system prompt。
- 调用率 70-90% → 在 `cairn.checkpoint.create` / `cairn.scratchpad.list` 时增加"未回报 subagent"检测逻辑，主 agent 读列表时 cairn 顺带提示"有 N 个 subagent 未写入结果"。

**时间盒**：2-3 天（dogfood 跨多任务，不是一次连续跑完）

---

## 4. 调研 / 测量项详细计划

### 4.1 D-1：Cursor / Cline 非 MCP-aware host 接入路径

**目的**：PRODUCT.md §5.1.1 明确说 v0.1 只覆盖 MCP-aware agent，Cursor 和 Cline 的实际接入路径是开放问题 1。在决定"v0.1 是否为 non-aware host 投入"之前，需要先摸清可行路径和成本。

**手段**

- 读 Cursor 官方文档（MCP 支持现状 / Extension API）；
- 读 Cline GitHub README + docs（是否支持 MCP server 接入）；
- 本地试安装 Cursor，检查是否有 `.mcp.json` 等效配置入口；
- 记录：每个 host 的接入方式（原生 MCP / VS Code extension hook / 无路径）+ 概估工作量（小时 / 天）。

**产出**：《非 MCP-aware host 接入路径决策表》，格式：

| Host | 是否 MCP-aware | 接入方式 | 工作量估算 | v0.1 建议 |
|---|---|---|---|---|
| Claude Code | 是 | 原生 `.mcp.json` | 已完成 | 主要 ICP |
| Cursor | 待查 | ... | ... | ... |
| Cline | 待查 | ... | ... | ... |

**时间盒**：0.5 天

---

### 4.2 D-2：daemon 资源占用 baseline 测量

**目的**：daemon 是常驻后台进程。如果 idle 状态就吃 > 200MB RAM / > 5% CPU，用户会关掉它——检测和记录能力全部失效。在优化之前，先测基线。

**手段**

- 启动 daemon（`packages/daemon`），等待 5 分钟稳定；
- **Idle 测量**：1 小时内无任何 MCP 调用，每 10 秒采样一次 RSS / CPU%（用 `process.memoryUsage()` + Node.js `--inspect` 或 `ps` 命令）；
- **Busy 测量**：用压测脚本维持 5 calls/sec（scratchpad write / checkpoint create 混合），持续 30 分钟，同样采样；
- 记录 p50 / p99 / max。

**目标基线**

| 状态 | RAM（RSS） | CPU |
|---|---|---|
| Idle | < 50MB | < 1% |
| Busy（5 calls/sec） | < 200MB | < 10% |

**超标应对**

- 找 hot path（`clinic flame` 或 `0x` profiler）；
- 优化 SQLite 查询（检查是否缺 index）；
- 考虑 lazy load（migration 在首次使用时才初始化，不在启动时全部 load）。

**时间盒**：0.5 天

---

### 4.3 D-3：MCP-aware vs non-aware 接入成本对比

**目的**：基于 D-1 的结果，量化"给 non-aware host 做适配"的工作量，用一句话结论决定 v0.1 是否投入。

**手段**

- 用 D-1 的结论表格 + 当前 CC 接入工作量（`.mcp.json` 配置，约 0.5 小时用户侧操作）做对比；
- 计算：如果要支持 Cursor，额外需要多少工程天？这些天是否可以推到 v0.2 而不影响 v0.1 ICP？

**产出**：一句话结论，例：

- "Cursor 有原生 MCP 支持，接入成本 0.5 天，v0.1 值得做。"
- "Cline 无 MCP 标准接入路径，需要写 sidecar，工作量 5+ 天，推迟到 v0.2。"

**时间盒**：0.25 天（D-1 完成后顺手做，不单独计时）

---

### 4.4 D-4：冲突检测假阳性率收集

**目的**：PRODUCT.md §11.2 风险表里明确"假阳性率高 → 用户关闭通知 → 检测功能失效"。v0.1 用保守策略，但保守策略的实际假阳性率需要 dogfood 数据校准。

**手段**

- 在 W3-W6 dogfood 阶段（与 PoC-4 同期），每次 cairn 报冲突时记录：
  - 实际是否真有冲突（人工核查 git diff）；
  - 假阳性原因（同一 agent 的两次 checkpoint 被误判为不同 agent？时间窗口太宽？）。
- 每周统计一次假阳性率。

**通过判据**

| 假阳性率 | 处理 |
|---|---|
| < 5% | 保守策略有效，继续当前实现 |
| 5%-20% | 提高触发阈值：要求两端 agent 都已 commit-after 才报（减少"写到一半"的误报） |
| > 20% | 临时静音冲突通知，改为只记录日志，用户主动查询才看到；重新评估检测触发条件 |

**时间盒**：嵌入 W3-W6 dogfood 期，不单独计时；每周花 0.25 天整理数据

---

## 5. 优先级排序与执行顺序

### 5.1 第一波（最优先，W3 第一周内启动）

**PoC-4 先于 PoC-1。**

原因：PoC-4 影响的是 v0.1 核心价值主张的可行性——如果 subagent 调用率 < 70%，US-S（消息可达）整条路径在 v0.1 需要重做，PRODUCT.md §5.4 和 §9.2 路径 (a) 的表述要修改，ARCHITECTURE.md 的对应锚点要重写。这是牵连面最广的风险，且 PoC-4 的 dogfood 需要多天时间分布运行，应该最早启动。

PoC-1 并发启动（不依赖 PoC-4 结果），因为 race window 的问题是冲突检测的基础，但它是单日内可完成的技术测试，不需要提前几天排期。

**建议顺序**：
1. **Day 1**：启动 PoC-4（配置 `.mcp.json` + 设计 system prompt template + 跑第一个 dogfood 任务）；
2. **Day 1-2**：并发做 PoC-1（写压测脚本，一天内出数据）；
3. **Day 1-3**：同时做 D-2（daemon baseline 测量，启动即可后台跑）。

### 5.2 第二波（第一波数据出来后）

**PoC-2** 和 **PoC-3** 并行推进：

- PoC-2 的 commit-after hook 如果失败（延迟 > 200ms 或 Windows IPC 不稳定），可以退化为只用 MCP-call 单层——不致命，PRODUCT.md §5.1.1 保留兜底描述，ARCHITECTURE.md 降级该路径即可。
- PoC-3 的 LLM 选型决策对 W5-W7 的 Dispatch 开发有影响，但 W5 至少还有 2-3 周，时间窗口充裕。

### 5.3 第三波（并发推进）

**D-1 + D-3** 合并做（D-1 出结论，D-3 立刻接着算）；**D-4** 嵌入整个 dogfood 期持续收集。

---

## 6. 完成判据：何时算"做前验证完成"

以下所有条件满足时，本计划关闭，四能力编码正式启动：

- [ ] PoC-1：漏报率 / 延迟数据出炉，通过判据明确满足或失败应对方案写入 ARCHITECTURE.md；
- [ ] PoC-2：hook 延迟数据出炉，commit-after 层状态确认（保留 / 退化为异步 / 砍掉）；
- [ ] PoC-3：三模型打分完成，LLM 选型决策落地（Sonnet / 7B / 模板化）；
- [ ] PoC-4：至少 15 个 subagent 样本，调用率数据出炉，路径 (a) / (b) 决策写入 ARCHITECTURE.md；
- [ ] D-1：Cursor / Cline 接入路径决策表完成；
- [ ] D-2：daemon baseline 测量完成，超标则有 profiling 结果；
- [ ] D-3：一句话结论写入；
- [ ] ARCHITECTURE.md 里所有 🚧 锚点被回填或显式标"v0.2 议题"；
- [ ] 产出 `docs/superpowers/plans/YYYY-MM-DD-impl-kickoff.md`，列明第一个能力（建议从"冲突可见"或"消息可达"之一开始，取决于 PoC-1 和 PoC-4 的结果）。

---

## 7. 时间盒总览

| 项目 | 类型 | 净工作量 | 备注 |
|---|---|---|---|
| PoC-1 | 代码压测 | 1 天 | 单日内可完成 |
| PoC-2 | hook 原型 | 0.5 天 | |
| PoC-3 | 数据实验 | 1 天 | 含人工打分 |
| PoC-4 | dogfood | 2-3 天 | 跨多天分布运行 |
| D-1 | 调研 | 0.5 天 | |
| D-2 | 测量 | 0.5 天 | 可与 PoC-4 并行 |
| D-3 | 对比 | 0.25 天 | D-1 之后顺手做 |
| D-4 | 数据收集 | 嵌入 W3-W6 | 每周 0.25 天整理 |

**合计净工作量**：约 5-7 天

**与路线图的重叠**：PoC-4 和 D-4 的 dogfood 与 W3-W4 dogfood 期完全重叠，不是额外时间；D-2 在 W3 第一天就能启动，后台跑。

**最早可以开始动手 v0.1 W3+ 编码的时机**：第一波 PoC（PoC-4 有初步调用率数据 + PoC-1 出数据）之后，约 W3 第 3-4 天。

---

## 8. 失败时的退路

每条 PoC / 调研项的退路已经在各节的"失败应对"里给出。这里做汇总，供快速决策参考：

| 验证项 | 失败定义 | 退路方案 | 对 v0.1 范围的影响 |
|---|---|---|---|
| PoC-1 race window | 漏报率 > 0.1% 或 p99 > 100ms | 加 SQLite 行锁 / daemon 内存 in-flight set / 异步 conflict 写入 | 不缩范围，但实现复杂度增加 |
| PoC-2 hook 延迟 | p99 > 200ms 或 Windows IPC 不稳定 | hook 异步化，或砍掉 commit-after 层（退化为 MCP-call 单层） | PRODUCT.md §5.1.1 表格更新，不砍能力但降级一层保障 |
| PoC-3 LLM 均分低 | Sonnet 和 7B 均 < 7/10 | Dispatch 改为模板化派单（用户填表） | Dispatch v0.1 范围缩窄，NL 解析推迟到 v0.2 |
| PoC-4 subagent 调用率低 | 调用率 < 70% | 前置路径 (b) Task tool wrapper（v0.2 工作提前到 W3-W5） | W3-W5 工期增加约 1 周；US-S 能力仍可 deliver，但实现路径变 |
| D-1 Cursor 无接入路径 | Cursor 和 Cline 均无 MCP 标准接入路径 | v0.1 ICP 收窄为 Claude Code-only；PRODUCT.md §3.1 更新目标用户描述 | ICP 变窄，但不影响核心四能力的技术实现 |
| D-2 资源超标 | Idle > 100MB 或 Busy > 400MB | profiling 找 hot path，优化 SQLite 查询，考虑 lazy init | 可能增加 0.5-1 天优化工作，阻塞 dogfood 扩展 |

---

## 9. 与 v0.1 路线图承接

### 与 PRODUCT.md §10.2 的对应关系

| PRODUCT.md §10.2 阶段 | 本计划对应 |
|---|---|
| W2 EOD（当前）= 楔已落地，dogfood 阶段 | 本计划在 W2 EOD 产出，W3 第一天启动执行 |
| W3-W4 = dogfood + 第一波反馈 | PoC-4（dogfood 调用率）+ D-4（假阳性收集）嵌入这一阶段 |
| W5+ = 四能力 v1 编码 | 第一波 PoC 通过后开始编码；如 PoC 失败，W5+ 推迟，先做退路方案 |
| W5-W7 = Dispatch v1 | PoC-3 的 LLM 选型结论在此阶段启动前必须出炉 |

### 编码启动的判断逻辑

```
PoC-4 调用率 ≥ 70%
  AND PoC-1 漏报率 < 0.1%
  → 按原计划 W5+ 启动四能力编码

PoC-4 调用率 < 70%
  → W3-W5 前置路径 (b) wrapper
  → 四能力编码推迟到 wrapper 完成后

PoC-1 漏报率 > 0.1%
  → 先修 race window（加锁 / in-flight set）
  → 冲突检测能力编码推迟
```

---

## 附录：与 ARCHITECTURE.md 🚧 锚点对应表

本表供两份文档 cross-reference 时快速检索。编号由两文档共同约定，不可单方面修改。

| 本文 ID | ARCHITECTURE.md 🚧 锚点 | 状态 |
|---|---|---|
| PoC-1 | 🚧 PoC-1 race window | 待执行 |
| PoC-2 | 🚧 PoC-2 git hook IPC | 待执行 |
| PoC-3 | 🚧 PoC-3 Dispatch LLM 选型 | 待执行 |
| PoC-4 | 🚧 PoC-4 subagent 调用率 | 待执行 |
| D-1 | 🚧 D-1 non-MCP host 接入 | 待调研 |
| D-2 | 🚧 D-2 daemon 资源 baseline | 待测量 |
| D-3 | 🚧 D-3 接入成本对比 | 待 D-1 完成后做 |
| D-4 | 🚧 D-4 假阳性率 | 嵌入 dogfood 期收集 |

> 上表中的状态在各项 PoC / 调研完成后更新为：通过 / 失败（+退路方案）/ v0.2 议题。
