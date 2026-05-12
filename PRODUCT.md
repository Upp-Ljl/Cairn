# Cairn 产品定义文档（PRODUCT.md v4）

> 版本：v4.0（AI Engineering Operations Layer 扩展）
> 日期：2026-05-10
> 状态：Product MVP 阶段（kernel 工程已交付，product layer 基本到位，operations layer 三模式起步）
> 文档定位：v4 在 v3 product surface reframe 之上加 **operations layer**——Mode A · Mentor / Mode B · Continuous Iteration / Mode C · Multi-Cairn v0 三个新模式，让 Cairn 从"看 agent 工作现场"扩展到"按用户授权推进 agent 工作现场"。**反定义内核不松；只精确松绑 §1.3 #4 / #5 / #8 三条**，新增子句明确边界（详 §1.3）。本文档 §0~§13 是 v4 主体；§14~§17 沿用 v2/v3 工程事实；§18 是 v1 历史归档；§19 是变更记录。

---

## 0. TL;DR（30 秒读完）

Cairn 是 **程序员的 AI engineering operations layer**——也就是用户感知形态的 **AI 编程项目本机 project control surface**。

用户出想法 → Cairn 翻译为待办 + 排序 + 干系人 → AI agents（Codex / Claude Code / Cursor / Kiro / subagents）执行 → 用户 approve / reject 终态。这条流水线的每一步 Cairn 都让你**看见 + 推荐 + 在授权范围内推进**，但 accept / reject / push / merge 永远是人。

Cursor / Codex / Claude Code / Kiro 是 **coding surfaces**——你在它们里面写代码、和 agent 对话。**Cairn 不是 coding surface。** 它是它们旁边的**项目现场控制层 + AI 工人组合管理面**。

它按 project 组织各 agent 的工作现场：

- 哪些 agent sessions / subagents 在跑
- task chains 推进到哪、谁在做、哪一段卡住
- 哪些 task BLOCKED、哪些 WAITING_REVIEW、哪些 outcome FAILED
- 跨 session 怎么 resume、什么时候该 rewind
- 完整的 run log、handoff packets、checkpoints 时间线
- **v4 新增**：项目信号 → 排好序的 work items + WHY + 干系人（Mode A · Mentor）
- **v4 新增**：用户授权 N candidate → 自动 chain scout → worker → review，停在 REVIEWED 等用户 Accept（Mode B · Continuous Iteration）
- **v4 新增**：shared dir + JSONL outbox 把 published candidates 在多台 Cairn 节点间 read-only 共享（Mode C · Multi-Cairn v0）

**Cairn 让程序员在长程多 agent 编程任务里不丢掉项目掌控感，且能把"出想法 → 翻译 → 执行 → 审"这条流水线交给 Cairn 协调，自己只做终态判断。** 代码执行交给 Codex / Claude Code / Cursor / Kiro；Cairn 只做：让你看见、让你接得上、让你能回退、按授权连续推进、收回结果让你审。

**形态**：本机桌面侧边窗 + tray status icon + ambient floating marker + Live Run Log + Mentor chat panel + Continuous Iteration controls + Team sub-section。极简、高信息密度。形态参考 Activity Monitor、Windows 任务管理器、journalctl。**不**参考 Cursor / Jira / Linear / Asana。

> **v4 cockpit patch（2026-05-12，进行中）**：panel 的 L2（单项目视图）正在从"feature museum"（8 cards + 5 inner tabs）重构为**单项目驾驶舱**（5 modules：state strip / steer / activity feed / safety / needs-you）。新结构保留高密度信息、加易读 Linear-Notion 风格、新增 talk-to-agent + rewind 两个 first-class mutation。详 `docs/superpowers/plans/2026-05-12-panel-cockpit-redesign.md`。受众也同步扩到 **程序员 + 非开发者**（§3.1 patch）。

**英文 pitch**：

> Cairn is a local **project control surface** for agentic software work. It does not execute code or orchestrate agents; it turns agent activity into durable tasks, blockers, handoffs, outcome checks, and recoverable project state — so the programmer stays in control of long-horizon AI coding without becoming the bottleneck.

> "AI PMO layer" 是 Cairn 在介绍场景下用的辅助 framing（让程序员一眼理解"在他工作流的哪个位置"）。但**主定位词是 project control surface**，*不是* PMO——避免被读成 Linear / Jira clone。详 §15.4。

**支撑底座**（kernel 工程已交付）：28 MCP tools / 10 migrations / 8 host-level state objects / 411 daemon tests / 329 mcp-server tests / 32-of-32 cross-session dogfood PASS。

**当前阶段**：Product MVP。kernel 工程闭环已完成（W1+W4+W5+Phase 4 docs unification）；下一步把 kernel 接成可用的 desktop side panel。详见 §6.2 / §10。

---

## 1. 产品定位

### 1.1 一句话定位

**用户感知形态**（v3 保留为 v4 主句）：

> Cairn 是 AI 编程项目的**本机 project control surface**。它不替代 Codex / Claude Code / Cursor / Kiro 写代码，也不调度它们。它按 project 组织各 agent sessions / subagents / task chains / blockers / handoffs / outcomes / checkpoints / run log，让程序员随时看清长程 AI 编程项目正在如何被推进，并能在需要时复盘、接力、回退。

**工程现实**（v4 新增 framing，描述 Cairn 在用户和 AI agents 之间扮演什么）：

> Cairn 是程序员的 **AI engineering operations layer**——它坐在用户和他的 AI agents（Codex / Claude Code / Cursor / Kiro / subagents）之间，读项目信号、推荐排好序的 work items、在用户显式授权下自动 chain agent runs、收回结果让用户审。Cairn 不写代码、不替用户拍板；用户出想法 + 给授权范围 + 做终态决定（accept / reject / push / merge），中间的协调与可见性由 Cairn 提供。

两句一致，不冲突：**外面**用户看到一个 project control surface（桌面侧边窗 + tray + 浮窗）；**里面** Cairn 在做 AI 工人组合管理面的工作（推荐 + 翻译 + 协调 + 在授权范围内连续推进 + 收回结果让人审）。

### 1.2 五层架构（v4 把 v3 的 4 层叠加扩展为 5 层）

Cairn 现在 = 5 层叠加，不是 5 个 phase。每层都可独立讨论，但只有 5 层一起，才是 Cairn v4。

| 层 | 描述 | 用户感知 | 当前状态 |
|---|---|---|---|
| **Operations layer**（v4 新增） | AI engineering operations：Mentor 推荐 / Continuous Iteration 自动 chain / Multi-Cairn v0 read-only 共享 | 用户主动调起的"让 Cairn 帮我组织 AI 工人"动作 | ⏳ Mode A/B/C 起步（§6.5） |
| **Product layer** | project-scoped agent work side panel / project control surface | 用户看到的产品 surface（桌面侧边窗 + tray + ambient floating marker + Live Run Log） | Product MVP 基本到位（§6.2） |
| **Kernel layer** | host-level multi-agent coordination kernel | 产品底座，不直接面向用户 | ✅ 已交付（W1+W4+W5） |
| **Integration layer** | MCP tools（现）/ future adapters / sidecars | agent 接入 Cairn 的方式 | ✅ MCP 28 工具已交付 |
| **Storage layer** | SQLite + 8 host-level state objects + JSONL outboxes（candidates / iterations / worker reports）+ future events log | 持久化基础 | ✅ 10 migrations + 三类 JSONL registry 已交付 |

关键澄清（避免再次形态混淆）：

- **MCP 是 agent 接入 Cairn 的方式，不是 Cairn 的产品形态。** 用户不通过 MCP 用 Cairn；agent 通过 MCP 把工作现场告诉 Cairn。
- **desktop side panel / tray / floating marker / Live Run Log 才是用户感知的产品形态**——属于 Product layer。
- **Operations layer 不是新的 surface**，是 Product layer 上长出来的"主动模式"：Mentor 是 panel 里的 chat sub-section、Continuous 是 Three-Stage Loop UI 上的"auto-chain" 切换、Multi-Cairn 是 Inspector 里的 Team sub-section。它们都借 Product layer 的 surface，但语义是"操作"而非"显示"。
- 5 层之间是从下到上的支撑关系：Storage → Kernel → Integration → Product → Operations。任一层缺位，上层失效。

**设计选择说明**（v4 reframe 关键决定）：把三个新模式归到独立的 **Operations layer** 而不是塞进 Product layer 子层，理由：

1. **语义边界清晰**：Product layer 的本质是 *display kernel state*（只读 / 渲染 / detail drawer / event log）。Mentor 要 *consume signals → rank → recommend*；Continuous 要 *chain runs based on authorization*；Multi-Cairn 要 *federate JSONL outboxes across nodes*。这些是"操作语义"，不是"渲染语义"——和 Product layer 的 read-only 本质有冲突，混进去会模糊 §6.2 的 read-only 边界（§12 D9）。
2. **授权边界对齐**：v4 松绑的反定义条款全部集中在"用户显式授权"前提（§1.3 #4 / #8）。把这些能力收到一个新 layer，授权模型可以围绕 Operations layer 集中定义，不污染 Product / Kernel / Integration 已成熟的 trust boundary。
3. **将来 Operations 演化不波及 Product**：Mode A 的 ranking 算法 / Mode B 的 auto-chain 策略 / Mode C 的 federation 协议都会迭代多次；隔离在 Operations layer 后，Product layer 的 panel / tray / Live Run Log 不被牵连。
4. **defensive against 滑坡**：如果未来 Mentor 被错误地扩展成"自动答 blocker / 自动 rewind / 自动 dispatch"，layer 边界让评审能一眼看到"它越界从 Operations 干进了 Product mutation"——比放在 Product 子层好评审。

替代方案"Operations 作 Product 子层"被否决：Product layer 的 §6.2 MVP read-only 是硬边界（D9），把含有 mutation 能力（Mode B auto-chain 是写 JSONL outbox + 启动 worker process）的子层塞进 Product 会立刻让 D9 的语义崩塌；新拉一层比改 D9 干净。

### 1.3 反定义

边界清单。任何违反此节的需求 / 设计，直接 veto。

**Cairn 不是**：

1. **不是 coding agent**——不写代码、不开 PR、不改文件
2. **不是 Cursor clone / IDE**——不带代码编辑器，不接管"写代码"
3. **不是 Claude Code skin**——CC 是 Cairn 的"应用"之一，不是 Cairn 的容器
4. **不是 lead-subagent orchestrator**——不拆任务、不派 agent、不替 agent reasoning、**不替用户拍板**（内核保留）。
   - **v4 子句 #4a**：可以在用户**显式授权**后自动 chain agent runs（Mode B · Continuous Iteration，§6.5.2）：scout → worker → review 自动接龙，但 chain **强制停在 REVIEWED**，accept / reject / push / merge / 自动跨 candidate 接龙都仍是人按按钮。boundary verify 越界一律自动停在 REVIEWED 并标 `needs_human`。
   - **v4 子句 #4b**：可以在 Mentor 模式（§6.5.1）里**推荐**排好序的 work items + WHY + 干系人，但**不替用户决定上不上 / 派谁 / 什么时候开工**。Mentor 是 advisor，Continuous 是 executor under explicit authorization；终态决策权（"做不做 / 接不接 / 合不合"）始终在人。
   - 反定义内核**不松**："不替 agent reasoning" 和 "不替用户拍板终态决策" 仍是硬底线。任何把 Cairn 扩展成"自动给 PR 写 review verdict 决定 merge"、"自动批准 accept / push"、"自动跨 candidate 决定下一个干哪个" 的提案直接 veto。
5. **不是 Jira / Linear / Asana / sprint planning / gantt / 企业 PM SaaS**——**没有 sprint / story point / burn-down / 资源分配**（内核保留）。
   - **v4 子句 #5a**：但 Cairn 可以对**用户自己的 AI agent workforce** 做 mentoring（§6.5.1 Mode A）——读项目信号、给出排好序的 work items、解释 WHY、列出干系人。**这不属于 Linear-style 团队 PM**，因为：(i) 工作单位是 agent 产生的 candidates / tasks 而非人手动开的 issue / story；(ii) 干系人是 agent / role（worker / reviewer / human-required）而不是公司同事；(iii) 没有 cross-team gantt / sprint planning / 项目经理 dashboard；(iv) 排序是 Cairn 读项目信号给的**建议**，不是项目经理给团队成员的**指派**。
   - **v4 子句 #5b**：Mentor 给出的 work items **不是 Linear-style issues**——它们引用 / 关联到 Cairn 已有的 candidates / tasks / blockers / outcomes，不引入新的"团队工单"实体。
   - 反定义内核**不松**：不引入 sprint planning / burn-down / 资源池 / 跨人安排；不替代 Linear / Jira 给团队做项目管理。
6. **不是 generic agent framework / SDK**——面向最终用户的产品，不是给开发者造 agent 用的库
7. **不是 plain MCP service**——MCP 是接入方式，不是产品形态本身
8. **本机单用户优先；不做共享 daemon / 跨机 auth / PM SaaS 化**（内核保留）。
   - **v4 子句 #8a**：但 v4 引入受控的 multi-Cairn 协作 v0（§6.5.3 Mode C）：**shared dir + JSONL outbox 的 read-only sharing**——每个 Cairn 节点把自己 published 的 candidates 写到 `${CAIRN_SHARED_DIR}/published-candidates.jsonl`（单一共享 append-only 文件，所有节点 fold-by-(node_id,candidate_id) 读侧聚合），其他节点 read-only 看到。共享内容仅含 `description / candidate_kind / status / kind_chip`（snapshot only），**不**含 prompt 内容、**不**含 worker diff、**不**含 secret。
   - **v4 子句 #8b**：Mode C v0 明确**不做**：cross-machine auth、conflict resolution、shared daemon、real-time sync、跨 Cairn 节点跑 worker run、跨节点写入对方 SQLite。每个节点仍然只对自己的 `~/.cairn/cairn.db` 有写权；其他节点的 candidates 是 read-only 视图。
   - **v4 子句 #8c**：v0 形态明确是 *试验*：v2 才考虑全功能 multi-user（届时再评估 auth / sync / conflict）。Mode C 不引入"团队协作 SaaS 化"的任何要素。
   - 反定义内核**不松**：不做共享 daemon、不做 cross-machine auth、不做 PM SaaS 化、不做 cloud sync 默认开。
9. **不是 v1 那种"用户的 agent 化身"**——floating marker 是 ambient 状态显示（schema → sprite 动画契约 §8.5），不接受开发对话、不替 agent 写代码

### 1.3.cockpit Mentor 精确边界（v4 cockpit patch · 2026-05-12）

> 这段补丁澄清 v4 §1.3 #4b 的"Mentor 是 advisor"的精确内涵——以免被读成"Cairn 内置 LLM 一律不许做任何事"。memory `cairn-mentor-scope-clarified` 是源真值。

**Mentor 的内核身份分三层**：

| 层 | Cairn 内置 LLM 能做 | Cairn 内置 LLM 不能做 |
|---|---|---|
| 战略决策（"下一个 feature 是啥 / 架构怎么选 / PR 是否合") | ❌ 必须走外部 leader coding agent（CC / Cursor / Codex / Aider） | ❌ 内置 LLM 不发表战略意见 |
| 监督 + 引导（"agent 跑偏了，给它一句话 nudge 拉回 goal"） | ✅ 这是 cockpit Mentor 的核心机制（"用户走开时 Mentor 替你过滤"） | ❌ 但不能擅自改代码 / 不能擅自合 PR / 不能 force push |
| 辅助提效（排序 / 摘要 / 翻译 / 归类） | ✅ Cairn 内置 LLM OK（详 §6.2.helpers 的 4 个 helper） | ❌ 决策性 LLM 输出仍要走外部 leader |

**关键校准**：用户曾说"PoC-3 我觉得是有意义的，调用 llm 也是为了辅助更好的做排序或者一些能提效的事情。不要做一个单纯的管理系统"。这意味着：
- **废止** = LLM 来做*全自动派单决策 + 全自动战略决策*（v2 PoC-3 真正废止的部分）
- **复活 / 一直可用** = LLM 做*监督 + 引导 + 辅助提效*（cockpit Mentor + 4 个 helper）

cockpit redesign 把这个边界 first-class 化：Mentor 在用户授权下**主动给 agent 发引导消息**，但 escalate 给用户的时机由 §5 policy 明文定义（见 `docs/superpowers/plans/2026-05-12-panel-cockpit-redesign.md` §5 escalation policy），不是 LLM 自由发挥。

### 1.3.cockpit 驾驶舱架构（v4 cockpit patch · 2026-05-12）

> Cairn 不是动力源；agent 才是。

| 角色 | 是什么 | 干啥 |
|---|---|---|
| **agent**（Claude Code / Cursor / Codex / Aider 等） | **真正的动力源** | 写代码 · 跑测试 · 开 PR · 一切实际工作 |
| **Cairn Mentor**（Cairn 里的 logical role，不是独立进程） | supervisor + 引导员 | 给 agent 发引导消息 · 监控 agent 输出 · 按 §5 policy escalate 给用户 |
| **Cairn panel (cockpit)** | 仪表盘 + 方向盘 + 急刹车 | 让用户看见 agent 在做啥 · 让用户不切 session 给 agent 发话 · 让用户回退 |
| **用户** | 老板 / 司机 | 设 goal · 走开 · 回来 glance · Mentor 搞不定才被叫回来 |

这保留 §1.3 #1 / #2 / #4 / #6 的硬底线（Cairn 不写代码 / 不是 IDE / 不替用户拍板 / 不是 generic agent framework）。

**v3 → v4 反定义松绑总览**（精确到子句，便于审查）：

