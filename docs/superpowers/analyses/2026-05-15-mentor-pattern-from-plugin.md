# Mentor Pattern from CC PM Plugin — What Cairn Should Actually Borrow

> 日期：2026-05-15
> 作者职责：补足 `2026-05-15-cc-pm-plugin-vs-cairn.md` 漏掉的**元层**——插件的 mentor 模式 / 工作流形态 / 质量标准 loading 机制。
> CEO 鸭总 push back（2026-05-15）："插件的主要价值还在于他们的 mentor 的设计模式，以及怎么给出一个方案，到最终指导项目完成开发，这个核心价值我们也要学习，甚至可以为此改变当前的功能。"
> 配合 CEO 2026-05-15 早上 softening 指示："不要太体现 mentor 的话语" —— **结构借鉴，话语软化**。

---

## Table of Contents

1. 插件 mentor 模式的本质（5 bullets distilled）
2. Cairn 现状逐层对照：每层的"质量 bar"在哪、是 implicit 还是 explicit
3. 应该做什么改动（按优先级 HIGH / MED / LOW / DO NOT BORROW）
4. 结构借鉴 vs UI 软化 —— 那条线
5. 绝不借鉴清单（防漂移）
6. 是否需要改 PRODUCT.md，怎么改

---

## 1. 插件 mentor 模式是什么（5-8 bullets）

重新拷问 gist 之后，元层提炼如下。这一节描述的是**模式**，不是 feature list（feature 已在 §2 of 上一份分析里 zero-overlap 完成）。

### 1.1 它把"meta-work"拆成 7 个 named phase，每个 phase 有自己的"成品长什么样"

`/write-spec` 出 PRD、`/roadmap-update` 出 Now/Next/Later、`/synthesize-research` 出 themes + personas + opportunity points、`/competitive-brief` 出 feature matrix + positioning、`/metrics-review` 出 trend + target comparison、`/stakeholder-update` 出 audience-adapted status、`/brainstorm` 出 *position statement*。**关键点：每个 phase 的"成品 shape" 是 hard-coded 在 skill 文档里的，不是 LLM 自由发挥**。

### 1.2 Commands 是 thin trigger，Skills 是 thick quality bar

每个 slash command = 一个 LLM call + 一个对应的 markdown skill 文件被 inject 到 prompt 前缀。**Skill 文档是 plain markdown，用户可以编辑**（"把公司术语和分级标准补进技能文件"）。Skill 不是 process / pipeline / workflow，**是 standard**——"技能不是流程，是**标准**"。这是插件的核心心法：**质量 bar 与触发点解耦**。

### 1.3 Skills 是 runtime-loaded、可外置、按相关性 inject

加载时机：slash command 触发时，对应 skill markdown 被读出来当 system prompt 前缀拼上去。这意味着：
- 同一个 LLM model，七个不同 skill = 七种不同 output 形态
- 用户改 skill = 改 quality bar，不需要改代码
- 第三方写新 skill = 加新 phase，不需要改 plugin

### 1.4 Phase 之间 **loose coupling**——只有 brainstorm → write-spec 是 explicit handoff

绝大多数 phase 平行存在，互不强制 chain。Position statement 是唯一明面的接口（"会话收尾时，它给的不是清单，而是**一个立场**"），且会被 `/write-spec` 当 input 接住。**没有 master DAG 强制 idea → research → spec → roadmap → review 的顺序**。用户自己决定下一个 phase 是什么。

### 1.5 Five-phase brainstorm = LLM 单方主导的 5 turn 对话

立框 / 发散 / 挑衅 / 收敛 / 留痕。LLM 负责推进 phase 切换，不是用户敲指令切。**收尾产物不是 deliverable 是 position statement**：strongest direction + why + biggest unvalidated assumption + single next action。这是"mentor 不当记录员，当对手 / 督促者"的具体落地。

### 1.6 角色定位 = "有主见的 thinking partner"，不是 assistant

明面 vocabulary："搭档不是记录员"、"替你把第一个想法推到第四个"、"反驳你、追问你"、"唱反调"。**没有 "mentor" / "coach" / "advisor" 字面词**——但行为模型是 Socratic mentor：question-driven、assumption-challenging、position-forcing。

