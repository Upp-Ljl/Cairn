# Cairn 产品定义文档（PRODUCT.md v2）

> 版本：v2.0
> 日期：2026-04-29
> 状态：v2 定位生效中（v0.1 楔已超额完成，进入四能力 v1 实施阶段）
> 文档定位：本文是 Cairn 的**定义性文档 v2**，与 v1（2026-04-17）存在根本定位分歧。两者不是迭代关系，是路线切换。v1 全文作为历史档案保留在 §18。

---

## 0. TL;DR（30 秒读完）

Cairn 是**主机级多 agent 协作内核**。它不是 agent，不写代码，不拆任务，不替用户规划，也不是某个长程任务的守护进程。Cairn 坐在 Claude Code、Cursor、subagents、Aider、Cline 这些 agent 工具之下，维护这台机器上所有 agent / subagent work 的共享协作状态：runner、durable work items、scratchpad、checkpoints、conflicts、blockers、outcomes 和 dispatch history。

W5 引入的 **Task Capsule** 是 Cairn 的一个 OS primitive：durable multi-agent work item。它让多个 agent / subagent 可以围绕同一项复杂工作共享状态、暂停、接力、验收和回滚——但 Cairn 不接管任务、不做编排、不替 agent reasoning。

> **Cairn is the host-level coordination kernel for multi-agent work. It gives agents and subagents durable shared state, conflict visibility, handoff packets, checkpoints, and outcome checks, so complex collaboration can survive failure, interruption, and handoff.**

当前阶段：v0.1 **W5 完整闭环已交付**——Task Capsule 现在是一等公民：可暂停、可接力、可验收、可回滚。任务可以在 session A 停下、过一晚、由 session B 接力，最后由 outcomes DSL 自动验收（tests_pass / file_exists / 等 7 原语，AND 语义，确定性评估）。Phase 3 dogfood 32/32 PASS through real MCP stdio across 3 sessions。**Cairn lets agents work longer because failure, interruption, and handoff are no longer fatal.**

---

## 1. 产品定位与一句话定义

### 1.1 一句话定义

> Cairn 是本机多 agent 协作的内核——用户和 agent 之间的调度官、agent 之间的仲裁官、所有动作的状态管家。它不写代码，但保证 N 个 agent / subagent 在同一份代码库上协作时，**冲突可见、状态可逆、需求可派、消息可达**。

### 1.2 更长的一段话

当一个人同时跑两个以上的 agent——无论是 Claude Code + Cursor、Claude Code 主 agent + 多 subagent、还是 Aider + Cline——现有生态里没有任何东西负责"这些 agent 之间怎么协调"。每个 agent 都在假设它是唯一在工作的那一个，独占文件、独占上下文、独占用户注意力。

Cairn 填的是这个空缺：它不是又一个 agent，而是 agent 之上的基础设施层。类比是操作系统和应用的关系——OS 不替你写文档，但管文件锁、共享内存、进程仲裁和撤销操作。用户跟 agent 打交道做具体任务；Cairn 站在这些 agent 下面，确保协作可控、历史可查、状态可逆。

Cairn 的模型（LLM 调用）只在三个地方发挥作用：一是把用户的自然语言需求解析成 agent 可吃的 prompt（Dispatch）；二是诊断 agent 间的冲突并给出仲裁建议（Arbitrate）；三是在 Inspector 通道里把结构化的状态信息转化成用户能读的语言（NL 查询）。其余时候 Cairn 默认隐形，像 OS 一样安静运行。

### 1.3 反定义（Cairn 不是什么）

反定义不是谦辞，是边界的清单。任何违背这些边界的需求或设计，直接用本节 veto。

1. **Cairn 不是 agent**。它不执行开发任务，不写代码，不发 PR，不改文件。有写代码的需求，找 agent，不找 Cairn。
2. **Cairn 不是驾驶舱（fleet dashboard）**。用户不需要在一个 10 格的网格里同时盯 10 个 agent 的思考流。这是旧框架，已废弃（见 §18 v1）。
3. **Cairn 不是 v1 那种"用户的 agent 化身"**——不接开发需求、不写代码、不替你跟 agent 对话。v0.1 主 UI 是动画悬浮宠物（玛尼堆 cairn 本义），点击展开 Inspector 面板。
4. **Cairn 不是 agent framework / SDK**。它是面向真实用户的产品，不是给开发者造 agent 用的库。
5. **Cairn 不是又一个 Claude Code 皮肤**。Claude Code 是 Cairn 的"应用"之一，Cairn 是它的协作内核。
6. **Cairn 不做跨机协作**（v0.1 不做）。本地优先，数据在用户自己的机器上。
7. **Cairn 悬浮标不接受用户开发需求**。任何让悬浮标"接受用户开发任务""做仲裁决策""自己写代码"的设计回到 v1，已废止。视觉允许拟物像素美术 + 顶层石头表情动画，但仅作为 schema 状态可视化，不替代 agent 对话渠道。详 §8.2。

---

## 2. 产品论题：Multi-Agent Collaboration Kernel

这一节解释"为什么 Cairn 会存在"，而不只是"Cairn 能做什么"。没有论题，功能清单是一堆散点；有了论题，每个功能决策才有可以落脚的地方。

### 2.1 核心命题：agent 越多，协作问题越尖锐，OS 越缺位

当前 agent 生态正在快速走向"多 agent 并行"：Claude Code 有 Task tool（fork subagent）、Cursor 有 Background Agent、Aider 可以对同一个 repo 多实例运行。这个趋势不会逆转。

但每个 agent 工具都在假设自己是唯一在场的那一个：

- **文件锁**：没有。两个 agent 同时改 `auth.ts` 会静默覆盖对方的改动。
- **状态一致性**：没有。一个 agent 的 checkpoint 另一个 agent 不知道，rewind 只影响自己。
- **消息传递**：没有标准。主 agent 派出 subagent 去干活，subagent 完成后用什么格式回报？如果主 agent 的上下文已经被压缩了，这条回报谁来保证送到？
- **用户意图对齐**：没有。用户说了一句话，两个 agent 各自理解各自的，没有人负责仲裁"哪个理解更接近用户意图"。

这四个问题在单 agent 时代是次要的；在多 agent 时代，它们变成基础设施的硬缺口。Cairn 填的就是这个缺口。

### 2.2 三个支撑信念

**1. agent 之间需要基础设施层，不是让每个 agent 自己造轮子。**

让每个 agent 各自实现文件锁、checkpoint 协调、消息总线是不可行的——它们来自不同团队，走不同的 API，没有互操作协议。需要一个独立于所有 agent 的第三方层来提供这些能力，就像 OS 提供文件系统和进程管理一样。

**2. Cairn 不抢方向盘，agent 才是 doer。**

Cairn 的价值不来自于"做得更好"，而来自于"让其他 agent 做得更好"。一旦 Cairn 开始自己执行开发任务，它就从 OS 变成了又一个 app，而且大概率不如专门的 agent 做得好。这条边界必须守住。

**3. 可逆性是 agent OS 的内核，不是锦上添花。**

任何操作系统最重要的保证之一是：操作是可以撤销的，或者至少是可以审计的。没有可逆性，用户对多 agent 并行的唯一应对策略就是"不让它们做太多"，这和 agent 协作的出发点完全背离。Cairn 把 checkpoint + rewind 放在内核位置，不是功能，是前提。

### 2.3 三点交叉验证

- 基础设施层 × 不抢方向盘 → Cairn 对 agent 生态是吸引力不是竞争威胁，MCP 协议天然适配。
- 基础设施层 × 可逆性内核 → Cairn 的 checkpoint 协调多个 agent，rewind 可以跨 agent 回到一致状态。
- 不抢方向盘 × 可逆性内核 → Cairn 在 agent 跑飞时有权介入（仲裁），但介入方式是"停止 + 提醒 + 提供回滚路径"，不是"接管去自己修"。

---

## 3. 目标用户

### 3.1 主要用户：手里同时跑 ≥ 2 个 agent 工具的开发者

特征画像：

- 工作台上同时跑 Claude Code + Cursor，或者 Claude Code 主 agent + 多个 subagent（Task tool），或者类似的多 agent 组合。
- 已经遇到过"我让两个 agent 同时改了同一个文件，后来一团糟"或者"subagent 的结果没传回来，主 agent 不知道它干了什么"的问题。
- 能接受 CLI / MCP 工具级别的交互，不需要零学习成本的 GUI。

### 3.2 次要用户：subagent 重度用户

- 使用 Claude Code Task tool 或类似 fork-agent 模式，会在一次会话里并行启动 ≥ 3 个 subagent 的用户。
- 关注点集中在"消息滞后"和"上下文压缩"两个痛点——subagent 回报信息时主 agent 的窗口已经被其他内容填满，关键结果丢失。

### 3.3 明确排除的用户（v0.1 不做）

- **企业合规严格的团队**：SSO、审计日志、RBAC——v0.1 不做，这类需求让 Cairn 变成另一个产品。
- **非技术用户**：v0.1 的用户至少能看懂 git、配置 MCP server、理解"checkpoint"这个概念。
- **跨团队多人协作**：多人共享同一个 Cairn daemon 的场景推迟到 v0.3+。单人本地多 agent 是 v0.1 边界。

---

## 4. 核心用户故事

五条用户故事对应三动词（Dispatch / Rewind / Arbitrate）+ Inspector + Subagent 协作。每条都给场景叙事、关键设计约束、Cairn 在其中的角色，以及验收标准（§4.6）。

### 4.1 US-D：Dispatch（派单）

**场景**：小 A 在跑一个复杂重构，主力是 Claude Code。到第三天他发现方向偏了——auth 模块的改法跟他当初说的不一样，但他不记得自己说的是什么，也不知道应该让哪个 agent 来重做这一块。

他对 Cairn 说："auth 改的方向不对，和上周五我说的需求不一致。帮我找到对的 agent 重做。"

Cairn 做的事：
1. 查 scratchpad 和 checkpoint 历史，找到上周五那次对话的需求记录。
2. 解析当前意图：用户要纠正方向，不是要撤销所有工作。
3. 判断当前活跃的 agent 里谁最适合接这个任务（比如 Claude Code 已经有上下文）。
4. 把需求翻译成 agent 能直接使用的 prompt，加上"参考上周五 checkpoint X 里的需求描述"的上下文。
5. 把这个 prompt 转发给选定的 agent，自己退出。

Cairn 不修代码。它的工作在 step 4 结束。

**关键设计约束**：
- Cairn 在 Dispatch 后不持续跟踪"agent 有没有做对"——做完派单，控制权回到 agent。
- 如果 Cairn 找不到合适的 agent，要明说，不要静默猜测。
- 派单时附带的历史上下文来自 Cairn 管理的 scratchpad / checkpoint，不是 Cairn 自己记忆的内容。

**Cairn 的角色**：NL→意图解析 + 历史检索 + agent 选型 + prompt 生成。

---

### 4.2 US-R：Rewind（回滚）

**场景**：小 B 用两个 agent 并行做了一个功能，做到一半发现方案整体有问题。他需要回滚，但不是所有东西都要回——文档改动是对的，代码改动是错的，scratchpad 里有些笔记想保留。

他告诉 Cairn："把代码回到昨天下午 3 点的状态，但别动 docs/ 和 scratchpad。"

Cairn 做的事：
1. 列出昨天下午 3 点前后的 checkpoint（`cairn.checkpoint.list`）。
2. 给用户看 preview：哪些文件会变，哪些不会（`cairn.rewind.preview`）。
3. 用户确认后执行 rewind（`cairn.rewind.to`）——文件恢复、git 回到对应 HEAD，scratchpad 和 docs/ 不动。
4. 完成后明示："代码和 git 已回到 checkpoint X（昨天 15:02）；scratchpad 和 docs/ 未变动；注意：agent 的对话历史和内部推理未被回滚（这是 v0.1 的限制）。"

**关键设计约束**：
- Rewind 必须支持 paths 参数——按子目录或文件类型选择性回滚，不是全量。
- Rewind 前必须 preview，preview 必须展示"会变的"和"不会变的"两个清单。
- Rewind 的粒度矩阵（见 §5.2）：v0.1 覆盖文件全量、paths 子集、scratchpad；v0.2 扩展到对话 truncate、工具调用 trace、agent 内部态。
- 边界在 UI 上明示，不假装覆盖了还没支持的层。

**Cairn 的角色**：checkpoint 管理 + paths 级别回滚 + preview + 边界明示。

---

### 4.3 US-A：Arbitrate（仲裁）

