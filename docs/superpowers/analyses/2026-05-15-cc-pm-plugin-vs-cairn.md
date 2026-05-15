# CC PM Plugin vs Cairn — 影响分析

> 日期：2026-05-15
> 分析对象：`product-management` plugin（knowledge-work-plugins 系列第 2 章 / 共 11 章），v1.2.0，Apache-2.0
> 源 URL（raw HTML gist）：`https://gist.githubusercontent.com/LiuShiyuMath/4a17d28ca28c79f3591fa87d22701f73/raw/product-management-plugin-20260514-154427.html`
> 目的：判定 functional overlap、抵抗定位漂移、抽取可借鉴 design / implementation / vocabulary、给出 CEO 决策清单
> Positioning lock（CEO 鸭总 2026-05-15）："我们不是做的依附于 cc 的产品，最终形态一定是在所有本机 agents 之上的一个产品"

---

## Table of Contents

1. CC PM 插件做什么（去 marketing）
2. Functional overlap matrix with Cairn
3. Positioning differentiation — "我们不漂移" 过滤
4. 可借鉴的 design + implementation 想法
5. 详细方案：Cairn-side feature 提议（TOP 1-2）
6. Recommendations / decisions for CEO

---

## 1. CC PM Plugin IS（concrete features only）

### 1.1 形态总览（fact-checked from gist）

- **Plugin shape**：Claude Code / Claude Cowork 的**插件**。安装路径有二：(i) marketplace 注册后 `claude plugin install product-management@knowledge-work-plugins`；(ii) Claude Cowork 的 `claude.com/plugins` 一键安装。
- **代码位置**：`anthropics/knowledge-work-plugins` repo。配置目录 `~/.claude-minimax`（推断 CC 用户配置目录的一个 sibling 或 fork）。
- **运行时容器**：CC（TUI）/ Cowork（web）。**不**自带桌面 surface / tray / 桌面侧边窗 / 后台 daemon。**没有**独立进程、没有 SQLite、没有 MCP server。
- **"两层设计"自述**：commands（显式 workflow）+ skills（quality standards）。所有 mutation 都在 CC session 内通过用户敲 slash command 触发。

### 1.2 七个 slash commands（feature 主体）

| 命令 | 输入 | 输出 | 实现推断 |
|---|---|---|---|
| `/write-spec` | problem statement | PRD：user stories、需求优先级、success metrics、scope、open questions | CC skill markdown + 内置 LLM prompt template |
| `/roadmap-update` | now/next/later 或 quarter themes 或 OKR | roadmap 文档（含 dependency mapping） | 同上 |
| `/stakeholder-update` | audience（exec / eng / customer）+ context | 听众-定制的 status update | 同上，加 MCP 连接器拉 context |
| `/synthesize-research` | interview transcripts / survey / support tickets | thematic synthesis + persona + evidence-backed opportunity | 同上，下游接 TeamBrain |
| `/competitive-brief` | 对手列表 / 类别 | feature matrix + positioning + strategic implications | 同上 |
| `/metrics-review` | 指标数据 | trend / target comparison / actionable conclusions | 同上 |
| `/brainstorm` | 议题 | 五阶段对话：立框 / 发散 / 挑衅 / 收敛 / 留痕 | LLM dialogue skill，不出 deliverable，靠交互 |

### 1.3 七个 skills（"professional standards"）

`feature-spec` · `roadmap-management` · `stakeholder-comms` · `user-research-synthesis` · `competitive-analysis` · `metrics-tracking` · `product-brainstorming`。

每个 skill 是 markdown 规范文档（推断 CC skill 标准结构：YAML frontmatter + 描述 + judgment area），CC 在执行 slash command 时把对应 skill 作为 quality bar 加载到 prompt。

### 1.4 "Tool-agnostic connector model"（值得记下）

用 **category placeholders**（`~~project tracker` / `~~chat` / `~~knowledge base` / `~~design` / `~~product analytics` / `~~user feedback` / `~~meeting transcription` / `~~competitive intelligence`）描述外部 SaaS 接入，**不**写死 Linear / Notion / Figma。每个 placeholder 预集成多个 MCP servers（如 `~~project tracker` = Linear + Asana + monday + ClickUp + Atlassian）。无连接时 fallback 到"用户手动 paste context"。