### 1.7 Tool-agnostic via category placeholder（与本分析无关，上一份已抽过，不重复）

### 1.8 总览：插件把"如何做 X"知识沉淀成 *editable markdown rubric*，而不是 prompt-baked-in 或 code

这是最值得 Cairn 学的元结构。**插件没有把 "how to write a PRD" 硬编码在 plugin TypeScript 里**——它把这条知识放在 `feature-spec.md` skill 文件，用户能 cat / vim / sed 改。这一条对 Cairn 的启发最大（详 §3.1）。

---

## 2. Cairn 现状逐层对照

对七个有"质量 bar"语义的 layer 做 audit：当前 quality bar 是 implicit（hardcoded in prompt） 还是 explicit（runtime-loaded markdown）？是否能从 skill-doc 外置中获益？

| Layer | 文件 | 当前 quality bar 形态 | Implicit / Explicit | 适合 skill 外置？ |
|---|---|---|---|---|
| **2.1** Scout 起 Mode A plan | `mode-a-scout.cjs::buildScoutPrompt` | 长 system prompt 内联（"3-8 steps, 30min-2hr 体量, label 写 milestone 不写具体行动"）+ CAIRN.md `## Plan Shape` / `## Plan Hard Constraints` / `## Plan Authority` 三段（已 runtime-loaded） | 混合：硬规则 implicit 在代码，per-project 部分 explicit 在 CAIRN.md | **YES, 强**——硬规则部分应该外置 |
| **2.2** Lead-CC boot prompt | `mode-a-spawner.cjs::buildBootPrompt` | 长 prompt 内联（"call cairn.session.name / read inbox / cairn.task.create / cairn.task.submit_for_review / 不要问用户"）+ CAIRN.md profile（north star / constraints / authority） | 混合：protocol implicit, per-project explicit | **MED**——protocol 是 kernel contract，硬编码合适；handoff shape 可外置 |
| **2.3** Mentor advisor prompt | `mentor-prompt.cjs::buildHardRules + buildOutputFenceInstruction` | 9 条 STRICT RULES + schema invariants 内联 + signals categorized 渲染 | Implicit | **MED**——硬规则不外置（安全 bar），output shape **可**外置 |
| **2.4** Mentor LLM judge / off-goal | `mentor-tick.cjs::evaluateRuleC_offGoal` + `cockpit-llm-helpers.cjs::judgeOffGoal` | LLM prompt 内联在 helper | Implicit | **LOW**——judge prompt 短，外置 ROI 低 |
| **2.5** Mentor-tick rules B/C/D/E/G | `mentor-policy.cjs::DEFAULTS` + per-rule evaluators | numeric thresholds in `DEFAULTS` (`errorNudgeCap: 2`, `timeBudgetEscalationFraction: 0.80`)；rule logic in code | Implicit, code-level | **NO**——这是 *policy machinery* 不是 quality bar |
| **2.6** Outcomes evaluator | `packages/mcp-server/src/dsl/evaluator.ts` + 7 primitives | DSL primitives are *deterministic*（`tests_pass / files_exist / regex_match / ...`）；no LLM | Explicit but as **DSL** not markdown | **NO**——已经是最强 explicit；不需要 skill 化 |
| **2.7** CAIRN.md per-project policy | `docs/CAIRN-md-spec.md` + `mentor-project-profile.cjs::loadProfile` | per-project markdown sections（`## Whole / ## Goal / ## Mentor authority / ## Plan Shape / ## Plan Hard Constraints / ## Plan Authority`）at runtime loaded by scout / spawner / mentor | **Explicit, runtime-loaded markdown** | **已经是这个模式** |

### 2.x 关键发现

**Cairn 已经有 skill-doc 模式的雏形——就是 CAIRN.md**。每个 project 一份 markdown，rumtime loaded 进 Scout / Lead-CC / Mentor-tick 三个地方。这跟插件的 skill 文档非常像。