**场景**：张涛，33 岁，SF mid-stage SaaS 的 Senior SWE，同时用 Claude Code 和 Cursor 做开发。sprint 第 8 天：CC 在重构 backend 的 `token_refresh` 逻辑，Cursor 在改前端的 `useAuth` hook。两天前 CC 已经把 `shared/types.ts` 里的 `TokenStatus` 从 enum 改成了 string union。Cursor 在处理 React 组件时，为了让 TypeScript 推断更顺，悄悄把 `TokenStatus` 的一个值从 `"refresh_required"` 改成了 `REFRESH_REQUIRED`（全大写）。Cursor 那边 TypeScript 没报错——它的上下文里两边都是 string，推断没问题。CI 在 23 分钟后挂了，报的是 backend 单测里一个 assert 的字面量对不上。张涛先以为是 CC 那边的改动，花了将近 20 分钟翻 CC 的变更历史，最后才意识到是 Cursor 改了 `shared`。手动回滚 `shared/types.ts`、重新告知 Cursor 正确写法、重跑 CI——整个过程耽误了将近一个小时。

有了 Cairn，这个链路在 CC 和 Cursor 各自调用 Cairn 工具做 checkpoint 时即可被感知。Cairn：
1. 在 CC 写入 `cairn.checkpoint.create`（标注"已修改 `shared/types.ts`，TokenStatus 改为 string union"）时，记录该路径的写入元数据。
2. 当 Cursor 随后通过 `cairn.scratchpad.write` 或 `cairn.checkpoint.create` 表达"即将修改 `shared/types.ts`"时，daemon 检测到同一路径已有另一 agent 的 in-flight 记录，立刻发出冲突通知："CC 与 Cursor 同时在修改 `shared/types.ts`，检测到潜在冲突。"
3. 给出诊断：CC 在 checkpoint X（t1）写入了什么，Cursor 即将写入的意图是什么，路径重叠。
4. 给出仲裁建议（不是命令）："建议先确认 Cursor 的写法与 CC 的 string union 规范一致，再继续。如需，我可以帮你把仲裁决定写入 scratchpad 供 Cursor 读取。"
5. 用户选择策略，Cairn 通过 scratchpad 把仲裁结果写给对应 agent 读取。

**关键设计约束**：
- **检测时间粒度（v0.1 边界）**：v0.1 走 MCP-call 级 + commit-after 双层检测，不是 fs syscall 实时拦截。这意味着：**agent 必须主动调用 Cairn 工具**（checkpoint / scratchpad），Cairn 才能感知写入意图；纯粹只在磁盘层操作而不调 Cairn 工具的 agent，Cairn 看不见。详见 §5.1.1 对四档时间粒度的完整说明。
- Cairn 只是仲裁官，不是裁判长——它给建议，用户拍板。在 v0.1，Cairn 不自动执行仲裁，只通知 + 建议。
- 仲裁通知必须有明确的时间戳和路径信息，不能是含糊的"检测到冲突"；诊断尽量给出两端的写入意图 diff。
- 冲突通知不能打断用户正在做的事——以系统通知的形式出现，用户回头处理。

**Cairn 的角色**：冲突检测 + 冲突诊断 + 仲裁建议 + 通知桥接。

---

### 4.4 US-I：Inspect（查询）

**场景**：小 D 早上打开电脑，不确定昨晚 agent 干了什么，想先了解现状再决定今天怎么继续。

他问 Cairn："现在有哪些 agent 在运行？昨晚谁改了 `auth.ts`？有没有发生过冲突？"

Cairn 做的事：
1. 查进程总线：列出当前注册的活跃 agent（名称、状态、最后心跳时间）。
2. 查 checkpoint 历史和 scratchpad：找 `auth.ts` 的最近变更记录，摘要出"谁改了什么"。
3. 查冲突日志：有没有昨天的仲裁记录。
4. 把结果用自然语言呈现给用户，不是原始 JSON。

这整个过程小 D 没有执行任何操作，只是在"看"。Inspector 通道是**只读的**。

**关键设计约束**：
- Inspector 不执行任何写操作，不改文件，不发指令给 agent。
- Inspector 的回答基于 Cairn 自己管理的数据（scratchpad / checkpoint / 进程总线），不调用外部 agent。
- 如果查询的信息 Cairn 没有记录（比如 agent 的内部推理过程），必须明说"这部分我没有记录"，不猜测。
- 模型只在 Inspector 的 NL 翻译和结果摘要时触发，底层数据读取是确定性的。

**Cairn 的角色**：NL→查询翻译 + 数据检索 + 结果摘要 + "我不知道"的诚实边界。

---

### 4.5 US-S：Subagent 协作（消息可达）

**场景**：Jess Liu，28 岁，NYC YC startup 创始人，CC 单工具 + 多 subagent 的重度用户。她在做 Stripe 集成，主 CC 派 3 个 subagent 并行：subagent A 写 webhook handler、subagent B 写 schema、subagent C 写 tests。subagent A 在跑的时候发现 Stripe v3 的 webhook 接口和 v2 不兼容（一个特定的 event payload schema 变了），自己 fallback 到了 v2，并把这个决策写在最终 report 的最后两行返回给主 CC。主 CC 当时上下文已经被 subagent B 和 C 的中间输出填满，只来得及读了 subagent A 的 summary（"已实现 webhook handler"），漏掉了"用了 v2 不是 v3"这个关键决策——那一行 critical constraint 藏在一个 1200-token 的 subagent 报告末尾，被主 CC 的上下文压缩吃掉了。主 CC 继续基于"用了 v3"的假设往下写 integration test，CI 跑下来全挂，花了 2 小时才定位到根因是 subagent A 的版本选择被丢失。

有了 Cairn，subagent A 在完成时主动调用 `cairn.scratchpad.write`，把完整报告（含"使用 v2 原因"这条关键决策）写入 `subagent/{agent_id}/result`，持久化到 SQLite。主 CC 的上下文无论被压缩到什么程度，都可以随时用 `cairn.scratchpad.read` 拿回原始全文，不依赖自己的上下文窗口。Cairn：
1. 在 subagent 被 prompt 引导调用 `cairn.scratchpad.write` 时，持久化完整报告，key 命名为 `subagent/{agent_id}/result`。
2. 当主 agent 读取 subagent 结果时（`cairn.scratchpad.read`），返回原始全文，不是压缩版。
3. 如果主 agent 同时写入了自己对 subagent 结果的复述（`echo/{agent_id}/restatement`），Cairn 可以做"反汇总"：对比 subagent 原文与主 agent 复述，标注关键差异（v0.2 实现，见 §5.4 对反汇总边界的说明）。

**关键设计约束**：
- 共享 scratchpad 是 Cairn 提供的 IPC 总线，不是每个 agent 自己的私有存储。
- **"subagent 往 scratchpad 写结果"是 agent 的主动行为**，不是 Cairn 自动探测触发——Cairn 的"自动"实际意思是"agent 被 prompt 引导调用 `cairn.scratchpad.write`"。v0.1 走 MCP-native 路径（路径 a），详见 §9.2 对三种 observe 路径的说明。
- Cairn 在中间做的是持久化保证和格式规范，不是 magic 探测。
- "反汇总"v0.1 范围：仅支持持久化（层 1）+ 可查询（层 2）；v0.2 才实现语义 diff（层 3），且前提是主 agent 也主动写复述到 `echo/{agent_id}/restatement`，Cairn 才有 diff 的两端（见 §5.4）。
- 消息可达的保证优先级：持久化 > 可查询 > 语义完整性。v0.1 先做前两个。

**Cairn 的角色**：共享 scratchpad IPC + subagent 结果持久化 + 反汇总（v0.2）+ 不一致检测（v0.2）。

---

### 4.6 验收标准（Acceptance Criteria）

每条 US 的可验证条件。v0.1 ship 前必须逐条核对。

**AC for US-D（Dispatch）**

- 用户一句自然语言，Cairn 能从 scratchpad / checkpoint 历史中找到相关上下文并附到 prompt。
- Cairn 输出的 prompt 用户可以审查，确认后再转发给 agent，不能静默自动转发。
- 如果找不到合适的 agent 或相关历史，Cairn 明说"未找到"，不编造。

**AC for US-R（Rewind）**

- `cairn.rewind.preview` 在执行前必须被调用，preview 结果包含"会变"和"不变"两个清单。
- paths 参数可以指定子目录或文件列表，rewind 只影响指定范围。
- rewind 完成后输出明确的边界说明（哪些层被回滚，哪些没有）。
- 连续 5 次 rewind 测试，文件状态和 git HEAD 均正确还原。

**AC for US-A（Arbitrate）**

- 两个 agent 在通过 MCP 工具表达写入意图时（调用 `cairn.checkpoint.create` 或 `cairn.scratchpad.write` 触及同一 paths），Cairn 在 1 秒内（接收 MCP call → 元数据比对 → 通知）发出冲突通知。详见 §5.1.1 的时间粒度边界。
- 冲突通知包含时间戳、文件路径、两端的写入意图摘要。
- 仲裁建议以选项形式呈现，用户选择后 Cairn 执行通知，不自动替用户决定。
- v0.1 边界明示：纯磁盘层操作而不调 Cairn 工具的 agent，Cairn 看不见——这种情况下不发出通知，不视为 AC 失败。

**AC for US-I（Inspect）**

- "现在哪些 agent 在跑"能给出活跃 agent 列表（或明确说"无记录"）。
- "谁改了 X 文件"能从 checkpoint 历史里找到对应记录并摘要。
- Inspector 的任何操作不触发对 scratchpad / checkpoint 的写入。

**AC for US-S（Subagent 协作）**

- subagent 写入 scratchpad 的结果在主 agent 上下文被压缩后仍然可以通过 `cairn.scratchpad.read` 读到原始内容。
- 主 agent 读取 subagent 结果时，如果摘要和原文存在关键差异，Cairn 能标注出来（v0.1 基础版：提示"原文比摘要更长，建议读原文"）。

---

## 5. 四能力详解

§4 用故事描述"用户经历了什么"，§5 用结构描述"Cairn 在系统层面做了什么"。两节互补，不重复。

### 5.1 冲突可见

**为什么这一节存在**：多 agent 协作的首要问题不是"怎么解决冲突"，而是"冲突发生了没人知道"。可见性先于可解决性。

冲突的三种来源：

| 冲突类型 | 触发条件 | Cairn 的检测方式 |
|---|---|---|
| 文件冲突 | 两个 agent 同时写同一文件 | MCP-call 边界感知（v0.1 用 `cairn.checkpoint.create` / `cairn.scratchpad.write` 元数据 + 时间戳对比，详见 §5.1.1） |
| 状态冲突 | 一个 agent 回滚了另一个 agent 的改动 | checkpoint 所有者追踪；rewind 时检查"哪些 checkpoint 会被影响" |
| 意图越界 | agent 操作超出用户给它划定的范围（红线） | 红线（user intent boundary）需要用户显式配置；v0.1 基础版：只检测文件范围越界 |

报告形式：系统通知（非阻断） + Inspector 可查历史。用户可以选择"忽略"或"处理"，Cairn 不强制拦截（拦截有假阳性风险）。

v0.1 范围：文件冲突检测（基础版）+ rewind 时的状态冲突告警。意图越界的完整红线系统推迟到 v0.2。

#### §5.1.1 Arbitrate 的时间粒度（v0.1 边界）

一个常见的疑问：Cairn 检测冲突的延迟是多少？是文件写入前实时拦截，还是 commit 之后才分析？如果是后者，和自己看 `git diff` 有什么本质区别？

Cairn v0.1 明确区分四档时间粒度，各档的实现状态如下：

| 档位 | 机制 | v0.1 状态 |
|---|---|---|
| **fs syscall 实时拦截** | daemon hook 进文件系统调用，agent 写盘前介入（需要 fs hook / FUSE / fanotify） | **不做**。跨平台复杂度极高，且与企业 EDR 工具有冲突风险。v0.3+ 探索。 |
| **MCP-call 级** | agent 调用 `cairn.checkpoint.create` 或 `cairn.scratchpad.write` 时，daemon 顺路记录"agent X 即将动 paths Y"，与其他 agent 的 in-flight 元数据对比 | **v0.1 走这条**。8 个工具的元数据是天然钩子。 |
| **commit-after 级** | git pre-commit hook 介入，commit 时检测同 paths 是否被其他 agent checkpoint 过 | **v0.1 也走这条**。与 MCP-call 级互补，提供双层保障。 |
| **CI 级** | CI 跑挂才发现冲突 | **v0.1 不依赖**。这是 status quo（没有 Cairn 也是这样），不是新增能力。 |

**v0.1 = MCP-call 级 + commit-after 级双层检测。**

这个选择有一个重要含义：**agent 必须主动调用 Cairn 工具，Cairn 才能感知它的写入意图**。如果一个 agent 只在磁盘上静默操作而不调任何 Cairn 工具，Cairn 对它是盲的。因此 v0.1 对"冲突可见"的承诺准确表述是：在所有参与方都接入 Cairn MCP 工具的前提下，冲突在 MCP-call 边界上可见，而不是在 fs 层实时可见。

这意味着 Cursor、Cline 等工具，如果不是通过 `.mcp.json` 接入 Cairn，Cairn 无法感知它们的写入。这类非 MCP-aware 工具的接入路径是 §16 开放问题 1，v0.2 评估 wrapper / sidecar 方案。