### 1.5 五阶段 brainstorm 结构（vocabulary 值得借鉴）

立框 · 发散 · 挑衅 · 收敛 · 留痕 — 自陈"搭档不是记录员"（partner isn't a note-taker）。close 时给出 "position statement"：最强方向 + 理由 + 关键未验证假设。

### 1.6 State storage / surface

- **State 存哪**：Plugin 自身不持久化结构化 state。所有输出是**对话 turn 内的 markdown**（PRD / roadmap / update doc）。下游入 TeamBrain（外部产品）或外部 SaaS（Linear / Notion / Figma 等）。CC session JSONL 自然包含历史，但**没有**独立 schema。
- **UI surface**：CC TUI（slash command 输出渲染为 markdown）+ Cowork web。**没有** sidebar / tray / panel / 桌面控件。
- **Triggers**：100% 用户敲命令；**没有** hook / 后台 watcher / 定时任务 / 事件驱动。

### 1.7 Differentiator 自述

> "通用的 Claude 会写文档、会分析，但它不知道一份 PRD 该长什么样"

定位为"职业惯例问题"——不是模型能力问题，是 domain conventions（PRD 结构 / RICE 优先级 / 听众分层沟通模式）。**Customization** 走改 text file（不是改代码），让用户能换 tool stack / 加公司 terminology。

### 1.8 Visual / vocabulary

- Academic journal serif（Fraunces + Noto Serif SC）+ 松柏绿 `#2b4a3f` + 赭石 `#9a5f1c`。营造"知识工作 / 专业读物"感。
- Vocabulary："岗位插件深读"、"职业惯例"、"两层设计"、"搭档"、"留痕"、"立框 / 发散 / 挑衅 / 收敛"。

---

## 2. Functional overlap matrix with Cairn

| CC PM 插件 feature | Cairn 等价（文件/模块/状态对象） | Overlap | Notes |
|---|---|---|---|
| `/write-spec` PRD generator | 无 | **none** | Cairn 不写 PRD、不生成文档。PRD 是 *coding agent* 的产出，不是 Cairn 的范畴（§1.3 #1）。 |
| `/roadmap-update` | 无（且 §1.3 #5 反定义 veto） | **none** | Cairn 反 sprint / story point / burn-down。Mentor (Mode A) 给 ranked work items，但**绑当下信号、不是 quarter roadmap**，且仅引用现有 candidates / tasks，不引入 issue / story 实体。 |
| `/stakeholder-update` | 无 | **none** | Cairn 不写 status update 给外部 audience。panel 是程序员自己看的，不是 exec dashboard。 |
| `/synthesize-research` | 无 | **none** | Cairn 不做 user research。 |
| `/competitive-brief` | 无 | **none** | 同上。 |
| `/metrics-review` | 无 | **none** | Cairn 不接 product analytics（Amplitude / Pendo）。kernel state 是 agent work 现场，不是产品业务指标。 |
| `/brainstorm` 五阶段对话 | 无（最近邻：office-hours skill，但是 gstack 而非 Cairn 的） | **none in Cairn** | Cairn 不是对话产品。但**五阶段命名是 vocabulary 借鉴点**——见 §4。 |
| 7 skills "professional standards" | 无 | **none** | Cairn 不做 PM playbook。 |
| Tool-agnostic connector model（`~~project tracker` etc） | partial：Mentor (Mode A) 读多源信号（git log / PRODUCT.md / candidates JSONL / kernel SQLite），但**不**接 Linear / Notion / Figma | **partial** | 抽象很对，**但 Cairn 不接 SaaS PM 工具**。Mode A 读的是本机项目信号。借鉴点：用 category placeholder 表达 input source。详 §4。 |
| Five-phase brainstorm structure | 无 | **none** | 但 vocabulary 可借鉴到 Mentor chat / cockpit 文案。 |
| Plugin shape（CC plugin） | 反例 | **anti-pattern** | Cairn 显式**不**是 CC plugin（CEO lock 2026-05-15）。 |
| State 在 CC session JSONL | Cairn = SQLite + 10 migrations + 8 host-level state objects | **opposite stance** | CC PM plugin: agent-local，CC restart 丢；Cairn: project-scoped，跨 session / 跨 agent / 跨机器重启不丢。**结构性差异**。 |
| UI = TUI slash output | Cairn = desktop side panel + tray + ambient floating marker（read-only） | **none** | 完全不同 surface。 |
| 触发 = 用户敲命令 | Cairn = MCP tool call + git hook + 1s polling + Mode A loop | **none** | 完全不同 trigger 模型。 |