**差异 / gap**：CAIRN.md 是 *per-project* 文件，是用户对 Cairn 的项目级授权。插件的 skill 是 *cross-project, per-phase* 的 "how to do X well" 标准（PRD 该长啥样、roadmap 该长啥样）。Cairn **没有** cross-project 的"how to do X"层——所有关于"good plan = 3-8 steps, milestone-not-action"的标准都硬编码在 `mode-a-scout.cjs` 的字符串里。

**这就是值得借鉴的 gap**：把 implicit hardcoded quality bar 抽出来变成 `~/.cairn/skills/<name>.md`，让所有项目共享，让 power user 可改。

---

## 3. 应该做什么改动（HIGH / MED / LOW / DO NOT）

### 3.1 [HIGH-1] 抽 Scout 的 "what a good plan looks like" 到 `~/.cairn/skills/plan-shape.md`

**问题**：当前 `buildScoutPrompt` 里硬编码 "3-8 steps / 30min-2hr 体量 / label 写 milestone 不写行动 / step 顺序按依赖排"。这条知识 (a) 跨所有 project 通用 (b) 用户改不了 (c) 调改要发新 build。

**改动**：
- 新建 `~/.cairn/skills/plan-shape.md`（首次启动时从内置 default 写出）
- `mode-a-scout.cjs::buildScoutPrompt` runtime 读这个文件，inject 到 prompt 的 `## Hard rules` 段之前
- per-project CAIRN.md `## Plan Shape` 仍然 override / append（已有，不变）
- 用户可以 `vim ~/.cairn/skills/plan-shape.md` 调全局默认；CAIRN.md 调 per-project override

**Cited 文件**：`packages/desktop-shell/mode-a-scout.cjs` 的 lines 230-260 (`## Hard rules`) → 抽到 skill 文件。

**Migration**：(a) 新增 `packages/desktop-shell/skills-loader.cjs` (pure, no I/O dep)；(b) 写默认 plan-shape.md content；(c) install hook 把 default 拷到 `~/.cairn/skills/`；(d) `buildScoutPrompt` 调用 loader；(e) smoke `scripts/smoke-skills-loader.mjs` + 重跑 `scripts/diagnose-mode-a.mjs` 确认 gate 1-8 通过。

**Effort**：6-8h（含 default content + loader + smoke + docs）。

**Why HIGH**：(1) 直接对齐插件 mentor 模式的核心心法（quality bar 外置 + editable）；(2) 解耦 build-time / runtime；(3) 给非开发者用户一个"调整 Cairn 行为"的 zero-code 路径，对齐 README "Customize by editing text not code"。

---

### 3.2 [HIGH-2] 抽 Mentor advisor 的 output shape 到 `~/.cairn/skills/mentor-recommendation.md`

**问题**：`mentor-prompt.cjs::buildOutputFenceInstruction` 把 work item JSON schema（id / description / why{impact,cost,risk,urgency} / stakeholders{owner,reviewer,notify} / next_action / evidence_refs / confidence）硬编码在 prompt。这个 shape 是产品契约的一部分，但 (a) 出 panel UI 要改时这里也要改；(b) 业内 advisor output shape 有讨论空间（confidence interval / top-K / why 是否要细分 cost/risk/urgency）；(c) 不同 model 适合不同 shape 时改 prompt 要发新 build。

**改动**：
- 新建 `~/.cairn/skills/mentor-recommendation.md`（含 schema invariants 1-5 + closed-set values + 输出 shape）
- 9 条 STRICT RULES（permission boundary）**留在代码里**——这是安全 bar 不是 quality bar
- `mentor-prompt.cjs::generateMentorPrompt` 改成：hard rules from code + output shape from skill file
- schema invariants 仍在代码里 enforce（schema validator 不动），skill 文件是给 LLM 看的"指引"——双 belt 防漂移

**Cited 文件**：`packages/desktop-shell/mentor-prompt.cjs` lines 113-184 抽走；lines 62-110 (STRICT RULES) **留**。

**Migration**：3 commits — (1) loader + default skill md；(2) prompt 重构；(3) smoke `scripts/smoke-mentor-prompt-skill.mjs`。

**Effort**：5-7h。