| 条款 | v3 状态 | v4 处置 | 新增子句 |
|---|---|---|---|
| #1 不是 coding agent | 硬底线 | **不变** | — |
| #2 不是 Cursor clone / IDE | 硬底线 | **不变** | — |
| #3 不是 Claude Code skin | 硬底线 | **不变** | — |
| #4 不是 lead-subagent orchestrator | 硬底线 | **精确松绑** | #4a 授权 chain（停 REVIEWED）/ #4b Mentor 推荐不替拍板 |
| #5 不是 Jira / Linear / Asana | 硬底线 | **精确松绑** | #5a mentor AI workforce 非 Linear / #5b work items 非 issues |
| #6 不是 generic agent framework | 硬底线 | **不变** | — |
| #7 不是 plain MCP service | 硬底线 | **不变** | — |
| #8 不做跨机 / 共享 daemon | 硬底线 | **精确松绑** | #8a multi-Cairn v0 read-only / #8b 明确不做 list / #8c 试验形态 |
| #9 不是 v1 桌面宠物 agent 化身 | 硬底线 | **不变** | — |

**Cairn 是**：

1. **project control surface**——按本机 project 组织 agent 工作现场（主定位词，用户感知形态）
2. **AI engineering operations layer**（v4 新增 framing）——程序员的 AI 工人组合管理面，读项目信号 → 推荐 → 按授权连续推进 → 收回结果让人审
3. **project-scoped agent work side panel**——桌面侧边窗、tray icon、ambient floating marker
4. **coordination kernel window**——通过 read-only Live Run Log 把 kernel 的 8 类状态对象暴露给程序员
5. **run log / recovery surface**——可复盘、可接力、可回退
6. **mentor for your AI workforce**（v4 Mode A）——读项目信号给出排好序的 work items + WHY + 干系人
7. **continuous iteration coordinator**（v4 Mode B）——按用户授权自动 chain scout → worker → review，停在 REVIEWED 等用户 Accept
8. **multi-Cairn shared-context node**（v4 Mode C v0）——通过 shared dir + JSONL outbox 在多个 Cairn 节点间 read-only 共享 published candidates
9. **AI PMO layer**（辅助 framing，介绍场景用，不作为主定位词）——*layer*，不是 *tool* / *suite* / *clone*。详 §15.4 与 Linear / Jira 的硬区分。

---

## 2. 产品论题

### 2.1 核心命题：长程 AI 编程项目里，程序员会失去项目掌控感

AI 编程正在从"人写代码"变成"人 + 多个 agents / subagents 共同推进"。Codex / Claude Code / Cursor / Kiro 解决的是**单条任务**的执行能力——一个 agent 写代码到底有多强。

但程序员真实使用 multi-agent 工作流时，痛点不在执行能力。痛点是：

| 程序员感受到的问题 | 对应 host-level state object |
|---|---|
| 不知道哪个 agent / subagent 正在做什么 | `processes` |
| 不知道 subagent 的输出有没有传回主 agent，还是被上下文 compact 吃掉了 | `scratchpad` |
| 不知道任务链走到哪一步、剩下什么没做 | `tasks`（含 parent_task_id 树） |
| 不知道谁 blocked 在等什么问题 | `blockers` |
| 不知道任务是否完成、按什么标准算完成、是谁说算完成 | `outcomes` |
| 不知道失败后从哪里恢复 | `checkpoints` + `resume_packet` |
| 不知道两个 agent 改没改同一个文件 | `conflicts` |
| 不知道一个长程任务跨 5 天 3 sessions 是怎么走过来的 | `tasks` + `blockers` + `scratchpad` + `outcomes` 聚合 |
| 不知道用户自己上次说"用什么 agent 干什么"被怎么处理了 | `dispatch_requests` |

**Cairn 解决的是项目掌控感，不是代码执行能力。** 执行交给 Codex / Claude Code / Cursor / Kiro。Cairn 只做：让你看见、让你接得上、让你能回退。

### 2.2 三个支撑信念

**1. Cairn 不抢方向盘，agent 才是 doer。**

Cairn 一旦自己执行开发任务，就从 OS 退化成又一个 app，且大概率不如专门 agent。这条边界硬约束，§1.3 反定义 #1 / #2 / #4 守。Cairn 的价值是"让其他 agent 做得更好"，不是"做得比它们更好"。

**v4 升级**：**但 Cairn 可以在用户显式授权范围内连续推进**——Mode B · Continuous Iteration 允许 scout → worker → review 自动接龙。这**不**违背"不抢方向盘"——方向盘的定义是 **终态决策（accept / reject / push / merge / 跨 candidate 接龙）**，这些永远是人。链式自动只是把"用户在每个中间步骤都得点一次"的执行摩擦消掉，并不是把决策权交给 Cairn。boundary verify 触发越界 → 自动停在 REVIEWED，让人接管。

**2. 可见性先于可解决性。**

"用户不知道发生了什么" 比 "用户不能从 panel 改" 更危险。Product MVP 第一目标是让项目状态**可见**——agent 干了什么、走到哪、卡在哪、谁说算完成、出错从哪回——而不是从 panel 直接 mutate 状态。后者是 Later，前者必须先做透。这条信念 veto 任何"MVP 加 desktop write actions"类需求。

**v4 升级：从 "可见" 升级为 "可见 + 可推荐 + 可执行（按用户授权）"**。Product layer（panel / tray / Live Run Log）仍然 read-only（D9 不变）；新增能力进 Operations layer——Mentor 给推荐（不动 state）、Continuous 在显式授权范围内 chain 起 scout / worker / review runs（写 JSONL outbox 和启 agent process，仍不替用户做 accept / reject / push / merge）。三段升级语义：**可见**（render kernel state）→ **可推荐**（read signals → suggest）→ **可执行**（authorized chain run）→ 终态仍是 *可决策*，决策权在人。

**3. 可逆性是底层保证。**

checkpoint + rewind 让长程任务的失败不致命。没有可靠回退，长程托付就是空话。kernel 已交付 L0-L2 paths（文件全量 / paths 子集 / scratchpad），L3-L6（对话 / 工具 trace / agent 内部态 / subagent 树）需要 host LLM 配合，留 Later。

### 2.3 与 v2 论题的衔接（不是替换）

v2 论题 "multi-agent collaboration kernel" **完整保留**为 kernel layer 论题。v3 在其上加 product layer 论题"程序员失去项目掌控感"。两者一致：

- v2 关心：N 个 agent 之间的协作，host 层提供基础设施
- v3 关心：**程序员**在 N 个 agent 推进项目时不失控
- 同一份 8 host-level state objects——对 agent 是协作底座，对程序员是项目现场视图。

v3 不是 v2 的废止。两层论题平行存在；§13 详记演进。

---

## 3. 目标用户

### 3.1 主用户：**程序员 + 非开发者**（同等重要）

> **v4 patch（2026-05-12 cockpit redesign）**：v3 时主用户单独是"程序员"。grilling 出 cockpit 隐喻时，用户把"非开发者用户"扩为同等重要的主用户群（"针对不太会开发的用户提供完整的开发过程指导"）。两类主用户由同一个 panel surface 服务，但 onboarding / 文案 / 默认开关姿态需要 plain language。

**主用户 A：程序员（v3 原始画像）**

- 在一个本机 project 里同时使用 Codex / Claude Code / Cursor / Kiro / subagents 推进长程任务
- **不一定**同时开 10 个 agent——只要他已经把大量项目推进交给 agent，Cairn 就有价值
- 已经感受过：「我让两个 agent / subagent 干了一晚上，第二天打开不知道走到哪了」「subagent 跑完了，主 agent 上下文 compact 了，结果丢了」「一个 task 卡了 3 天我都不知道为什么」
- 看得懂 git、checkpoint、state machine 的概念

**主用户 B：非开发者用户（v4 新增）**

- 用 Claude Code / Cursor 等 AI agent 推进编程项目，但自己**不写代码 / 不熟 git**
- 需要 step-by-step 的开发过程引导，看不懂 `WAITING_REVIEW / PENDING_REVIEW / dispatch_request` 这类 kernel 术语
- 价值主张：panel 让他能 "看到 agent 在干啥 + agent 跑偏了能拉回来"，而无需理解底层 state machine
- 验收：cockpit 默认拷贝必须是白话；kernel 术语只出现在 expert / debug 视图

### 3.2 次要用户

- **subagent 重度用户**：Claude Code Task tool 一次派 ≥ 3 subagent；关注消息可达 / 上下文压缩
- **多 agent 并行用户**：CC + Cursor / CC + Cline 同时开，关注冲突可见 / 跨 agent rewind

两类用户在 v2 已锁定，v3 / v4 继续覆盖。

### 3.3 明确排除的用户

- **单 agent 用户**：只用一个工具，问题尚未出现，Cairn 加不了价值
- **企业合规团队**：MVP 不做 SSO / RBAC / SBOM / 审计合规
- **小团队 / 跨机协作**：v3 不做。Cairn 是单机优先；多人 / 跨机是单独的产品方向，不在 Product MVP 范围。

> ~~**非技术终端用户**：MVP 假设用户能读 git / 配置 MCP / 理解 state machine~~ — **v4 patch 移除**：非开发者用户从"排除"上升为"主用户 B"。但 enterprise / 小团队 / 单 agent 用户仍排除。
> 小团队是潜在扩展，但**不是**当前主交付目标。任何把 "v3 兼顾团队" 的设计提前引入 MVP 的需求，由 §1.3 反定义 #8 直接 veto。

---

## 4. 核心用户故事

§4 描述用户在 Product MVP 桌面侧边窗形态下的使用场景。每条 US-P 对应 panel 的一个主视图。验收标准见 §4.6。

> v2 的 US-D / US-R / US-A / US-I / US-S 描述的是 kernel 视角的能力契约，仍是 ground truth，不冲突；v3 主体改写为 panel 视角的 P 系列。

### 4.1 US-P1：Project Glance（午饭回来 / 早上打开"现在到哪了"）

**场景**：上午 Cairn 装上之后，程序员在 CC session α 开了 task A（refactor auth），在 Cursor session β 派了 1 个 subagent 跑 task B（前端改 useAuth）。中午回来 1 小时，他不想再读三段 chat history。

他点桌面 tray icon → side panel 展开。**Project summary card**：

- **2 active sessions**：CC `cairn-6eb0e3c9...` (RUNNING) · Cursor `cairn-3f12be7a...` (IDLE 12m)
- **3 tasks**：T-001 RUNNING（auth refactor，进行 24m）/ T-002 BLOCKED（useAuth — 等用户答 deprecation flag 问题）/ T-003 DONE
- **1 outcome FAIL**：T-004 上次 evaluate 挂在 `tests_pass(packages/daemon)`
- **last checkpoint**：4m ago，agent CC，label `before-token-status-rename`

他点 T-002 → 看到 blocker question + 历史 context。点 outcomes view 看 T-004 失败原因。

**Cairn 的角色**：把 8 类 state objects 聚合成 30 秒可读的项目现状。**Cairn 不替他答 blocker、不替他重跑 evaluate**——这些动作仍在 agent 那一侧（MVP read-only；Later 可能加 panel 直接答，§6.3）。

---

### 4.2 US-P2：Project History（长程任务跨天跨 session 怎么走完的）

**场景**：T-007 拖了 5 天，跨 3 个 session（中间一晚 BLOCKED 等用户回答），最后 outcome PASS。今天写 demo 文档需要回顾过程。

side panel → 选 task T-007 → 时间线：

```
2026-05-04 14:02  CREATED         CC session α
2026-05-04 17:30  BLOCKED         question: "v3 fallback OK?"
2026-05-05 09:14  ANSWERED        "yes, fallback v2 if v3 incompat"
2026-05-05 09:15  READY_TO_RESUME session β picked up
2026-05-05 11:40  WAITING_REVIEW  criteria=[tests_pass, file_exists]
2026-05-05 11:42  outcome FAIL    tests_pass failed → back to RUNNING
2026-05-05 12:15  retry           outcome PASS → DONE
```

不用 read-through chat history。不用 git log 反推。就在 panel 的 task drawer 里。

**关键**：这个时间线不是 Cairn "记下" 的，是 agent 通过 MCP 工具调用自然产生的——`cairn.task.create` / `cairn.task.block` / `cairn.task.answer` / `cairn.task.submit_for_review` / `cairn.outcomes.evaluate` 每条调用都是一个事件。Cairn 只是聚合渲染。

**Cairn 的角色**：从 host-level state objects 聚合 task 完整轨迹，让长程过程可复盘。

---

### 4.3 US-P3：Recovery（agent 跑偏了，从哪 rewind）

**场景**：晚上回来发现 CC subagent 把 `shared/types.ts` 改坏了，CI 红。要回到稳定点。

side panel → checkpoints view → 看到时间线，每条都标了 **agent_id + label + paths affected + git_head**。点 `before-token-status-rename`（4h ago） → 点 "preview" → 看到 will-change file 列表 + will-not-change 列表 → 用户在 panel 看清边界，然后**到他的 agent 里说"rewind 到 ckpt-..."**——agent 调 `cairn.rewind.to`。

**MVP 边界**：rewind 这个 mutation **从 panel 触发**仍在 Later。Product MVP 的 panel 只看 + 触发 preview + 给出 ckpt-id。实际 mutation 走 agent / CLI 路径。这条边界明确：避免 panel trust boundary 在 MVP 阶段提前破。

**Cairn 的角色**：把 checkpoint timeline + paths preview 这一对核心 recovery primitives 暴露在 panel 上，让用户能"看清边界再回退"。

---

### 4.4 US-P4：Subagent Result（主 agent 上下文 compact 了，subagent 报告还在）

**场景**：主 CC 派 3 个 subagents 并行（webhook handler / schema / tests）。主 CC 上下文 compact 之后只剩 summary 行，不知道 subagent A 是不是用了 v2 fallback。

side panel → scratchpad view → key `subagent/agent-A/result` → 全文。复制粘贴回 CC，让主 agent 重新读全文（或者主 agent 主动 `cairn.scratchpad.read`）。

**关键设计约束**：

- 共享 scratchpad 是 Cairn 提供的 IPC 总线，不是每个 agent 自己的私有存储
- "subagent 往 scratchpad 写结果"是 agent 的主动行为（路径 a，详 §9.2），不是 Cairn 自动探测；用户的 prompt template 引导 subagent 调 `cairn.scratchpad.write`
- 反汇总（compare 主 agent 的复述 vs subagent 原文）是 Later，需要主 agent 也写 `echo/{agent_id}/restatement`，§5.4 详

**Cairn 的角色**：subagent result 持久化（agent 写）+ panel 全文展示（用户读）。

---

### 4.5 US-P5：Conflict（两个 agent 改同一个文件）

**场景**：CC 在改 backend，Cursor 在改 frontend。MCP-call 边界 + commit-after pre-commit hook 双层检测到 `shared/types.ts` 路径重叠。

side panel → conflicts view → 1 行 OPEN：`shared/types.ts` · CC (t1, "TokenStatus 改 string union") vs Cursor (t2, "REFRESH_REQUIRED 全大写")。tray icon 变色提示。

用户读 panel 上的双方意图摘要，决定：「CC 是对的，告诉 Cursor 别改 shared」。他的实际仲裁动作（写决定到 scratchpad / `cairn.conflict.resolve`）仍在 agent / CLI 那一侧（MVP read-only）。

**关键设计约束**（v0.1 检测时间粒度边界继承自 v2）：

- v0.1 走 MCP-call 级 + commit-after 双层检测，**不**是 fs syscall 实时拦截
- agent 必须主动调用 Cairn 工具（`cairn.checkpoint.create` / `cairn.scratchpad.write`），Cairn 才能感知写入意图
- 纯磁盘层操作而不调 Cairn 工具的 agent，Cairn 看不见——这是承认的边界，详 §5.1.1
- 冲突通知不夺焦、不阻塞，以 tray badge + side panel 行的形式出现

**Cairn 的角色**：检测 + 诊断 + panel 可见。仲裁建议执行 Later。

---

## 4.6 用户故事验收标准（Acceptance Criteria）

每条 US 在 Product MVP ship 前必须满足的可验证条件。

### AC for US-P1（Project Glance）

- side panel 启动到 summary card 渲染完 ≤ 1.5s（cold start ≤ 3s）
- summary card 包含：active sessions / running tasks / blockers OPEN / outcomes WAITING_REVIEW + FAIL / last checkpoint
- 数据基于 `~/.cairn/cairn.db` 实时读取，无需用户手动刷新
- 多 project 时 panel 显示当前 cwd 对应 project；切换走 project selector

### AC for US-P2（Project History）

- 任一 task 的完整时间线（state transitions + blocker / outcome / checkpoint 关联事件）可在 panel 内回放
- 时间戳精确到秒；事件类型明确分类
- 不需要离开 panel 跳到 git log / chat history 就能回答"这个 task 怎么走过来的"

### AC for US-P3（Recovery）

- checkpoints view 列出所有 READY checkpoint，按时间倒序
- 每行至少含：label / agent_id / created_at / paths_affected / git_head
- preview 点击立刻给出 will-change / will-not-change 文件列表
- panel 上**只读 + 触发 preview**，rewind mutation 不在 panel 内执行（MVP 硬边界）

### AC for US-P4（Subagent Result）

- scratchpad view 列出所有 key，按 namespace（`session/`, `subagent/`, `echo/`, `conflict/`, `dispatch/`）分组
- 点 key 看全文，不截断、不压缩
- 大于 128KB 的 blob-spilled 内容也能正确读出（kernel 已实现）

### AC for US-P5（Conflict）

- conflicts view 列出 OPEN / PENDING_REVIEW 行，含双方 agent_id + 时间戳 + paths + 写入意图摘要
- tray icon 在 OPEN > 0 时变色（schema-driven 动画契约 §8.5 conflict→review 规则）
- 不需要进 panel 也能从 tray badge 看到 OPEN 计数
- v0.1 检测边界明示：纯磁盘层不调 Cairn 工具的 agent 不可见，**不**视为 AC 失败

---

## 4.X kernel 视角故事保留（v2 ground truth）

> 以下五条 US（v2 编号）描述 Cairn kernel layer 对 agent 的能力契约。它们 v3 不被废止——只是不再作为 user-facing 主体故事。Product MVP 的 panel 是同一份 kernel 能力的程序员视角呈现。完整 v2 文本可在 `git log -- PRODUCT.md` 中追溯。