**结论**：**功能层 zero overlap**。CC PM plugin 解的是"PM 岗位职业惯例"问题；Cairn 解的是"程序员在 multi-agent 项目里失去掌控感"问题。受众不同（PM vs 程序员/非开发者），surface 不同（TUI vs 桌面 panel），生命周期不同（session-scoped vs project-scoped），层级不同（CC-plugin-above vs all-agents-below）。

---

## 3. Positioning differentiation — "我们不漂移" 过滤

逐条核对 CC PM plugin 的**所有**主张是否会拉 Cairn 漂移，给出结构性区别（不是"我们更好"）。

### 3.1 维度对比表

| 维度 | CC PM plugin | Cairn | 结构性差异（不是 "better"） |
|---|---|---|---|
| **Layer** | Above CC（plugin） | Below all agents（kernel） | 一个寄生 CC，一个 host 所有 agent。CC 关了 plugin 死，Cairn 关了 CC 还在跑。 |
| **Scope** | Single-agent（CC）+ single-session | Multi-agent，跨 CC / Cursor / Codex / Aider / Cline / subagents | 一个的世界里只有一个 agent，一个的世界里有 N 个 agent 同时 ↔ 协调状态。 |
| **State ownership** | Agent-local（CC session JSONL） | Project-shared（`~/.cairn/cairn.db`，8 host-level state objects） | CC 关掉 plugin 状态作废；Cairn 状态属于 project，跨 agent 实例 / 跨 OS 重启稳。 |
| **Failure mode under CC death** | Plugin state 全丢，下次 session 从零 | Tasks / blockers / outcomes / checkpoints / conflicts 全在；新 agent 进来 `cairn.task.resume_packet(task_id)` 就能接力 | Cairn 的卖点恰恰是 "CC 进程死了之后还在"。 |
| **Audience** | Product managers（PM 岗位） | 程序员 + 非开发者用户（用 agent 推进编程项目的人） | Cairn 不服务 PM 岗位职业惯例；服务的是"项目掌控感"。 |
| **Coding-vs-meta** | 100% meta-work（PRD / roadmap / brief / metrics review，全是文档生成） | 100% project control surface（看 agent **正在做的代码工作**走到哪、卡在哪、能否回退） | 一个是"准备做啥"（pre-work doc），一个是"做的过程怎么样"（in-flight control surface）。 |
| **Mutation model** | Slash command → LLM turn → markdown 输出 | MCP tool call → SQLite write → state machine 12 transitions；panel 默认 read-only（D9） | 一个是 stateless dialogue artifact，一个是 stateful, auditable state object lifecycle。 |
| **Trigger** | 用户每次手动敲 `/cmd` | MCP / git hook / 1s poll / Mode A loop / unattended pipeline（HITL 是 escalation path 不是 blocking gate，§1.4） | 一个 100% HITL，一个 unattended by design。 |
| **Reasoning role** | Plugin 借 LLM **替用户起草** PRD / brief | Cairn **不替用户拍板** + **不替 agent reasoning**（§1.3 #1, #4 硬底线） | Cairn 反"用 LLM 出战略意见"（cockpit Mentor 的精确边界，PRODUCT.md §1.3.cockpit）。 |
| **External SaaS coupling** | 重度（Linear / Notion / Figma / Amplitude / Slack / Intercom / Fireflies / Similarweb） | 零依赖（本机文件 + git + SQLite + MCP；可选 GitHub 读 issues） | Cairn 是 daemon-class 本机 app（memory `cairn-is-daemon-app-not-cli`）。 |
| **Customization 路径** | 改 markdown 文本 file | 改 CAIRN.md（per-project Mentor 授权）+ kernel schema 不准用户改 | 不同 customization 哲学。 |