**Why HIGH**：(1) advisor output 是 Mode A · Mentor 跟用户的核心契约，外置后 evolution 不破 schema；(2) 让 cockpit redesign 团队改 panel UI 时不用改 prompt 代码——直接动 skill 文件即可；(3) 给后续 model swap（Claude / Codex / Gemini）准备好——每 model 一份 skill 变体也可以。

---

### 3.3 [HIGH-3] 抽 Lead-CC boot prompt 的 "what good handoff looks like" 到 `~/.cairn/skills/handoff-protocol.md`

**问题**：`mode-a-spawner.cjs::buildBootPrompt` 把 "call cairn.session.name / read inbox / cairn.task.create with dispatch_id / submit_for_review then outcomes.evaluate / 不要问用户 → 用 cairn.task.block" 硬编码。当 Cairn protocol 演化（v0.2 加 cairn.task.resume_packet auto-call？），改这里要发新 build。

**改动**：
- `~/.cairn/skills/handoff-protocol.md` 描述 boot-prompt 的 protocol contract
- `buildBootPrompt` runtime 读取，inject 到 `## What to do` 段
- per-project CAIRN.md `## Handoff overrides` (可选 section) override

**Cited 文件**：`packages/desktop-shell/mode-a-spawner.cjs` lines 117-146（`## What to do` + `## Required protocol`）。

**Migration**：2 commits + 1 smoke。

**Effort**：4-5h。

**Why HIGH**：与 1.2 / 1.3 是同一心法；做了前两个不做第三个就只完成了 2/3 的 mentor 模式借鉴；handoff-protocol 是 kernel contract 的"外门面"，外置可降低 kernel evolution 的修改面。

---

### 3.4 [MED-1] 每个 Mode A 步骤一个 "what good looks like" expandable hint

**改动**：panel UI 在 Mode A plan steps 每条加一个 `?` icon，hover / click 展开当前 skill doc 的对应段落（前提：3.1 / 3.3 已完成）。读 skill markdown 渲染到 panel。

**Cited 文件**：`packages/desktop-shell/panel.html` + `panel.js` + new `panel-skill-renderer.js`。

**Effort**：4-6h（panel UI 单独工作量）。

**Why MED**：对非开发者主用户友好（PRODUCT.md §3.1 patch）；不改 pipeline；不动 schema。但**前提是 §3.1 / §3.3 已落地**——没有 skill 文件就没法 render hint。

---

### 3.5 [MED-2] Mentor 输出加 "position statement" 三段尾巴

**改动**：mentor-prompt.cjs 的 work_items JSON 之后追加一个 `position_statement: { direction, why, biggest_unvalidated_assumption, next_action }` 顶层字段。schema validator 加规则。panel Mentor sub-section 把这段当固定底部 box 渲染（accent 灰，不抢 work_items 视觉重点）。

**Cited 文件**：`packages/desktop-shell/mentor-prompt.cjs`（output schema 改）+ `panel.js`（render）+ `docs/mentor-layer-spec.md`（schema doc）。

**Effort**：4-6h。

**Why MED**：直接借鉴插件 brainstorm 闭合 ("一个立场" 模式)；提升 Mentor 输出的可审性（"凭什么排这样" 显式化）；但**不是 critical path**——work items 已经够用，position statement 是锦上添花。

**注意**：UI 上**不用** "立场" / "position statement" 字面词——用 "Why this order" / "What might be wrong" 等中性 phrasing（§4 软化原则）。

---

### 3.6 [LOW-1] Brainstorm 五阶段命名作为 Mentor follow-up question 风格

**改动**：当用户在 panel Mentor chat 追问 "为什么把 X 排前面"时，让 follow-up prompt 切到"挑衅 / converge"风格——不是给新答案，而是 challenge 用户的前提或 force 收敛。

**Why LOW**：UX polish；调 follow-up prompt 比改 main prompt ROI 低。先把 HIGH 做完。

---

### 3.7 [LOW-2] CAIRN.md `## Skill overrides` section

让 per-project CAIRN.md 可以塞 `## Skill: plan-shape` / `## Skill: mentor-recommendation` 段，append 或 override 全局 skill。