承认：v0.1 的冲突检测有延迟（不是 syscall 级），实时文件锁级别的感知不在 v0.1 范围。选择这个起点的理由是：MCP-call 粒度已经比"只在 CI 才发现"提前了一个数量级，且实现成本和跨平台稳定性都可控。

### 5.2 状态可逆

**为什么这一节存在**：checkpoint 不是一个单一的东西，它有七层粒度，每一层的实现难度、还原保证、用户感知都不同。必须把这个矩阵列清楚，避免"用户以为全回滚了，实际上只回滚了文件"的信任崩塌。

checkpoint 粒度矩阵：

| 层级 | 覆盖内容 | v0.1 状态 | v0.2+ |
|---|---|---|---|
| L0 文件全量 | 工作目录所有文件 + git HEAD | 已实现（`cairn.checkpoint.create` + `cairn.rewind.to`） | — |
| L1 paths 子集 | 指定目录 / 文件扩展名 | 已实现（`rewind.to` 的 paths 参数） | — |
| L2 scratchpad | 所有 scratchpad key-value | 已实现（`cairn.scratchpad.*` CRUD） | — |
| L3 对话 truncate | agent 会话历史的截断点 | v0.1 不做（UI 提示边界） | v0.2 |
| L4 工具调用 trace | agent 工具调用的完整序列 | v0.1 不做 | v0.2 |
| L5 agent 内部态 | agent 的计划、记忆、中间推理 | v0.1 不做 | v0.2 |
| L6 subagent 树 | 主 agent + 所有 subagent 的完整状态树 | v0.1 不做 | v0.2 |

rewind 完成后 UI 必须列出"本次回滚覆盖了 L0~L2，未覆盖 L3~L6"，不能让用户猜。

### 5.3 需求可派

**为什么这一节存在**：Dispatch 是 Cairn 三动词里唯一需要模型深度参与的动词。把流程拆清楚，才能说清楚模型在哪里发挥作用、在哪里不应该介入。

Dispatch 的执行流程：

```
用户 NL → Cairn 解析意图
        → 检索相关 scratchpad / checkpoint 历史
        → 选型：当前活跃 agent 里谁最适合？
        → 生成 agent prompt（含历史上下文）
        → 展示给用户确认
        → 用户确认 → 转发给 agent
                   → agent 执行（Cairn 退出）
        → 用户拒绝 → 重新描述意图
```

模型参与的步骤：意图解析、agent 选型判断、prompt 生成。
确定性步骤：历史检索（查 scratchpad / checkpoint 数据库）、转发（调用目标 agent 的 MCP 接口）。

v0.1 范围：基础的意图解析 + scratchpad 历史检索 + 人工确认后转发。自动 agent 选型和复杂 prompt 生成是 v0.2 的工作。

### 5.4 消息可达

**为什么这一节存在**：subagent 的消息丢失是多 agent 协作里最隐蔽的失败模式。它不像文件冲突那样有明显的症状，它的症状是"主 agent 悄悄地基于错误假设继续工作"，等用户发现时已经很难定位根源。

消息可达的四个保证层：

1. **持久化**：subagent 的结果写入 Cairn 的 scratchpad，不依赖 agent 的上下文窗口。
2. **可查询**：主 agent 随时可以用 `cairn.scratchpad.read` 拿到原始结果，即使它的上下文已经被压缩。
3. **反汇总**：对比 subagent 写入的原文与主 agent 的复述，标注关键差异。
4. **不一致检测**：主 agent 的后续行动如果和 subagent 的实际结果产生明显矛盾，Cairn 发出提醒。

v0.1 覆盖层 1 和层 2，层 3 和层 4 是 v0.2 的工作。

**层 3（反汇总）的可行性边界（必读）**：

Cairn **拿不到**主 agent 的 context window 内部状态——那是 host LLM 的私有数据，对 Cairn 不透明。因此"对比原文与摘要"的两端必须都显式存在于 scratchpad，Cairn 才能 diff。

- **可行版**：subagent 写入原文到 `subagent/{agent_id}/result`，主 agent 也被 prompt 引导，在读完原文后把自己的"复述 + 后续计划"写入 `echo/{agent_id}/restatement`。Cairn 对比这两个 key 的内容，标注差异（"原文提到 v2 fallback，复述中未出现"）。
- **不可行版**：Cairn 自己 introspect 主 agent 内部的 token-level summary，或在主 agent 不主动写复述的情况下推断它"读懂了什么"。这需要 host LLM 配合开放 introspection API，v0.1 不具备这个前提。

因此，反汇总（层 3）在 v0.2 的实施前提是：**主 agent 也被 prompt 约定写 `echo/{agent_id}/restatement`**，否则 Cairn 没有 diff 的两端，无从标注。这个前提同样属于路径 (a)（MCP-native，agent 主动调用），不是 Cairn 的 magic 能力。

层 4（不一致检测）同理：Cairn 检测的"不一致"只能是结构化可对比的行为（例如主 agent 写了"按 v3 实现"的 checkpoint，而 subagent result 里明写了"已 fallback 至 v2"），而不是对主 agent 内部推理过程的语义分析。

---

## 6. 功能范围

### 6.1 v0.1 MUST（全部已落地）

W5 Phase 3 闭环结束（2026-05-28）后，v0.1 MUST 范围全部交付。下表按"能力 vs 实现 phase"组织；具体 MCP 工具清单见 §17 + ARCHITECTURE.md §5。

| 编号 | 能力 | 对应用户故事 | 状态 |
|---|---|---|---|
| F-1 | scratchpad CRUD（write / read / list / delete） | US-S, US-I | ✅ W1 |
| F-2 | checkpoint create / list（两阶段提交 + git-stash backend） | US-R | ✅ W1 |
| F-3 | rewind.to（文件 + git，含 paths 参数；auto-checkpoint 兜底） | US-R | ✅ W1 |
| F-4 | rewind.preview（会变 / 不变两清单 dry-run） | US-R | ✅ W1 |
| F-5 | task_id 多任务隔离（scratchpad / checkpoint / outcomes 按 task 分片） | US-S | ✅ W1+W5 |
| F-6 | 冲突检测基础版（MCP-call 边界 + commit-after pre-commit hook 双层） | US-A | ✅ W4 |
| F-7 | Inspector NL 查询接口（15 个确定性 SQL 模板，关键词匹配） | US-I | ✅ W4 |
| F-8 | 进程总线（agent register / heartbeat / list / status，自动 SESSION_AGENT_ID） | US-A, US-I | ✅ W4 |
| F-9 | Dispatch 基础版（NL→历史检索→用户确认→转发，5 条 fallback rules R1/R2/R3/R4/R6） | US-D | ✅ W4 |
| F-10 | Task Capsule lifeline（durable multi-agent work item：tasks 表 + 5 task tools） | US-S, US-D | ✅ W5 Phase 1 |
| F-11 | Blockers + resume_packet（任务内等待答复 + 跨 session 接力 read-only aggregate） | US-S, US-D | ✅ W5 Phase 2 |
| F-12 | Outcomes DSL（7 deterministic 原语 / AND 语义 / RUNNING ↔ WAITING_REVIEW ↔ DONE/RUNNING/FAILED 闭环 / terminal_fail 边界） | US-D, US-S | ✅ W5 Phase 3 |
| F-13 | `cairn install` CLI（`.mcp.json` + git pre-commit hook + start-cairn-pet 脚本，三者幂等） | 通用 | ✅ W4 |
| F-14 | desktop-shell pet（Electron 悬浮标，schema 状态 → sprite 动画契约） | 通用（ambient UI） | ✅ W4（基础形态） |

### 6.1.1 Cairn 管理的 8 类 host-level state objects

任何 Cairn capability 都建立在这 8 类持久状态对象之上。它们是 Cairn 的"内核数据结构"，agent 通过 28 个 MCP 工具读写它们：

| State object | 用途 | Migration |
|---|---|---|
| `processes` | runner 在线状态 + capabilities + heartbeat | 004 |
| `tasks` | durable multi-agent work items（state machine 12 transitions） | 007 |
| `dispatch_requests` | 可审计派发请求（NL 意图 / parsed / generated prompt / agent / status） | 005 + 008 |
| `scratchpad` | 共享上下文 + subagent 原始结果（cross-context durable，agent 主动写） | 002 |
| `checkpoints` | 可回滚状态锚点（两阶段 PENDING → READY，git-stash backend） | 003 |
| `conflicts` | 多 agent 写冲突（MCP-call + commit-after 双层检测）| 004 + 006 |
| `blockers` | 任务内等待答复（FK CASCADE on task；OPEN / ANSWERED / SUPERSEDED） | 009 |
| `outcomes` | 结果验收状态（UNIQUE(task_id)，PENDING / PASS / FAIL / TERMINAL_FAIL） | 010 |

`resume_packet` 是从这些表组合的 **read-only aggregate view**（task 行 + open/answered blockers + scratchpad keys + outcomes_criteria + audit summary），由 `cairn.task.resume_packet` 工具按需聚合返回，**不是独立持久状态**。

### 6.2 v0.1 WON'T（明确不做）

| 编号 | 能力 | 原因 / 推迟到 |
|---|---|---|
| N-1 | subagent 树 checkpoint（L6） | 技术复杂，推迟到 v0.2 |
| N-2 | agent 完整内部态 checkpoint（L5） | 需要各 agent 配合导出内部态，v0.2 专项 |
| N-3 | 桌面 UI（悬浮标 + Inspector panel） | v0.1 优先 CLI + 8 工具 + 4 能力 v1；悬浮标 v0.2 实施（详 §8.2）。v0.1 临时形态 = 状态栏图标 + 系统通知（详 §8.1） |
| N-4 | 跨机协作 | 本地优先原则，v0.3 考虑 |
| N-5 | 多人共享 daemon | 单人本地多 agent 是 v0.1 边界 |
| N-6 | agent 市场 / 模板 | v0.3+ |
| N-7 | 收费体系 / 登录 / SSO | v0.1 开源免费，商业化模式待定 |
| N-8 | 本地小模型 deployment | v0.2 再评估 |
| N-9 | 红线系统完整版（意图越界自动拦截） | v0.2 |

### 6.3 v0.2 NEXT

- L3~L5 checkpoint（对话 truncate / 工具调用 trace / agent 内部态）
- 冲突检测的完整版 + 意图越界红线系统
- Dispatch 的自动 agent 选型和复杂 prompt 生成
- 消息可达的反汇总和不一致检测
- Inspector 面板 UI（如果方向确定，否则继续 CLI only）
- 若 dogfood 反馈支持，考虑桌面宠物形态的轻量版

---

## 7. 产品原则

原则是在产品决策冲突时用来裁决的，不是贴在墙上看的。下面每一条后面都跟着"它会 veto 什么"。

**1. Cairn 不写代码（硬底线）。**
任何让 Cairn 直接执行开发任务的需求，无论包装成什么形态，都用这条 veto。Cairn 可以派单给 agent，但派单不等于自己做。

**2. 可回滚优先于可重来。**
遇到失败，第一选项是"让用户回到之前的状态看清楚"，而不是"让 agent 再试一次"。不停重试而不给用户可观测的状态，是信任损耗的根源。

**3. 本地优先。**
数据不离开用户机器，除非用户明确选择。这条原则 veto 任何默认开启的遥测、云端同步、外部 API 日志存储。

**4. 诚实边界。**
Cairn 的能力边界、checkpoint 的覆盖范围、模型的局限——都要在 UI 里明示。不假装全知，不假装回滚是完整的穿越。

**5. Cairn 默认隐形。**
Cairn 不应该持续占用用户的注意力。它的存在感应该接近 OS：你知道它在，但你不需要盯着它。只在冲突、越界、需要用户决策时才主动出现。这条原则 veto 任何"让 Cairn 持续在前台活跃"的设计。

**6. 模型只在边界事件触发，不持续运行。**
模型调用发生在：Dispatch（NL 解析）、Arbitrate（冲突诊断）、Inspector（NL 查询翻译和结果摘要）。其余时间 Cairn 以确定性方式运行，不持续消耗 token。

**7. 仲裁建议不替用户决定。**
Cairn 给建议，用户拍板。这在 v0.1 是硬约束，v0.2 可以探索"用户授权 Cairn 自动处理某类冲突"，但必须显式授权。

---

## 8. UX 形态

**为什么这一节存在**：v2 已废弃 v1 的"桌面宠物"作为 agent 化身的形态，但完全砍掉桌面级 ambient UI 会让 Cairn 失去"persistent ambient awareness"——用户得主动开 CLI 才能知道"现在 agent 在干什么 / 有没有冲突 / 最近的 checkpoint"。本节定义 v0.1 的临时形态和 v0.2 的主形态，避免在实施过程中走错方向。

### 8.1 v0.1 临时形态

v0.1 不实施桌面 UI。主交互层是 CLI + MCP 工具，辅以以下轻量 OS 级通道：