### 3.2 哪些 CC PM plugin 主张会拉 Cairn 漂移（必须 veto）

1. **"PRD generator" / "roadmap-update"** — 进 Cairn 就违反 §1.3 #1（不写文档）+ #5（不做 Linear / Asana / sprint 工作）。**永远不要做**。
2. **"Stakeholder update for exec audience"** — 把 Cairn 变成 dashboard / 汇报工具，进 Cairn 就违反"程序员个人 / 单机优先"（§3.3）。**永远不要做**。
3. **"Synthesize user research"** — 进 Cairn 违反 §1.3 #6（不是 agent framework / 不是通用 LLM 工具）。
4. **"Plugin shape"** — 最大漂移风险。CEO 已明确 2026-05-15："**不是**依附于 CC 的产品"。Cairn 必须维持 daemon + desktop-shell + MCP server 形态，**永远**不退化成"装在 CC 里的插件"。
5. **"7 skills professional standards"** — 进 Cairn 等于把 Cairn 变成 prompt-template library，违反 §1.3 #6 + #7（不是 plain MCP service / 不是 generic SDK）。

### 3.3 哪些主张**不会**漂移、可以安全借鉴

- **Tool-agnostic via category placeholders**（§1.4）— 已经和 Cairn "MCP 是接入方式不是产品形态" 的哲学同构。Cairn 可以借鉴"category over product name"的文案模式。
- **Five-phase brainstorm naming**（§1.5）— pure vocabulary 借鉴，不影响 Cairn 反定义。
- **"Customize by editing text not code"** — Cairn 的 CAIRN.md / cockpit_settings 已经是这条路，可以从他们的文案学习。
- **"两层设计 = commands + skills"** — Cairn 已经有更深的两层（MCP tools + per-project CAIRN.md），可借鉴"两层"作为对外解释器。

---

## 4. 可借鉴的 design / implementation / vocabulary

按"可借鉴度 + 与 Cairn 现状的接口" 排序。每条给出：**source feature → 借鉴点 → Cairn 落点 → 优先级**。

### 4.1 [HIGH] Category placeholder over product name（tool-agnostic 表达模式）

- **Source**：CC PM plugin 的 `~~project tracker` / `~~chat` / `~~knowledge base` 八类 placeholder——抽象类别而非 Linear / Slack / Notion 之类的实名。
- **借鉴点**：在 Cairn 描述"我们读哪些项目信号"时，不要写死 "git log" / "PRODUCT.md" / "GitHub issues"，而是 **categorize**：`~~project narrative`（PRODUCT.md / README / TODO）/ `~~vcs signal`（git log / branch / dirty）/ `~~issue tracker`（GitHub issues / 未来可能 Linear）/ `~~candidate pipeline`（candidates JSONL）/ `~~kernel state`（kernel SQLite 8 类对象）/ `~~worker reports`（governance §6.4）。
- **Cairn 落点**：
  - PRODUCT.md §6.5.1 Mode A · Mentor 的 "项目信号" 输入清单（line 668-674 附近）现在是平铺枚举，可重写为 category-based。
  - `mode-a-loop.cjs` / `mentor-tick.cjs` 内部的 signal-collection 抽象成几个 `collectFromCategory(cat)` 函数，将来要加新信号源只动 category 不动 caller。
  - Per-project `CAIRN.md` 的 schema 可以保留 category 占位允许用户配 "我这 project 用什么 issue tracker"。
- **Priority**：**HIGH**。Mode A 还在起步，恰好可以一次到位；deferred 不好改回来。
- **Effort**：1-2h doc 文案 + 2-3h 重构 `mode-a-loop.cjs` signal collection。

### 4.2 [HIGH] Customize-by-text-not-code 哲学的文案学习