**Why LOW**：YAGNI 风险——99% 项目用全局 default 就够了；先看 HIGH 3 个落地后真有几个项目要 override 再加。

---

### 3.8 [DO NOT BORROW]

| 反例 | 为什么不借鉴 |
|---|---|
| **Slash-command-as-trigger** | Cairn 是 daemon / event-driven，用户不在 chat 敲 `/write-spec`——他打开 panel 看状态。借这个会把产品形态拉成 CC plugin（§1.3 #10 lock）。 |
| **PM job verbs（PRD / roadmap / stakeholder / metrics-review）** | §1.3 #5 反定义硬底线：不写文档、不做 sprint planning、不出 stakeholder update。这条永远不松。 |
| **`/synthesize-research` / `/competitive-brief`** | 同上 + §1.3 #6（不是 generic agent framework）。 |
| **Plugin marketplace 分发** | Cairn 是 daemon-class 本机 app（memory `cairn-is-daemon-app-not-cli`）；skill 文件夹是用户家目录，不进任何 marketplace。 |
| **5 phase brainstorm 5 turn 对话作为 Mentor 的默认模式** | Mentor `不持续后台运行 / 每次 chat turn 是一次显式触发`（PRODUCT.md §6.5.1）；强行 5 turn dialogue 跟 panel ambient nudge 心法不合。**可以**借这个命名做 follow-up phrasing（§3.6），但不借 dialogue 结构本身。 |
| **Academic serif + 松柏绿配色** | DESIGN.md 锁配色为 accent 蓝 + alert 红 + 灰阶。 |
| **"搭档" / "thinking partner" 自称** | softening 指示直接禁止：UI 不能说自己是 mentor / 搭档 / advisor。 |

---

## 4. 结构借鉴 vs UI 软化 —— 那条线

这是这份提案最 critical 的 trade-off。

**插件的 mentor 模式有两面**：

1. **内部结构面**：skill markdown 作为 runtime-loaded quality bar，外置 / editable / per-phase。**这一面 Cairn 全盘可借鉴**——它是 prompt engineering 的工程模式，跟产品定位无关。
2. **外部话语面**：自称 "搭档 / partner / thinking partner / opponent"，五阶段 brainstorm UI 显式标 "挑衅 / 收敛"，输出强调 "一个立场"。**这一面 Cairn 完全不借鉴**——CEO softening 指示直接 veto。

**那条线在哪里**：**用户看见的所有文字、按钮、section header、tooltip、log message 都不用 "mentor / advisor / coach / partner / 搭档" 字面词；但 `~/.cairn/skills/*.md` 文件名、source code module 名（`mentor-policy.cjs`）、内部 prompt（LLM 看到的）可以保留 "Mentor advisor" 措辞**。

具体落地：

| 层 | "Mentor" 字面词 | 例 |
|---|---|---|
| **Panel UI 文案** | ❌ 禁 | 不写 "Ask the Mentor"；写 "Get suggestions" / "Show recommendations" |
| **Tray / floating marker hint** | ❌ 禁 | 不写 "Mentor is thinking"；写 "Looking at your project..." |
| **Activity feed event labels** | ❌ 禁 | 不写 "Mentor escalation"；写 "Needs you" / "Needs review" |
| **Skill 文件名** | ✅ 可保留 | `~/.cairn/skills/mentor-recommendation.md`（power user 看到，OK） |
| **Source code module / log channel** | ✅ 保留 | `mentor-tick.cjs` / `cairnLog.info('mentor-tick', ...)`（开发者看到） |
| **LLM 系统 prompt** | ✅ 保留 | "You are Cairn's Mentor advisor..."（LLM 内部，用户看不到） |
| **PRODUCT.md / ARCHITECTURE.md / spec doc** | ✅ 保留 | "Mode A · Mentor" 已经写满产品文档（设计语义） |
| **Public README / pitch / 落地页** | ⚠️ 谨慎 | 可说 "Cairn recommends what to do next"，少用 "Mentor"——尤其向非开发者用户 |