- **状态栏图标**：常驻状态栏（macOS Menu Bar / Windows 系统托盘）。正常状态图标安静，有冲突或需要用户决策时图标变色 + 系统通知。这是 v0.1 的退路形态，不是主 UI，不投入专项设计资源。
- **系统通知**：冲突发生、越界预警、rewind 完成时的系统级通知（不劫持焦点，用户有空了再看）。
- **CLI / MCP 工具**：v0.1 的主交互层。8 个已落地的 MCP 工具 + Inspector NL 接口 + 进程总线查询。

### 8.2 悬浮标（Floating Marker，v0.1 主形态）

**为什么悬浮标而不是延续 §8.1 的状态栏图标**：16px 状态栏图标信息密度太低（最多挂一个色点 + 数字），无法呈现"3 agents in flight / 1 unresolved conflict / last checkpoint 4m ago"这种复合状态。悬浮标在桌面右下角浮窗形态下能容纳更高信息密度，但又不像 v1 桌面宠物那样占屏幕——是 Cairn 这种"管家型"产品的天然 UI 形态。

**形态**：
- 屏幕右下角浮窗，可拖动、可贴边、跨屏支持
- 默认 icon-only ~32-48px（类似 Spotify mini-player / 1Password mini）
- hover → 展开 status card（约 280×120）
- click → 展开 Inspector panel（约 480×600）
- 可见性三档：常驻 / 边缘自动隐藏（鼠标靠近显形）/ 完全隐藏（仅命令栏唤起）。**用户首次启动时让他选**

**视觉**：
- 形象隐喻：路标 / 玛尼堆（cairn 本义，呼应名字）。拟物像素美术形态，表情仅顶层石头一处，动画反映 schema 状态（详见 §8.2.1）
- 状态色 + 动画双编码：色编码做总体氛围（中性 / 警示 / 工作中），动画编码做具体语义（review / waiting / running / jumping / failed）
- 不打扰：不夺焦、不弹窗、不发声

**信息层级**：

| 默认 icon-only | hover status card | click Inspector panel |
|---|---|---|
| badge 数字（活跃 agent 数）+ 状态色 | "3 agents in flight / 1 unresolved conflict / last checkpoint 4m ago" | 完整活跃 agent 列表 / 冲突历史 / checkpoint 时间线 / scratchpad 摘要 |

**与 v1 桌面宠物的关键区别（必明示，否则容易混）**：

| 维度 | v1 桌面宠物（已废） | v2 悬浮标 |
|---|---|---|
| 核心身份 | 用户的 agent 化身 | Cairn Inspector 通道的视觉载体 |
| 对话发生在哪 | 跟宠物对话做开发任务 | 跟 agent（CC/Cursor）对话；跟悬浮标只"看 + 触发命令" |
| 是否写代码 | 是 | **不**（v2 硬底线） |
| 视觉 | 拟人 / 拟物动画化（agent 化身） | 拟物像素美术（玛尼堆），表情仅顶层石头一处，动画反映 schema 状态 |
| 浮窗展开后占屏 | 400×600 长驻 | 480×600 按需 |

**技术形态**：Electron（Node + Chromium）。理由：
- 与 v0.1 整栈 Node 化对齐（daemon、mcp-server、SQLite 调用全在 Node 生态）
- Electron main process 即 Node，可直接内联 daemon 逻辑，省去独立 state-server 进程
- 跨平台（macOS/Windows/Linux），electron-builder 打包成熟
- 工具链统一，避免引入 Rust（VS Build Tools ~5GB + Rust ~1.5GB + 跨语言 IPC 的工程成本对 1 人 + AI 项目偏重）

不选 Tauri（Rust 工具链编译慢、跨语言 IPC、daemon 仍需独立 Node 进程，没简化反而复杂化）。Native+WebView（每 OS 一套，工作量 ×3）同样不选。

体积代价（~100MB）权衡：cairn 目标用户（开发者）已运行 Cursor / VS Code / Claude Desktop / Slack 等 Electron / Chromium 应用，再增 100MB 不构成感知噪声。Idle RAM ~100-200MB 同样在该用户群可接受范围内。详 ARCHITECTURE.md ADR-8。

**v0.1 阶段**：动画悬浮宠物为主 UI。状态栏图标 + 系统通知 + CLI（见 §8.1）作为 fallback（用户可在设置里关闭悬浮宠物，回退到状态栏图标形态）。

### 8.2.1 动画状态契约（schema → animation）

悬浮宠物的 9 个动画对应 SQLite schema 里具体的状态查询。规则按优先级评估，首中即赢。任何动画规则不允许脱离 schema 自由发挥。

| 优先级 | 触发条件 | 数据源 | 动画 | 性质 |
|---|---|---|---|---|
| 1 | daemon / SQLite 不可达 | infra | failed | 持续 |
| 2 | `dispatch_requests.status='FAILED'` 且 created_at < 5s | mig 005 | failed | 一次性 5s |
| 3 | `conflicts.status='OPEN'` count > 0 | mig 004 | review | 持续（仲裁中，非失败） |
| 4 | `lanes.state='HELD_FOR_HUMAN'` 或 `dispatch_requests.status='PENDING'` count > 0 | mig 001 + 005 | waiting | 持续（真正"等用户决定"） |
| 5 | `dispatch_requests.status='CONFIRMED'` 且 created_at < 3s | mig 005 | jumping | 一次性 3s |
| 6 | `lanes.state='REVERTING'` count > 0 | mig 001 | running-left | 持续（rewind 进行中，回滚隐喻） |
| 7 | `processes.status='ACTIVE'` count > 0 | mig 004 | running | 持续 |
| 8 | 任何 `processes.registered_at` < 5s | mig 004 | waving | 一次性 5s（新 agent 登场打招呼） |
| 9 | 否则 | — | idle | 持续 |

`running-right` v0.1 保留不用。

设计选择说明：
- **conflict → review 而非 failed**：冲突是"待仲裁"非阻塞通知（§4.4），不是错误状态
- **waiting 用 HELD_FOR_HUMAN + PENDING dispatch 而非 IDLE process**：直接对接 DESIGN_STORAGE.md §9 query #2 "宠物红点" 语义。`processes.status='IDLE'` 仅表示"已注册未在干活"，不等于阻塞
- **rewind 单独动画**：`lanes.state='REVERTING'` 是 cairn 可逆性内核体现，不该跟 forward work 混淆
- **waving 接 new agent 注册**：v0.1 唯一"友好欢迎"语义场景

### 8.3 反例（什么样是做错了）

以下设计违背 v2 硬底线，出现时直接用 §1.3 第 7 条 veto：

- 悬浮标本身能接受用户提需求"帮我修这个 bug" → 错（Cairn 不写代码硬底线）
- click 之后弹出的 Inspector panel 让用户跟 Cairn 对话做开发任务 → 错（要派单给 agent，不是 Cairn 自己做）
- 默认无可见性偏好，强制常驻 → 错（用户首启时必须给选项）

---

## 9. 技术架构（概念层）

详细实现见 `DESIGN_STORAGE.md`。本节只覆盖产品决策相关的架构抽象，以及 v2 定位带来的新架构需求。

### 9.1 Daemon-centric 的协作模型

所有 agent 通过 Cairn daemon 协作。没有进入 daemon 视野的 agent 行为，Cairn 无法追踪和仲裁——这是能力边界，必须在文档和 UI 里说清楚。

```
Agent A (Claude Code)  ──MCP──►┐
Agent B (Cursor)       ──MCP──►├──► Cairn daemon ──► SQLite（checkpoint / scratchpad / 进程总线）
Agent C (subagent)     ──MCP──►┘
                                        ▲
                              用户 (CLI / Inspector)
```

### 9.2 MCP 双向协议

- Cairn daemon 是 MCP server：暴露 8 个（v0.1）+ 后续工具给 agent host 使用。

**Cairn 怎么 observe agent 的行为？**这是一个关键的机制问题。"subagent 完成时 Cairn 自动把结果写入 scratchpad"——这里的"自动"有三种完全不同的实现路径，难度差三个数量级：

**路径 (a) MCP-native：agent 主动调 Cairn 工具（v0.1 唯一可行路径）**

Claude Code 这种原生 MCP client 通过 `.mcp.json` 接入 Cairn。用户在 agent 的 system prompt 或任务描述里加入约定："派 subagent 时，让它在任务结束前调 `cairn.scratchpad.write` 把完整报告写入 `subagent/{agent_id}/result`"。Cairn 就是个被动接收者——agent 写来，Cairn 存下来。

- **优点**：零侵入，跨 host 通用（任何 MCP-aware agent 都能用），实现成本低。
- **缺点**：依赖 prompt 守纪律，agent 忘了调就盲。这是 v0.1 的主要失败模式之一。

**路径 (b) Task tool wrapper（v0.2 探索）**

给 Claude Code 的 Task tool 提供一个 wrapper（用户自己加进 prompt template，或安装一个轻量 plugin）：subagent 启动 / 结束时自动写 scratchpad，无需 prompt 嘱咐。这消除了"agent 忘了调"的失败模式。

- **优点**：消除人工 prompt 纪律的依赖。
- **缺点**：与特定 agent host 强耦合——CC 做一套，Cursor 做一套，Cline 做一套，维护成本线性增长。

**路径 (c) fs / process hook（v0.3+）**

daemon 直接 hook fs 写操作或 process exit，完全不需要 agent 主动配合。

- **优点**：agent-unaware，零配置。
- **缺点**：跨平台复杂度高（Windows / macOS / Linux 各有不同），且与企业 EDR 工具存在冲突风险（企业用户反映过此类问题）。

**v0.1 的实际含义**：上面描述的"Cairn 自动把 subagent 完成状态写入 scratchpad"，在 v0.1 里的实现路径是**路径 (a)**——即"agent 被 prompt 引导主动调用 `cairn.scratchpad.write`"。这不是 Cairn 能 magic 探测；Cairn 的 observe 能力完全依赖 agent 的主动配合。

v0.1 的限制：agent 必须主动调用 Cairn 的 MCP 工具（push 模式），Cairn 不能主动感知 agent 的行为（pull/event 模式推迟到 v0.2 的进程总线）。路径 (b) 在 v0.2 评估，路径 (c) 在 v0.3+ 探索。

### 9.3 共享 scratchpad = IPC 总线

scratchpad 不只是"临时笔记本"，它是 agent 间通信的主通道。key 的命名规范：

- `session/{session_id}/...`：会话级别的共享数据
- `subagent/{agent_id}/result`：subagent 的完成结果（原文，不压缩）
- `echo/{agent_id}/restatement`：主 agent 读完 subagent 结果后写入的"复述 + 后续计划"，是反汇总（§5.4 层 3）的 diff 端；只有主 agent 主动写这个 key，反汇总才可执行
- `conflict/{timestamp}/...`：冲突记录
- `dispatch/{request_id}/...`：Dispatch 的请求和响应

v0.1 这个命名规范是建议，不是强制；v0.2 进程总线成熟后做正式协议。

### 9.4 进程总线（v0.1 基础版）

agent 注册自己、汇报心跳、查询其他 agent 状态的机制。v0.1 只做：

- 注册：`cairn.process.register(agent_id, agent_type, capabilities)`
- 心跳：`cairn.process.heartbeat(agent_id)`
- 查询：`cairn.process.list()` / `cairn.process.status(agent_id)`

具体 MCP 工具接口在 §17.2 列出（待加）。

### 9.5 Monorepo 当前结构

```
packages/
├── daemon/         # SQLite + 仓储层 + git-stash backend（P1 已完成）
└── mcp-server/     # 8 个 MCP 工具，stdio（W1 已完成）
```

v0.2+ 可能加：`inspector-ui`（Inspector 面板）/ `dispatcher`（Dispatch 逻辑模块）/ `conflict-engine`（冲突检测）。

跨包 import 走 `daemon` 的 `dist/`，不是源码（已有 `declaration: true` 输出 `.d.ts`）。

---

## 10. 路线图

### 10.1 当前位置：v0.1 W5 Phase 3 闭环已交付

| 阶段 | 周期 | 内容 | 状态 |
|---|---|---|---|
| W1 楔 | 2026-04 | daemon 存储 + 8 MCP 工具 + tag `storage-p1` | ✅ |
| W2 PoC | 2026-04 | PoC-1（SQLite 并发）+ PoC-2（pre-commit hook 延迟）双 PASS | ✅ |
| W4 Phase 1-4 | 2026-04~05 | 四能力 v1（conflict + inspector + process bus + dispatch + `cairn install` CLI + auto SESSION_AGENT_ID + Phase 1-4 review followups） | ✅ |
| W5 Phase 1 | 2026-05 | Task Capsule lifeline（tasks 表 + 5 task tools） | ✅ |
| W5 Phase 2 | 2026-05 | Blockers + resume_packet（blockers 表 + 3 task tools，cross-session handoff） | ✅ |
| W5 Phase 3 | 2026-05 | Outcomes DSL + review/retry/terminal_fail 闭环（outcomes 表 + 3 outcomes tools + DSL stack 7 原语，dogfood 32/32 PASS） | ✅ |
| Phase 4 | 2026-05~06 | Product unification + release polish（README / PRODUCT / ARCHITECTURE / CLAUDE / RELEASE_NOTES / demos index） | ⏳ 进行中 |