- **US-D（Dispatch / 派单）**：用户 NL → Cairn 解析 → 选 agent → 翻译成 prompt → 用户确认 → 转发给 agent。`cairn.dispatch.request` + `cairn.dispatch.confirm` ✅。
- **US-R（Rewind / 回滚）**：`cairn.rewind.preview` → `cairn.rewind.to(paths=[...])`，覆盖 L0-L2 ✅；L3-L6 留 Later。
- **US-A（Arbitrate / 仲裁）**：MCP-call + commit-after 双层冲突检测 ✅；自动仲裁推荐留 Later。
- **US-I（Inspect / 查询）**：`cairn.inspector.query` 15 个确定性 SQL 模板 ✅；NL panel UI 留 Later。
- **US-S（Subagent 协作）**：`cairn.scratchpad.write/read` IPC 总线 ✅；反汇总（layer 3）留 Later。

---

## 5. 五能力详解

§4 用故事描述用户在 panel 上经历什么。§5 用结构描述 Cairn 在系统层面做了什么，以及每个能力对应到 panel 的哪个视图。

### 5.0 能力 → state object → panel 视图映射

| 能力 | 数据源 | side panel 视图 | kernel 状态 | MVP 状态 |
|---|---|---|---|---|
| 冲突可见 | `conflicts` | conflicts list / tray badge | ✅ | ⏳ |
| 状态可逆 | `checkpoints` + `scratchpad` | checkpoints timeline / paths preview | ✅ | ⏳ |
| 需求可派 | `dispatch_requests` | dispatch history / pending review | ✅ | ⏳ |
| 消息可达 | `scratchpad` | scratchpad browser / subagent results | ✅ | ⏳ |
| **任务掌控感** | `tasks` + `blockers` + `outcomes` + `processes` | **Live Run Log + project summary + task chains + blockers + outcomes** | ✅ | ⏳（v3 重点） |

第五条"任务掌控感"是 v3 reframe 的产品核心——kernel W5 已经交付了底层数据结构，Product MVP 把它做成用户能看见的视图。前 4 条 v2 已写透，下面保留原文；§5.5 是新增能力。

### 5.1 冲突可见

**为什么这一节存在**：多 agent 协作的首要问题不是"怎么解决冲突"，而是"冲突发生了没人知道"。可见性先于可解决性。

冲突的三种来源：

| 冲突类型 | 触发条件 | Cairn 的检测方式 |
|---|---|---|
| 文件冲突 | 两个 agent 同时写同一文件 | MCP-call 边界感知（v0.1 用 `cairn.checkpoint.create` / `cairn.scratchpad.write` 元数据 + 时间戳对比，详见 §5.1.1） |
| 状态冲突 | 一个 agent 回滚了另一个 agent 的改动 | checkpoint 所有者追踪；rewind 时检查"哪些 checkpoint 会被影响" |
| 意图越界 | agent 操作超出用户给它划定的范围（红线） | 红线（user intent boundary）需要用户显式配置；v0.1 基础版：只检测文件范围越界 |

报告形式：系统通知（非阻断） + Inspector 可查历史。用户可以选择"忽略"或"处理"，Cairn 不强制拦截（拦截有假阳性风险）。

当前范围：文件冲突检测（基础版）+ rewind 时的状态冲突告警。意图越界的完整红线系统推迟到 Later。

#### §5.1.1 Arbitrate 的时间粒度（v0.1 边界）

一个常见的疑问：Cairn 检测冲突的延迟是多少？是文件写入前实时拦截，还是 commit 之后才分析？如果是后者，和自己看 `git diff` 有什么本质区别？

Cairn v0.1 明确区分四档时间粒度，各档的实现状态如下：

| 档位 | 机制 | v0.1 状态 |
|---|---|---|
| **fs syscall 实时拦截** | daemon hook 进文件系统调用，agent 写盘前介入（需要 fs hook / FUSE / fanotify） | **不做**。跨平台复杂度极高，且与企业 EDR 工具有冲突风险。Later 探索。 |
| **MCP-call 级** | agent 调用 `cairn.checkpoint.create` 或 `cairn.scratchpad.write` 时，daemon 顺路记录"agent X 即将动 paths Y"，与其他 agent 的 in-flight 元数据对比 | **v0.1 走这条**。8 个工具的元数据是天然钩子。 |
| **commit-after 级** | git pre-commit hook 介入，commit 时检测同 paths 是否被其他 agent checkpoint 过 | **v0.1 也走这条**。与 MCP-call 级互补，提供双层保障。 |
| **CI 级** | CI 跑挂才发现冲突 | **v0.1 不依赖**。这是 status quo（没有 Cairn 也是这样），不是新增能力。 |

**v0.1 = MCP-call 级 + commit-after 级双层检测。**

这个选择有一个重要含义：**agent 必须主动调用 Cairn 工具，Cairn 才能感知它的写入意图**。如果一个 agent 只在磁盘上静默操作而不调任何 Cairn 工具，Cairn 对它是盲的。因此 v0.1 对"冲突可见"的承诺准确表述是：在所有参与方都接入 Cairn MCP 工具的前提下，冲突在 MCP-call 边界上可见，而不是在 fs 层实时可见。

这意味着 Cursor、Cline 等工具，如果不是通过 `.mcp.json` 接入 Cairn，Cairn 无法感知它们的写入。这类非 MCP-aware 工具的接入路径是 §16 开放问题 1，Later 评估 wrapper / sidecar 方案。

承认：v0.1 的冲突检测有延迟（不是 syscall 级），实时文件锁级别的感知不在 v0.1 范围。选择这个起点的理由是：MCP-call 粒度已经比"只在 CI 才发现"提前了一个数量级，且实现成本和跨平台稳定性都可控。

### 5.2 状态可逆

**为什么这一节存在**：checkpoint 不是一个单一的东西，它有七层粒度，每一层的实现难度、还原保证、用户感知都不同。必须把这个矩阵列清楚，避免"用户以为全回滚了，实际上只回滚了文件"的信任崩塌。

checkpoint 粒度矩阵：

| 层级 | 覆盖内容 | 当前状态 | Later 计划 |
|---|---|---|---|
| L0 文件全量 | 工作目录所有文件 + git HEAD | 已实现（`cairn.checkpoint.create` + `cairn.rewind.to`） | — |
| L1 paths 子集 | 指定目录 / 文件扩展名 | 已实现（`rewind.to` 的 paths 参数） | — |
| L2 scratchpad | 所有 scratchpad key-value | 已实现（`cairn.scratchpad.*` CRUD） | — |
| L3 对话 truncate | agent 会话历史的截断点 | 不做（UI 提示边界） | Later（需 host LLM 配合） |
| L4 工具调用 trace | agent 工具调用的完整序列 | 不做 | Later |
| L5 agent 内部态 | agent 的计划、记忆、中间推理 | 不做 | Later |
| L6 subagent 树 | 主 agent + 所有 subagent 的完整状态树 | 不做 | Later |

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

当前范围：基础的意图解析 + scratchpad 历史检索 + 人工确认后转发（5 fallback rules R1/R2/R3/R4/R6）。自动 agent 选型和复杂 prompt 生成是 Later。

### 5.4 消息可达

**为什么这一节存在**：subagent 的消息丢失是多 agent 协作里最隐蔽的失败模式。它不像文件冲突那样有明显的症状，它的症状是"主 agent 悄悄地基于错误假设继续工作"，等用户发现时已经很难定位根源。

消息可达的四个保证层：

1. **持久化**：subagent 的结果写入 Cairn 的 scratchpad，不依赖 agent 的上下文窗口。
2. **可查询**：主 agent 随时可以用 `cairn.scratchpad.read` 拿到原始结果，即使它的上下文已经被压缩。
3. **反汇总**：对比 subagent 写入的原文与主 agent 的复述，标注关键差异。
4. **不一致检测**：主 agent 的后续行动如果和 subagent 的实际结果产生明显矛盾，Cairn 发出提醒。

当前覆盖层 1 和层 2，层 3 和层 4 是 Later。

**层 3（反汇总）的可行性边界（必读）**：

Cairn **拿不到**主 agent 的 context window 内部状态——那是 host LLM 的私有数据，对 Cairn 不透明。因此"对比原文与摘要"的两端必须都显式存在于 scratchpad，Cairn 才能 diff。

- **可行版**：subagent 写入原文到 `subagent/{agent_id}/result`，主 agent 也被 prompt 引导，在读完原文后把自己的"复述 + 后续计划"写入 `echo/{agent_id}/restatement`。Cairn 对比这两个 key 的内容，标注差异（"原文提到 v2 fallback，复述中未出现"）。
- **不可行版**：Cairn 自己 introspect 主 agent 内部的 token-level summary，或在主 agent 不主动写复述的情况下推断它"读懂了什么"。这需要 host LLM 配合开放 introspection API，v0.1 不具备这个前提。

因此，反汇总（层 3）的 Later 实施前提是：**主 agent 也被 prompt 约定写 `echo/{agent_id}/restatement`**，否则 Cairn 没有 diff 的两端，无从标注。这个前提同样属于路径 (a)（MCP-native，agent 主动调用），不是 Cairn 的 magic 能力。

层 4（不一致检测）同理：Cairn 检测的"不一致"只能是结构化可对比的行为（例如主 agent 写了"按 v3 实现"的 checkpoint，而 subagent result 里明写了"已 fallback 至 v2"），而不是对主 agent 内部推理过程的语义分析。

### 5.5 任务掌控感（v3 新增）

**为什么这一节存在**：前 4 条能力是 v2 视角下"agent 之间的协作基础设施"。v3 reframe 的产品核心问题是"程序员在 multi-agent 项目里失去掌控感"——这需要把 W5 引入的 Task Capsule + Blockers + Outcomes 三表组合作为一种**新的能力**显式写出来，而不是埋在前 4 条的脚注里。

任务掌控感的四个保证层：

1. **可见**：每个 durable work item 有 `task_id`、`state`（PENDING / RUNNING / BLOCKED / READY_TO_RESUME / WAITING_REVIEW / DONE / FAILED / CANCELLED）、parent_task_id 树结构，panel 上可列、可筛、可点开。
2. **可接力**：BLOCKED → user answer → READY_TO_RESUME → 新 session 调 `cairn.task.resume_packet` 拿全部历史 → 接着干。跨 session、跨 process、跨 agent 都能续。
3. **可验收**：DSL 7 deterministic primitives（`tests_pass` / `command_exits_0` / `file_exists` / `regex_matches` / `scratchpad_key_exists` / `no_open_conflicts` / `checkpoint_created_after`）AND 聚合，PASS → DONE，FAIL → 回 RUNNING 重试，TERMINAL_FAIL → FAILED 结束。
4. **可复盘**：所有 state transition 都是 host-level event，panel 通过 Live Run Log 回放完整 task 轨迹（详 US-P2）。

**panel 视图**：

- **task chains view**：按 parent_task_id 树渲染，每行显示 state + 当前 attempt + 最近事件
- **blockers view**：OPEN / ANSWERED / SUPERSEDED 分组，drill-down 看 question + answer 历史
- **outcomes view**：按 task_id 看 criteria + 上次 evaluation status + FAIL 详情
- **resume packet drawer**：read-only 渲染 `cairn.task.resume_packet` 聚合视图

**实现状态**：v0.1 全部已就位（W5 Phase 1+2+3 闭环，dogfood 32/32 PASS）。Product MVP 的工作是把它们渲染到 panel。

**v3 边界**：

- "可见 / 可接力 / 可验收 / 可复盘" 的 mutation 入口仍是 MCP / CLI / agent，不是 panel
- 自动推荐"下一步该做什么"是 Later，不在 MVP；MVP 只做 record + show + recover

---

## 6. 功能范围

v3 不再用 v0.1 / v0.2 / v0.3 多版本路线表达 scope。两层组织：

- **§6.1 Kernel layer 工程底座**：W1 + W4 + W5 + Phase 4 全部已交付
- **§6.2 Product MVP 范围**：当前阶段交付目标
- **§6.3 Later**：*eventually* 范畴，不绑时间表 / 不绑版本号

### 6.1 Kernel layer 工程底座（全部已落地）

按"能力 vs 实现 phase"组织。具体 MCP 工具清单见 §17 + ARCHITECTURE.md §5。

| 编号 | 能力 | 对应能力维度 | 实现 phase | 状态 |
|---|---|---|---|---|
| F-1 | scratchpad CRUD（write / read / list / delete，128KB blob spill） | 消息可达 / 任务掌控感 | W1 | ✅ |
| F-2 | checkpoint create / list（两阶段提交 + git-stash backend + CORRUPTED 扫描） | 状态可逆 | W1 | ✅ |
| F-3 | rewind.to（文件 + git，paths 子集；auto:before-rewind 兜底） | 状态可逆 | W1 | ✅ |
| F-4 | rewind.preview（will-change / will-not-change 两清单 dry-run） | 状态可逆 | W1 | ✅ |
| F-5 | task_id 多任务隔离（scratchpad / checkpoint / outcomes 按 task 分片） | 消息可达 / 任务掌控感 | W1+W5 | ✅ |
| F-6 | 冲突检测基础版（MCP-call 边界 + commit-after pre-commit hook 双层） | 冲突可见 | W4 | ✅ |
| F-7 | Inspector NL 查询接口（15 个确定性 SQL 模板，关键词匹配，无 LLM） | 通用 | W4 | ✅ |
| F-8 | 进程总线（register / heartbeat / list / status，自动 SESSION_AGENT_ID） | 任务掌控感 / 冲突可见 | W4 | ✅ |
| F-9 | Dispatch 基础版（NL→历史检索→用户确认→转发，5 fallback rules R1/R2/R3/R4/R6） | 需求可派 | W4 | ✅ |
| F-10 | Task Capsule lifeline（durable multi-agent work item：tasks 表 + 5 task tools） | 任务掌控感 | W5 Phase 1 | ✅ |
| F-11 | Blockers + resume_packet（任务内等待答复 + 跨 session 接力 read-only aggregate） | 任务掌控感 | W5 Phase 2 | ✅ |
| F-12 | Outcomes DSL（7 primitives / AND / RUNNING ↔ WAITING_REVIEW ↔ DONE/RUNNING/FAILED 闭环） | 任务掌控感 | W5 Phase 3 | ✅ |
| F-13 | `cairn install` CLI（`.mcp.json` + git pre-commit hook + start-cairn-pet 脚本，幂等） | 通用 | W4 | ✅ |
| F-14 | desktop-shell pet（Electron 悬浮标，schema 状态 → sprite 动画契约 §8.5） | Product layer 基础形态 | W4 | ✅（基础形态） |

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

### 6.2 Product MVP 范围（当前阶段交付目标）

**目标**：把 kernel 接成一个**可用的本机 project-scoped agent work side panel**。

不再拆 v0.1 / v0.2 / v0.3。一个阶段，一份 DoD。

#### 为什么 MVP 严格 read-only

panel 看到 BLOCKED 用户大概率会问"为什么不能直接答 blocker"。MVP 答案是**可信可见性先做透，写操作等下面三个前置条件清楚后再加**：

1. **Daemon 独立 API**：当前 mcp-server 直接 import `daemon/dist/`，agent 是写者。让 panel 也写需要先把 daemon 拆成独立进程并定义稳定 IPC API（详 §9.7 Later 架构）。
2. **Supervisor identity 模型**：panel 是 user supervisor 触发的写，与 agent 触发的写在 audit trail 里必须可区分（who / why / via）。当前 SESSION_AGENT_ID 只覆盖 agent 侧，supervisor 侧需要新模型。
3. **Dogfood 信号支持**：panel 的哪种 mutation 真的能省事？（一键答 blocker？preview 后直接 rewind？）这要 dogfood ≥ 3 天后才能识别。先猜没意义。

三条都满足后再做 mutation。在此之前，panel 上**只读 + 触发外部跳转**（"复制 ckpt-id"、"点 task 跳到 chat history" 类）。详 §12 D9。

#### MVP MUST（9 项）

从 v3 初版 15 项压到 9 项。compressed-out 的项移到 Later，或合并到现有项的 drill-down。

| 编号 | 能力 | 来源 | 状态 |
|---|---|---|---|
| MVP-1 | **project selector / current project**：基于 cwd 决定读哪个 project 的 view，多 project 时可切（含 Electron shell + daemon SQLite read-only connection bootstrap，前提之一） | 新建 | ⏳ |
| MVP-2 | **tray / status-bar icon**：常驻系统托盘 + state-driven badge（active agents / open conflicts / WAITING_REVIEW count）；复用 floating marker 的 schema → sprite 契约 §8.5 | 复用 desktop-shell | ⏳ |
| MVP-3 | **side panel shell**：宽 ~480px 可贴边窗，从 tray / floating marker 唤起；含 detail drawer（点 row 展开） | 新建 | ⏳ |
| MVP-4 | **project summary card**：active sessions / running tasks / blockers OPEN / outcomes WAITING_REVIEW + FAIL / last checkpoint | 新建 | ⏳ |
| MVP-5 | **agent sessions view**：processes 表渲染（state + last heartbeat + agent_id + capabilities） | 新建 | ⏳ |
| MVP-6 | **task chains view**：tasks 树（parent_task_id），每行显示 state / attempt / 最近事件；drill-down 含 resume_packet 聚合 + checkpoints 关联 | 新建 | ⏳ |
| MVP-7 | **blockers + outcomes view**（合并视图）：blockers OPEN/ANSWERED/SUPERSEDED + outcomes criteria/status/FAIL 详情，按 task 组织 | 新建 | ⏳ |
| MVP-8 | **Live Run Log low-fidelity**：8 类 state objects 事件按时间倒序静态滚动列表（事件 = 一行：timestamp / source / type / agent_id / target / detail）；不要求实时推送 / 不要求高级筛选 / 不要求 grouping。详 `docs/superpowers/plans/2026-05-29-v0.2-live-run-log.md` 的"低保真版" | plan 已 lock | ⏳ |
| MVP-9 | **desktop dogfood**：单程序员长程 dogfood ≥ 3 天，panel 覆盖 ≥ 80% 项目掌控感需求，无需跳到 chat history / git log | 新建 | ⏳ |