**关键判定**：mentor 是 **internal role name**（系统内部 / spec / source）；对外**显示**用动词或目的（recommend / suggest / show next / needs you）而不是名词角色。这跟插件类似——插件文档明面用"搭档"，但 UI 上 slash command 是 `/write-spec` 不是 `/ask-mentor`，**角色定位走内化路径**。

---

## 5. 绝不借鉴清单（防漂移）

补 §3.8 之外的 deep cuts：

1. **"PRD-shaped" task description**——Cairn task / candidate / blocker 的 description 字段 **绝不**变成 user-story 模板。Cairn 不写文档；§1.3 #1 硬底线。
2. **RICE / MoSCoW 优先级框架内置**——work_items 的 `why{impact,cost,risk,urgency}` 已经够，**不**演化成 RICE 评分 UI。RICE 是 PM 工具，Cairn 是 project control surface。
3. **Stakeholder = 人**——work_items.stakeholders.notify 已经规定 "agent role / kind strings only, NO real names"（mentor-prompt.cjs:165）。不松。
4. **Five-phase 显式 UI**——不要在 Mentor chat panel 加 "phase 1 / 2 / 3" 进度条。chat 是 stateless turn。
5. **"Position statement" 作 UI 一等公民标题**——§3.5 提案里说了用中性 phrasing；任何 "立场 / position" 字面词只能在 spec 文档出现，不上 UI。
6. **Skill 文件作为 plugin 接入点**——Cairn 不引入第三方 skill / 不接入 plugin marketplace / 不允许 skill 文件挂 hook 或调外部 process。Skill 是**纯文本，纯 prompt prefix**，无副作用。
7. **/brainstorm 作为 Cairn 的入口** — Cairn 没有 slash command 入口；user-facing 入口仍是 panel + tray + ambient marker。

---

## 6. 是否需要改 PRODUCT.md？

**Yes**——但只是补一段 §6.5.1 的实现细节，不动 §1.3 反定义、不动 §0 / §1.1 定位、不动 §1.2 五层架构。

**改动建议**（如果 3.1 / 3.2 / 3.3 都 ship）：

### 6.1 §6.5.1 Mode A · Mentor 末尾追加一段

提议新段："**Skill 外置（v4 patch · 2026-05-15）**"：