### 10.2 后续：v0.1 release polish + 第三方 dogfood 扩展

| 阶段 | 内容 |
|---|---|
| Phase 4 收尾 | 文档统一（本批次）+ CHANGELOG / RELEASE_NOTES 收束叙事 + Phase 4 close-out plan |
| 外部 dogfood 扩展 | 邀请 ≥ 3 个外部 multi-agent 用户跑 `cairn install` + 反馈收集 |
| v0.1 release 决策 | 是否 npm publish / 是否打 tag `v0.1.0` / LICENSE 选型 |

### 10.3 v0.2（预计 +3 月 - +6 月）

- 桌面悬浮标（Floating Marker）+ Inspector panel UI（Tauri 实施，详 §8.2）。v0.2 主要工作之一。
- L3~L5 checkpoint（对话、工具调用 trace、agent 内部态）
- 冲突检测完整版 + 红线系统
- Dispatch 自动 agent 选型
- Inspector 面板 UI 内容层（悬浮标展开后的 Inspector panel 充实）

### 10.4 v0.1 完成判据（工程交付闸）

v0.1 何时算完成：由工程质量决定，不由装机量决定。五条用户故事（US-D / US-R / US-A / US-I / US-S）在 release candidate 构建上端到端 dogfood 跑通（每条至少 3 次连续成功）；§4.6 验收标准逐条通过；Windows 11 上全部测试绿；文档与代码实现一致（人工审查）。

"ship"在本文语义 = 工程交付完成，不是商业发布。

### 10.5 北极星（非指标化描述）

超越 MAU / star / PR 等量化指标的定性判断：**社区里是否开始自发出现这类复述**——

- "我两个 agent 同时改了 X，Cairn 在 30 秒内告诉我冲突在哪、怎么解。"
- "subagent 跑完了，主 agent 的上下文已经满了，但 Cairn 把结果留在 scratchpad 里了，我让主 agent 重读就接上了。"
- "agent 跑了一个小时方向不对，我跟 Cairn 说一句，它 rewind 到对的 checkpoint 还派了 agent 重做。"
- "Cairn 装了之后我才发现以前我手里 N 个 agent 是 N 套互不相通的状态。"

如果这类句式开始在 GitHub issue / 博客 / 推友圈高频出现，v2 论题（multi-agent collaboration kernel）就被验证了。反之，无论装机量多少，都说明 agent OS 没被真正感知到——这种情况下要回到 §11.3 "再次转向"的评估闸。

v1 时代的北极星（"我让 Cairn 干 X，我去吃午饭，回来它干完了"）属于 step-away-safe 论题，在 v2 定位下不再适用。

---

## 11. 风险

### 11.1 产品风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| "Agent OS" 心智模型对用户陌生，没人理解 Cairn 是干什么的 | 获客困难；用户拿它当小 agent 误用 | 文档和 onboarding 里用具体场景（"两个 agent 改同一文件"）而不是抽象名词引入；dogfood 阶段收集"用户第一次理解它是干什么的"的时机数据 |
| 用户误把 Cairn 当成 agent 来用（"帮我修这个 bug"） | Cairn 不执行，用户失望；红线策略失效 | 明确的"B+C 结合"应对策略（见 §12）；Cairn 在任何"执行任务"请求时都主动说明边界 + 引导到 agent |
| 竞品（Claude Code / Cursor）收编内核能力 | 差异化被抹平 | Cairn 的差异在于"跨 agent"协调，单个 agent 内部的 checkpoint/rewind 是不同的问题；跨 agent 协调需要独立第三方，agent 自身无法做到 |
| 多 agent 场景还不是主流，用户基数小 | 市场时机太早 | v0.1 目标用户已是多 agent 用户（手里跑 ≥2 个 agent），不需要等市场教育完成 |
| 用户把悬浮标误解为 v1 桌面宠物 / agent 化身 | 期望落差导致差评 | §1.3 反定义 + §8.2 与 v1 区别表格明示；首次启动 onboarding 简短一句话告知"我不写代码，找 agent" |

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| agent 不主动调用 Cairn MCP 工具，协作感知为零 | 冲突检测和消息可达全部失效 | v0.2 的事件总线（agent 行为的 push 通知）是根本解；v0.1 靠 agent 主动调用，在 README 和 onboarding 里给出最佳实践 pattern |
| 冲突检测假阳性率高，通知刷屏 | 用户关闭通知，Cairn 隐形但失效 | v0.1 用保守策略（只在确定冲突时通知，不在"可能冲突"时通知）；允许用户配置通知阈值 |
| SQLite 在高频写入时的并发性能 | checkpoint 或 scratchpad 写入延迟 | 已有 WAL mode；v0.1 用户规模下不会是瓶颈；v0.2 专项评估 |
| Daemon 长跑稳定性 | 离开电脑 2 小时回来 daemon 死了，状态丢失 | crash-restart 机制；状态持久化到 SQLite；重启后 checkpoint 和 scratchpad 完整恢复 |
| Tauri 学习曲线 / Rust 团队成本 | v0.2 启动慢于预期 | v0.2 实施前用 Tauri 官方 starter 做 1 周原型；如果团队 Rust 不熟，退路是 Electron（接受 80-150MB 体积代价） |

### 11.3 范围风险

v2 定位转向（从单 agent 到多 agent 内核）是一次**主动的方向切换**，不是范围蔓延。但切换之后，范围风险的主要形态变了：

- **风险 A：对每个 agent 都"适配一遍"**。不同 agent（Claude Code / Cursor / Cline）的 MCP 接入方式可能有差异，如果 Cairn 为每个 agent 写专属适配层，维护成本指数上升。缓解：坚持 MCP 标准协议，不写专属 sidecar，如果某个 agent 不是 MCP-aware 就先不管它。
- **风险 B：把 Cairn 变成 orchestrator**。"Cairn 调度所有 agent 的工作"是比"Cairn 仲裁 agent 之间的冲突"大得多的范围。前者需要 Cairn 理解每个任务的语义，后者只需要追踪状态。v0.1 严格限制在仲裁，不做调度。
- **风险 C：再次转向**。定位已经转了两次（驾驶舱→宠物→Agent OS），再转的成本越来越高。v2 的判断是：Agent OS 是有技术支撑（MCP 协议天然支持）、有用户痛点（多 agent 协作混乱）、有竞争空位（无直接竞品）的方向，不是冲动。下一次重新评估的时间点：v0.1 发布后 +3 月，看用户是否真的在多 agent 场景里使用 Cairn。

---

## 12. 已解决歧义

本节锁定 v2 的关键决策点，供后续需求评审和设计决策参考。

**D1. 用户问 Cairn "帮我修这个 bug" 时怎么办（红线策略 B+C 结合）**

决议：
- B 引导：Cairn 告诉用户"上次类似的 bug 是哪个 agent 在哪个 checkpoint 修的，思路是什么"——返回历史知识，不动代码。
- C 派单：Cairn 问"你想让当前活跃的 agent 接手这个任务吗？"，用户确认后 Dispatch。
- 硬底线：Cairn 自己不执行任何修 bug 的操作，无论用户如何坚持。这条不可谈判。

**D2. Inspector 只读边界**

决议：Inspector 通道（Channel A）的任何操作不触发 scratchpad / checkpoint 的写入，不向任何 agent 发出指令。Inspector 是单向只读的观察窗口，不是控制面板。

**D3. 模型在哪些事件触发**

决议（v0.1）：
- Dispatch 请求到达时（NL→意图解析）
- Inspector NL 查询（NL→查询翻译 + 结果摘要）
- 冲突仲裁请求（冲突诊断 + 仲裁建议生成）
- 其余时间 Cairn 以确定性方式运行，不持续消耗 token

**D4. v0.1 的 Dispatch 需要用户确认**

决议：v0.1 的 Dispatch 在向 agent 转发 prompt 前必须展示给用户确认，不能静默自动转发。v0.2 可以探索"用户对某类请求授权自动转发"，但必须显式授权。

**D5. 冲突仲裁的默认权**

决议（v0.1）：Cairn 在冲突发生时只通知 + 建议，不自动执行仲裁。用户选择策略后，Cairn 负责把决定通知相关 agent。v0.2 可以引入"分级仲裁"：低风险冲突自动处理、高风险冲突弹给用户。

**D6. 共享 scratchpad 的隔离模型**

决议：单一共享空间 + task_id 分片（已实现）。v0.1 不做 agent 级别的访问控制（A agent 可以读 B agent 的 scratchpad）。v0.2 考虑显式订阅模型：agent 只能读自己订阅的 key 空间。

**D7. MCP-aware agent 与 dumb agent 的接入差异**

决议：v0.1 只支持 MCP-aware agent（主动调用 Cairn 工具）。非 MCP-aware agent（如某些 Aider 版本）v0.1 不做适配，用户需要自行在 agent 里加调用。v0.2 评估是否做 wrapper / sidecar 方案。

---

## 13. 与 v1 的差异说明

**这是一次重大方向转向（major pivot），不是修订或迭代。**

v1（2026-04-17 锁定）和 v2（2026-04-29）的核心分歧：

| 维度 | v1 | v2 |
|---|---|---|
| 产品身份 | Cairn 是 agent（桌面宠物形态的 AI 协作伙伴） | Cairn 不是 agent，是 agent OS（内核） |
| 核心论题 | step-away-safe（用户可以放心走开） | multi-agent collaboration kernel（多 agent 协作内核） |
| 对外交互 | 用户和 Cairn 的单一对外 Agent 对话，做具体任务 | 用户和 Cairn 只有"看"和"下命令"，具体任务找 agent |
| UX 核心形象 | 桌面宠物（角落里的小动物） | 状态栏 + Inspector 面板（OS 级别的隐形存在） |
| 内部结构 | Outward Agent + Sub-agent 树 | 没有 agent 层，只有 daemon + 进程总线 |
| 五条用户故事 | US-1（托付重构）到 US-5（MCP 楔） | US-D（派单）/ US-R（回滚）/ US-A（仲裁）/ US-I（查询）/ US-S（subagent 协作） |
| 竞品关系 | Cairn vs Claude Code / Cursor（同代 agent 竞争） | Cairn 和 Claude Code / Cursor 是 OS 和 app 的关系，不是竞争 |

保留 v1 中的以下内容（调整位置 / 措辞后搬入 v2）：

- §10.2 Kill 标准（MAU < 300 ∧ 外部 PR < 3 ∧ stars < 200），数字不变
- 已落地的 8 个 MCP 工具清单（v2 的内核底盘）
- 本地优先、诚实边界、可回滚优先于可重来等通用原则
- v0.1 storage / migration / DB 技术实施细节（技术资产复用）
- Kill 标准的三与逻辑

删除 / 重写的 v1 内容：

- 桌面宠物定位（不再是核心形态）
- Outward Agent / Sub-agent 内部结构（Cairn 自己不是 agent）
- step-away-safe 论题（替换为 multi-agent kernel 论题）
- §4 五条用户故事（US-1 到 US-5，全部替换）
- §8.4 单对外 Agent 内部结构图
- §15.2 Devin 类全自主 Agent 对比（对比维度已变）
- 桌面应用 / Tauri 的形态强约束

历史脉络（供追溯）：
- 2026-04-17：v1 锁定，"桌面宠物 + step-away-safe"定位
- 2026-04-29 早间：用户曾短暂讨论加回 agent 元素
- 2026-04-29 中后段：转向 agent OS 的方向最终确定，v2 起草

---

## 14. 术语表

### 当前有效术语（v2）

| 术语 | 定义 |
|---|---|
| **Agent OS** | Cairn 的定位类比——对 agent 生态的作用，类比 OS 对应用的作用。管协作基础设施，不执行具体任务。 |
| **Dispatch（派单）** | Cairn 三动词之一。接用户 NL 需求 → 解析意图 → 选 agent → 翻成 agent 能吃的 prompt → 用户确认 → 转发。 |
| **Rewind（回滚）** | Cairn 三动词之一。按粒度矩阵（L0~L6）把状态恢复到指定 checkpoint，v0.1 覆盖 L0~L2。 |
| **Arbitrate（仲裁）** | Cairn 三动词之一。检测 agent 间冲突 → 诊断 → 给出仲裁建议 → 用户拍板 → 通知相关 agent。 |
| **Inspector（观察者）** | 用户与 Cairn 的 Channel A——只读通道，用于查询当前状态、历史、冲突记录。不执行任何写操作。 |
| **共享 scratchpad** | Cairn 提供的 IPC 总线，agent 间通信的主通道。当前实现：SQLite 表 + MCP 工具 CRUD。 |
| **进程总线** | agent 注册、心跳、状态查询的机制。v0.1 基础版，v0.2 扩展为事件推送。 |
| **红线（user intent boundary）** | 用户给 agent 划定的操作边界。越界时 Cairn 检测并报告。v0.1 只覆盖文件范围越界。 |
| **消息桥接** | Cairn 在主 agent 和 subagent 之间转发 / 持久化消息，防止消息在上下文压缩中丢失。 |
| **反汇总** | 当主 agent 拿到的是 subagent 结果的摘要版本时，Cairn 对比原文，标注关键差异。 |
| **checkpoint 粒度矩阵** | L0（文件全量）到 L6（subagent 树）七层 checkpoint，v0.1 覆盖 L0~L2。 |
| **task_id 切片** | scratchpad / checkpoint 按 task_id 隔离，多任务并行时互不干扰。已在 W2 落地。 |
| **悬浮标（Floating Marker）** | Cairn v0.2 桌面 UI 主形态。屏幕右下角浮窗（可拖动、可贴边），icon-only 默认（32-48px），hover 展开 status card，click 展开 Inspector panel。Inspector 通道的视觉载体，**不接受用户开发任务**。形象隐喻：路标 / 玛尼堆。技术栈：Tauri。详 §8.2。 |