**floating marker** 已是基础形态（`packages/desktop-shell/`），不算新交付项；状态契约 §8.5 不变。

**从初版 compressed out 的项**：

- 旧 MVP-1 desktop bootstrap → 折入 MVP-1 project selector
- 旧 MVP-3 floating marker（已 ✅）→ 不算 MVP 新交付，是 supporting fact
- 旧 MVP-5 side panel + 旧 MVP-14 detail drawer → 合并为 MVP-3 side panel shell
- 旧 MVP-7 project summary → MVP-4
- 旧 MVP-8 sessions → MVP-5
- 旧 MVP-9 task chains + 旧 MVP-13 resume packets → 合并为 MVP-6（resume packet 走 task drill-down）
- 旧 MVP-10 blockers + 旧 MVP-11 outcomes → 合并为 MVP-7（一个 view 看完整 task lifecycle）
- 旧 MVP-12 checkpoints view → 折入 MVP-6 drill-down（checkpoints 跟 task 关联，不需独立 view；conflict view + scratchpad view + dispatch view 同样下放到 Later，dogfood 看是否真的需要独立 view）
- 旧 MVP-15 dogfood → MVP-9
- 旧 MVP-6 Live Run Log（high fidelity）→ MVP-8 **low-fidelity** 版（关键松绑：MVP 不要求事件流完整或推送实时，先有静态滚动列表就算）

**MVP 强调**：信息高效、可用、可复盘。**不**追求 dashboard 美感、**不**追求复杂 UI 动画。极简像 Activity Monitor / journalctl，目标信息密度高于美感。

### 6.5 v4 新增 Operations Layer：三个模式（A / B / C）

v4 在 Product MVP 之上加 **Operations layer**——三个用户主动调起的模式，让 Cairn 从"看 agent 工作现场"扩展到"按用户授权推进 agent 工作现场"。三个模式不互相依赖，可独立 ship；都受 §1.3 反定义约束（特别是 #4 / #5 / #8 的子句）。

#### 6.5.1 Mode A · Mentor（v4 新增）

**一句话**：用户输入一句话目标，Cairn 读项目信号，给出排好序的 work items + WHY + 干系人。

**触发**：用户在 side panel 的 Mentor chat sub-section 输入一个目标 / 一句话情境（例如 "准备上线，怎么排优先级"、"今天该先动哪个"、"哪些 task 拖太久了"）。

**输入**（项目信号——Cairn 在 host-level state 上的聚合读）：

- 项目元信息：`PRODUCT.md` / `TODO` / `README` 等静态文档（如有）
- git 信号：`git log` 最近 N commit / 当前 branch / dirty files
- open issues（如果 git remote 配置了 GitHub 且用户授权）
- 已有 candidates（`~/.cairn/project-candidates/*.jsonl`，Three-Stage Loop 的产物）
- 已有 tasks / blockers / outcomes（kernel SQLite 8 类状态对象）
- 已有 worker reports（如有，governance §6.4 引入）

**输出**：ranked work items 列表，每条含：

```
- description（短句，≤ 240 char）
- why（影响 + 成本 + 风险三段，每段 ≤ 1 句）
- stakeholders（owner / reviewer / notify——agent role，如 "worker: claude-code-cli, reviewer: human, notify: codex-session-α"）
- recommended next action（"pick to start Continuous Iteration" / "create blocker question" / "manual run via Codex CLI" 之一）
- evidence_refs（指向 task_id / candidate_id / commit_hash 的引用，让用户能 drill down 核对 Cairn 凭什么这么排）
```

**形态**：**chat panel**（不是静态报告 / 不是 daily push / 不是邮件）。用户问一句，Cairn 答一段。可往返追问（"为什么把 X 排在 Y 前面"、"如果不做 Z 会怎样"），追问也是 LLM call。**Mentor 不持续后台运行**——每次 chat turn 是一次显式触发。

**边界**：

- Mentor **不替用户做决策**——只推荐排序，不自动 dispatch / 不自动起 worker / 不自动答 blocker
- 用户 pick 一个 work item 后由 **Mode B · Continuous Iteration** 接手执行（前提：用户在 Mode B 给了授权）
- Mentor 的 LLM call 走当前已配置的 host LLM（Claude / Codex / Gemini 等），不引入新的 model dependency
- Mentor **不**自动跑（不是每天 9 点弹推荐通知）；推 chat 模式因为推荐质量极度依赖 timing context，"用户主动问" 比 "Cairn 主动推" 准
- 反定义 #4b 约束：Mentor 给的是建议，不是 manager 的指派

**实现指向**：Operations layer 的新模块，读 kernel SQLite read-only + 读 JSONL outboxes + 调 host LLM。**不**新增 host-level state object / **不**新增 MCP tool / **不**新增 daemon process。第一版可以纯 client-side（panel 直接调 LLM API），后续再考虑放进 daemon。

#### 6.5.2 Mode B · Continuous Iteration（v4 新增）

**一句话**：Three-Stage Loop v1（scout → worker → review，三段都手按一次的版本）的延伸——**用户授权后自动 chain**，停在 REVIEWED 等用户 Accept。

**Three-Stage Loop v1 的关系**：
v1 已交付（commit chain `6af5167..15c2108`），三段都是用户每次点一次按钮：scout 生成 candidates → 用户 pick → worker 跑 → 用户看 review → 用户决定 ACCEPTED / REJECTED / ROLLED_BACK。Mode B 就是把"用户每次手按一次" 替换成 "auto-chain，但终止于 REVIEWED"。

**触发**：用户在 Three-Stage Loop UI 切到 "Continuous Iteration" 模式 + 显式授权范围（"auto-run top N candidates" / "limit to candidate_kind=missing_test" / "stop after first ROLLED_BACK"）。授权一旦给出，Cairn 自动接 chain；用户随时可以撤销授权（一键停 chain）。

**安全边界（critical）**：

- **accept / reject / push / merge 永远人按按钮**——Cairn 不会自动把 candidate 从 REVIEWED 推到 ACCEPTED；不会自动 commit / 自动 push / 自动 merge / 自动开 PR
- **boundary verify 触发越界 → 自动停在 REVIEWED 并标 `needs_human=true`**（boundary verify 已在 commit `15c2108` 落地）；violation list 写入 candidate.boundary_violations
- **跨 candidate 接龙的决策权也是人**——Cairn 不能"完成 candidate X 后自己决定下一个跑 candidate Y"；用户授权"auto-run top N"是 N 个 candidates 的批授权，不是"无限授权 Cairn 自己排"

**不做**：

- 不自动 commit / 不自动 push / 不自动 merge
- 不跨 candidate 决策（每条 candidate 的 accept / reject 都要人触发）
- 不在 boundary violation 后自动 retry / 自动 escalate
- 不跨项目（一个 Cairn 节点的一个 project 是 chain 的边界）

**跟 Mode A 关系**：**Mode A 提候选，Mode B 执行候选**。用户在 Mentor chat 里 pick 一个 work item → 该 work item 落成一个 candidate（或链到已有 candidate）→ Mode B 在用户授权下跑这个 candidate。Mode A 是建议层，Mode B 是执行层。

**实现指向**：复用 `packages/desktop-shell/project-candidates.cjs` 的 state machine（PROPOSED → PICKED → WORKING → REVIEWED + ACCEPTED / REJECTED / ROLLED_BACK），新增 "auto-chain" 控制器在 PICKED 自动推到 WORKING，在 worker done 后自动 bindReviewIteration，在 REVIEWED 一定停。复用 `managed-loop-handlers.cjs` 现有 worker spawn + review bind 逻辑。**不**新增 schema / 不新增 MCP tool / 不新增 kernel state object。

#### 6.5.3 Mode C · Multi-Cairn v0（v4 新增）

**一句话**：env `CAIRN_SHARED_DIR` + 持久化 `node_id` + 单一共享 JSONL outbox，多个 Cairn 节点 read-only 共享 published candidates。

**实现**：

- 用户配置环境变量 `CAIRN_SHARED_DIR=/path/to/shared`（Dropbox / iCloud / SMB 共享目录均可）；`CAIRN_NODE_ID` 可选，未设时从 `~/.cairn/node-id.txt` 读取一个随机 12-hex（首次启动生成并持久化，与 hostname 解耦）
- 所有 Cairn 节点 append-only 写**同一个共享文件** `${CAIRN_SHARED_DIR}/published-candidates.jsonl`（不是各写各的子目录）；每行是一个事件，含 `event_version / node_id / published_at / project_id / candidate_id / snapshot`，或带 `tombstone: true` 表示 unpublish
- 读侧 fold：按 `(node_id, candidate_id)` 取 `published_at` 最新的那行（latest-wins）；最新行带 tombstone 标记则该 candidate 从输出中排除
- `listPublishedCandidates` 返回当前 project **其他 node**（排除自己 node_id）且未 tombstoned 的事件，按 `published_at` 倒序
- 其他 Cairn 节点在 panel 的 **Inspector → Team sub-section** read-only 看到这些事件
- multi-Cairn 未启用（`CAIRN_SHARED_DIR` 未设或目录不存在）时所有 API 返回空集 / `multi_cairn_not_enabled`，单机流程不受影响

**共享内容**（明确清单，避免 leak）：

- ✅ snapshot 仅暴露 4 个字段：`description / candidate_kind / status / kind_chip`
- ✅ 事件顶层附带 `node_id / published_at / project_id / candidate_id / source_iteration_id` 用于 attribution
- ❌ **不**共享 prompt 内容（scout / worker / review prompt 都不出 node）
- ❌ **不**共享 worker diff（generated code 不出 node）
- ❌ **不**共享 secret / token / API key / cwd 绝对路径
- ❌ **不**共享 task 详情 / blocker / outcome / scratchpad / checkpoint

**形态**：Inspector 加一个 **Team sub-section**，read-only table 显示其他 node 发布的 candidates（`node_id / description / status / kind_chip`）。点行 drill-down 只显示更详细的 status snapshot，**不**显示 prompt / diff / commit。

**明确不做**：

- **cross-machine auth**：share dir 是文件系统 trust 边界（NFS / Dropbox / Syncthing / git）；Cairn 不引入用户名密码 / SSO / TLS / key exchange
- **conflict resolution**：所有节点 append 同一文件，靠 latest-wins fold 解决并发；不引入锁 / CRDT / merge 协议
- **shared daemon**：每个节点跑自己的 daemon / SQLite / mcp-server，不共享进程
- **real-time sync**：read 端 polling（10s-60s）；不引入 push / WebSocket / mDNS
- **跨 Cairn 跑 worker run**：节点 A 的 candidate 不能在节点 B 上 PICK 起 worker；要做的话用户在 B 节点手动重建 candidate
- **跨节点写入对方 SQLite**：写权严格在 own node；共享文件只 append 本节点 `node_id` 的事件

**v0 / 试验形态**：

- 目的是验证 *最低耦合的多节点 read-only 共享* 这条产品方向是否成立
- 用户验证场景：两个程序员（或一个人两台机器）想互相看见对方在做什么 candidate，不引入团队 SaaS
- **v2 才考虑全功能 multi-user**——届时再评估 auth / sync / conflict / shared write，目前 v0 只解决"看得见"

**实现指向**：在 `packages/desktop-shell/` 加 `multi-cairn.cjs`（reader + writer），借现有 `project-candidates.cjs` 的 JSONL fold 模式。Inspector Team sub-section 是一个新 view。**不**新增 schema / MCP tool / daemon process。

**与 §1.3 #8 子句的对齐**：

- 子句 #8a 准入 → 本节实现
- 子句 #8b 明确不做 → 上面"明确不做"清单
- 子句 #8c 试验形态 → 本节"v0 / 试验形态"段

### 6.3 Later（不是 v0.2 / v0.3，是 *eventually*——dogfood 反馈和真实使用驱动优先级，不绑定时间表）

| 能力 | 推迟原因 |
|---|---|
| desktop write actions（直接从 panel 改状态） | MVP 硬边界 read-only；mutation 仍走 MCP / CLI 路径，避免 panel trust boundary 提前破。**升级前置条件**：daemon 独立 API + supervisor identity 模型 + dogfood 信号支持（详 §6.2 + §12 D9） |
| answer blocker from desktop | 同上 |
| rewind from desktop | 同上 |
| resolve conflict from desktop | 同上 |
| 独立的 conflicts / scratchpad / dispatch / checkpoints view | MVP 把 checkpoints 折入 task drill-down，conflict 只走 tray badge + Live Run Log；dogfood 后看是否需要独立 view |
| Live Run Log 高保真版（实时推送 / 高级筛选 / grouping / replay） | MVP 是低保真静态滚动列表；高保真等 dogfood 信号 |
| small-team sync / 跨机协作 | 单机优先；CRDT / sync 协议是大工程，单独立项 |
| AI PMO recommendations（"下一步建议"） | 容易滑坡到 manager agent；先做可见性，再评估推荐 |
| **Agent Work Governance（详 §6.4）** | 从"看见 agent 工作现场"升级到"让 agent 工作现场可治理"——Project Rules / Worker Report / Pre-PR Gate / Repeated Failure Pattern / Governance Debt。前置条件：当前 Project-Aware Live Panel 的 dogfood 信号；不在 MVP 范围 |
| richer dependency graph（DAG / urgency / priority） | 当前 tasks 只有 parent_task_id 树。DAG 是 schema 增量，等 MVP dogfood 后评估 |
| Grader agent hook（LLM 验收） | DSL v1 全确定性 AND 是有意（LD-15）；schema 已留 `GraderHook` 占位 |
| DSL v2（OR / NOT / nested combinators） | 同上 |
| outcome_evaluations history 子表 | v1 单 outcome 设计是 LD-14 锁定 |
| L3-L5 checkpoint 粒度（对话 truncate / 工具 trace / agent 内部态） | 需要 host LLM 配合开放 introspection；不可单方实施 |
| 反汇总（layer 3）+ 不一致检测（layer 4） | 前提是主 agent 主动写 `echo/{agent_id}/restatement`；详 §5.4 |
| non-MCP-aware agent integration（Cursor / Cline 不接 .mcp.json 的） | wrapper / sidecar 路径，单独 D-1 research |
| 红线系统完整版（意图越界自动拦截） | v0.1 基础版只检测文件范围；完整版需要红线 DSL |
| Inspector NL panel UI（直接在 panel 输自然语言查 kernel） | inspector tool 已有，panel UI 包装是 dogfood 后的优先级问题 |
| 系统通知集成（OPEN conflict 弹系统级通知） | tray badge 是 MVP 最小可见性；通知是上层 |
| 本地小模型 deployment | dogfood 后再评估 |
| 跨机协作 / 多人共享 daemon | 单机优先原则，跨机是单独的产品方向 |

**关键**：以上能力都是 *eventually* 范畴——不绑定时间表，不绑定版本号。dogfood 反馈和市场信号决定优先级。

---

### 6.4 Agent Work Governance（Later，下一层产品方向）

> **状态**：产品方向 note，**不在 MVP 范围**。前置条件 = 当前 Project-Aware Live Panel 跑通真实 dogfood、用户开始反馈"看见还不够，agent 跑得乱"信号。
> **来源**：内部设计 note `Xproduct.md`（参考美团 31 万行代码 AI 重构实践的运营模型）。本节是产品定义层面的提炼；详细实现 sketch / 阶段拆分见 `Xproduct.md`。

#### 6.4.1 一句话定位

Cairn 的下一层产品升级，从 **"看见 agent 工作现场"** 升级到 **"让 agent 工作现场可治理"**——按 project 落实规则、报告、验收门、复盘条目，让长程多 agent 项目的 *standards / progress / drift / handoff / repeated failures* 有一处可见、可关联、可复用的本地落点。

**这不是新产品身份。** 仍然是同一个 project control surface，加一层基于现有 8 类 state objects 的治理视图。

#### 6.4.2 反映的核心断言

> 大规模 AI Coding 失败的主因不是 agent 写得慢，而是 agent 工作**难以治理**：标准是隐式的、报告不一致、任务漂离原意、验收被跳过、handoff 上下文混乱、重复失败没成为可复用规则。

Cairn 不解决"让 agent 写得更好"；它解决"让人和 agent 在同一组项目规则下对齐"。来自内部 note 的关键论断：

- **从"人人对齐"延伸到"人机对齐"**：先有显式的项目标准，再把它们物化成 AI Rules / Skills / SOP / checklists。Cairn 不发明这些标准，只让它们 durable / visible / tied to tasks。
- **AI 让 see-everything 的成本变低；决定 what matters 仍是人**——governance 层不替用户拍板，只让"漂移、未验收、缺证据"被看见。

#### 6.4.3 六个候选能力（Later，逐个 dogfood 决定上不上）

| 能力 | 一句话 | 与现有 state objects 的关系 |
|---|---|---|
| **Project Rules Registry** | 项目级规则的本地存储与展示（编码规范、checkpoint 规则、worker 报告规则、Pre-PR checklist 等） | 新增工件，跨 task 引用；不替代 outcomes |
| **Worker Report Protocol** | 每个 worker session 结束时输出固定 schema 的短报告（GOAL / DONE / NOT_DONE / CHANGED / TESTS / BLOCKERS / RISKS / NEXT / HUMAN_NEEDED），挂到 task chain | 复用 `tasks` + `scratchpad`；可作为 `cairn_events` 的 `agent.reported` 来源 |
| **Pre-PR Gate** | PR / handoff 前的 readiness 自检（READY / NEEDS_TESTS / NEEDS_REVIEW / BLOCKED / FAILED_GATE / DRIFT_RISK），advisory only | 输入端聚合 `tasks` + `outcomes` + `blockers` + `checkpoints` + 最近 worker report + project rules |
| **Rule Adherence Record** | 哪条规则在哪个 task 被检查 / 通过 / 失败 / waived | 第一版可借 `outcomes` 表达；最终归 `cairn_events` |
| **Repeated Failure Pattern Log** | 把"agent 总忘跑测试 / 总不写 checkpoint / 总把未解决 blocker 当 done"这类反复失败做成 pending 候选规则，等用户审批 | 新轻量条目；进规则要走人审 |
| **Governance Debt** | 工程债的项目管理对应物：task 无 outcome / session 无 report / failed outcome 无下一步 / 风险操作前无 checkpoint / 未归属 agent 活动 / done 但没跑 Pre-PR | 派生视图；不是新表 |