```markdown
**Skill 外置（v4 patch · 2026-05-15）**

Mode A · Mentor / Mode A Scout / Mode A Lead-CC boot 三处的"质量 bar"
（plan 该长啥样 / advisor 输出 shape 是啥 / handoff protocol 是啥）
从 hardcoded prompt 字符串迁移到 `~/.cairn/skills/*.md` markdown 文件，
runtime-loaded。用户可编辑：

- `~/.cairn/skills/plan-shape.md` — Scout 起 plan 的 shape 标准
- `~/.cairn/skills/mentor-recommendation.md` — Mentor advisor 输出 shape
- `~/.cairn/skills/handoff-protocol.md` — Lead-CC boot 的 handoff protocol

per-project `CAIRN.md` 仍可 override 全局 skill。这条迁移**不引入新 schema / 
新 MCP tool / 新 host-level state**——纯 prompt engineering 工程改造，
让"什么算 good output"这条知识从代码沉到 markdown，对齐 Cairn 的 
"customize by editing text not code" 哲学（README）。

边界保留：advisor 的 9 条 STRICT RULES（permission boundary）**留在代码里**，
不外置——这是安全 bar 不是 quality bar，不接受用户运行时编辑。
```

### 6.2 §3.1 主用户 B（非开发者）段落补一行

提议加："非开发者用户能通过编辑 `~/.cairn/skills/*.md` 微调 Cairn 输出风格，不需要写代码——对齐 Customize-by-text 原则（README）。"

### 6.3 §1.3 反定义 — **不动**

特别要明确：Skill 外置**不需要**松绑任何反定义。
- §1.3 #1（不写代码）：skill 是 prompt text，不是 code generation。
- §1.3 #5（不是 Linear / Jira）：skill 文件不是 issue / story / sprint 实体。
- §1.3 #6（不是 generic agent framework）：skill 不暴露给第三方 / 不发 marketplace。
- §1.3 #10（不是 plugin）：skill 在 `~/.cairn/skills/`，daemon 自己管，不挂任何 agent 的 plugin 机制。

### 6.4 不动的部分（明列以防漂移）

- §0 TL;DR — 不动
- §1.1 一句话定位 — 不动
- §1.2 五层架构 — 不动
- §1.3 反定义全部 — 不动
- §2 论题 — 不动
- §6.2 Product MVP read-only D9 — 不动
- §6.5.2 Mode B / §6.5.3 Mode C — 不动

---

## 7. Open Questions for CEO

仅这三条，其余 §3.8 / §5 已 self-decided：

1. **§3.1 / §3.2 / §3.3 是否一起 GO？**——三个 HIGH 同源同心法，分开做 ROI 减半。预计合并工作量 15-20h，约 2.5 个工作日。可逆（skill 不工作时 fallback 到 hardcoded default 即可）。CLAUDE.md Decision Rules"可逆 / 局部 / 5 分钟撤销"原则其实可以 agent 自决，但因为牵涉 PRODUCT.md §6.5.1 改写所以提 CEO。
2. **§3.5 position-statement 三段尾巴**做不做？——美化 Mentor 输出，但跟 §3.1-3.3 不绑。可以推迟到 cockpit redesign 之后。
3. **README 是否要加一段 "Customize by editing skills, not code"**？——若加，是非开发者主用户的第一触点信号，对齐 PRODUCT.md §3.1 patch。

---

## Appendix A — 关键 Cairn 文件 cross-ref

- `packages/desktop-shell/mode-a-scout.cjs` lines 163-262（`buildScoutPrompt` + Hard rules → §3.1 抽取目标）
- `packages/desktop-shell/mode-a-spawner.cjs` lines 72-148（`buildBootPrompt` → §3.3 抽取目标）
- `packages/desktop-shell/mentor-prompt.cjs` lines 62-184（buildHardRules + buildOutputFenceInstruction → §3.2 拆 STRICT RULES 留 / output shape 抽）
- `packages/desktop-shell/mentor-policy.cjs` DEFAULTS（rules thresholds，**不**外置）
- `packages/mcp-server/src/dsl/evaluator.ts`（outcomes evaluator，**已**最佳形态）
- `docs/CAIRN-md-spec.md` v2 schema（per-project skill override 的现有 surface）
- `docs/mentor-layer-spec.md`（mentor 内部架构 spec）
- `docs/superpowers/analyses/2026-05-15-cc-pm-plugin-vs-cairn.md`（前一份 functional analysis，本文补元层）
- `~/.claude/projects/D--lll-cairn/memory/feedback_cairn_md_auto_authored.md`（CAIRN.md auto-author 心法——skill 文件同理：用户不写冷文档，default-from-template + edit）

## Appendix B — 借鉴 / 不借鉴一句话总览

| 维度 | 插件做法 | Cairn 处理 |
|---|---|---|
| Quality bar 与触发点解耦 | skill md + slash command | **借**——`~/.cairn/skills/*.md` + 事件触发（不是 slash command） |
| 每 phase 输出 shape | hardcoded in skill md | **借**——抽到 skill md，与代码解耦 |
| 用户改 markdown 调整产品行为 | 是 | **借**——README 加 "Customize by editing text not code" |
| Loose coupling between phases | 是 | **已有**——Mode A / B 已经是 loose chain |
| "Position statement" 闭合 | 是 | **借**（弱）——work_items 后加 position_statement field，UI 中性 phrasing |
| 五阶段 brainstorm 名字 | 立框/发散/挑衅/收敛/留痕 | **不上 UI**——可用于 follow-up prompt 风格 |
| Slash command 触发 | 是 | **不借**——daemon / event-driven |
| PM job verbs（PRD / roadmap / stakeholder） | 是 | **不借**——§1.3 #5 反定义硬底线 |
| 自称 "搭档 / partner / mentor" | 是 | **不上 UI**——internal role name only |
| Plugin marketplace | 是 | **不借**——daemon-class，本机一等公民 |
- end -