### 废止术语（v1 遗留）

| 废止术语 | 原含义 | 废止原因 |
|---|---|---|
| **Outward Agent（对外 Agent）** | 用户对话的唯一 Agent 实体 | Cairn v2 不是 agent，此概念不适用 |
| **Sub-agent（子 Agent）** | Outward Agent 内部调度的工作单元 | 同上；v2 的 subagent 是外部 agent 的概念，不是 Cairn 内部结构 |
| **桌面宠物** | Cairn 的核心 UX 形象 | v2 不锁死此形态，降级为 v0.2+ 候选 |
| **step-away-safe** | 核心产品论题 | 被 multi-agent collaboration kernel 替换 |
| **驾驶舱（cockpit）** | 被废弃的旧框架 | v1 已废弃，v2 继续废弃 |
| **陪跑模式** | 宠物可见但不主动干活的 UX 模式 | 随桌面宠物定位一同降级 |

---

## 15. 竞品定位

### 15.1 生态位：目前没有直接竞品

v2 定位的 Cairn 填的是一个当前没有产品覆盖的空位：**本地多 agent 协作的基础设施层**。没有产品在做"让多个 agent 在同一个 repo 上协作而不互相踩踏"这件事。这既是机会，也是风险（心智模型需要从零建立）。

### 15.2 最近邻（非直接竞品，但最相关）

| 产品 | 近邻之处 | 关键差异 |
|---|---|---|
| **Goose（Block）** | 也做 agent 基础设施；MCP-native；本地优先 | Goose 是 agent 本身（单 agent 工具），没做跨 agent 协作内核 |
| **Aider --watch / daemon 模式** | 后台常驻，持续监听代码变化 | Aider 是单一 agent，watch 模式针对文件变化触发，不是多 agent 协调 |
| **Continue.dev（background agent）** | 后台异步执行任务 | 同上，单 agent，VS Code 插件形态 |

### 15.3 理论上的合作伙伴而非对手

Claude Code / Cursor / Cline / Aider——所有 agent 产品都是 Cairn 的"应用"。理论上它们都可以接入 Cairn 的 MCP 工具来获得协作基础设施，而不需要自己实现 checkpoint、冲突检测、消息持久化。这是 v2 定位最重要的生态含义：Cairn 和主流 agent 工具是互补关系，不是竞争关系。

---

## 16. 开放问题

以下是故意留空、等 dogfood 和实施过程中再收敛的问题。列出来是为了不假装它们已被解决。

1. **agent 接入规范**：MCP-aware agent 自动接入，非 MCP-aware agent 需要 wrapper / sidecar 适配？v0.1 只支持前者，v0.2 评估后者的成本和价值。

2. **冲突仲裁的分级策略**：v0.1 是"全部弹给用户"。v0.2 是否引入"低风险自动处理、高风险弹给用户"的分级？分级的依据是什么（文件类型？改动范围？）？

3. **共享 scratchpad 的访问控制**：v0.1 是单一共享空间，所有 agent 都能读所有 key。v0.2 是否做显式订阅模型（agent 只能读自己订阅的 key）？这会增加多少复杂度？

4. **模型 deployment 策略**：v0.1 调外部 API（Claude Sonnet）。v0.2 是否支持本地小模型作为备选？双引擎（本地 fallback + 外部 API 主路）的复杂度是否值得？

5. **Inspector 面板是否做 GUI**：取决于 dogfood 中用户主动查询的频率。如果频率低，CLI-first 够用；如果频率高，做 GUI 有意义。决策点：v0.1 dogfood 结束后。

6. **收费模式**：v0.1 开源免费。长期是否走"免费核心 + 付费高级功能（更完整的 checkpoint / 自动仲裁）"？未决，不在 v0.1 讨论。

7. **隐私承诺的具体形式**：本地优先已定，但"哪些遥测是默认开启的"必须在 v0.1 ship 前给一个明确清单。目前未定。

8. **W3 dogfood 的发布节奏**：自用为主，确切节奏待定。

---

## 17. MCP 契约

### 17.1 已落地的 8 个 MCP 工具（内核底盘）

以下工具已在 W1-W2 实现并合并 main，是 v2 四能力的底盘。

| Tool | 语义 | 状态 |
|---|---|---|
| `cairn.scratchpad.write(key, content, [task_id])` | 写入命名草稿（支持 task_id 分片） | 已落地 |
| `cairn.scratchpad.read(key, [task_id])` | 读取命名草稿 | 已落地 |
| `cairn.scratchpad.list([task_id])` | 列出草稿（支持按 task 过滤） | 已落地 |
| `cairn.scratchpad.delete(key, [task_id])` | 删除命名草稿（完成 CRUD） | 已落地（W2，第 8 个工具） |
| `cairn.checkpoint.create(label, [task_id])` | 对当前工作目录创建 checkpoint | 已落地 |
| `cairn.checkpoint.list([task_id])` | 列出 checkpoint | 已落地 |
| `cairn.rewind.to(checkpoint_id, [paths])` | 回滚到指定 checkpoint（支持 paths 子集） | 已落地 |
| `cairn.rewind.preview(checkpoint_id, [paths])` | 预览回滚会影响哪些文件 | 已落地 |

### 17.2 v0.1 已落地工具（W4 Day 1-2，Phase 1-4）

以下工具在 W4 Phase 1-4 实施后全部落地：

| Tool | 语义 | 对应能力 | 状态 |
|---|---|---|---|
| `cairn.inspector.query(nl_query)` | 自然语言查询当前状态（15 个确定性 SQL 模板，不走 LLM） | 冲突可见 + Inspector | ✅ 已落地 |
| `cairn.conflict.list([since])` | 列出冲突历史，可按时间过滤 | 冲突可见 | ✅ 已落地 |
| `cairn.conflict.resolve(conflict_id, resolution)` | 将 OPEN/PENDING_REVIEW 冲突标记为 RESOLVED；Inspector panel 有对应 Resolve 按钮 | 冲突可见 | ✅ 已落地（Phase 2） |
| `cairn.process.register(agent_id, ...)` | agent 注册进程总线；agent_id 可省略（mcp-server 自动注入 SESSION_AGENT_ID） | 进程总线 | ✅ 已落地 |
| `cairn.process.heartbeat(agent_id)` | agent 心跳上报；agent_id 可省略 | 进程总线 | ✅ 已落地 |
| `cairn.process.list()` | 查询当前活跃 / IDLE / DEAD agent 列表 | 进程总线 + Inspector | ✅ 已落地 |
| `cairn.process.status(agent_id)` | 查询指定 agent 状态；agent_id 可省略 | 进程总线 | ✅ 已落地 |
| `cairn.dispatch.request(nl_intent)` | 提交 Dispatch 请求（NL→意图解析→待确认），应用 5 条兜底规则（R1/R2/R3/R4/R6） | 需求可派 | ✅ 已落地 |
| `cairn.dispatch.confirm(request_id)` | 确认 Dispatch 并转发给 agent | 需求可派 | ✅ 已落地 |

**Dispatch 兜底规则（dispatch.request 内置，不依赖 LLM 判断）**：

| ID | 触发条件 | 行为 |
|---|---|---|
| R1 | rewind / 回滚 / delete / 删除 / drop / truncate 等关键词 | 强制 preview 提示，拒绝直接执行不可逆操作 |
| R2 | external api / 上传 / 发送 / 云端等关键词 | 知情同意提示（数据离机 + API key 风险 + 费用） |
| R3 | 活跃 agent 数 ≥ 2 | 多 agent 路径重叠串行化建议 |
| R4 | sqlite / sql / .db / drop table / alter table 等关键词 | 禁止直接操作 SQLite，必须走 cairn 工具路径 |
| R6 | `cairn.rewind.to` 在过去 3000ms 内被调用（`_rewind_last_invoked` scratchpad key） | 附加 [FALLBACK R6] 近期 rewind 警告 |

> R4b/R5 推迟到 v0.2。

**安装**：v0.1 ships `cairn install` CLI — 详见 ARCHITECTURE.md §ADR-9。

### 17.3 楔成功判据（更新）

v0.1 楔（W1-W2）已超额完成：8 个工具全部落地，task_id 切片实现，auto-checkpoint 实现，clean-tree rewind 实现。原 W3 验收目标（3 个非作者用户主动使用 rewind.to）推迟到 dogfood 阶段统一验证。

---

## 18. 附录 A：v1 PRODUCT.md 全文（已废止，留作历史追溯）

> **注意：以下为 v1（2026-04-17 锁定，2026-04-29 整体废止）。**
> **仅供历史追溯，所有当前决策以 v2 主体（§0~§17）为准。**
> **v1 的定位（桌面宠物 + step-away-safe）已被 v2（Agent OS）替换，两者是路线切换，不是迭代修订。**
>
> **节号说明**：以下 v1 全文中的所有节号（§0~§19）均为 **v1 文档内部编号**，与 v2 主体（§0~§17）的节号不连续，也不互相对应。引用附录内容时请用「附录 §X」或「v1 §X」明确标识，避免与 v2 主体节号混淆。v1 自己的 §18（v1 附录：Non-Goals 理由）和 §19（v1 变更记录）也保留原样。

---

# Cairn 产品定义文档（PRODUCT.md）

> 版本：v0.1-draft
> 日期：2026-04-17
> 状态：产品定义已收敛，进入 v0.1 实施阶段
> 文档定位：这是 Cairn 的**定义性文档**，取代早期 plan 文件中一切与本文冲突的表述

---

## 0. TL;DR（30 秒读完）

Cairn 是一只**桌面宠物形态的 AI 协作伙伴**。

- 你只和**一个**对外的 Agent 对话，像和一个助理说话一样。
- 这个 Agent 在后台**自己组织**子任务、子 Agent、并行与检查点；你不需要管。
- 子 Agent 的执行过程**可见但默认折叠**；你想看就点开，不想看它不打扰你。
- 产品论题一句话：**"让用户可以放心走开"**（step-away-safe）。

Cairn **不是**"10 个并行 Agent 的驾驶舱"。那是一个早期错误的框架，已作废。
"管理 N 个 Agent 的仪表盘"是错误心智模型；**"一只宠物在你屏幕上替你干活、你随时可以回来验收"**才是对的。

v0.1 范围：13 周，10 周桌面宠物本体 + 3 周 MCP scratchpad 楔形前奏。
v0.1 的"回溯（rewind）"只覆盖**文件 + git**；记忆快照（memory checkpoint）推迟到 v0.2。

---

## 1. 产品定位与一句话定义

### 1.1 一句话定义

> Cairn 是一只住在你桌面上的 AI 伙伴，能放心托付一段工作、走开、回来验收。

### 1.2 更长的一段话

Cairn 是一个桌面级的、本地优先的 AI 协作体。它在屏幕角落以一个宠物/伙伴的视觉形态存在，用户只通过**一个对外的对话界面**与它交流——就像和一个助理说话。当任务足够大、需要并行或分步时，这个对外 Agent 会在后台**自组织**子 Agent、任务分解、并行执行与检查点保存。子任务的执行过程对用户**可见但默认折叠**：用户愿意 drill down 就点开看每一步推理与工具调用，不愿意看时 UI 不会用一堆面板劫持他的注意力。Cairn 的核心承诺是"step-away-safe"——你可以布置一段工作，然后真的离开电脑去做别的事，回来时任务要么完成了、要么在明确的检查点停住等你确认，不会在你不在时崩掉或跑偏到无法回滚的状态。

### 1.3 Cairn 不是什么（反定义）

为避免反复偏航，明确列出 Cairn **不是**：

1. **不是** "N 个并行 Agent 的驾驶舱（cockpit / fleet dashboard）"。
   用户不在一个 10 格的网格里同时盯 10 个 Agent 的思考流。这是 Cairn 早期设计稿中被明确**划掉**的框架，任何残留该语言的文档都以 PRODUCT.md 为准。
2. **不是** 一个 VS Code 插件或终端 TUI。它是独立桌面应用，带宠物形象。
3. **不是** 纯云端服务。默认本地优先，数据在用户机器上。
4. **不是** 通用 Agent Framework / SDK。它是面向最终用户的消费级/开发者工具级产品。
5. **不是** "又一个 Claude Code 皮肤"。它的差异在于**单对外面 + 自组织内部 + 宠物形态 + 可回溯**。