#### 6.4.4 第一个可落地 demo（推荐起点）

> **Lightweight Pre-PR Gate**：单 task 范围，纯 read-only。

最小流程：

1. Claude Code / Codex / Cursor 完成一段工作，写一份 worker report（短 markdown 或 scratchpad key 即可，**先不立新表**）。
2. Cairn 把 report 关联到 task chain。
3. 用户在 panel 点 task → 看到 Pre-PR Gate 卡片：tests 是否跑过 / 是否有 OPEN blocker / 是否有 checkpoint / outcome 状态 / changed files 摘要 / 项目规则匹配情况。
4. 卡片输出：`READY` / `NEEDS_TESTS` / `BLOCKED` / `DRIFT_RISK`，附 missing evidence + suggested next。

**这个 demo 严格不做的事**（沿用 §1.3 反定义）：

- 不自动开 PR / 不写 git hook / 不阻断 commit
- 不调用 LLM 做"AI code review"裁决
- 不替用户决定要不要 ship；只把证据摆出来
- 不引入新 schema（Phase A 完全靠现有工件 + 一个 markdown report 文件验证 UX）

成功判据：用户在自己的项目里反馈"我开始用 panel 看 Pre-PR 状态而不是回去翻 chat"——再考虑 Phase B / C（详 `Xproduct.md` §7）。

#### 6.4.5 边界（这一层 governance 仍受 §1.3 反定义约束）

Governance 层落地时**仍然不能**让 Cairn 变成：

- 不是 code reviewer——不单独裁决"代码对不对"，只把证据汇总
- 不是 CI 替代品——不跑测试、不阻断 merge、不上 git hook（advisory only）
- 不是 Jira / Linear / Asana——没有 sprint / story point / 看板 / 资源分配；规则是项目工件，不是任务条目
- 不是 lead-subagent orchestrator——不自动派工 / 不替 agent reasoning
- 不替用户拍板——repeated failure 进规则要走人审；Pre-PR Gate 是 advisory，不强制

任何让 Cairn 跨越以上边界的"governance 升级"提案，与 §1.3 反定义同等优先级 veto。

#### 6.4.6 与现有路线的关系

- **与当前 Product MVP 不冲突**：MVP 仍然是 read-only "看见 agent 工作现场"。governance 层加在它之上，不替换。
- **与 §6.3 其它 Later 项的优先级**：governance 层是"做了 dogfood 之后看用户反馈"决定，不是"先做哪个"。如果 dogfood 信号显示用户最痛的不是 governance 而是 desktop write actions / 跨机协作，governance 让步。
- **与 `cairn_events` memo 的关系**：`cairn_events`（详 `docs/cairn-events-table.md`）是 governance 的工程基底——`agent.reported` / `rule.checked` / `pre_pr.ready` / `failure_pattern.detected` 都自然落进 events 表。但 governance Phase A 不依赖 events 表，可以先用现有工件 + scratchpad 验证。

---

## 7. 产品原则

原则在产品决策冲突时用来裁决，不是贴墙看的。每条都跟着"它会 veto 什么"。

**1. Cairn 不写代码（硬底线）。**
任何让 Cairn 直接执行开发任务的需求，无论包装成什么形态，veto。Cairn 可以让 panel 看到 agent 干了什么，不可以替 agent 干。

**2. 可见性先于可解决性。**
Product MVP 第一目标是让项目状态可见。从 panel 直接 mutate 状态（answer blocker / rewind / dispatch / resolve conflict）是 Later。这条原则 veto "MVP 加 desktop write actions" 类需求。

**3. 可回滚优先于可重来。**
遇到失败，第一选项是"让用户回到之前的状态看清楚"，而不是"让 agent 再试一次"。

**4. 本地优先。**
数据不离开用户机器，除非用户明确选择。veto 默认开启的遥测、云端同步、外部 API 日志存储。

**5. 诚实边界。**
Cairn 的能力边界、checkpoint 的覆盖范围、L3-L6 未实现——都要在 panel UI 里明示。panel 上看不到的 ≠ 不存在。不假装全知。

**6. Cairn 默认隐形。**
Cairn 不该持续占用用户注意力。tray / floating marker 安静在场，需要时再唤起 panel。这条原则 veto "panel 持续占屏" / "默认弹窗" / "默认声音提醒" 类设计。

**7. 模型只在边界事件触发，不持续运行。**
模型调用发生在：Dispatch（NL 解析）、Arbitrate（冲突诊断）、Inspector（NL 查询翻译）。其余时间 Cairn 以确定性方式运行，不持续消耗 token。Live Run Log 不调 LLM；它是确定性的事件流。

**8. 仲裁 / 推荐建议不替用户决定。**
Cairn 给信息，用户拍板。AI PMO recommendations 是 Later，不在 MVP；即使做也是建议，不自动执行。

**9. 不再做版本号路线（v0.2 / v0.3）。**
v3 之后路线只有 "Product MVP（当前）" 和 "Later（不绑时间）"。veto "把功能切到 v0.X 版本" 类讨论；新 feature 评估只问"在 MVP 里 / 不在 MVP 里"。

**10. AI 降低看见一切的成本，人仍然决定什么重要。**
Cairn 的角色是把项目状态、证据、缺失检查、handoff 状态、重复失败、回退点摆出来；不假装是最终权威。这条原则适用于当前 panel，也适用于 Later 的 Agent Work Governance（§6.4）：Pre-PR Gate 是 advisory、Repeated Failure 进规则走人审、Rule Adherence 只记录不裁决。veto "让 Cairn 自动判断 PR 通不通 / 自动改规则 / 自动派工" 类需求。

---

## 8. UX / 产品形态

### 8.1 Product MVP 的四组件

| 组件 | 形态 | 角色 | 状态 |
|---|---|---|---|
| **Tray / status-bar icon** | macOS Menu Bar / Windows 系统托盘常驻 | 一眼看到 active agents / open conflicts / WAITING_REVIEW 计数；颜色随状态变化 | ⏳ MVP-2 |
| **Floating marker** | 屏幕角落浮窗（可拖动 / 贴边 / 隐藏） | ambient presence；schema → sprite 动画反映 8 类 state objects 实时状态 | ✅ 基础形态在 `packages/desktop-shell/`（MVP-3） |
| **Side panel / Inspector window** | 宽 ~480px，可贴边或独立窗口 | 主交互面：Live Run Log + project summary + 8 个 view + detail drawer | ⏳ MVP-5 |
| **Detail drawer** | 从 panel 行点入展开 | 看完整行状态 + 历史 + 关联 row | ⏳ MVP-14 |

### 8.2 Side panel 的视图组织

panel 进去先看到 **Project summary card**（30 秒读完），下面是 8 个可切换 view：

```
┌─ Project summary card ─────────────┐
│ project: D:\lll\cairn               │
│ 2 active sessions · 3 tasks running │
│ 1 conflict OPEN · 1 outcome FAIL    │
│ last ckpt: 4m ago (cairn-6eb0e3c9)  │
└─────────────────────────────────────┘

[Live Run Log] [Sessions] [Tasks] [Blockers]
[Outcomes] [Checkpoints] [Conflicts] [Scratchpad]
```

**Live Run Log 是默认主视图**——read-only event-oriented stream，呈现 8 类 state objects 的事件随时间流动。它是 panel 的"主入口"；其他 7 个 view 是 drill-down 入口。

详细 view 设计：

| view | 数据源 | 主要列 |
|---|---|---|
| Live Run Log | 8 类 state objects 聚合事件 | timestamp / source / type / agent_id / target / detail |
| Sessions | `processes` | agent_id / state / capabilities / last_heartbeat / cwd |
| Tasks | `tasks` (parent_task_id 树) | id / state / intent / current_attempt / last_event_at |
| Blockers | `blockers` | id / task_id / status / question / answer / answered_at |
| Outcomes | `outcomes` | task_id / status / criteria_count / last_eval_at / FAIL detail |
| Checkpoints | `checkpoints` | id / label / agent_id / created_at / paths_affected / git_head |
| Conflicts | `conflicts` | id / status / paths / agent_a / agent_b / detected_at |
| Scratchpad | `scratchpad` | namespace / key / agent_id / size / updated_at |

### 8.3 形态参考与反例

**形态参考**（应该像）：

- Windows 任务管理器 / macOS Activity Monitor — 信息密度高 / 只读 / 实时刷新
- journalctl --follow + grouping — 事件流 + 类别筛选
- Linux /proc 文件系统的 GUI 包装 — kernel 内部状态的 read-only 窗口
- 1Password mini / Spotify mini-player — 桌面侧边浮窗的工业参考

**形态反例**（不应该像）：

- Cursor / VS Code IDE — Cairn 不带代码编辑器、不嵌 diff viewer
- Jira / Linear / Asana 任务板 — 没有 sprint / 看板 / story point / burn-down / 资源分配
- Figma / Slack 多面板 SaaS — 不是协作 SaaS
- Cairn v1 桌面宠物 + 单对话面（已废）— panel 不接管对话

### 8.4 Live Run Log（v3 主视图，已 lock）

read-only / event-oriented kernel window，呈现 agents / subagents / tasks / blockers / outcomes / checkpoints / conflicts 随时间流动的事件，让程序员能复盘和监督 agent 协作现场。

设计参考：dtrace / journalctl --follow / Linux /proc — kernel 的 UI 形态从来不是 dashboard，是 *window into itself*。

具体设计 + 实施路线见 `docs/superpowers/plans/2026-05-29-v0.2-live-run-log.md`（决议 2026-05-29 锁，veto "Inspector 漂移成 observability SaaS / task board"）。

**Mutation 路径**（answer blocker / resolve conflict / rewind 从 panel 触发）推迟到 Later。MVP Live Run Log 严格 read-only。

### 8.5 Floating marker 状态契约（schema → animation）

floating marker 的 9 个动画对应 SQLite schema 里具体的状态查询。规则按优先级评估，首中即赢。任何动画规则不允许脱离 schema 自由发挥。

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

- **conflict → review 而非 failed**：冲突是"待仲裁"非阻塞通知，不是错误状态
- **waiting 用 HELD_FOR_HUMAN + PENDING dispatch 而非 IDLE process**：`processes.status='IDLE'` 只表示"已注册未在干活"，不等于阻塞
- **rewind 单独动画**：`lanes.state='REVERTING'` 是 cairn 可逆性内核体现，不该跟 forward work 混淆
- **waving 接 new agent 注册**：唯一"友好欢迎"语义场景

### 8.6 v3 reframe 后悬浮标的角色

`packages/desktop-shell/` Electron pet 不变——仍是 ambient presence。但它**不再是单独的产品形态**，而是 Product MVP 四组件之一（floating marker 角色）。状态契约 §8.5 不变。

**与 v1 桌面宠物的关键区别**（必明示，否则容易混）：

| 维度 | v1 桌面宠物（已废） | v3 floating marker |
|---|---|---|
| 核心身份 | 用户的 agent 化身 | Cairn Live Run Log 的 ambient 入口 |
| 对话发生在哪 | 跟宠物对话做开发任务 | 跟 agent（CC / Cursor）对话；跟 floating marker 只"看 + 唤起 panel" |
| 是否写代码 | 是 | **不**（硬底线 §1.3 #1 / #9） |
| 视觉 | 拟人 / 拟物动画化（agent 化身） | 拟物像素美术（玛尼堆），表情仅顶层石头一处，动画反映 schema 状态 |
| 与 panel 关系 | 浮窗展开为对话面 400×600 长驻 | 点击唤起 side panel ~480px，按需 |

**技术形态**：Electron（Node + Chromium）。理由 + 选型权衡见 ARCHITECTURE.md ADR-8。

### 8.7 反例（什么样是做错了）

以下设计违背反定义，veto 直接：

- side panel 加输入框让用户输 "帮我改这个 bug" → 错（§1.3 #1）
- side panel 自动选 agent 派任务 → 错（§1.3 #4）
- side panel 加代码编辑器 / diff viewer 嵌入 → 错（§1.3 #2）
- side panel 加 sprint planning / story point / 看板 → 错（§1.3 #5）
- side panel 默认全屏 / 强制常驻 → 错（§7 原则 6）
- 默认开声音提醒 / 系统弹窗 → 错（§7 原则 6）
- floating marker 接受用户开发对话 → 错（§1.3 #9）
- 把 panel 设计成 Cursor-like IDE 嵌入 / Jira-like 看板 → 错（§1.3 #2 / #5）

---

## 9. 技术架构（概念层）

详细实现见 `ARCHITECTURE.md` 和 `DESIGN_STORAGE.md`。本节只覆盖产品决策相关的架构抽象，以及 v3 product surface reframe 引入的 desktop-shell 读路径。

### 9.1 Daemon-centric 协作模型 + Product Surface 读路径

所有 agent 通过 mcp-server 写入 daemon 的 SQLite。没有进入 daemon 视野的 agent 行为，Cairn 无法追踪——这是能力边界，必须在文档和 panel UI 里明示。

```
Agent A (Claude Code)  ──MCP──►┐
Agent B (Cursor)       ──MCP──►├──► mcp-server ──► daemon storage ──► SQLite (WAL)
Agent C (subagent)     ──MCP──►┘                                            │
                                                                            │
                                              desktop-shell ◄───────────────┘
                                                   │ (read-only)
                                                   ▼
                                          用户（看 panel）
```

- **agent 写路径**：MCP stdio → mcp-server → daemon storage → SQLite（写）
- **用户读路径**：desktop-shell → SQLite（read-only connection）→ panel 渲染
- **WAL mode** 已开，concurrent reader（panel）不阻塞 writer（mcp-server）
- **关键**：desktop-shell **不**通过 MCP——MCP 是 agent ↔ daemon，不是 desktop ↔ daemon

### 9.2 MCP 双向协议

- Cairn daemon 是 MCP server：暴露 8 个（v0.1）+ 后续工具给 agent host 使用。

**Cairn 怎么 observe agent 的行为？**这是一个关键的机制问题。"subagent 完成时 Cairn 自动把结果写入 scratchpad"——这里的"自动"有三种完全不同的实现路径，难度差三个数量级：

**路径 (a) MCP-native：agent 主动调 Cairn 工具（v0.1 唯一可行路径）**

Claude Code 这种原生 MCP client 通过 `.mcp.json` 接入 Cairn。用户在 agent 的 system prompt 或任务描述里加入约定："派 subagent 时，让它在任务结束前调 `cairn.scratchpad.write` 把完整报告写入 `subagent/{agent_id}/result`"。Cairn 就是个被动接收者——agent 写来，Cairn 存下来。

- **优点**：零侵入，跨 host 通用（任何 MCP-aware agent 都能用），实现成本低。
- **缺点**：依赖 prompt 守纪律，agent 忘了调就盲。这是 v0.1 的主要失败模式之一。

**路径 (b) Task tool wrapper（Later 探索）**

给 Claude Code 的 Task tool 提供一个 wrapper（用户自己加进 prompt template，或安装一个轻量 plugin）：subagent 启动 / 结束时自动写 scratchpad，无需 prompt 嘱咐。这消除了"agent 忘了调"的失败模式。

- **优点**：消除人工 prompt 纪律的依赖。
- **缺点**：与特定 agent host 强耦合——CC 做一套，Cursor 做一套，Cline 做一套，维护成本线性增长。

**路径 (c) fs / process hook（Later 探索，跨平台 + EDR 风险高）**

daemon 直接 hook fs 写操作或 process exit，完全不需要 agent 主动配合。

- **优点**：agent-unaware，零配置。
- **缺点**：跨平台复杂度高（Windows / macOS / Linux 各有不同），且与企业 EDR 工具存在冲突风险（企业用户反映过此类问题）。

**当前的实际含义**：上面描述的"Cairn 自动把 subagent 完成状态写入 scratchpad"，当前的实现路径是**路径 (a)**——即"agent 被 prompt 引导主动调用 `cairn.scratchpad.write`"。这不是 Cairn 能 magic 探测；Cairn 的 observe 能力完全依赖 agent 的主动配合。

**当前限制**：agent 必须主动调用 Cairn 的 MCP 工具（push 模式），Cairn 不能主动感知 agent 的行为。pull / event 模式 + 路径 (b) / (c) 都是 Later。

### 9.3 共享 scratchpad = IPC 总线

scratchpad 不只是"临时笔记本"，它是 agent 间通信的主通道。key 的命名规范：

- `session/{session_id}/...`：会话级别的共享数据
- `subagent/{agent_id}/result`：subagent 的完成结果（原文，不压缩）
- `echo/{agent_id}/restatement`：主 agent 读完 subagent 结果后写入的"复述 + 后续计划"，是反汇总（§5.4 层 3）的 diff 端；只有主 agent 主动写这个 key，反汇总才可执行
- `conflict/{timestamp}/...`：冲突记录
- `dispatch/{request_id}/...`：Dispatch 的请求和响应

当前命名规范是建议，不是强制；Later 进程总线成熟后做正式协议。

### 9.4 进程总线（基础版，已落地）

agent 注册自己、汇报心跳、查询其他 agent 状态的机制。v0.1 只做：

- 注册：`cairn.process.register(agent_id, agent_type, capabilities)`
- 心跳：`cairn.process.heartbeat(agent_id)`
- 查询：`cairn.process.list()` / `cairn.process.status(agent_id)`

具体 MCP 工具接口见 §17.2。

### 9.5 Monorepo 当前结构