- **Source**：CC PM plugin 自称 "Customization: edit text files (not code) to replace tool stack, add company terminology, align with team practices"。
- **借鉴点**：Cairn 的 CAIRN.md / cockpit_settings 已经走这条路，但**对外说法**还没找到一句话。可以学他们的措辞，强化 Cairn 安装后非开发者用户也能调。
- **Cairn 落点**：
  - `README.md` 顶部 30-second 上手段落里加一行 "Customize by editing CAIRN.md, no code changes required"。
  - `docs/CAIRN-md-spec.md` 顶部加这句作为产品哲学声明。
  - `PRODUCT.md §3.1` 非开发者主用户段落可引用。
- **Priority**：**HIGH**（cheap，对非开发者主用户有效）。
- **Effort**：1h 文案。

### 4.3 [MED] Five-phase 命名作为 Mentor / cockpit 文案灵感

- **Source**：`立框 · 发散 · 挑衅 · 收敛 · 留痕`。其中"挑衅"（assumption challenging）和"留痕"（documentation outputs + unvalidated assumption）非常精准。
- **借鉴点**：Cairn 的 Mentor (Mode A) chat panel 当前是 "用户问 → Mentor 答 → ranked work items"，没有阶段划分。可考虑给 Mentor 加一个**显式阶段标签**（不强制 5 个）让用户知道当前 turn 是 "发散建议" 还是 "挑衅前提" 还是 "收敛到 next action"。
- **Cairn 落点**：
  - panel Mentor sub-section 文案：button "ask again with challenge"、"converge to one action"、"record unanswered question"。
  - `mentor-tick.cjs` 的 prompt template 加 phase tag 让 LLM 自标当前 phase。
  - 也可以借给 cockpit Module 1 (state strip) 的 hover 提示用："此 task 还在 *发散* / *挑衅* / *收敛* 阶段"。
- **Priority**：**MED**。是 UX 细节不是核心功能。
- **Effort**：3-4h prompt + UI 文案试验。

### 4.4 [MED] Brainstorm closing 的 "position statement" 模式

- **Source**：每次 brainstorm close 时输出 "strongest direction + rationale + key unvalidated assumption" 三段。
- **借鉴点**：Cairn 的 Mentor 在每次 chat turn 末尾可以**强制**输出三段 trailer：
  - **recommended direction**（最强建议）
  - **why this over alternatives**（理由）
  - **what could break this**（最大未验证假设 / 风险）
- 比当前的 "ranked work items" 多出"假设 / 风险"维度，提升 Mentor 的可审性。
- **Cairn 落点**：`mentor-tick.cjs` 的输出 schema 加 `position_statement: { direction, why, risk }` 字段；panel Mentor sub-section 渲染为固定底部 box。
- **Priority**：**MED**。
- **Effort**：4-6h（含 panel UI 渲染 + schema 演进 + smoke 验证）。

### 4.5 [LOW] "两层设计 = commands + skills" 对外类比

- **Source**：CC PM plugin 把自己解释为 "两层：commands（do what）+ skills（quality bar）"。
- **借鉴点**：Cairn 对外解释自己的 layer 时也可以走 "两层" 类比，比如 "MCP tools = capabilities; CAIRN.md = quality bar per project"。但 Cairn 实际是 5 层（v4 §1.2），过度类比会失真。
- **Cairn 落点**：仅限 README / pitch 的 30 秒读完段落用，**不**进 PRODUCT.md 主体。
- **Priority**：**LOW**。
- **Effort**：30min 文案。

### 4.6 [LOW] "Functions without connector by reverting to manual context provision"

- **Source**：CC PM plugin 在没接 Linear/Notion/Figma 时回落到 "用户手动 paste context"。
- **借鉴点**：Cairn 的 Mode A signal collection 已经做到了 graceful degrade（缺 PRODUCT.md / 缺 GitHub remote 不挂掉），但**没有显式告诉用户**"这条信号缺失了"。可以借鉴他们的回落策略**显式化**：Mentor 输出顶部列出 "available signals: git, PRODUCT.md, candidates" / "missing signals: GitHub issues (set GITHUB_TOKEN to enable)"。
- **Cairn 落点**：`mentor-tick.cjs` 在 prompt 里把 signal availability 列出来，panel 也显示。
- **Priority**：**LOW**（quality-of-life）。
- **Effort**：2-3h。