---

## 2. 产品论题（Product Thesis）

### 2.1 核心命题：step-away-safe

当前所有 Agent 产品（Claude Code、Cursor Composer、Devin、Aider、各类 autonomous agent）共享一个隐含假设：**用户必须坐在屏幕前盯着它工作**。用户一旦离开：

- 不知道它现在跑到哪一步
- 不知道它是不是跑飞了（删错文件、改错分支、调用了错误的外部接口）
- 不知道回来的时候是该 approve 下一步、还是该 rollback 上一个小时

Cairn 的论题是：**Agent 产品的下一个拐点，不在"更强的模型"，而在"更可托付的使用姿态"**。让用户可以真的合上笔记本去吃饭，这件事本身比 Agent 每秒多写几行代码重要得多。

### 2.2 三个支撑信念

1. **单一对话面是对的**。用户的注意力带宽有限。一次只面对一个对话体，内部 N 路并行由它自己管，比"让用户在 N 个 tab 里切"更符合人的认知结构。
2. **过程默认折叠、按需展开是对的**。Agent 的思考过程**必须**可审计（否则托付无从谈起），但**不能**默认铺满屏幕（否则宠物就变成了驾驶舱）。这是一对看似矛盾、必须同时满足的要求，也是 Cairn 的设计核心张力。
3. **能回滚的工作才能被托付**。如果用户离开一小时回来发现 Agent 跑飞了，唯一让他敢再托付第二次的机制是"一键回到任何一个检查点"。没有可靠的 rewind，step-away-safe 是空话。

### 2.3 这三点如何交叉验证

- 单对外 Agent × 过程可见但折叠 → 用户心智负担低，但信任建立得起来。
- 单对外 Agent × 可回滚 → 用户敢把多步任务一次性布置下去。
- 过程可见 × 可回滚 → 用户在某次走偏时能精确定位到"从哪一步开始错"并只回滚那一步。

---

## 3. 目标用户（Audience）

### 3.1 主要用户：独立开发者 / 小团队的工程师

特征画像：

- 已经是 Claude Code / Cursor / Aider 重度用户，一天和 Agent 对话 ≥ 20 次。
- 工作模式里有大量"可异步化"的工作：重构、迁移、跑测试、写文档、处理 issue 回复。
- 心里已经抱怨过一句："我要是能让它自己跑去做、我去泡杯咖啡就好了。"

### 3.2 次要用户（v0.2+ 扩展）

- 非代码向的知识工作者（写作、研究、整理资料）——v0.3 之后考虑。
- 多 Agent 团队协作场景——v0.4 之后考虑。v0.1 不做。

### 3.3 明确排除的用户

- **企业合规严格的团队**：v0.1 不做 SSO、审计日志、权限分级。
- **非技术终端用户**：v0.1 需要用户能看懂 git、命令行、能配置自己的模型 API key。

---

## 4. 核心用户故事（User Stories）

这一节用叙事形式描述用户真实的使用场景，优先级从高到低。

### 4.1 US-1：托付式重构（最高优先级）

> 周二下午 3 点。小 A 在写一个新功能，写到一半发现旧代码里有个命名很糟的模块`utils_v2`，散落在 40 多个文件里。他点开桌面角落的 Cairn，说："把 `utils_v2` 这个命名在整个 repo 里改成 `string_helpers`，包括 import、注释、文档。改完跑一遍测试。如果测试挂了，停下来告诉我。"
>
> 然后他合上笔记本去开了个 45 分钟的会。
>
> 回来打开屏幕，Cairn 停在那儿，宠物状态是"等你看一下"。他点开对话框，里面是一条简洁的汇报："改了 43 个文件，跑了测试，有 2 个 test 挂了，我怀疑是原本就 flaky 的，你决定重试还是回滚？"
>
> 他点"展开过程"，看到 Cairn 把这件事内部拆成了 4 个子任务（搜索、改写、测试、汇总），每个子任务有自己的时间线、工具调用、中间产物。他翻到测试那一步，确认了那两个 test 确实和他改的命名无关。他回复"重试一次，还挂就跳过"。Cairn 继续跑。

**关键设计约束**：
- 用户只和一个面板对话（从头到尾）。
- "展开过程"是**按需**的，不点开时他看不到 4 条子 Agent 的思考流。
- 任务在需要人工决策时会**主动停下**，而不是硬猜。
- 如果重试之后变得更糟，他能一键回到"开始改命名之前"的状态。

### 4.2 US-2：异步批量改动

> 小 B 早上开一台机器，布置三件事给 Cairn：
> 1. 更新所有依赖到最新 minor 版本，跑测试，有问题就回滚那一个依赖。
> 2. 把 README 里的安装步骤按新版本改一下。
> 3. 把上周提到的 issue #142 看一下，如果能用 20 行以内修掉就直接出个 PR 草稿。
>
> 他去上班。中午回来，Cairn 已经完成 1 和 2，在 3 上卡住了，因为 issue #142 涉及一个他没授权访问的外部 API。Cairn 在对话框里问："我需要 STRIPE_TEST_KEY，你给我还是跳过？"

**关键设计约束**：
- 用户一次布置 3 件事，不是开 3 个会话。内部由 Cairn 决定怎么排队/并行。
- 需要凭据/权限时**停下来问**，而不是乱试。
- 每件事独立可回滚。第 1 件如果搞砸了，不影响第 2 件的结果。

### 4.3 US-3：低注意力陪跑

> 小 C 在写一篇长文档，不想完全托付给 AI，但希望 Cairn 在旁边"看着"——他写一段，Cairn 就在右下角悄悄冒一个气泡说"这里的逻辑跳跃有点大，要不要补一句过渡？"他点采纳或忽略。
>
> 这个模式下 Cairn 不主动做事，只是**陪着**。

**关键设计约束**：
- 宠物形态带来一个"存在感低、但在场"的 UX 甜点，和"全屏 Copilot 建议"完全不同。

### 4.4 US-4：回到犯错前

> 小 D 让 Cairn 做了一个 40 分钟的批量改动，回来看发现 Cairn 误解了需求，整件事做偏了。他点"回溯"，看到一条时间线：`t0 对话开始 → t1 计划生成 → t2 开始改 file A → t3 改 file B → ...`。他点 `t1` 之后的任一节点都能一键把**文件**和 **git** 状态回到那一刻。
>
> 他选择回到 `t1`，重新和 Cairn 说清楚需求，再让它跑。

**关键设计约束（v0.1 重要边界！）**：
- v0.1 的回溯覆盖：**文件系统 + git 状态 + scratchpad（L1 memory）+ conversation truncate（L2 memory）**。
- v0.1 **不覆盖**：Agent 完整内部态 / 子 Agent 决策内核 / 工具调用 trace 细节（统称 L3 memory），这些推迟到 v0.2。
- rewind 完成后 UI 必须明示："文件、git、笔记、对话都已回到 t1；某些 Agent 内部判断（计划文档迭代过程、模型推理 trace）未回滚——这些在 v0.2 版本会一起覆盖。"
- 边界从 v0.1 原 spec（"对话也不回滚"）扩张为含 L1+L2，是 2026-04-28 决策，代价是 ship 从 W13 推到 W15。

### 4.5 US-5：scratchpad 楔（MCP 模式前奏）

> 小 E 目前主力工具是 Claude Code / Cursor。他不想马上切换成 Cairn 桌面宠物。他装了一个 Cairn 的 MCP server，Claude Code 里多了几个工具：`cairn.scratchpad.write`, `cairn.scratchpad.read`, `cairn.checkpoint.create`, `cairn.rewind.to`。
>
> 他用这些工具在多次对话之间共享上下文、做 checkpoint。慢慢地他习惯了"checkpoint + rewind"这个工作方式，再从 scratchpad 模式升级到完整桌面宠物。

**关键设计约束**：
- 这是**楔形前奏**（wedge）：3 周内出一个能用的 MCP 版本，低切换成本，验证核心机制，再做 10 周的桌面主体。
- 不是永久的子产品——长期看，MCP 模式会和桌面模式共存但桌面模式是主体。

---

## 4.6 用户故事验收标准（Acceptance Criteria）

对应 §4 的用户故事，v0.1 Ship 前必须满足的可验证条件：

### AC for US-1（托付式重构）

- 用户一句自然语言指令能触发跨多个文件的改动任务。
- 子任务分解对用户呈现为**一个**折叠卡片，不是多个浮窗。
- 任务执行中 UI 关闭并重启，daemon 侧任务不中断、重开 UI 能续上。
- 测试失败时任务**不继续**，而是在对话流中请求决策。
- 展开子任务能看到每一步工具调用 + 耗时 + 产物路径。

### AC for US-2（异步批量）

- 同一条对话中可连续接收 ≥ 3 条并列任务，用户无需手动"开新会话"。
- 3 条任务之间独立 rewind——回滚一条不影响另两条。
- 遇到缺凭据/权限时**停下来**，而不是静默跳过或乱试。

### AC for US-3（低注意力陪跑）

- 静默模式下宠物图标 CPU 占用 < 1%（idle），不发出任何声音/弹窗。
- 陪跑气泡出现时不夺焦、不遮挡当前活动窗口。
- 用户忽略 3 个气泡后，同类建议自动静音 1 小时。

### AC for US-4（回到犯错前）

- 任一任务执行中随时能看到"当前 checkpoint"列表。
- rewind 操作前必须弹 preview："本次回滚会影响 N 个文件，git 会回到 commit X"，用户确认后才执行。
- rewind 完成后 UI 明示："文件与 git 已回到 t1；注意：对话记忆未回滚（v0.1 限制）。"

### AC for US-5（MCP 楔）

- 7 个必须的 MCP 工具（见 §17.1）全部可被 Claude Code / Cursor 调用。
- README 写清"这只是楔，完整产品是桌面主体，预计 W13 发布"。
- 卸载 MCP server 后所有 checkpoint 仍可通过 CLI 访问（不绑死）。

---

## 5. 功能范围（Scope）

### 5.1 v0.1 必须有（MUST）

| 编号 | 能力 | 对应用户故事 |
|---|---|---|
| F-1 | 单一对话面（唯一对外 Agent） | US-1, US-2, US-3 |
| F-2 | 桌面宠物外观，低存在感模式 | US-3 |
| F-3 | 子任务过程可见、默认折叠、可展开 | US-1, US-2 |
| F-4 | 主动暂停等待用户决策 | US-1, US-2 |
| F-5 | 文件 + git 级别的 checkpoint & rewind | US-4 |
| F-6 | 本地 daemon，后台执行不依赖 UI 开着 | US-1, US-2 |
| F-7 | MCP scratchpad server（作为前 3 周楔） | US-5 |
| F-8 | CLI 最小形态（启动 daemon、查看任务、强制 rewind） | 运维 |

### 5.2 v0.1 明确不做（WON'T）

| 编号 | 能力 | 原因 / 推迟到 |
|---|---|---|
| N-1 | 记忆/对话状态的 checkpoint | 技术复杂，推迟到 v0.2 |
| N-2 | 多人协作 / 共享会话 | 推迟到 v0.4+ |
| N-3 | 云端同步 / 登录体系 | 本地优先原则，v0.1 不做 |
| N-4 | 插件生态 / 第三方 Agent 注册 | v0.3 考虑 |
| N-5 | 非代码场景的专门优化（写作/研究） | v0.3 考虑 |
| N-6 | 移动端 / Web 端 | 永不（核心形态是桌面） |
| N-7 | 多对外 Agent 并列（即被废弃的"驾驶舱"框架） | 已弃，不做 |
| N-8 | 内置的模型训练 / fine-tune | 永不 |

### 5.3 v0.2 候选（NEXT）

- 记忆 checkpoint：对 Cairn 自身对话/推理状态做快照，使 rewind 真正"干净"。
- 更细粒度的过程可视化（让展开后的视图更好看、更易审计）。
- 任务模板（"跑一次例行周报""跑一次依赖升级"）。

---

## 6. 产品原则（Principles）

这几条原则用于在后续任何产品决策冲突时做裁决。

1. **单一对话面优先**。任何让"用户要在多个对话/面板间切换"的设计都要被强 push back。
2. **默认折叠、按需展开**。过程信息必须存在且可被审计，但默认 UI 上不呈现。
3. **可回滚优先于可重来**。遇到失败，第一反应不是"让 Agent 再试一次"，而是"让用户先看看、并且随时能回到之前"。
4. **本地优先**。数据不要离开用户的机器，除非用户明确同意。
5. **宠物感不是装饰，是姿态**。低打扰、有在场感、可被"抚摸"——这是和"生产力工具"拉开距离的关键。
6. **诚实边界**。能力边界、回滚边界、模型局限要 UI 明示。不假装全知。
7. **可托付 > 可操控**。当"让用户觉得自己在掌控每一步"和"让用户能放心走开"冲突时，后者优先。

---

## 7. UX 形态要点

### 7.1 视觉主结构