```
packages/
├── daemon/         # SQLite + 仓储层 + git-stash backend (kernel + storage layer)
├── mcp-server/     # 28 MCP 工具，stdio (kernel + integration layer)
└── desktop-shell/  # Electron 悬浮标 + Product MVP side panel (product layer)
```

跨包 import 走 `daemon` 的 `dist/`，不是源码（已有 `declaration: true` 输出 `.d.ts`）。

### 9.6 desktop-shell 与 daemon 的关系（Product MVP 架构边界）

**read-only**：desktop-shell 通过 SQLite read-only connection 读 `~/.cairn/cairn.db`。**不**通过 MCP——MCP 是 agent ↔ daemon 的通道，不是 desktop ↔ daemon。

**polling vs event-driven**：MVP 用 polling（500ms-1s）+ SQLite update_hook（如果架构允许跨进程）。Live Run Log 实施细节见对应 plan。

**MVP 进程模型**：

- 每个 agent host 启动一个 mcp-server 子进程（已有架构）
- 全局只有 1 个 desktop-shell（Electron）
- 两者通过 SQLite WAL 文件同步，无直接 IPC

**Later 架构**：standalone daemon process + IPC（v2 §已提及，仍保留为 Later 范畴）。

### 9.7 当前 v0.1 进程模型现实

mcp-server 直接 import `daemon/dist/` 函数，没有独立 daemon 长跑进程；agent host 起一个，mcp-server 起一个。Product MVP 给 desktop-shell 加 read-only SQLite connection 不改这个模型——只是在已有的 SQLite WAL 上加一个 reader。

---

## 10. 路线图

v3 不再用版本号路线（v0.2 / v0.3 / v0.4）。两个阶段：

- **当前阶段**：Product MVP（kernel 工程已交付，做 desktop side panel）
- **Later**：*eventually* 范畴，dogfood 反馈和真实使用驱动优先级

### 10.1 已交付：Kernel layer 工程底座

| 阶段 | 周期 | 内容 | 状态 |
|---|---|---|---|
| W1 楔 | 2026-04 | daemon 存储 + 8 MCP 工具 + tag `storage-p1` | ✅ |
| W2 PoC | 2026-04 | PoC-1（SQLite 并发）+ PoC-2（pre-commit hook 延迟）双 PASS | ✅ |
| W4 Phase 1-4 | 2026-04~05 | 四能力 v1（conflict + inspector + process bus + dispatch + `cairn install` CLI + auto SESSION_AGENT_ID） | ✅ |
| W5 Phase 1 | 2026-05 | Task Capsule lifeline（tasks 表 + 5 task tools） | ✅ |
| W5 Phase 2 | 2026-05 | Blockers + resume_packet（blockers 表 + 3 task tools，cross-session handoff） | ✅ |
| W5 Phase 3 | 2026-05 | Outcomes DSL 闭环（outcomes 表 + 3 outcomes tools + DSL stack 7 原语，dogfood 32/32 PASS） | ✅ |
| Phase 4 | 2026-05 | Product unification + release polish docs | ✅ |

**累计**：28 MCP tools / 10 migrations / 8 host-level state objects / daemon 411 tests / mcp-server 329 tests / cross-session dogfood 32/32 PASS。

### 10.2 当前阶段：Product MVP

把 kernel 接成可用的本机 project-scoped agent work side panel。具体 deliverables 见 §6.2 MVP-1..15。

**主要工作**：

- desktop bootstrap + tray + side panel + Live Run Log + 8 view 渲染
- 单程序员长程 dogfood（≥ 3 天 / ≥80% 项目掌控感覆盖率）
- panel **read-only**——所有 mutation 仍走 agent / CLI / MCP 路径

**关键依赖文档**：

- `docs/superpowers/plans/2026-05-29-v0.2-live-run-log.md`（Live Run Log 设计 + 实施路线，决议已锁）
- `RELEASE_DECISIONS.md`（5 项 owner default：Apache-2.0 / GitHub-only / tag-after-LICENSE / dogfood ≤5 invites / spritesheet keep）

### 10.3 v0.1 release polish（独立于 Product MVP，与 owner 决策绑定）

| 项 | 状态 |
|---|---|
| LICENSE Apache-2.0 | working tree 已起草，待 commit |
| README / 2× package.json License 段 | working tree 已起草，待 commit |
| RELEASE_DECISIONS.md 5 项 default | working tree 已起草，待 commit |
| `v0.1.0` tag | LICENSE commit 入库后打 |
| npm publish | 不发（GitHub-only） |
| 外部 dogfood 邀请 | ≤ 5 invites（closed beta） |

### 10.4 Later

§6.3 Later 项目。不绑定时间表 / 不绑定版本号。dogfood 反馈和真实使用驱动优先级。

下一层主要产品方向：**Agent Work Governance（§6.4）**——从"看见 agent 工作现场"升级到"让 agent 工作现场可治理"。前置条件是当前 Project-Aware Live Panel 真实 dogfood 显示用户开始反馈 governance 类痛点。第一个可落地 demo = Lightweight Pre-PR Gate（详 §6.4.4）。

### 10.5 完成判据

**Kernel layer**：已完成（W5 Phase 3 + Phase 4 docs）。

**Product MVP** 完成判据 = MVP-15 desktop dogfood PASS：

- 单程序员长程 dogfood ≥ 3 天
- panel 覆盖 ≥ 80% 项目掌控感需求（不需要跳到 chat history / git log 就能回答 "现在到哪了 / 谁卡住了 / 上次 outcome 失败为啥 / 从哪个 ckpt 回退"）
- §4.6 五条 AC（US-P1..P5）全部通过
- Windows 11 + macOS（如有） panel 启动 / 渲染 / 切换无明显 jank

"ship" 在本文语义 = 工程交付完成，不是商业发布。

### 10.6 北极星（非指标化描述）

社区里开始自发出现：

- "我开了一上午 agent 干活，下午回来打开 Cairn 一眼就看到状态，没读 chat history。"
- "跨 3 个 session 的长程任务，handoff 全靠 Cairn resume packet，没掉东西。"
- "subagent 写完了，主 agent 上下文 compact 了，我从 Cairn panel 直接复制 subagent result 全文回去。"
- "agent 跑了一晚上方向不对，我打开 Cairn 看 ckpt timeline，找到对的点回退。"
- "我两个 agent 同时改了 X，Cairn 在 30 秒内告诉我冲突在哪、怎么解。"
- "Cairn 装了之后我才发现以前 N 个 agent 是 N 套互不相通的状态。"

如果这类句式开始在 GitHub issue / 博客 / 推友圈高频出现，v3 论题（程序员失去项目掌控感）就被验证了。反之，无论装机量多少，都说明 product surface 没被真正感知到——这种情况下要回到 §11.3 "再次转向"的评估闸。

---

## 11. 风险

### 11.1 产品风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| "AI PMO" 心智模型对用户陌生，被理解成 Linear / Jira clone | 期望落差，差评 | onboarding 用 "Activity Monitor for AI coding" / "journalctl for agents" 类比，避开 PM SaaS 词；§1.3 反定义明示；§15.4 列 Linear / Jira 区分 |
| "项目掌控层" 这个 framing 对用户陌生 | 获客困难；用户拿它当小 agent 误用 | 文档和 onboarding 用具体场景（"午饭回来打开看现在到哪了"）而不是抽象名词引入；dogfood 收集"用户第一次理解它是干什么的"的时机数据 |
| 用户误把 Cairn 当成 agent 来用（"帮我修这个 bug"） | Cairn 不执行，用户失望 | side panel 没有自然语言输入框；任何"执行任务"请求引导到 agent（D1 红线策略） |
| 竞品（Claude Code / Cursor）收编 panel 能力 | 差异化被抹平 | Cairn 的差异在 "跨 agent" + "host-level" + "本机 project-scoped"——单个 agent 内部的 panel 是不同的问题，agent 自身做不到跨 agent 视图 |
| 多 agent 场景还不是主流，用户基数小 | 市场时机太早 | v3 主用户已是 multi-agent 用户（手里跑 ≥2 agent），不需要等市场教育完成 |
| 用户把 floating marker 误解为 v1 桌面宠物 / agent 化身 | 期望落差 | §1.3 #9 反定义 + §8.6 与 v1 区别表格明示；首次启动 onboarding 一句话告知"我不写代码，找 agent" |
| panel 做不出比"看 sqlite3 cli"明显更好的体验 | MVP 失去存在意义 | MVP-15 dogfood ≥ 3 天 / ≥80% 覆盖率是硬验收，不达标不 ship |

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| agent 不主动调用 Cairn MCP 工具，协作感知为零 | 冲突检测和消息可达全部失效 | Later 的事件总线 / 路径 (b)(c) 是根本解；当前靠 agent 主动调用，在 README / onboarding / `docs/cairn-subagent-protocol.md` 给最佳实践 pattern |
| 冲突检测假阳性率高，通知刷屏 | 用户关闭通知，Cairn 隐形但失效 | 保守策略（只在确定冲突时通知，不在"可能冲突"时通知）；允许用户配置通知阈值 |
| SQLite 在高频写入时的并发性能 | checkpoint 或 scratchpad 写入延迟 | 已有 WAL mode；PoC-1 已验证 N=2/5/10 场景 100% 成功 p99 < 6ms；N=50 是 Later 跨机场景的天花板 |
| Daemon 长跑稳定性（当前 = mcp-server 内联进程） | 状态丢失 | 状态持久化到 SQLite；重启后 checkpoint / scratchpad / tasks 完整恢复（已验证）|
| Electron 体积 + RAM 代价（~100MB binary / ~100-200MB RAM） | 桌面用户感知噪声 | 目标用户已运行 Cursor / VS Code / Claude Desktop / Slack 等 Electron 应用，再增 100MB 不构成额外噪声。详 ARCHITECTURE.md ADR-8 |

### 11.3 范围风险

v3 reframe（v2 kernel → v3 product surface）是 product layer 重新包装，**不是** kernel pivot。kernel 完整保留。但 reframe 之后，范围风险的主要形态变了：

- **风险 A：Product MVP 滑坡到 manager agent**（自动给建议、自动派 agent、自动答 blocker）。触底线。缓解：§1.3 反定义 + §6.3 Later 把 "AI PMO recommendations" 明确放在 *eventually*，不在 MVP scope；§7 原则 8 + 原则 2 在所有评审中引用。
- **风险 B：对每个 agent 都"适配一遍"**。不同 agent（Claude Code / Cursor / Cline）的 MCP 接入方式可能有差异。缓解：坚持 MCP 标准协议，不写专属 sidecar；非 MCP-aware 工具的接入路径推 Later。
- **风险 C：把 Cairn 变成 orchestrator / dashboard SaaS**。前者需要 Cairn 理解任务语义；后者会变成 Linear 复制品。MVP 严格限制在 record + show + recover，不做 plan + assign + manage。
- **风险 D：再次转向**。定位已经转了三次（驾驶舱→宠物→kernel→panel），再转的成本越来越高。v3 的判断是：product surface 没改 kernel 论题，只改用户感知，比前两次切换轻得多。下一次重新评估的时间点：MVP dogfood 完成 + 3 月，看用户是否真的把 panel 当主要工作面。
- **风险 E：v3 reframe 自身的累积心智负担**。新会话进来要消化 v1 / v2 / v3 演进史。缓解：§13 v1/v2/v3 差异表 + canonical positioning 双层 framing 落定后不再轻易改。

### 11.4 v3 reframe 自身风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 已交付 28 工具被 panel reframe 贬值，工程师感觉白干 | 团队士气 | kernel facts 在 §6.1 完整保留 + RELEASE_NOTES 不动；Product MVP 是其上的产品面，不是替代 |
| 把 "AI PMO" 翻译成英文时被读成传统 PMO（项目管理办公室） | 国际用户误读 | 英文 pitch 锁 "AI PMO **layer** for agentic software work"——*layer* 不是 *tool* / *suite*；onboarding 文案二审 |
| Live Run Log 实施 cost 远超估计 | MVP delay | plan 已 lock，但 read-only event stream 是 MVP 范围最大不确定项；可选保底：MVP 先做静态 8 view + summary card，Live Run Log 单独 ship |
| MVP read-only 边界用户接受度差（"为啥从 panel 不能直接答 blocker"） | 用户摩擦 | onboarding 明示"Cairn 是看的，不是做的"；Later 段的 mutation 项目跟 MVP dogfood 一起评估优先级 |

---

## 12. 已解决歧义

本节锁定关键决策点，供后续需求评审和设计决策参考。D1-D7 由 v2 锁定，D8-D10 是 v3 reframe 新增。

**D1. 用户问 Cairn "帮我修这个 bug" 时怎么办（红线策略 B+C 结合）**

决议：
- B 引导：Cairn 在 panel 上展示"上次类似 bug 在哪个 checkpoint / agent / scratchpad key"——返回历史知识，不动代码。
- C 派单：Cairn 不在 panel 内派单（MVP read-only）；用户在 agent 里说"按 ckpt-X 接手"，agent 通过 MCP 调用 Cairn。
- 硬底线：Cairn 自己不执行任何修 bug 的操作，无论用户如何坚持。这条不可谈判。

**D2. Inspector 只读边界**

决议：Inspector 通道（含 v3 panel 的全部 view）的任何操作不触发 scratchpad / checkpoint 的写入，不向任何 agent 发出指令。Inspector 是单向只读的观察窗口，不是控制面板。

**D3. 模型在哪些事件触发**

决议：
- Dispatch 请求到达时（NL→意图解析）
- Inspector NL 查询（NL→查询翻译 + 结果摘要，仍在 MCP tool 层；MVP panel 不调）
- 冲突仲裁请求（冲突诊断 + 仲裁建议生成）
- 其余时间 Cairn 以确定性方式运行，不持续消耗 token
- **Live Run Log 不调 LLM**——它是确定性事件流

**D4. Dispatch 需要用户确认**

决议：Dispatch 在向 agent 转发 prompt 前必须展示给用户确认，不能静默自动转发。"用户对某类请求授权自动转发"是 Later，必须显式授权。

**D5. 冲突仲裁的默认权**

决议：Cairn 在冲突发生时只通知 + 建议，不自动执行仲裁。用户选择策略后，Cairn 负责把决定通知相关 agent。"分级仲裁"（低风险自动 / 高风险弹）是 Later。

**D6. 共享 scratchpad 的隔离模型**

决议：单一共享空间 + task_id 分片（已实现）。Cairn 不做 agent 级别的访问控制（A agent 可读 B agent 的 scratchpad）。显式订阅模型是 Later。

**D7. MCP-aware agent 与非 MCP agent 的接入差异**

决议：当前只支持 MCP-aware agent（主动调用 Cairn 工具）。非 MCP-aware agent（如某些 Aider 版本 / 不接 .mcp.json 的 Cursor / Cline）当前不做适配。wrapper / sidecar 方案是 Later。

**D8. 主定位词是 "project control surface"，"AI PMO layer" 是辅助 framing（v3 新增）**

决议：
- **主定位词**：project control surface / project-scoped agent work side panel。所有正式介绍 / 一句话定位 / 标题用这套
- **辅助 framing**："AI PMO layer"——只在介绍场景下用一次，让程序员一眼理解 Cairn 在他工作流的位置；不作为主标题反复出现
- **不**意味着 Cairn 实现传统 PM 软件的 sprint / story point / gantt / burn-down / 资源分配
- **不**意味着 Cairn 自动拆任务、自动排优先级、自动派 agent
- 实质功能仍是：record + show + recover。不是 plan + assign + manage。
- 中英 pitch 对齐：英文主句 "Cairn is a local project control surface for agentic software work"；"AI PMO **layer**" 仅作辅助解释一次，*layer* 不是 *tool* / *suite*

**D9. Product MVP read-only 边界（v3 锁；v4 cockpit-redesign 升级为 D9.1 responsible mutation · 2026-05-12）**

> **v4 patch**：v3 D9 把整个 panel 锁成"默认 read-only，所有 mutation 走 env flag 或 CLI"。受众扩到非开发者（§3.1）后，env-flag 配置成了非开发者天敌——卡死他们。同时 cockpit redesign 要求 panel 能让用户**不切 session 给 agent 发指令** + 一键回退，这些动作本质就是 mutation。v4 把 D9 替换为分层的 D9.1。

**D9.1 Responsible mutation（v4 cockpit-redesign 新约 · 2026-05-12）**

决议（替换 v3 D9 的 single-flag 模型）：

| Tier | 动作类型 | 默认是否可用 | 安全机制 |
|---|---|---|---|
| **A · first-class** | 用户**可见可拒**的 cockpit 动作 — accept / reject / archive · talk-to-leader（即向 agent live session 注入消息）· refresh-suggestions | **默认可用**（无 env flag、无确认对话框） | 操作产生 audit trail；可撤销（如 archive 反操作）；走 supervisor identity（详 D9.2） |
| **B · confirm dialog** | **破坏性 / 不可见副作用**的动作 — 删除 task · clear archive · 改 project settings · rewind to checkpoint | 默认可用，但**前置 inline 确认对话框**（"确认回退到 ckpt-...?"）；无 env flag | 二次确认 + audit trail + 显式 undo 窗口（30 s toast） |
| **C · env-flag gate** | 还在 dev / legacy / debug 阶段的 mutation — 现有 `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` 才显的 legacy Inspector Resolve 仍**保留**这一档 | 默认不可用，需 env flag | 兼容现有内部用例，不污染主 panel |

**为什么从 "全 read-only" 升到 "responsible mutation"**：

1. **受众扩到非开发者**（§3.1 v4 patch）：env-var 配置不是非开发者能跨过的门槛。
2. **cockpit 的核心诉求**就是 mutation：talk-to-leader（注入 agent live session）和 rewind（回退到 checkpoint）这两个动作如果都要 env flag，cockpit 就废了。
3. **v3 D9 的三个前置条件中两条已满足**：Daemon API（managed-loop-handlers.cjs IPC 层已成形）+ supervisor identity 模型（cairn-session 体系 + capabilities 标签把 user-supervisor 与 agent 区分）。第三条（dogfood ≥ 3 天）由本次 cockpit-redesign 的 phase 7 验证。
4. **审计仍硬**：每个 mutation 仍写入 audit trail；tier-B 强制 inline 确认；tier-A 可撤销。失去的是"完全不能动"的强限制；保留的是"动了能回头 + 动了留痕"的强保证。