### 4.7 不可借鉴 / 不应借鉴清单（防漂移）

| 反例 | 为什么不借鉴 |
|---|---|
| Slash command 触发模型 | Cairn 是 daemon + desktop-shell，不是 CC plugin。CEO 2026-05-15 lock。 |
| LLM 起草 PRD / roadmap / status update | 违反 §1.3 #1 + #5 + #6。 |
| Skill-as-markdown-quality-bar | Cairn 用 schema (DSL) 和 state machine 而非 prompt-template；二者哲学不同。 |
| `~/.claude-minimax` 这种"塞进 CC 配置目录"的 sibling 位置 | Cairn 的目录是 `~/.cairn/`，daemon-class，本机一等公民。 |
| Academic serif + 松柏绿配色 | Cairn 形态参照系是 Activity Monitor / journalctl，**不是**学术期刊。DESIGN.md 已经锁配色（accent 蓝 + alert 红 + 灰阶），禁用绿。 |
| Plugin marketplace 分发 | Cairn 装路径是 `cairn install`（CLI）+ desktop app 一键 add project（memory `cairn-is-daemon-app-not-cli`）。 |

---

## 5. Detailed design proposal — TOP 1 inspiration

挑 §4.1（category placeholder for Mode A signal sources）作为 TOP 1，因为：(a) Mode A 还在起步 (Phase 1+2+3 done at code-spike level，尚未 frozen schema)；(b) 一旦不上后续要加新信号源（Linear？Jira？OpenAPI spec？）每次都要改 caller 太刚性；(c) 文案 + 实现一次到位，1 day 内完成。

### 5.1 Goal（1 line）

把 Mode A · Mentor 读项目信号的方式从"平铺列表"重构为"**category-keyed signal collector**"，让"加新信号源"只动 category map，不动 caller 路径，并对用户显式声明 "available / missing signals"。

### 5.2 Non-goals

- **不**接入新外部 SaaS（Linear / Notion / Figma 等）。Cairn 仍是本机优先，§1.3 #8 不松。
- **不**让用户配 "category → plugin" 映射 UI。Customization 仅通过 CAIRN.md 文本字段（如 `signals.issue_tracker: github | null`）。
- **不**改 host-level state schema / **不**新增 MCP tool / **不**新增 migration。纯 desktop-shell 内重构。

### 5.3 Architecture（file-by-file）

**新文件**：

`packages/desktop-shell/mentor-signal-categories.cjs`
```javascript
// Pure module. No side-effects.
// Maps category → list of collectors. Each collector returns { available: boolean, content: string, source: string }.
const CATEGORIES = {
  project_narrative: ['readProductMd', 'readReadme', 'readTodo'],
  vcs_signal:        ['collectGitLog', 'collectBranch', 'collectDirty'],
  issue_tracker:     ['collectGithubIssues'],          // returns available:false if no GITHUB_TOKEN
  candidate_pipeline:['readCandidatesJsonl'],
  kernel_state:      ['readTasks', 'readBlockers', 'readOutcomes'],
  worker_reports:    ['readWorkerReports'],
};

function collectByCategory(category, ctx) { /* dispatch */ }
function collectAll(ctx) { /* iterate categories, return { available[], missing[], blob } */ }

module.exports = { CATEGORIES, collectByCategory, collectAll };
```

**改文件**：

`packages/desktop-shell/mentor-tick.cjs`
- 把当前直接读 `PRODUCT.md` / `git log` / candidates JSONL / SQLite 的胶水代码抽出，全部走 `mentor-signal-categories.collectAll(ctx)`。
- LLM prompt 顶部加 "Signal availability" section（list available + missing），给 Mentor 显式知道哪些 signal 缺。