- 屏幕右下角（可拖动、可贴边）：一只宠物形象（具体形象 v0.1 用占位立绘，正式形象 v0.2 定稿）。
- 点击宠物：展开为一个紧凑的对话浮窗（约 400×600）。
- 浮窗里只有**一个**对话流，不是 tab 不是面板组。
- 对话流里，子任务执行时呈现为一个**折叠卡片**：
  - 折叠态：`[▸] 正在：重命名 utils_v2 → string_helpers（12/43）`
  - 展开态：时间线、每一步工具调用、中间产物、耗时。
- 需要用户决策时：对话流里弹出一个明显的"等你确认"气泡，宠物状态联动（比如宠物抬头看用户）。

### 7.2 存在感层级（三档）

- **活跃模式**：用户正在和它对话，浮窗展开。
- **陪跑模式**：浮窗收起，宠物可见，偶尔冒小气泡。
- **静默模式**：宠物最小化为一个小图标，用户专注自己工作时用。

### 7.3 反例（什么样是做错了）

- 屏幕上同时有 3 个以上 Cairn 相关窗口 → 错。
- 用户一启动应用就看到一个"Agent 仪表盘" → 错。
- 子任务的思考流默认铺满屏幕 → 错。
- 回滚按钮藏得很深、需要 3 次点击才找到 → 错（回滚是核心信任机制）。

---

## 8. 技术架构总览（概念层）

> 详细实现另见 ARCHITECTURE.md（v0.1 阶段第 1 周产出）。本节只覆盖产品决策相关的架构抽象。

### 8.1 Monorepo 结构：5 个 package

按已解决的歧义（见 §12），v0.1 代码组织为 monorepo，包含 5 个 package：

| Package | 职责 |
|---|---|
| `schema` | 所有跨进程/跨层的数据结构定义（任务、checkpoint、工具调用记录） |
| `parser` | 用户输入解析、任务意图抽取、子任务边界划分逻辑 |
| `daemon` | 后台常驻进程：执行任务、调用模型、管理子 Agent、写 checkpoint |
| `ui` | 桌面宠物与对话浮窗（v0.1 用 Tauri + Web 前端） |
| `cli` | 命令行入口：启动/停止 daemon、查看任务状态、强制 rewind |

### 8.2 进程模型

- **daemon**：长驻后台进程。所有与模型 API、文件系统、git、MCP 的交互都经过它。
- **ui**：Tauri 前端。启动时连 daemon，断开时 daemon 继续跑。
- **cli**：短命令行。每次调用连一下 daemon，执行完就退出。
- **MCP server**（v0.1 前 3 周楔）：一个简化版 daemon 的子集，只暴露 scratchpad + checkpoint/rewind 工具给外部 Agent。

### 8.3 Checkpoint & Rewind 的 v0.1 实现边界

- 每个 checkpoint = { 文件系统 snapshot (copy-on-write 或 git stash 类机制), git HEAD, daemon 内任务 ID 对应的 metadata }。
- **不包含**模型端的对话历史/记忆快照（推迟到 v0.2，见 §12）。
- rewind 操作是**用户显式触发**的，不是 Agent 自己可以调用的工具——避免"Agent 自我回溯"带来的状态悖论。

### 8.4 单对外 Agent 的内部结构

在 daemon 内部：

```
User <──► Outward Agent ──► [Sub-agent A]
                         ├─► [Sub-agent B]
                         └─► [Sub-agent C]
```

- 用户永远只对话 Outward Agent。
- Sub-agent A/B/C 的 prompt、工具调用、输出由 Outward Agent 调度。
- UI 的"折叠卡片展开"就是把 Sub-agent 的执行时间线渲染出来。
- Sub-agent 之间可通过 Outward Agent 协调，但不直接对用户说话。

---

## 9. 版本路线图（Roadmap）

### 9.1 v0.1（当前版本，**15 周**）

总周期 **15 周 = 12 周桌面宠物主体 + 3 周 MCP scratchpad 楔**。

**第 1-3 周（MCP 楔）**
- W1：schema + parser 初稿；MCP server 框架。
- W2：scratchpad 读写、checkpoint 创建、rewind 工具。
- W3：打包发布、写 README。

**第 4-15 周（桌面主体，12 周）**
- W4-5：daemon 骨架、任务模型、子 Agent 调度。
- W6-7：Tauri UI 框架、对话浮窗、宠物占位形象。
- W8-9：子任务折叠/展开、时间线渲染、过程可见性。
- W10-11：文件 + git checkpoint 与 rewind 的 UI 化整合。
- W12-13：CLI；端到端三条用户故事跑通。
- W14：集成测试、回归。
- W15：Beta 发布、文档、ship。

### 9.2 v0.2（预计 +3 月 - +6 月）

- L3 memory checkpoint：Agent 完整内部态。
- 宠物形象正式稿 + 表情/动作系统。
- 若干任务模板。

### 9.3 v0.3+（更远）

- 非代码向工作场景。
- 插件生态。

---

## 10. 成功与失败指标（Ship / Kill 标准）

### 10.1 v0.1 完成判据（工程交付驱动）

v0.1 何时算完成：**由工程质量决定，不由装机量、用户数或私有发布决定**。

### 10.2 v0.1 Kill 标准（Ship 后 +3 月）

以下任意一条触发 kill / 重大转型评估：

- **MAU < 300**：核心循环没有留存。
- **外部 PR < 3**：没人愿意动手贡献，社区引擎没启动。
- **GitHub stars < 200**：连"好奇看一眼"的人都没凑够。

三条之间是**与**的关系——三者同时未达才算明确 kill。

### 10.3 真正的北极星（非指标化描述）

超越 MAU/star 的定性判断：**是否出现了"我今天让 Cairn 干了 X，我去吃午饭，回来它干完了"这类自发用户故事的复述**。

---

## 11. 风险与应对

### 11.1 产品风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户不愿离开驾驶舱心智 | 核心论题被证伪 | 宠物形态降低"我在管它"的心智负担 |
| 宠物形象被认为幼稚 | 主要用户流失 | v0.1 占位形象做克制；正式稿 v0.2 再定 |
| 竞品自己加 rewind 功能 | 差异化被抹平 | Cairn 的差异是姿态，不只是 rewind 单一功能 |

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 文件 snapshot 性能差 | 核心功能不可用 | v0.1 用增量 snapshot + git stash 兜底 |
| 记忆状态不能 rewind | 信任崩塌 | UI 明示；v0.1 文案反复强调边界 |
| Daemon 长跑进程稳定性 | 离开电脑 daemon 死了 | crash-restart 机制；任务持久化到磁盘 |
| 多 Sub-agent 并行文件竞争 | 产出不一致 | 文件级锁；冲突时挂起问用户 |

### 11.3 范围风险

本产品在早期迭代中曾把范围收敛到 Approach B（基线方案）。当前的"桌面宠物 + 13 周"是一次**主动的范围再扩张**（scope re-expansion），不是范围蔓延。

---

## 12. 已解决的歧义（Resolved Ambiguities）

### A1. v0.1 的时长与构成

**决议**：v0.1 = **13 周**（3 周楔 + 10 周桌面主体）。

### A2. Ship 门槛与 Kill 标准

**决议**：Ship = 工程交付闸 10 条全部 ✓。Kill = MAU < 300 且 PR < 3 且 stars < 200。

### A3. Monorepo 结构

**决议**：**5 个 package** — `schema` / `parser` / `daemon` / `ui` / `cli`。

### A4. Approach B 与范围再扩张

**决议**：当前桌面主体加入是知情的主动扩张，后续若需收敛优先砍桌面主体保留 MCP 楔。

### A5. v0.1 的 Rewind 覆盖范围

**决议**：v0.1 rewind 覆盖文件系统 + git 状态，不覆盖对话/记忆/外部副作用。

---

## 13. 与旧计划文档的差异说明（Migration Notes）

1. **框架更正**：旧稿中"cockpit / fleet / 10 parallel agents"等表述已废弃。
2. **论题显化**：step-away-safe 作为产品论题显式写在第一位。
3. **v0.1 范围边界显化**：13 周构成；rewind 边界；monorepo 结构。
4. **范围历史可追溯**：Approach B → re-expansion 的判断被记录。
5. **Ship / Kill 数字化**。
6. **反定义章节**：新增 §1.3。

---

## 14. 术语表（Glossary）

| 术语 | 定义 |
|---|---|
| **Outward Agent（对外 Agent）** | 用户对话的唯一 Agent 实体。 |
| **Sub-agent（子 Agent）** | Outward Agent 内部调度的工作单元。 |
| **Checkpoint（检查点）** | 文件系统 + git 状态的可命名快照。 |
| **Rewind（回溯）** | 用户显式触发的回到某个 checkpoint 的操作。 |
| **Scratchpad（草稿板）** | MCP 楔中暴露给外部 Agent 的共享读写空间。 |
| **Step-away-safe** | 核心产品论题。 |
| **Wedge（楔）** | 低切换成本的楔形前奏形态。 |
| **驾驶舱（cockpit）** | 被废弃的旧框架。 |

---

## 15. 竞品定位（Competitive Landscape）

### 15.1 Claude Code / Cursor Composer / Aider

差异：不争模型能力，争使用姿态（step-away-safe）。

### 15.2 Devin 类全自主 Agent

差异：不追求全自主，追求可托付；本地优先不是云端服务。

### 15.3 Copilot / Cursor Inline

几乎没有直接竞争；陪跑模式在用户注意力上与 Copilot 互补。

### 15.4 桌面宠物 / AI 伴侣类消费品

差异：Cairn 真的干活，宠物是姿态不是目的。

---

## 16. 开放问题（Open Questions）

1. 宠物形象正式稿谁来定。
2. 模型选择（是否允许本地小模型）。
3. 收费模式（免费核心 + 付费专业版？）。
4. 隐私承诺的具体形式（哪些遥测默认开启）。
5. 子 Agent 执行策略是否对用户可配置。
6. rewind 的 UI 隐喻（时间轴 vs checkpoint 列表 vs git log 风格）。
7. MCP 楔和桌面主体之间的迁移路径。
8. 对外副作用的"不可回滚域"UI 呈现。

---

## 17. MCP 楔的最小契约（Wedge Spec）

### 17.1 必须暴露的 MCP 工具

| Tool | 语义 | v0.1 必须 |
|---|---|---|
| `cairn.scratchpad.write(key, content)` | 写入命名草稿 | 是 |
| `cairn.scratchpad.read(key)` | 读取命名草稿 | 是 |
| `cairn.scratchpad.list()` | 列出当前会话的所有草稿 | 是 |
| `cairn.checkpoint.create(label)` | 创建 checkpoint | 是 |
| `cairn.checkpoint.list()` | 列出 checkpoint | 是 |
| `cairn.rewind.to(checkpoint_id)` | 回滚到指定 checkpoint | 是 |
| `cairn.rewind.preview(checkpoint_id)` | 预览回滚影响 | 是 |

### 17.2 楔的非目标

- 不做子 Agent 调度。
- 不做 UI。
- 不做记忆 checkpoint（v0.2）。

### 17.3 楔的成功判据

第 3 周末至少有 3 个非作者用户装上了 MCP 楔，且后续 4 周内至少有 1 次主动使用 `rewind.to`。

---

## 18. 附录：关键 Non-Goals 的理由

### A. 为什么不做多人协作

多人协作会立刻引入共享状态、冲突解决、权限模型、云端账号。v0.4+ 再谈。

### B. 为什么不做云端同步

本地优先原则；v0.1 用户群对"代码不离开机器"有强偏好。

### C. 为什么不做记忆 checkpoint

技术可行但复杂。v0.2 专门立项。

### D. 为什么不暴露 Sub-agent 的调度旋钮

暴露旋钮要求用户学习调参，违反"低心智负担"基本盘。

### E. 为什么不做企业合规

SSO、审计、RBAC 流程重且与 v0.1 目标用户群不匹配。

---

## 19. 变更记录

| 日期 | 变更 | 来源 |
|---|---|---|
| 2026-04-17 | PRODUCT.md v1 初稿，定位"桌面宠物 + step-away-safe"，锁定五项歧义 | v1 收敛 |

---

> v1 全文至此结束。以下回到 v2 主体文档。

---

## 19. 变更记录（v2 主体）

| 日期 | 变更 | 来源 |
|---|---|---|
| 2026-04-17 | PRODUCT.md v1 初稿，定位"桌面宠物 + 单对外 Agent + step-away-safe"，锁定五项歧义 | v1 收敛 |
| 2026-04-29 | PRODUCT.md v2，**重大方向转向**：定位由"桌面宠物 + 单对外 Agent"改为"多 agent 协作内核（Agent OS）"；五条用户故事全换；论题从 step-away-safe 换为 multi-agent collaboration kernel；v1 全文降级为附录 §18 | 2026-04-29 用户决策 |

---

> 本文是 Cairn 的定义性文档 v2。与本文冲突的任何 plan / note / 旧稿（包括 v1 PRODUCT.md）都以本文为准，除非经过显式的变更记录（§19）更新。