**D9.2 Supervisor identity（v4 cockpit-redesign 新约 · 2026-05-12）**

cockpit 触发的 mutation 在 `processes.capabilities` / audit trail 里必须可与 agent 触发的写区分：

- agent 写：现有 `cairn-session-<12hex>` + `client:mcp-server` / `cwd:...` 模式不变
- cockpit 写：新增 `cairn-supervisor-<12hex>` 前缀，capabilities 含 `client:cockpit` / `via:panel-action`

这给后续 audit / "is this action user-triggered?" 的查询提供基础。

**D9.3 升级路径不撤回**：D9.1 不是 D9 的"撤销"——是 D9 升级路径的*第一段*（"三条前置条件满足后做 mutation"中的两条已满足，第三条 cockpit phase 7 dogfood 验证）。Later 阶段如要再扩 mutation 类型（e.g. cross-machine sync），仍需走 §12 完整审议。

**D9.legacy v3 原文（保留作历史）**：
> Product MVP side panel **不**支持 mutation：不答 blocker / 不 rewind / 不 dispatch / 不 resolve conflict。所有 mutation 仍走 agent / CLI / MCP 路径。panel 唯一允许的"动作"是 preview（rewind preview / outcomes evaluate preview）和触发外部跳转（"复制 ckpt-id" 类）。

**D10. 不再做版本号路线（v3 新增）**

决议：
- v3 reframe 之后，路线只有 "Product MVP（当前）" 和 "Later（不绑时间）"
- 不再写 v0.2 / v0.3 / v0.4 等版本切片——历史经验显示版本切片会触发"我的功能在哪个版本"焦虑，且容易让 reviewer 把 Later 当承诺
- "Later" 是 *eventually* 范畴：dogfood 反馈和真实使用驱动优先级
- 单一例外：v0.1 release 决策（npm publish / tag / LICENSE）仍在 RELEASE_DECISIONS.md 走，不是路线图问题

---

## 13. 与 v1 / v2 的差异说明

v3（2026-05-08）是 **product surface reframe**，**不是** kernel pivot。kernel layer 完整保留为底层，user-facing 框架升级为 project-scoped agent work side panel / project control surface。

### 13.1 v1 → v2 → v3 三次定位演进

| 维度 | v1（2026-04-17） | v2（2026-04-29） | v3（2026-05-08） |
|---|---|---|---|
| 产品身份 | 桌面宠物形态的 AI 协作伙伴 | host-level multi-agent coordination kernel | project-scoped agent work side panel / project control surface |
| 用户感知形态 | 桌面宠物 + 单对话面 | MCP service + Floating Marker | desktop side panel + tray + ambient floating marker + Live Run Log |
| 核心论题 | step-away-safe（用户可放心走开） | multi-agent collaboration kernel | 程序员失去项目掌控感（v2 论题保留为 kernel layer 论题） |
| 主要 UX 投资 | 桌面宠物本体 | MCP 工具 + agent 接入便利性 | Product MVP desktop side panel |
| 路线表达 | W1-W15 周线 | v0.1 / v0.2 / v0.3 多版本 | Product MVP 一阶段 + Later（不绑版本号） |
| 反定义重心 | "不是驾驶舱 / VS Code 插件" | "不是 Cursor clone / 不是 agent" | + "不是 Jira / Linear clone / 不是 PM SaaS / 不是 IDE / 不是 plain MCP service" |
| 竞品关系 | Cairn vs Claude Code / Cursor（同代竞争） | OS vs apps（互补） | 同 v2，OS vs apps；新增 Cairn vs Linear / Jira（不同范畴，不竞争） |
| 用户故事 | US-1..US-5（托付重构 / 异步批量 / 陪跑 / 回错 / MCP 楔） | US-D / US-R / US-A / US-I / US-S（kernel 视角） | US-P1..US-P5（panel 视角）；v2 故事降为 kernel ground truth（§4.X） |

### 13.2 v3 reframe 的关键不变

**底层完整保留**：kernel layer 28 工具 / 8 host-level state objects / 10 migrations / 411 daemon tests / 329 mcp-server tests / dogfood 32-of-32 全部保留为 v3 supporting evidence。已交付的工程没有任何一行被 reframe 贬值。

**反定义保留 + 强化**：v2 的 7 条反定义（不是 agent / 不是 dashboard / 不是 desktop pet / 不是 framework / 不是 CC skin / 不做跨机 / 不做 proxy）全部保留。v3 在 §1.3 加 4 条（不是 Cursor clone / 不是 Jira clone / 不是 IDE / 不是 plain MCP service）。

**v2 用户故事归属**：v2 的 US-D / US-R / US-A / US-I / US-S 描述的是 kernel 视角的能力契约，仍是 ground truth。v3 的 US-P1..P5 是从 panel 视角描述同一份能力——两套故事描述同一系统，不冲突。v2 故事文本完整保留在 §4.X kernel 视角段。

**Kernel 论题保留**：v2 的 multi-agent collaboration kernel 论题没废止，只是从"主要 framing"降级为"kernel layer 内部论题"。v3 的"程序员失去项目掌控感"是 product layer 论题。两者并存。

### 13.3 v1 / v2 内容的处置

**v1 完整全文**：保留为附录 §18，未改一字。

**v2 主体**（v2 §0~§17）：在本次 reframe 中**就地修改**为 v3 主体。完整 v2 文本可在 `git log -- PRODUCT.md` 中追溯（HEAD 之前的 commit chain）。这是有意选择——避免 PRODUCT.md 进一步膨胀（已经 1500+ 行）；git history 提供完整可追溯性。

**保留 v2 的内容**（搬入 v3 不动）：

- §5.1-§5.4 四能力（冲突可见 / 状态可逆 / 需求可派 / 消息可达）正文
- §6.1.1 8 类 host-level state objects 表
- §8.5 floating marker 状态契约（schema → animation 9 行表）
- §9.2 三种 observe 路径 a/b/c 分析
- §9.3 scratchpad IPC key 命名规范
- §11.2 技术风险表
- §12 D1-D7 已解决歧义
- §15 / §16 / §17 三节大体保留

**v3 新增**：

- §1.2 四层架构（Product / Kernel / Integration / Storage）
- §4 US-P1..P5（panel 视角故事）+ §4.X（v2 kernel 故事 ground truth）
- §5.0 能力 → state object → panel 视图映射表
- §5.5 任务掌控感能力章节
- §6.2 Product MVP MUST 表 + §6.3 Later
- §8 全节（desktop side panel UX 形态）
- §9.1 数据流图（含 desktop-shell 读路径）+ §9.5-§9.7 monorepo 与 Product MVP 架构
- §10 路线图（Product MVP / Later，无版本号）
- §11.4 v3 reframe 自身风险
- §12 D8-D10
- §15.4 Cairn vs Linear / Jira 区分

### 13.4 历史脉络

- 2026-04-17：v1 锁定，"桌面宠物 + step-away-safe"
- 2026-04-29：v2 重写，"host-level coordination kernel"；v1 全文降为附录 §18
- 2026-05-07：canonical positioning 锁，"主机级多 agent 协作内核 / Task Capsule = OS primitive"（v2 内部强化，未升级版本号）
- 2026-05-08：v3 product surface reframe，"project-scoped agent work side panel / project control surface"（"AI PMO layer" 降为辅助 framing）；v2 主体 in-place 升级为 v3 主体；kernel 论题保留为 ground truth supporting layer
- 2026-04-29 早间：用户曾短暂讨论加回 agent 元素
- 2026-04-29 中后段：转向 agent OS 的方向最终确定，v2 起草

---

## 14. 术语表

### v3 product layer 术语

| 术语 | 定义 |
|---|---|
| **project control surface** | Cairn 的 v3 主定位词。本机按 project 组织 agent 工作现场的控制面。详 §0 / §1.1。 |
| **project-scoped agent work side panel** | Cairn 的 v3 user-facing 形态——按本机 project 组织 agent 工作现场的桌面侧边窗。 |
| **AI PMO layer** | Cairn 的辅助 framing（介绍场景用），让程序员一眼理解 Cairn 在工作流的位置。**不是主定位词**——主定位词是 project control surface，避免被读成 Linear / Jira clone。详 §15.4。 |
| **Product MVP** | 当前唯一活跃交付阶段。kernel 已交付，做 desktop side panel。详 §6.2 + §10.2。 |
| **Later** | *eventually* 范畴。不绑时间表 / 不绑版本号。dogfood 反馈驱动优先级。详 §6.3 + §10.4。 |
| **Side panel / Inspector window** | Product MVP 主交互面，宽 ~480px，含 Live Run Log + 8 view + detail drawer。 |
| **Live Run Log** | Product MVP panel 主视图。read-only event-oriented stream，呈现 8 类 state objects 事件随时间流动。设计参考 dtrace / journalctl / Linux /proc。详 §8.4。 |
| **Tray / status-bar icon** | Product MVP 组件之一。常驻 macOS Menu Bar / Windows 系统托盘，state-driven badge。 |
| **Floating marker** | Product MVP 组件之一（沿用 `packages/desktop-shell/`）。屏幕角落浮窗，ambient presence，schema → sprite 动画契约 §8.5。 |
| **Project summary card** | side panel 顶部 30 秒可读的项目现状（active sessions / running tasks / OPEN conflicts / WAITING_REVIEW outcomes / last checkpoint）。 |
| **detail drawer** | 从 panel 任意行点入展开的细节层。 |

### Agent Work Governance 术语（Later，§6.4 引入）

| 术语 | 定义 |
|---|---|
| **Agent Work Governance** | Cairn 的下一层产品方向（**Later**，不在 MVP）。从"看见 agent 工作现场"升级到"让 agent 工作现场可治理"。仍然是同一个 project control surface，加一层基于现有 8 类 state objects 的治理视图。详 §6.4。 |
| **Project Rules Registry** | 项目级规则的本地存储与展示（编码 / 测试 / checkpoint / migration / worker report / Pre-PR checklist 等规则）。规则是项目工件，跨 task 引用。详 §6.4.3。 |
| **Worker Report Protocol** | 每个 worker session 结束时输出固定 schema 的短报告（GOAL / DONE / NOT_DONE / CHANGED / TESTS / BLOCKERS / RISKS / NEXT / HUMAN_NEEDED），挂到 task chain。让 supervisor 不必读完整 chat history。详 §6.4.3。 |
| **Pre-PR Gate** | PR / handoff 前的 readiness 自检卡片，advisory only。状态枚举 `READY / NEEDS_TESTS / NEEDS_REVIEW / BLOCKED / FAILED_GATE / DRIFT_RISK`。**不**自动开 PR / 不写 git hook / 不阻断 commit。详 §6.4.4。 |
| **Rule Adherence Record** | 哪条规则在哪个 task 被 checked / passed / failed / waived。第一版借 outcomes 表达；最终归 `cairn_events` 表。详 §6.4.3。 |
| **Repeated Failure Pattern Log** | 反复出现的失败做成 pending 候选规则，等用户审批。**重要边界**：Cairn 不会偷偷训练或改写 agent 行为；进规则一律走人审。详 §6.4.3。 |
| **Governance Debt** | 工程债的项目管理对应物：task 无 outcome / session 无 report / failed outcome 无下一步 / 风险操作前无 checkpoint / 未归属 agent 活动 / done 但没跑 Pre-PR。派生视图，不是新表。详 §6.4.3。 |

### v2 kernel layer 术语（保留，仍为 ground truth）

| 术语 | 定义 |
|---|---|
| **host-level multi-agent coordination kernel** | Cairn 的 kernel layer 论题。坐在 Claude Code / Cursor / subagents / Aider / Cline 之下，维护本机所有 agent 工作的共享协作状态。 |
| **8 host-level state objects** | processes / tasks / dispatch_requests / scratchpad / checkpoints / conflicts / blockers / outcomes，Cairn 的内核数据结构。详 §6.1.1。 |
| **Task Capsule** | durable multi-agent work item（tasks 表 + state machine 12 transitions），v0.1 W5 引入的 OS primitive 之一。**不是产品本身。** |
| **Blockers** | 任务内等待答复（`blockers` 表，OPEN / ANSWERED / SUPERSEDED）。配合 BLOCKED → READY_TO_RESUME 闭环实现跨 session 接力。 |
| **resume_packet** | 跨 session 接力的 read-only aggregate view（task + blockers + scratchpad + outcomes + audit summary）。`cairn.task.resume_packet` 工具按需聚合返回，**不是独立持久状态**。 |
| **Outcomes DSL** | 7 deterministic primitives（tests_pass / command_exits_0 / file_exists / regex_matches / scratchpad_key_exists / no_open_conflicts / checkpoint_created_after），AND 聚合验收。 |
| **Dispatch（派单）** | Cairn 三动词之一。接用户 NL 需求 → 解析意图 → 选 agent → 翻成 prompt → 用户确认 → 转发。 |
| **Rewind（回滚）** | Cairn 三动词之一。按粒度矩阵（L0~L6）把状态恢复到指定 checkpoint，当前覆盖 L0~L2。 |
| **Arbitrate（仲裁）** | Cairn 三动词之一。检测 agent 间冲突 → 诊断 → 给出仲裁建议 → 用户拍板 → 通知相关 agent。 |
| **Inspector** | 用户与 Cairn 的 read-only 通道，用于查询当前状态、历史、冲突记录。不执行任何写操作。v3 panel 是 Inspector 的视觉载体。 |
| **共享 scratchpad** | Cairn 提供的 IPC 总线，agent 间通信的主通道。SQLite 表 + MCP CRUD。 |
| **进程总线** | agent 注册、心跳、状态查询的机制（`cairn.process.*` 4 工具，自动 SESSION_AGENT_ID）。Real Agent Presence v2（2026-05-08）起，SESSION_AGENT_ID 是 **session-level** 唯一（`cairn-session-<12hex>`），不再是 project-level sha1 哈希——同 project 下 N 个终端 session 在 processes 表展示为 N 行；project attribution 走 `processes.capabilities` 的 `git_root` / `cwd` tags + `agent_id_hints` 手动 hint。详 ARCHITECTURE.md ADR-9a。 |
| **红线（user intent boundary）** | 用户给 agent 划定的操作边界。当前基础版只检测文件范围越界，完整版 Later。 |
| **反汇总（layer 3）** | 主 agent 复述 vs subagent 原文 diff。Later，前提是主 agent 主动写 `echo/{agent_id}/restatement`。 |
| **checkpoint 粒度矩阵** | L0（文件全量）/ L1（paths）/ L2（scratchpad）已实现；L3-L6（对话 / 工具 trace / agent 内部态 / subagent 树）Later，需 host LLM 配合。 |
| **task_id 切片** | scratchpad / checkpoint / outcomes 按 task_id 隔离，多任务并行时互不干扰。 |
| **MCP-call 级 + commit-after 级双层检测** | v0.1 冲突检测的实现。详 §5.1.1。 |
| **观察路径 a / b / c** | a = MCP-native（agent 主动调）/ b = Task tool wrapper / c = fs hook。当前走路径 a，b/c 是 Later。详 §9.2。 |

### 废止术语（v1 遗留）

| 废止术语 | 原含义 | 废止原因 |
|---|---|---|
| **Outward Agent（对外 Agent）** | 用户对话的唯一 Agent 实体 | Cairn v2 起不是 agent，此概念不适用 |
| **Sub-agent（子 Agent，v1 含义）** | Outward Agent 内部调度的工作单元 | v2 起 subagent 是外部 agent 的概念，不是 Cairn 内部结构 |
| **桌面宠物（v1 含义：agent 化身）** | Cairn 的核心 UX 形象 | v2 起降级；v3 floating marker 是 ambient 状态显示，**不**是 agent 化身 |
| **step-away-safe** | v1 核心产品论题 | 被 multi-agent collaboration kernel 替换；v3 的 framing 是程序员失去项目掌控感 |
| **驾驶舱（cockpit）** | 被废弃的旧框架 | v1 已废弃，v2/v3 继续废弃 |
| **陪跑模式** | 宠物可见但不主动干活的 UX 模式 | 随桌面宠物 v1 定位一同降级 |
| **Tauri** | v2 早期假设的桌面技术栈 | 已切换为 Electron（详 ARCHITECTURE.md ADR-8） |
| **v0.2 / v0.3 / v0.4 路线** | v2 的版本切片 | v3 改为 Product MVP / Later，详 D10 |
| **Agent OS（中文：协作内核作为产品形态）** | v2 主要 framing | v3 reframe 后保留为 kernel layer 论题；产品形态对外 framing 改为 project control surface（AI PMO layer 是辅助） |

---

## 15. 竞品定位

### 15.1 生态位：本机 project-scoped agent work side panel

Cairn 填的空位：**本机 project-scoped agent work side panel + multi-agent coordination kernel**。当前没有产品在做"让程序员在长程多 agent 编程项目里不丢掉项目掌控感"这件事。既是机会，也是风险（心智模型需要从零建立）。

### 15.2 最近邻（非直接竞品，但最相关）

| 产品 | 近邻之处 | 关键差异 |
|---|---|---|
| **Goose（Block）** | 也做 agent 基础设施；MCP-native；本地优先 | Goose 是 agent 本身（单 agent 工具），没做跨 agent 协作内核 / panel |
| **Aider --watch / daemon 模式** | 后台常驻，持续监听代码变化 | Aider 是单一 agent，watch 模式针对文件变化触发，不是多 agent 协调 |
| **Continue.dev（background agent）** | 后台异步执行任务 | 单 agent，VS Code 插件形态 |
| **Activity Monitor / Windows 任务管理器** | read-only 系统状态侧边窗形态 | 看的是 OS 进程 / CPU / 内存，不是 agent 协作 |
| **journalctl / dtrace / Linux /proc** | kernel 内部状态 read-only 窗口的概念基础 | 系统级，不是 AI 编程项目级 |