`packages/desktop-shell/mode-a-loop.cjs`
- `ensurePlan` 的 signal-gathering 阶段从内联代码改为 `collectAll(ctx).blob`。
- 把"哪些 signal missing"附在 `mode_a_plan/<project_id>` scratchpad 上，便于 panel 显示。

`packages/desktop-shell/panel.html` / `panel.js`
- Mentor sub-section 顶部加一个 "Signals" pill row：available 灰色 pill / missing 浅红 pill + hover tooltip "set X to enable"。
- L1 hint：CSS 用现有 accent + alert tokens，不引入新色。

`docs/CAIRN-md-spec.md`
- 加 `signals.*` 可选字段定义（用户可以 force-disable 一个 category），但默认全部 auto-detect。

### 5.4 Contract changes

- **No host-level state change**。`mode_a_plan` scratchpad 内容多一个 `signals` 字段（向下兼容；旧 plan 没有这个 key 时 panel 不渲染 pill row）。
- **No MCP tool change**。
- **No migration**。下一个可用 migration 编号仍是 011。

### 5.5 Migration（2-4 commits）

1. `feat(mentor): extract signal collectors into category-keyed module` — 引入 `mentor-signal-categories.cjs`，先并行存在（caller 还没切）。带 unit test：每个 category 有 ≥1 collector。
2. `refactor(mode-a): mentor-tick + mode-a-loop use category collector` — 切 caller。跑 `smoke-mode-a-loop.mjs` + `smoke-goal-registry.mjs` + `diagnose-mode-a.mjs` 三个 smoke 验证。
3. `feat(panel): show signal availability in mentor sub-section` — panel UI 加 pill row。dogfood live：开 panel 看 missing signal 显示是否合理。
4. `docs: CAIRN.md signals.* + Mode A signal philosophy` — 更新 spec + PRODUCT.md §6.5.1 平铺枚举改 category-based。

### 5.6 Estimated effort

| Commit | 估时 |
|---|---|
| 1. extract category collectors + unit test | 3-4h |
| 2. refactor caller + smoke 验证 | 2-3h |
| 3. panel UI pill row + live dogfood | 2-3h |
| 4. docs sync | 1h |
| **Total** | **8-11h**（约 1 个工作日，预留 30% buffer） |

### 5.7 Risk register

1. **R1 — 重构破坏 Mode A diagnostic gate 2 (goal.success_criteria)**：`mentor-signal-categories.cjs` 抽错可能让 success_criteria 没传进 prompt。**Mitigation**：commit 2 跑 `diagnose-mode-a.mjs` 验证 gate 1-8 全过。
2. **R2 — Signal pill UI 与 cockpit redesign 冲突**：panel cockpit 5 模块还在并行重构（`2026-05-12-panel-cockpit-redesign.md`），新加 pill row 可能与 module 1/2 冲突。**Mitigation**：commit 3 之前在 PR 描述里 cross-ref cockpit plan，让 cockpit author 知道有这个 pill row 需要预留位置。也可以先把 pill row 放在 Mentor 内部抽屉而不是 module 顶部。
3. **R3 — Category 抽象提前太多**：YAGNI 风险。如果未来 6 个月只加 0-1 个新信号源，category 抽象就是 over-engineering。**Mitigation**：commit 1 严格 ≤ 100 行新代码，category map 是普通 object，将来不用可以 inline 回去。

### 5.8 Why this fits Cairn's positioning（**not** a CC clone）

- **Layer 不变**：仍在 Operations layer（Mode A 主场），不动 Kernel / Integration / Storage。
- **Surface 不变**：仍是桌面 panel，不是 slash command / TUI。
- **State ownership 不变**：信号 reside 在 host-level（git / PRODUCT.md / SQLite / candidates JSONL）的原位，Mentor 只读不写。
- **Reasoning 不变**：Mentor 仍只**推荐**，不替用户拍板。Position-statement-style trailer（§4.4 的 LOW 借鉴）若未来引入，仍是 advisor 角色。
- **反 CC plugin**：所有变更都在 desktop-shell / docs，**没有**一行进 CC 的 `.claude/` 或 plugin marketplace。

---

## 6. Recommendations + decisions for CEO

### 6.1 行动建议（按优先级）