### 15.3 理论上的合作伙伴而非对手

Claude Code / Cursor / Cline / Aider / Codex / Kiro——所有 coding agent 产品都是 Cairn 的"应用"。它们可以接入 Cairn 的 MCP 工具获得协作基础设施和 host-level 项目视图，不需要自己实现 checkpoint、冲突检测、消息持久化、跨 session 接力。Cairn 和主流 agent 工具是互补关系，不是竞争关系。

### 15.4 Cairn vs Linear / Jira / Asana / 企业 PM SaaS（必须明示）

v3 主定位词是 "project control surface"；"AI PMO layer" 是辅助 framing。后者最容易被误读成 Linear / Jira / Asana 的 AI 版。**这是错的**。区分如下：

| 维度 | Linear / Jira / Asana | Cairn |
|---|---|---|
| 用户 | 团队（人）协作的项目经理 / SWE 团队 | 单个程序员 + 他的 agents |
| 工作单位 | 人手动创建的 issue / story | agent 通过 MCP 自动产生的 tasks / blockers / outcomes |
| 数据来源 | 人在 web UI 里输入 | agent 调用 MCP 工具时自动写入 |
| 状态机 | 人定义的 workflow（todo / in progress / done） | kernel 锁定的 12 transition state machine |
| 验收 | 人 review 给 PR / closes ticket | DSL 7 primitives 自动验收（确定性） |
| Sprint / Story Point | 有 | 无 |
| 资源分配 / 人员安排 | 有 | 无 |
| 看板 / Gantt | 有 | 无（v3 反定义 #5 明确 veto） |
| 部署 | 云端 SaaS | 本机优先 |
| 扩展场景 | 跨团队 / 跨公司项目管理 | 单机单程序员 + 多 agent，跨机是单独产品方向 |

**核心区别**：Linear 类产品是**人协作**的 PM 工具，Cairn 是**人 + agent 协作**的本机 project control surface。两者面向的工作流不重叠——Linear 用户即使装了 Cairn，也不会用 Cairn 替代 Linear；反之亦然。

英文 pitch：主句锁 "Cairn is a local **project control surface** for agentic software work"。"AI PMO layer" 仅作为辅助解释出现一次，*layer* 不是 *tool* / *suite* / *clone*。

### 15.5 Cairn vs Cursor vs Claude Code vs RocketTeam vs Linear（v4 新增定位区分）

v4 引入 Mentor / Continuous / Multi-Cairn 三个模式后，最容易被误读成 "Cairn 在跟 Cursor / Claude Code 抢同一块"（写代码）或 "在跟 RocketTeam / Linear 抢同一块"（管同事 / 管项目）。**两个误读都是错的**。区分如下：

| 产品 | 它管什么 | Cairn 管什么 | 重叠？ |
|---|---|---|---|
| **Cursor** | 帮你写代码（coding surface，IDE + AI inline + composer） | 你和你的 Cursor session（以及其它 agents）之间的项目现场组织 | 几乎无：Cursor 在 surface 里写代码；Cairn 在 surface 旁边看它写到哪了 |
| **Claude Code** | 帮你写代码（CLI agent，会 chain tool calls） | 你和你的 Claude Code session（以及其它 agents）之间的项目现场组织 | 几乎无：CC 是 Cairn 的 "应用"，CC 通过 MCP 把工作现场告诉 Cairn |
| **RocketTeam（或类似 AI 团队管理 SaaS）** | 帮团队经理管同事（人）的工作 / 排期 / OKR | 帮单个程序员管自己的 AI 工人（agents）的 candidates / runs / outcomes | 不重叠：RocketTeam 管"同事是人"；Cairn 管"工人是 agent" |
| **Linear / Jira / Asana** | 帮团队管 issue / story / sprint（人协作的 PM 工具） | 帮单个程序员管自己的 AI 工人的 candidates / tasks / blockers / outcomes | 不重叠（详 §15.4） |

**一句话区分**：

- **Cursor / Claude Code = "帮你写代码"**（coding surface，你和 agent 1-on-1 对话）
- **Linear / Jira / RocketTeam = "管你的同事"**（人协作 PM）
- **Cairn = "管你的 AI 工人"**（管你和你的 agents 之间的工作现场，按 project，本机优先）

**为什么这三个范畴不重叠**：

- "帮你写代码" 的核心动作是 *agent ↔ user 1-on-1 对话生成 diff*。Cairn 没这个动作（§1.3 #1 / #2）。
- "管你的同事" 的核心动作是 *项目经理 ↔ 团队成员分配 issue + 跟进进度*。同事是人，有工资 / 工时 / 假期 / 跨公司协作。Cairn 没这个动作（§1.3 #5）。
- "管你的 AI 工人" 的核心动作是 *用户 ↔ 多个 agent 工作现场的 read + recommend + 授权执行 + 终态判断*。工人是 agent（不是人），没有工资 / 工时 / 跨公司，工作产物是 candidate / commit / diff / test result。

**Mode A · Mentor 在这个区分里的位置**：Mentor 推荐排好序的 work items + 干系人——但**干系人是 agent / role**（worker: claude-code-cli / reviewer: human / notify: codex-session-α），**不是同事**。Mentor 不会让用户 "@ 张三上工"，只会让 Cairn "spawn worker on candidate X 给 review queue"。这条边界是 §1.3 #5a 子句的具体体现。

**Mode B · Continuous Iteration 在这个区分里的位置**：Continuous 自动 chain 的是 **agent runs**（scout / worker / review process），不是 **人的工作分配**。停在 REVIEWED 等用户 Accept——这一行为 Cursor / Claude Code 不做（它们做完就完了），RocketTeam / Linear 也不做（它们不知道 review 这一段在 agent 工作流里是什么）。Continuous 是 Cairn 特有的中间层语义。

**Mode C · Multi-Cairn 在这个区分里的位置**：Multi-Cairn 共享 candidates 是 **Cairn 节点之间的 read-only federation**（每个节点是一个用户的本机），不是 **团队人员的协作面板**。两个用户用 Multi-Cairn 看见对方在做哪个 candidate，**不**等于他们在同一个 Linear workspace 里——他们没有共享 sprint / 共享 owner / 共享 burn-down。这是 §1.3 #8a 子句的具体体现。

**结论**：Cairn 在这张图里是**新范畴**，不是某个已有产品的 v2。误读为 "Cursor + Linear 缝合体" / "AI 版 Jira" / "Claude Code 的项目面板" 都是错的——这三种误读对应的是 §1.3 #1 / #5 / #3 反定义。

---

## 16. 开放问题

故意留空、等 dogfood 和实施过程中再收敛的问题。列出来是为了不假装它们已被解决。

1. **非 MCP-aware agent 接入规范**：Cursor / Cline / 部分 Aider 不接 `.mcp.json`。wrapper / sidecar / agent host hook —— 哪条路径成本可控？路径 b/c 在 §9.2 已分析，但具体实施未决。

2. **冲突仲裁的分级策略**：当前是"全部弹给用户"。是否引入"低风险自动处理、高风险弹给用户"的分级？分级的依据是什么（文件类型？改动范围？agent 信任度？）？Later 范畴。

3. **共享 scratchpad 的访问控制**：当前是单一共享空间，所有 agent 都能读所有 key。显式订阅模型（agent 只能读自己订阅的 key）增加多少复杂度？什么时候有用户痛点？

4. **模型 deployment 策略**：当前调外部 API（Claude Sonnet）。本地小模型作为备选 / fallback 的复杂度是否值得？dogfood 后再评估。

5. **隐私承诺的具体形式**：本地优先已定，但"哪些遥测是默认开启的"必须在 ship 前给一个明确清单。当前未定。

6. **Product MVP panel 的 polling vs event-driven**：MVP 用 polling（500ms-1s）+ SQLite update_hook 是基线方案；如果 update_hook 跨进程不可行，全 polling 的 CPU / 电量开销在长跑场景是否可接受？需要 benchmark。

7. **MVP panel 的 GUI 测试框架**：Electron + 长跑 read-only 视图 + 8 view 切换需要测试框架。Playwright Electron / Spectron / 手动？dogfood 阶段决策。

8. **Project selector 的发现机制**：MVP-4 需要列出"用户机器上有哪些 cairn project"。基于 `~/.cairn/cairn.db` 唯一文件还是支持多 db？多 cwd 怎么聚合？

9. **AI PMO recommendations 的 Later 路线**：Later 段列了"下一步建议"是 *eventually*。具体什么场景需要、什么时候触发、用什么模型评估——dogfood 才能告诉我们。

10. **mutation 路径的 Later 触发条件**：D9 锁了 MVP read-only。但什么 dogfood 信号会让 mutation 进入 next stage？用户高频跳到 agent / CLI 答 blocker 算信号吗？需要 MVP 之后的复盘。

11. **收费模式**：当前开源免费。长期是否走"免费核心 + 付费高级功能"？未决。

12. **小团队场景的产品边界**：mentor 提过"两个人都用 Cairn 时，agent 自动沟通同步"。这是另一个产品方向，跨机协作 + 团队认知一致性。是否在 Cairn 范围内？什么时候独立立项？

---

## 17. MCP 契约（kernel layer 工程事实）

> 本节是 kernel layer 已交付的 MCP 工具清单，作为 §6.1 表的展开。Product MVP panel 通过 SQLite read-only 直接读底层 8 类 state objects，**不**通过 MCP（MCP 是 agent ↔ daemon 通道）。但 MCP 工具仍然定义了 agent 能写入的语义集合，因此本节仍是 ground truth。

### 17.1 W1 已落地的 8 个 MCP 工具（kernel 底盘）

以下工具已在 W1-W2 实现并合并 main：

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

> R4b / R5 推迟到 Later。

**安装**：ships `cairn install` CLI — 详见 ARCHITECTURE.md §ADR-9。

### 17.3 W5 已落地的 11 个 MCP 工具（Task Capsule + Outcomes）

W5 Phase 1+2+3 闭环（2026-05-28）落地 W5 工具：

| Tool | 语义 | 对应能力 | 状态 |
|---|---|---|---|
| `cairn.task.create(intent, [parent_task_id])` | 创建 Task Capsule（PENDING） | 任务掌控感 | ✅ Phase 1 |
| `cairn.task.get(task_id)` | 读取 task 完整行 | 任务掌控感 | ✅ Phase 1 |
| `cairn.task.list([state, parent_task_id])` | 列出 tasks（按 state / parent 过滤） | 任务掌控感 | ✅ Phase 1 |
| `cairn.task.start_attempt(task_id)` | task PENDING / READY_TO_RESUME → RUNNING | 任务掌控感 | ✅ Phase 1 |
| `cairn.task.cancel(task_id, [reason])` | task → CANCELLED；reason 写入 metadata（atomic） | 任务掌控感 | ✅ Phase 1 |
| `cairn.task.block(task_id, question)` | task RUNNING → BLOCKED；blocker.OPEN | 任务掌控感 | ✅ Phase 2 |
| `cairn.task.answer(blocker_id, answer)` | blocker.ANSWERED；如所有 OPEN 已答 → task READY_TO_RESUME | 任务掌控感 | ✅ Phase 2 |
| `cairn.task.resume_packet(task_id)` | read-only aggregate（task + blockers + scratchpad keys + outcomes_criteria + audit summary） | 任务掌控感 | ✅ Phase 2 |
| `cairn.task.submit_for_review(task_id, criteria)` | upsert outcome（PENDING）+ task RUNNING → WAITING_REVIEW | 任务掌控感 | ✅ Phase 3 |
| `cairn.outcomes.evaluate(outcome_id)` | 跑 7 primitives；PASS → DONE / FAIL → RUNNING；PENDING-only | 任务掌控感 | ✅ Phase 3 |
| `cairn.outcomes.terminal_fail(outcome_id, reason)` | 给 path 放弃出口；TERMINAL_FAIL + task FAILED；PENDING-only | 任务掌控感 | ✅ Phase 3 |

**LD-8 wall**：故意**不**暴露 `cairn.task.list_blockers` / `cairn.task.get_blocker` / `cairn.outcomes.list` / `cairn.outcomes.get`——所有 blocker / outcome 访问通过 `resume_packet` 聚合（设计锁定）。

### 17.4 累计当前工具清单（28 工具，与 ARCHITECTURE.md §5 对齐）

scratchpad ×4 / checkpoint ×2 / rewind ×2 / process ×4 / conflict ×3 / inspector ×1 / dispatch ×2 / task ×8 / outcomes ×2 = **28 tools**。完整 alphabetical list 在 `tests/stdio-smoke.test.ts` 锁定。

### 17.5 楔成功判据（W1-W2 已超额完成）

8 个工具全部落地，task_id 切片实现，auto-checkpoint 实现，clean-tree rewind 实现。原 W3 验收目标（3 个非作者用户主动使用 rewind.to）合并入 Product MVP dogfood（MVP-15）。

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

## 19. 变更记录（v3 主体）

| 日期 | 变更 | 来源 |
|---|---|---|
| 2026-04-17 | PRODUCT.md v1 初稿，定位"桌面宠物 + 单对外 Agent + step-away-safe"，锁定五项歧义 | v1 收敛 |
| 2026-04-29 | PRODUCT.md v2，**重大方向转向**：定位由"桌面宠物 + 单对外 Agent"改为"多 agent 协作内核（Agent OS）"；五条用户故事全换；论题从 step-away-safe 换为 multi-agent collaboration kernel；v1 全文降级为附录 §18 | 2026-04-29 用户决策 |
| 2026-05-07 | canonical positioning install：锁"主机级多 agent 协作内核 / Task Capsule = OS primitive"；PRODUCT.md §0 + CLAUDE.md 顶部就位（v2 内部强化，未升级版本号） | 2026-05-07 用户决策 |
| 2026-05-08 | PRODUCT.md v3，**product surface reframe**：定位升级为"AI 编程项目的本机侧边控制层 / project-scoped agent work side panel / AI PMO layer"；user-facing 框架从 "MCP service + Floating Marker" 升级为 "desktop side panel + tray + ambient floating marker + Live Run Log"；五条用户故事改为 panel 视角 US-P1..P5（v2 US-D/R/A/I/S 保留为 §4.X kernel ground truth）；路线从 v0.1/v0.2/v0.3 多版本改为 Product MVP / Later 两段；新增反定义 #5 / #7 / #9 / #2（不是 Jira clone / 不是 plain MCP service / 不是 v1 桌面宠物 / 不是 Cursor clone）；新增 §1.2 四层架构 / §5.5 任务掌控感 / §6.2 MVP MUST 表 / §6.3 Later 表 / §8 全节 / §11.4 reframe 自身风险 / §12 D8-D10 / §15.4 Cairn vs Linear/Jira / §13 v1/v2/v3 演进表；kernel layer 28 工具 / 8 host-level state objects / 10 migrations / dogfood 32-of-32 完整保留 | 2026-05-08 用户决策 |
| 2026-05-08 | **§6.4 Agent Work Governance（Later）整合**：把 `Xproduct.md` 内部 design note 提炼为 PRODUCT.md 的下一层产品方向；新增 §6.4（governance 一节，含 6 候选能力 + 第一个可落地 demo Lightweight Pre-PR Gate + §1.3 反定义约束的边界澄清）；§6.3 Later 表加一行指向 §6.4；§7 加产品原则 #10（"AI 降低看见一切的成本，人仍然决定什么重要"）；§10.4 Later 加 governance 方向指引；§14 新增 7 条 governance 术语（Agent Work Governance / Project Rules Registry / Worker Report Protocol / Pre-PR Gate / Rule Adherence Record / Repeated Failure Pattern Log / Governance Debt）；当前 MVP 主定位（project control surface / project-scoped agent work side panel）**不变**——governance 严格在 Later，前置条件是当前 Project-Aware Live Panel dogfood 反馈；`Xproduct.md` 保留为更长 design note（PRODUCT.md §6.4 引用） | 2026-05-08 用户决策 |
| v4 (2026-05-10): added Mode A Mentor / Mode B Continuous / Mode C Multi-Cairn; loosened §1.3 #4/#5/#8 with explicit sub-clauses; introduced 5th architecture layer | PRODUCT.md v4 升级：在 v3 product surface reframe 上加 Operations layer（第 5 层）；§0 TL;DR + §1.1 升级出"AI engineering operations layer" framing（v3 "project control surface" 主句保留为用户感知形态）；§1.2 4 层 → 5 层；§1.3 #4 / #5 / #8 三条精确松绑（新增 #4a/#4b/#5a/#5b/#8a/#8b/#8c 子句），其余 6 条不变；§2.2 信念 #1 / #2 升级出"可见 + 可推荐 + 可执行（按授权）"三段语义；§6.5 新增 Operations layer 三节（Mode A · Mentor / Mode B · Continuous Iteration / Mode C · Multi-Cairn v0）；§15 新增 §15.5 Cairn vs Cursor / Claude Code / RocketTeam / Linear 五品类区分；kernel layer / Product MVP / §6.4 Agent Work Governance 论题不变，已交付的 28 工具 / 8 host-level state objects / 10 migrations / Three-Stage Loop v1 全部保留为 v4 supporting evidence | 2026-05-10 用户决策 |

---

> 本文是 Cairn 的定义性文档 v4。与本文冲突的任何 plan / note / 旧稿（包括 v1/v2/v3 PRODUCT.md）都以本文为准，除非经过显式的变更记录（§19）更新。
>
> **v4 升级的核心断言**：kernel layer（v2 论题）+ product layer（v3 论题）+ operations layer（v4 论题）三层平行存在；反定义内核不变，只精确松绑 §1.3 #4 / #5 / #8 三条以容纳 Mentor / Continuous / Multi-Cairn 三模式。已交付的 28 工具 / 8 host-level state objects / 10 migrations / Three-Stage Loop v1 不被升级贬值，是 v4 的 supporting evidence。