1. **Adopt §4.1 category placeholder pattern → 详方案 §5**。1 个工作日，Mode A 还在起步，是最便宜的窗口。**建议 GO**。
2. **Adopt §4.2 customize-by-text 文案**到 README / CAIRN.md spec。1h 工作，对非开发者主用户战略上重要。**建议 GO**。
3. **Try §4.3 / §4.4 Mentor phase tags + position statement trailer**。半天到一天。属于 Mentor UX polish，不影响 Mode A 核心闭环。**建议 OPT-IN**（如果 cockpit redesign 进度不挤）。
4. **§4.6 显式 missing-signal 提示**：合并到 §5 的方案 commit 3 里一起做（已经在 panel UI 设计里）。无独立成本。
5. **拒绝**所有把 Cairn 拉成 CC plugin / PRD generator / roadmap-builder / status-report-tool 的暗示。CEO 2026-05-15 lock 保留：Cairn 在所有本机 agents 之上，**不**依附于 CC。

### 6.2 不要做的事

- **不**装 / 不分析 / 不在 README 提及"我们也提供 PRD / roadmap / status update"功能。Cairn 不是文档生成器。
- **不**接 Linear / Notion / Figma / Amplitude 等 SaaS。Cairn 是本机优先 daemon。
- **不**搬 academic serif + 松柏绿配色到 Cairn。DESIGN.md 已锁 accent + alert + 灰阶。
- **不**把 Cairn 变成 plugin（任何引擎的 plugin，不只 CC）。
- **不**把 Mode A · Mentor 扩展成"自动每日推送 ranked 建议"。PRODUCT.md §6.5.1 已经明确 Mentor 是 chat / 主动问 only。

### 6.3 待 CEO 决策

1. **§5 方案是否 GO？**（1 个工作日，无 schema change，无 npm dep change，可逆。按 CLAUDE.md Decision Rules"可逆 / 局部 / 5 分钟撤销"原则其实可以 agent 自决，但因为牵涉 PRODUCT.md §6.5.1 改写所以提 CEO。）
2. **§4.2 customize-by-text 文案是否要进 README？**（30 秒决定，对非开发者用户战略上重要。）
3. **是否要在 Mentor UX 中引入 §4.3 / §4.4 五阶段命名 + position statement？**或推迟到 cockpit redesign 之后。

---

## Appendix A — 源 HTML 关键引用

- "通用的 Claude 会写文档、会分析，但它不知道**一份 PRD 该长什么样**"
- "搭档不是记录员"（partner isn't a note-taker，brainstorm phase)
- 五阶段：立框 / 发散 / 挑衅 / 收敛 / 留痕
- "两层设计：commands（显式 workflow）+ skills（quality standards）"
- "工具无关（Tool-agnostic）—— describes workflows via categories, not product names"
- 章节定位：岗位插件深读 · 第二章 / 共十一章

## Appendix B — 关键 Cairn 文件 cross-ref

- `D:\lll\cairn\PRODUCT.md` §0 + §1.2 + §1.3 + §6.5.1（positioning lock + Mode A spec）
- `D:\lll\cairn\ARCHITECTURE.md` §1 + §1.1 + §1.3 + §1.4（4-layer arch + 8 state objects + autonomy contract + veto list）
- `D:\lll\cairn\CLAUDE.md` opening（Cairn 是什么 / 不是什么 + workflow discipline）
- `D:\lll\cairn\packages\desktop-shell\mode-a-loop.cjs` / `mentor-tick.cjs` / `panel.js` / `panel.html`（Mode A 现有实现，§5 方案的改造对象）
- `D:\lll\cairn\packages\desktop-shell\scripts\diagnose-mode-a.mjs`（重构后必须仍能跑过 gate 1-8）
- `D:\lll\cairn\docs\superpowers\plans\2026-05-12-panel-cockpit-redesign.md`（与 §5 commit 3 panel UI 改动需 cross-ref，避免 cockpit module 冲突）
- `D:\lll\cairn\docs\CAIRN-md-spec.md`（§5 commit 4 docs sync 目标之一）
