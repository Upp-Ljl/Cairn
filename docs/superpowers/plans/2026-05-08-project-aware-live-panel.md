# Project-Aware Live Panel — 产品升级 plan

> 日期：2026-05-08
> 状态：Plan ready for kickoff（patch v1 完成，6 项决策 locked）。源码未动。
> 上游：PRODUCT.md v3（commit `3562f1f`），Quick Slice MVP 已上线（commits `f088b56..4c24fb6`）
> 实施位置：主要 `packages/desktop-shell/`；Day 1 例外在 `packages/mcp-server/`（presence integration，详 §3.4）
> 边界：不引入新 MCP 工具；不改 daemon-side schema（schema 改动只能列入 Later）；read-only by default；no version-tier roadmap
>
> **本 plan 是 Quick Slice 之后下一个、唯一的活跃阶段。**不拆 v0.x；只有"当前阶段"和 "Later"。
>
> **Patch 历史**（本文件原地修订，未拆 commit）：
>
> - **2026-05-08 v0**：原 plan，5 days，single-DB-per-project 假设
> - **2026-05-08 v1**（current）：4 项 P1 review patch：
>   - project identity 改为 `project_root`（多 project 可共享 db_path；Unassigned bucket per DB）
>   - 容许 mcp-server boot-time presence integration（auto-register + 30s heartbeat），让真实 agent 状态可见而不靠 fixture（§3.4）
>   - checkpoint schema 修正（无 paths_affected_json 列；展示 label / git_head / snapshot_status / size / 时间）
>   - floating marker click default 改为 togglePanel（与 tray 一致；legacy Inspector 仅 tray 右键）
>   - 总工作量 5 → 6 days（Day 1 mcp-server 单独 commit）

---

## 0. 30 秒总览

Quick Slice 证明 desktop-shell 能跑、tray + summary + Run Log + Tasks 都能渲染真实数据。**但它把 SQLite 表平铺给用户，这不是产品。** 用户实际的认知单位是 **project → agent session → task chain → 关联事件**，而不是"全局 tasks 列表 + 全局 Run Log"。

Project-Aware Live Panel 的目标是把信息架构从"扁平表浏览器"升级到"项目现场监控面"，同时把 UI 从普通 BrowserWindow 升级到真正的桌面侧边控制面（frameless / slide-in / 高密度）。

**核心 reframe**（2026-05-08 patch）：**project identity 不等于 DB path**。mcp-server 默认写 `~/.cairn/cairn.db`，多个 project 的数据可能落在同一个 DB 里。Registry 记的是 **project_root（唯一身份）+ db_path（数据源）+ agent_id_hints（用来从 DB 里把这个 project 的行筛出来）**。无法归属的行进入 **Unassigned** 视图（per DB）。

**这一阶段：6 天，单 commit chain，read-only，无 schema 改动，无新 MCP 工具。**唯一例外是 mcp-server 自动 presence integration（详 §3.4）—— 让真实 agent 状态可见，不靠 fixture。

完成判据 = 用户在自己机器上至少 2 个真实 project 同时跑 agent，从 panel 能 30 秒回答这两个项目"现在到哪了"，并能点进任一 project 看到 agent session → task chain → checkpoint 的完整层级。**真实** = panel 显示的 active agent 数 与 实际跑 mcp-server session 数 一致，无需 fixture 兜底。

---

## 1. Quick Slice 问题诊断

Quick Slice（Day 1+2+3）让 desktop-shell 渲染了真实数据，但产品体验有 6 个明确缺口。这些缺口不是优化空间，是**信息架构错位**。

### 1.1 没有 project 概念，且"一个 DB = 一个 project"是错的

panel header 只显示一个 workspace label + 一条 DB 路径。用户机器上可能跑多个 project（cairn 仓库 / 自己的 side project / 跟另一个 repo 协作的客户工作），每个 project 应该有独立的 health 信号、独立的 agent 列表、独立的 task chain。**当前 panel 只能一次看一个**——切 project 等于重开 SQLite。

更深的问题：**"一个 DB = 一个 project" 不是事实**。mcp-server 启动时默认连 `~/.cairn/cairn.db`（global），不会因为用户 cwd 不同就用不同的 DB。意味着同一个 SQLite 文件里可能并存多个 project 的 tasks / processes / blockers / outcomes / conflicts / checkpoints / dispatch_requests 行——它们之间的区分**只能通过 agent_id 间接推断**（mcp-server 用 `cairn-<sha1(hostname:cwd).slice(0,12)>` 作为 SESSION_AGENT_ID，同 cwd 派生一致 ID）。

schema 层面**没有 project_id 列**（PRODUCT.md §6 Decision 3 锁过）。改 schema 加 `project_id` 是 daemon 侧的大动作，本 plan 不做。本 plan 的实际路线：

- **Registry 模型**：每条 entry = `{ project_root, db_path, agent_id_hints }`。`project_root` 是身份；`db_path` 是数据源（**多个 project 可能共用同一个 db_path**）；`agent_id_hints` 是用来在 DB 里把这个 project 的行筛出来的过滤器
- **Unassigned bucket**：每个 db_path 都会有一个虚拟 "Unassigned" 视图，含没被任何 project 的 hints 匹配的行——用户能看到 DB 里"还有什么不在我视野内的活动"
- **Day 1 L1 list 基于 project_root**，不基于 db_path——所以两个 project 共用一个 DB 也会显示成两张独立的 card

### 1.2 task 是平铺的

Tasks tab 把 100 行任务按 state 优先级 + updated_at 倒序排，**忽略了 `parent_task_id` 树形结构**。用户的真实问题是"这条 task chain 从哪开始、走到哪、子任务怎么分支、谁在跑哪一段"——这些信息在 schema 里全有（`tasks.parent_task_id` + `tasks.created_by_agent_id`），但 panel 没用。

inline expansion 打开看到的是"这一行任务的 blocker + outcome"，没有树视角，没有兄弟任务，没有上下文。

### 1.3 agent / subagent 现场看不见

Quick Slice 把 active agent 数塞进 summary card，但**没有 sessions 视图**。用户想知道：

- 当前哪些 agent 在跑（`processes.status='ACTIVE'`）？
- 哪些 agent stale 了（heartbeat > heartbeat_ttl）？
- 这个 agent 创建了哪些 task / 在哪条 task chain 上工作？

这三个问题的数据在 `processes` + `tasks.created_by_agent_id` 都有，panel 没把它们连起来。subagent 的现场感**完全缺失**——用户的 prompt template 让 subagent 调 `cairn.process.register` 是可选行为，但即使它们注册了，panel 也只是把它们当成另一行 process。没有 parent agent → subagent 的可视化。

### 1.4 checkpoint 不可见

Quick Slice 把 checkpoints 整个折叠进 task drill-down 的"未来 Hardening"。这导致 US-P3（Recovery / 从哪 rewind）**完全没覆盖**——用户必须跳出 panel 翻 git log 或者直接到 agent 里查。

但 checkpoint 的数据已经在 `checkpoints` 表里 (`id` / `task_id` / `label` / `git_head` / `snapshot_status` / `size_bytes` / `created_at` / `ready_at`)，把它做成 task 节点下的可见对象成本不高。**read-only 显示 + 复制 ckpt-id 给 agent** 不踩 mutation 边界。

> 注：checkpoints 表**没有 paths_affected_json 列**（这一列在 conflicts 表）。要展示 checkpoint 影响哪些文件需要 git diff inspection（panel 侧 spawn `git stash show` 或 `git diff <git_head>`），属于 Hardening。本 plan 不展示 paths。

### 1.5 Run Log 不像现场记录

当前 Run Log 是"5 张表 SELECT 出来按 ts 排序"。它能告诉你"什么时候发生过什么"，但**不能告诉你"这个 agent 当时在做什么"**。具体缺口：

- 没有 agent_id 维度过滤——想看 agent X 的 timeline 必须人眼挑
- 没有 task_id 维度过滤——想看 task chain T 的演化必须人眼挑
- `outcomes` / `conflicts` 事件本身没 agent_id（schema 决定的），无法直接归因
- `processes` heartbeat 完全没进 Run Log（Quick Slice 显式排除，避免淹没）—— 但这意味着"agent 上线 / 掉线 / 卡住"在 Run Log 里完全消失
- 事件来源是 ad-hoc table SELECT，没有真正的 event log 表；事件顺序、重复事件、漂移都靠 ORDER BY 兜底

短期内可以继续聚合现有表，但**结构性的解法是 schema 加一个 `cairn_events` append-only 事件表**——daemon 在每个 mutation tx 里 INSERT 一条事件；panel 直接 SELECT 这一张表。这是 daemon 侧工作（schema migration + 仓储改造 + 工具点播事件），**不在本 plan 实施**，但本 plan 在 §3.2 显式登记，让后续 daemon 侧排期能接得上。

### 1.6 UI 形态不对

panel 当前是普通 `BrowserWindow` ~480×600，带 OS title bar，能拖、能 minimize、能闭。这看起来像一个**小网页**，不是**桌面侧边控制面**。Activity Monitor / `journalctl --follow` 也不是普通网页，它们是常驻、稳定位置、信息密度高、不抢用户注意力的 OS-级别工具。

具体缺：

- 有 OS title bar → 占用了垂直空间 + 视觉上像应用而非控制面
- 不贴边、可任意拖动 → 用户每次重启位置变 → 不形成肌肉记忆
- 没有 slide-in/out 动画 → tray click 是"开新窗"而不是"展开侧栏"
- 不区分 panel 窗 vs floating marker —— floating marker 仍承担 click-to-open-legacy 的"次要主 UI"角色

### 1.7 floating marker 角色含糊

floating marker 在 PRODUCT.md §8 设计上是 ambient presence。Quick Slice 实施时它继续承载"click 打开 legacy Inspector"功能（main.cjs 里的 `open-inspector` IPC handler）。这导致：

- 用户分不清 marker 和 panel 谁是主 UI
- 用户偶尔点 marker，弹出 legacy Inspector（4 段视图），跟 panel（5 段视图）的信息架构不一致

floating marker 应该**只**做 schema-driven sprite 动画，不承担任何窗口入口角色。tray 是唯一窗口入口。

---

## 2. 目标信息架构

panel 是**两层**结构。

### 2.1 L1：Projects List

panel 打开默认看到的视图。每个 project_root = 一张 card；Unassigned bucket per DB 单独成 card；按 health 排序。

```
┌─ Projects (3) + Unassigned (1) ────────────────┐
│                                                 │
│ ● cairn          alert  · 2 agents · 1 BLOCKED │
│   D:\lll\cairn          1 FAIL · ckpt 4m ago   │
│   DB: ~/.cairn/cairn.db                         │
│                                                 │
│ ◐ side-proj      warn   · 1 agent · 1 OPEN q   │
│   C:\…\side-proj         ckpt 14m ago          │
│   DB: ~/.cairn/cairn.db   (shares DB with cairn)│
│                                                 │
│ ○ scratch        idle   · — · last activity 3h │
│   C:\…\scratch                                  │
│   DB: C:\…\scratch\.cairn\cairn.db              │
│                                                 │
│ ◇ Unassigned (~/.cairn/cairn.db)                │
│   3 rows not matched by any project · last 1h   │
│                                                 │
│ + Add project…                                  │
└─────────────────────────────────────────────────┘
```

每张 project card 含：

- **health 状态点**（`●` alert / `◐` warn / `○` idle）—— 复用 tray 的 3 档逻辑，**按这个 project 的 agent_id_hints 过滤后再算**
- **project_root 标签 + 完整 path**
- **核心计数**：active agents · running+blocked tasks · OPEN blockers · FAIL outcomes · last checkpoint rel time（全部基于 hints 过滤后的子集）
- **last activity rel time**（最近一次任意源事件，hints 过滤后）
- **DB path 行**：显示数据源；如果多 project 共享同 DB 显式标 "(shares DB with X)"

每张 Unassigned card（每个有"未归属"行的 db_path 一张）：

- 状态点 ◇（中性符号）
- 行计数 + last activity
- 点开后看到 DB 里没被任何 project 的 hints 命中的所有行
- 提供 "assign these agent_ids to a project" UX hint（具体 assign 操作 Day 2 / Hardening）

排序：project alert > project warn > project idle > Unassigned；每档内按 last activity DESC。

`+ Add project…` 弹"添加 project"对话框（详 §3.1）→ 加进 registry → 出现新 card。

tray badge / 颜色 = 所有 **project**（不算 Unassigned）中最严重的 health。Unassigned 不参与 tray badge——它代表"我没有 claim 的活动"，不应该让它把用户的 tray 烧红。

### 2.2 L2：Project drill-down

点 L1 任一 project card → 滑入 L2 视图。L2 的结构：

```
┌─ ← cairn  D:\lll\cairn   alert ───────────────┐
│                                                 │
│ ┌─ Project summary card ─────────────────────┐ │
│ │ 2 agents · 3 tasks · 1 blocker · 1 FAIL   │ │
│ │ last ckpt 4m ago · last activity 30s ago  │ │
│ └────────────────────────────────────────────┘ │
│                                                 │
│ [Sessions] [Tasks*] [Run Log] [Conflicts]      │  * = default
│                                                 │
│ ┌─ Active view body ──────────────────────────┐│
│ │ ...                                          ││
│ └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

`←` 回 L1。Tabs 4 个：

#### Sessions tab

按 status 分组列出 `processes` 行：

```
ACTIVE (2)
  ● agent-cc-7f3a    claude-code · last hb 12s ago · capabilities=[...]
       └ owns 4 tasks (3 RUNNING / 1 BLOCKED)
  ● agent-cursor-a2  cursor      · last hb 47s ago
       └ owns 2 tasks (1 RUNNING / 1 DONE)

STALE (1)                          (= status='ACTIVE' but heartbeat older than ttl)
  ◐ agent-aider-99   aider        · last hb 8m ago

DEAD (0)
```

`└ owns N tasks (...)` = `tasks.created_by_agent_id = agent_id` 计数 + 状态分布。点这条 → 切到 Tasks tab + 自动 filter `created_by_agent_id`。

#### Tasks tab（默认视图）

按 `parent_task_id` 树渲染。每个根任务（`parent_task_id IS NULL`）一棵树：

```
▼ T-001  RUNNING  refactor auth module
   ├ created by agent-cc-7f3a · 2h ago · updated 30s ago
   ├ outcome: PENDING
   ├ blockers: 0 OPEN / 1 ANSWERED
   ├ checkpoints (3):
   │    · before-token-status-rename  4m ago  shared/types.ts
   │    · before-auth-refactor        2h ago  src/auth/*
   │    · auto:before-rewind-2        2h ago
   └ ▼ T-002  BLOCKED  fix useAuth hook
        ├ created by agent-cursor-a2 · 1h ago
        ├ outcome: —
        ├ blockers: 1 OPEN
        │    └ "deprecation flag yes/no?"  raised 14m ago
        └ checkpoints (0)

▼ T-007  WAITING_REVIEW  outcomes evaluation pending
   ├ created by agent-cc-7f3a · updated 5s ago
   ├ outcome: PENDING (criteria=[tests_pass, file_exists])
   └ checkpoints (1): submit-criteria  10m ago
```

每个节点都可点击折叠 / 展开。展开级别：

- L1：root task line（state pill + intent）
- L2（自动展开）：metadata 行 + outcome + blocker 摘要 + checkpoint count
- L3（点 checkpoints 行）：完整 checkpoint 列表（label / paths / git_head / created_at / 复制 ckpt-id 按钮）
- L3（点 blocker 行）：完整 question + answer 历史

filter 工具栏（顶部）：

```
[ All states ▾ ]  [ All agents ▾ ]   ← clear
```

filter 状态保存在 panel 进程内存，切 tab 不丢；切 project 重置。

#### Run Log tab

per-project 时间倒序事件流。视觉上是 journalctl 风格但每行**多一列 agent_id**：

```
HH:MM:SS  source       type                agent             target            message
14:32:01  tasks        task.failed         agent-cc-7f3a    T-009            outcomes evaluation FAIL
14:31:55  outcomes     outcome.fail        —                O-009            tests_pass: 12 failed
14:30:12  blockers     blocker.opened      agent-cursor-a2  B-008            deprecation flag y/n?
14:28:00  checkpoints  checkpoint.created  agent-cc-7f3a    C-014            before-token-rename · paths=2
```

**新增 source 类型**：

- `checkpoints` 加进 Run Log（Quick Slice 不含；现在加）
- `processes.registered_at` / `last_heartbeat`（仅 5min 内的 heartbeat 折叠为单条，避免淹没）

filter：

```
[ all sources ▾ ]  [ all agents ▾ ]  [ all tasks ▾ ]
```

#### Conflicts tab（仅当 OPEN > 0 时显示）

`conflicts` 表 OPEN/PENDING_REVIEW 行的列表，含 agent_a / agent_b / paths_json / detected_at / summary。read-only。

---

## 3. 数据模型新增 / 调整

**本 plan 不动 daemon-side schema**。三类工作：

### 3.1 desktop-shell 侧新增（本 plan 内做）

**`~/.cairn/projects.json`** —— project registry，desktop-shell 维护，daemon 不读不写：

```json
{
  "version": 2,
  "projects": [
    {
      "id": "cairn-self",
      "label": "cairn",
      "project_root": "D:\\lll\\cairn",
      "db_path": "C:\\Users\\jushi\\.cairn\\cairn.db",
      "agent_id_hints": ["cairn-6eb0e3c955f4"],
      "added_at": 1715140000000,
      "last_opened_at": 1715180000000
    },
    {
      "id": "side-proj",
      "label": "side-proj",
      "project_root": "C:\\Users\\jushi\\code\\side-proj",
      "db_path": "C:\\Users\\jushi\\.cairn\\cairn.db",
      "agent_id_hints": ["cairn-3f12be7a9b2c"],
      "added_at": 1715120000000,
      "last_opened_at": 1715170000000
    }
  ]
}
```

字段说明：

- `project_root` —— **唯一身份**。绝对路径，不可重复。
- `db_path` —— 数据源。可被多 project 共用（如上例：cairn-self + side-proj 都指向 `~/.cairn/cairn.db`）。
- `agent_id_hints` —— 用来从 db_path 这个 DB 里筛出本 project 的行。**默认自动填一个值**：mcp-server 用 `cairn-<sha1(hostname:cwd).slice(0,12)>` 作为 SESSION_AGENT_ID（CLAUDE.md "已落地约定"段确认），所以 hints 默认 = `[sha1(hostname:project_root).slice(0,12) prefixed with 'cairn-']`。
- 用户可手动追加更多 agent_id（subagent / 旧会话遗留），UX：Day 2 在 L2 Sessions tab 给"add to hints"按钮。

筛选语义（per-project view）：

- `processes` 行 → `WHERE agent_id IN (hints)`
- `tasks` 行 → `WHERE created_by_agent_id IN (hints)`
- `blockers` 行 → JOIN tasks ON task_id → 过滤 created_by_agent_id
- `outcomes` 行 → 同上（JOIN tasks 过滤）
- `checkpoints` 行 → JOIN tasks ON task_id → 过滤 created_by_agent_id（无 task_id 的 checkpoint 不归属，进 Unassigned）
- `conflicts` 行 → `WHERE agent_a IN (hints) OR agent_b IN (hints)`
- `dispatch_requests` 行 → `WHERE target_agent IN (hints)` OR JOIN task

Unassigned bucket 语义（per db_path）：

- 一个 db_path 在 registry 里所有 project 的 hints 取并集 = `assigned_set`
- Unassigned = 该 DB 中所有 7 类 row 不在 `assigned_set` 内的行
- 注意 `outcomes` / `blockers` / `checkpoints` 通过 task 链归属——没有 task_id 的 row 进 Unassigned

操作：

- `Add project…` —— 对话框：(1) 选 project_root（folder 选择，默认 cwd 或常见 git repo），(2) 自动推算 db_path（先看 `<project_root>/.cairn/cairn.db`，不存在则默认 `~/.cairn/cairn.db`），用户可改，(3) 自动计算默认 agent_id_hint。
- `Remove`（右键 card）—— 仅从 registry 删，不动 DB。
- `Rename`（双击 label）—— 改 label。
- `Add agent_id to hints`（Day 2 在 Unassigned card 或 Sessions tab 中）—— 把某个 agent_id 移入 project hints。

向后兼容 Quick Slice：

- 旧 `~/.cairn/desktop-shell.json.dbPath` 在 panel 启动时被读取
- 自动 mig：创建一行 registry entry，id=`legacy-default`，project_root=`(unknown)` 或 process.cwd()，db_path = 旧字段值，agent_id_hints = 空（用户在 panel 里 manually assign）
- 旧字段保留 30 天兼容窗口（plan 不强制硬期限，但 mig 后旧字段对 panel 启动不再有影响）

### 3.2 Later — daemon 侧需要做（不在本 plan，但必须显式登记）

这些是产品向 Project-Aware 演进路径上的真正下一步，但属于 daemon 工作，本 plan 只占位说明：

| Later 项 | 目的 | 对应 PRODUCT.md / plan 节 |
|---|---|---|
| schema 加 `tasks.project_id` / `processes.project_id` / 等 | 一个 DB 内可以容纳多 project；跨 project 查询不再依赖文件分隔 | 当前 plan §1.1 / Decision 3 升级 |
| **`cairn_events` append-only event log table** | Run Log 从"5 表 ORDER BY 拼"升级为"专表 SELECT"；事件可被订阅 / replay；processes heartbeat / scratchpad write 也能合理纳入 | 当前 plan §1.5 / PRODUCT.md §11 Hardening |
| daemon 独立进程 + 稳定 IPC API | desktop write actions 解锁 3 前置之一 | PRODUCT.md §12 D9 |
| `processes.parent_agent_id` 或独立 `sessions` 表 | subagent 树关系可视化（main agent → subagent → sub-subagent） | 当前 plan §1.3 |
| `checkpoints.created_by_agent_id` | checkpoint 直接归因到 agent（当前只能通过 task_id → tasks.created_by_agent_id 间接归因） | 当前 plan §2.2 |

本 plan 实施期间如果发现"没有这些 schema 改动绕不过去"，**停下来报告**，不要 hack panel 工作绕过 daemon。

### 3.3 现有 schema 复用（足以支撑本 plan）

| 需求 | 现有列 | 备注 |
|---|---|---|
| project = DB 文件 | DB 路径作为 project_id | registry 维护 |
| agent session | `processes.{agent_id, agent_type, status, registered_at, last_heartbeat, heartbeat_ttl}` | "session" = "process row"；stale = `now - last_heartbeat > heartbeat_ttl` |
| task chain | `tasks.{task_id, parent_task_id, created_by_agent_id}` | 树渲染 + agent 归因 |
| task → checkpoint | `checkpoints.{id, task_id, label, git_head, snapshot_status, size_bytes, created_at, ready_at}` | LEFT JOIN by task_id；untagged checkpoint（task_id IS NULL）进 Unassigned。**没有 paths_affected_json 列**——展示文件清单需要 git diff，留 Hardening |
| task → outcome | `outcomes.{task_id, status, criteria_json, evaluated_at, evaluation_summary}` | UNIQUE(task_id) 保证 1:1 |
| task → blocker | `blockers.{task_id, status, question, answer, raised_at, answered_at}` | per-task 多行 |
| Run Log 事件 | 5 表 ad-hoc projection（同 Quick Slice）+ 加 `checkpoints` + 折叠 `processes.last_heartbeat` | event log 表是 Later |

### 3.4 本 plan 容许的 mcp-server 改动 —— **presence integration**

这是本 plan 唯一在 desktop-shell 之外的源码改动，且范围严格限定。原因：当前 `processes` 表只有当 agent 主动调 `cairn.process.register` / `cairn.process.heartbeat` 时才会有数据；而 Claude Code / Cursor 的 mcp-server 不会自动调这些工具——必须由 user 在 prompt template 里嘱咐 agent 调，否则 panel 上 active agents 永远是 0。**这导致"真实 agent 活跃状态"无法在不靠 fixture 的前提下被验证**——本 plan 无法宣称交付。

为了打破这个死结，本 plan 容许 **mcp-server 启动时自动注册 presence**：

**改动**（仅 `packages/mcp-server/src/`）：

- `mcp-server` 启动时，在 workspace init（或 main entry）里调用 daemon 的 process repo `register` 函数（**直接 import，不通过 MCP 工具**），用现有自动注入的 `CAIRN_SESSION_AGENT_ID`，agent_type = `'mcp-server'`（或可选透传 host hint），capabilities = `[]`（保持简洁），heartbeat_ttl 走 default 60s。
- 启动后 `setInterval(30000, () => heartbeat(SESSION_AGENT_ID))` 每 30s heartbeat 一次。
- `process.on('SIGINT'/'SIGTERM'/'beforeExit')` —— 优雅关闭时调一次 heartbeat 标 `status='IDLE'` 或显式 `register(status='DEAD')`；如果失败，让 daemon 的 staleness sweeper 自然处理（heartbeat_ttl 60s 后标 DEAD）。

**严格边界**：

- ❌ **不**新增 MCP tool（既不暴露给 agent，也不增加 schema）
- ❌ **不**改 daemon 仓储函数（直接调用现有 `register` / `heartbeat`）
- ❌ **不**做 orchestration / dispatch / 任何替 agent 的决策——纯 presence 上报
- ❌ **不**让 panel 主动写 processes 表（panel 仍 strict read-only；写者仍是 mcp-server）
- ❌ **不**改任何已有 MCP 工具的行为（包括 `cairn.process.register/heartbeat` —— 它们仍存在，仍可被 agent 显式调用，行为不变）
- ❌ **不**改 workspace.ts 已有的 SESSION_AGENT_ID 计算逻辑

**为什么这是合规改动**：

- PRODUCT.md §1.3 反定义没有禁止 "mcp-server 维护自己的 presence"——这与 "Cairn 不写代码 / 不调度 / 不替 agent 决策" 完全无关
- CLAUDE.md "已落地约定" 段已经把 SESSION_AGENT_ID 自动注入和"agent_id 参数缺省"列为现状；本改动只是把"缺省调"扩展到"启动时主动调一次"
- 本质上是把 mcp-server 现有的 implicit presence assumption 显式化，让 panel 能据此呈现"agent 在线"

**测试 / 验证**：

- 现有 `tests/stdio-smoke.test.ts` + 各 process tool 测试不应被破坏（启动时多调一次 register 不改变工具行为）
- 新增极少量测试：boot-time register 的存在性、heartbeat interval 工作（用 fake timers）
- live dogfood：`cd packages/mcp-server && npm run build && node dist/index.js` 启动后查 SQLite，processes 表应有当前 SESSION_AGENT_ID 行 status=ACTIVE

**Day 1 单独 commit**（与 desktop-shell 改动分离），diff 范围局限在 mcp-server。详 §5 Day 1。

---

## 4. UI 结构建议

### 4.1 窗口形态升级（frameless slide-in）

| 维度 | Quick Slice | Project-Aware |
|---|---|---|
| Window chrome | 默认 OS title bar | **frameless**（`frame: false` + `transparent: false`） |
| 位置 | 用户可拖任意位置 | **贴右屏边**，从右侧 slide-in/out |
| 宽度 | 480×600 BrowserWindow | ~380-420×屏幕高度的 80%（适配显示器） |
| 入口 | tray click → BrowserWindow.show() | tray click → slide-in 动画展开 / 第二次点击 → slide-out 收起 |
| 拖动 | OS 提供的 title bar | 自定义 16-20px 顶部拖动条 + 双击吸附右屏边 |
| 信息密度 | 中（card + tabs + 中等行高） | **高**（行高 18-20px / 紧凑分组 / monospace 主导） |

实施要点：

- `BrowserWindow({ frame: false, transparent: false, alwaysOnTop: false, skipTaskbar: false, resizable: true })`
- slide-in 动画：`win.setBounds()` per frame（30fps = 33ms 步长 × ~10 frames），从屏幕外（x = screenWidth）滑到 x = screenWidth - panelWidth
- slide-out 反向，到位后 `win.hide()`
- panel 自定义"标题栏"：顶部 28px 高，`-webkit-app-region: drag`，含 project switcher 按钮 + close 按钮 + tray 状态点
- 二次 tray click：检测 panel 是否 visible 且 focused，是 → slide-out，否 → slide-in

跨平台：本 plan 主目标 Windows 11；macOS / Linux 复测留 Hardening。

### 4.2 floating marker 降级

- 移除 `petWindow` 的 `open-inspector` click handler 中"打开 legacy Inspector"行为
- marker 仍然是 ambient presence，schema-driven sprite 动画契约不变（PRODUCT.md §8.5 9 条规则）
- **单击 marker → `togglePanel()`**（与 tray click 一致）—— marker 不承担 legacy Inspector 入口，但承担"快速唤起 panel"的副入口角色
- legacy Inspector **只**通过 tray 右键菜单访问（不删，`dogfood-live-pet-demo.mjs` 仍依赖 legacy 行为）

### 4.3 panel 内部结构

```
panel.html
├── #titlebar  (drag region, 28px)
│   ├── ◀ back / ☰ menu (project switcher)
│   ├── workspace label
│   └── status dot · close ✕
├── #content
│   ├── #view-projects (L1)
│   │   └── ProjectCard × N + "Add project…" row
│   └── #view-project (L2; hidden by default)
│       ├── #project-header (path + health + back arrow)
│       ├── #summary-card
│       ├── #tabs  ([Sessions][Tasks*][Run Log][Conflicts])
│       └── #view-body
│           ├── #view-sessions
│           ├── #view-tasks-tree
│           ├── #view-runlog-project
│           └── #view-conflicts
```

**视觉风格继承 Quick Slice**：monospace dark `#1a1a1a`、severity 着色 sev-info/warn/error、pill / kbd 复用样式。

**信息密度提升**：

- 行高从当前 `padding 5px` 收紧到 `padding 2px 4px`
- task tree 缩进用 12px（不是 24px）
- 所有时间用 `HH:MM:SS` 或 `relTime`，绝不写完整 ISO 字符串
- pill / state 配色复用 Day 2 已有的 8 个 task state class

### 4.4 Tray 状态机不变

- alert / warn / idle 三档已落地
- 计算改为 across all projects in registry：`max(state_per_project)`
- tooltip 改为 multi-project 形态：`Cairn — 3 projects · 1 alert · 0 warn · 2 idle`
- click → toggle slide-in panel（同 §4.1）

---

## 5. 最小可落地切片（6 days）

切片设计原则：每 day 一 commit，每 day 末 `node --check` + 真 DB smoke + 一行 boot log。Day 1 单独 commit 在 mcp-server 包里以保持 diff 干净；Day 2-6 都在 desktop-shell。

### Day 1 — mcp-server presence integration

**目标**：让 mcp-server 启动即在 SQLite 里写入自己的 presence，panel 才能看到真实 agent 状态而不依赖 fixture。详 §3.4。

**任务**：

1. 找到 mcp-server 启动入口（`packages/mcp-server/src/index.ts` 或 workspace.ts），定位 SESSION_AGENT_ID 已经计算 + 注入 env 的位置
2. 在该位置之后调 daemon 的 process repo `register` 函数（直接 import，不走 MCP 工具）：
   - `agent_id` = SESSION_AGENT_ID
   - `agent_type` = `'mcp-server'`（保守起见，host hint 留 capabilities）
   - `capabilities` = `[]`（或 mcp-server 已暴露的工具数：`['28-tools']` 类标记，待实施时按现成代码风格定）
   - `status` = `'ACTIVE'`
   - `last_heartbeat` = `Date.now()`
   - 如果 register 已存在同 agent_id 行（重启场景）→ UPDATE last_heartbeat + status='ACTIVE'（用现有仓储函数语义；如果 register 不支持 upsert，需要先 list/get 判断再分流）
3. 起 `setInterval(30000, heartbeatTick)`：每 30s 调 heartbeat 仓储函数，error 静默吞掉（写日志即可，别让 panel 这种用例 crash mcp-server）
4. `process.on('SIGINT' / 'SIGTERM' / 'beforeExit')`：clearInterval + 尝试调一次 register（status='IDLE'）做优雅退出。失败由 daemon staleness sweeper 兜底（heartbeat_ttl 60s 后自动标 DEAD）
5. 现有 `cairn.process.register` / `heartbeat` MCP 工具行为**不动**——agent 仍可显式调，仍按 ws.agentId 缺省取 SESSION_AGENT_ID
6. **测试**：
   - `cd packages/mcp-server && npm test` 应全绿（不破坏现有 17 个测试文件）
   - 加新单测覆盖 boot-time register（用 fake-timers 检查 heartbeat interval）
7. **Live smoke**：
   - `cd packages/mcp-server && npm run build && node dist/index.js` 启动几秒后 ctrl-C
   - `node -e "...query processes..."` 看 processes 表有当前 SESSION_AGENT_ID 行 status='ACTIVE'（启动期间）/ 'IDLE'（优雅退出后）

**Commit**：`feat(mcp-server): boot-time presence — auto register + 30s heartbeat`

**Day 1 DoD**：

- ✅ mcp-server 启动后 1s 内 processes 表多一行（SESSION_AGENT_ID）状态 ACTIVE
- ✅ 30s heartbeat 工作（last_heartbeat 在更新）
- ✅ ctrl-C / SIGTERM 下尝试标 IDLE（即使失败也不影响进程退出）
- ✅ npm test 全绿（无既有测试破坏）
- ✅ 不增加 MCP 工具 / 不动 schema / 不动其他 mcp-server 行为
- ✅ desktop-shell **完全没碰**（Day 2 才动）

---

### Day 2 — Project registry + multi-DB connection + L1 Projects list

**目标**：从 single-DB single-project（Quick Slice）升级到 registry-based multi-project。

**任务**：

1. 新建 `~/.cairn/projects.json` 读写 helpers in `main.cjs` —— schema 详 §3.1
2. 启动迁移：旧 `desktop-shell.json.dbPath` → 写入 registry 第一行（id=`legacy-default`，project_root=`(unknown)`，agent_id_hints=`[]`），用户在 panel 里再 manually assign hints
3. `main.cjs` 改造：把 single `db` / `tables` 变成 `Map<dbPath, { db, tables, refCount }>` —— 多 project 共享 db_path 时 refCount += 1，registry remove 时 -= 1，到 0 才 close handle
4. `queries.cjs` 加：
   - `queryProjectSummaryFor(project)` —— 输入 registry record，应用 hints 过滤逻辑（详 §3.1 筛选语义）
   - `queryUnassignedSummaryFor(dbPath, allHintsAcrossProjects)` —— 计算 db 内不被任何 project 命中的行计数
5. 新 IPC channels（命名空间从 `get-project-*` 升级，路由含 project id）:
   - `get-projects-list` → 返回 `{ projects: [...], unassigned_buckets: [...] }`
   - `get-project-detail(projectId)` —— 后续 Day 3-4 用
   - `get-unassigned-detail(dbPath)` —— 后续 Day 3 用
   - `add-project(project_root, db_path?, agent_id_hints?)` —— dialog 走（folder picker for project_root + auto-detect db_path）
   - `remove-project(id)` / `rename-project(id, label)` / `add-hint-to-project(id, agent_id)`
6. `panel.html` 加 `#view-projects` L1 视图（project cards + Unassigned cards + "Add project…"），默认显示
7. 旧的 single-project header / summary card 迁到 `#view-project` 但**先不显示**——Day 3 再启用 L2

**Commit**：`feat(desktop-shell): Project-Aware Day 2 — projects registry + L1 list (project_root identity)`

**Day 2 DoD**：

- ✅ panel 启动后默认看到 Projects list（含从 legacy migrate 来的至少 1 行）
- ✅ Add project → 对话框选 project_root → 自动算 db_path 默认 → 自动算 agent_id_hint → registry 多一行 → card 多一张
- ✅ 两个 project 共用同一个 db_path 显示成两张独立 card，且两边的 active agents / tasks / blockers 计数因 hints 不同而不同
- ✅ Unassigned card 自动出现（只要 db_path 里有 hints 没命中的行）
- ✅ tray badge 反映 across-projects（不算 Unassigned）最严重 state
- ✅ 不破坏 Quick Slice：legacy Inspector 仍可从 tray 菜单打开
- ✅ 不动 daemon / 不动 mcp-server（presence 改动 Day 1 已完成）

---

### Day 3 — L2 project drill-down skeleton + Sessions tab + Unassigned drill-down

**任务**：

1. L1 card click → L2 视图，slide 切换（Day 5 加动画前先无动画）
2. L2 含 project header（project_root path / db_path / back / health）+ summary card（per-project，沿用 Day 2 数据）+ Tabs 占位
3. **Sessions tab 实施**：
   - 按 status 分组（ACTIVE / STALE / DEAD），STALE = `status='ACTIVE' AND now - last_heartbeat > heartbeat_ttl × 1.5` (grace period for R6)
   - 每行：agent_id（缩短显示） · agent_type · last hb rel time · capabilities pills
   - 每行下方 ` └ owns N tasks (m RUNNING / k BLOCKED / ...)` 通过 `tasks WHERE created_by_agent_id=?` 计数
   - 点 row → 切到 Tasks tab + `agentFilter` 设为该 agent_id（Day 4 才有效）
4. **Unassigned drill-down**：点 Unassigned card → 进 L2，但视图简化：
   - 显示 db_path
   - 列出未命中行（按 source 分组：Sessions / Tasks / Conflicts / Dispatch）
   - 每个 agent_id 行显示 "Add to project…" 按钮 → 弹出 project 选择 → 写入对应 project 的 hints
5. Tasks / Run Log / Conflicts tab 仍是 placeholder

**Commit**：`feat(desktop-shell): Project-Aware Day 3 — L2 drill-down + sessions view + unassigned`

**Day 3 DoD**：

- ✅ 点 L1 card → 进入 L2，再点 back → 回 L1
- ✅ Sessions tab 看到至少 ACTIVE / STALE / DEAD 三组（即使有组为空也显示分组标题）
- ✅ owns N tasks 计数与 SQL 实查一致（hints 过滤后）
- ✅ Unassigned 视图能看到 hints 未命中的行；"Add to project…" 把 agent_id 加进 hints 后该行从 Unassigned 移到 project 视图（再次刷新生效即可）
- ✅ 切 project 切 tab 都不闪烁

---

### Day 4 — Task tree + checkpoints visibility + per-project Run Log

**任务**：

1. **Tasks tab 树渲染**：
   - `queryTasksTree(project, { agentFilter, stateFilter })` —— 一次查全表（已 hints 过滤）→ 客户端构造 parent_task_id 树
   - 每节点 L2 自动展开（metadata + outcome + blocker count + checkpoint count）
   - 点 row → toggle L3 detail（checkpoints list / blocker history / outcome detail）
   - 顶部 filter 工具条（state dropdown + agent dropdown，"clear" 按钮）
2. **Checkpoints 可见**：
   - 任务 L3 展开时 LEFT JOIN `checkpoints WHERE task_id=?` ORDER BY created_at DESC
   - 每条显示 label · git_head · snapshot_status pill · size_bytes（人读 KB/MB）· created_at rel · ready_at rel
   - **不显示 paths_affected_json**（schema 没有此列；详 §1.4 + §3.3）
   - "复制 ckpt-id" 按钮（写 `id` 到剪贴板 —— agent 用这个 id 调 `cairn.rewind.to`）
   - 任务无 checkpoint：显示 `(no checkpoints)`
3. **per-project Run Log**：
   - `queryRunLogEvents(project)` —— 5 表 + checkpoints 共 6 类源 + processes heartbeat（5min 折叠）
   - 应用 hints 过滤：每类源筛逻辑详 §3.1
   - heartbeat 折叠：`processes.last_heartbeat` 仅取最近 5min 内的，每个 agent 一条聚合事件 `process.heartbeat (5min window)`
   - filter 工具条（source / agent / task）
   - 列加 agent 列；message 列保留
4. **Conflicts tab**：仅当 `conflicts WHERE (agent_a IN hints OR agent_b IN hints) AND status IN ('OPEN','PENDING_REVIEW')` 非空时才在 tab bar 显示标记 `Conflicts (N)`，0 时该 tab 灰色 disabled
5. EXPLAIN QUERY PLAN per new query（同 Quick Slice §10 R16 实践），结果摘到 commit message

**Commit**：`feat(desktop-shell): Project-Aware Day 4 — task tree + checkpoints + run log per project`

**Day 4 DoD**：

- ✅ task tree 至少 2 层渲染（含 parent_task_id 关系，hints 过滤后）
- ✅ 点开 task 看到 checkpoints 列表（W5 dogfood 历史 DB 至少有一条；显示 label + git_head + snapshot_status + size + 时间，不显示 paths）
- ✅ filter（state + agent）工作
- ✅ Run Log 包含 checkpoint.created 事件
- ✅ heartbeat 折叠不刷屏
- ✅ Conflicts tab 仅在有 OPEN 时高亮

---

### Day 5 — Frameless panel + slide-in/out + tray-toggle + floating marker → togglePanel

**任务**：

1. `BrowserWindow({ frame: false, ... })` —— panel 改成 frameless
2. 自定义 `#titlebar`（28px，`-webkit-app-region: drag`，含 back / menu / project label / close）
3. **slide-in 动画**：tray click 触发：
   - 当前 hidden → `win.setPosition(screenW, baseY)` 立即；`win.show()`；setBounds 渐变到 `(screenW - panelW, baseY)` 过 ~280ms
   - 当前 visible 且 focused → setBounds 反向到 `(screenW, baseY)` → `win.hide()`
4. 双击 titlebar 吸附右屏边
5. **floating marker → togglePanel**：
   - 移除 marker click → `open-inspector` 路径
   - marker click handler 改为 `togglePanel()`（与 tray 一致）—— 详 §4.2 patch
   - legacy Inspector 仍可从 tray 右键菜单打开
6. tray tooltip 改 multi-project 形态：`Cairn — N projects · X alert · Y warn · Z idle`

**Commit**：`feat(desktop-shell): Project-Aware Day 5 — frameless slide-in panel + ambient marker`

**Day 5 DoD**：

- ✅ panel frameless，无 OS title bar
- ✅ tray click slide-in 动画 ≤ 300ms，无明显 jank
- ✅ 第二次 click slide-out + hide
- ✅ panel 双击 titlebar 自动贴右屏边
- ✅ marker click → toggle panel（与 tray 一致），不再开 legacy Inspector
- ✅ legacy Inspector 仍可通过 tray 右键访问

---

### Day 6 — Dogfood + plan-for-cairn_events doc + report

**任务**：

1. 准备真实 dogfood 环境：
   - 启动 mcp-server 在不同 cwd 模拟 ≥ 2 个 project（Day 1 presence integration 让它们出现在 processes 表）
   - 注册 ≥ 2 个 project_root 到 registry，每个 hints 含其对应 SESSION_AGENT_ID
   - real project（D:\lll\cairn）跑 W5 demo 历史 + Day 1 mcp-server 启动后会自动加 presence
   - 第二个 project：在另一个文件夹（cwd=`<some_path>`）启 mcp-server，让 SESSION_AGENT_ID 不同 → 加进 registry 第二条 entry，用同一个 db_path（验证多 project 共享 DB 用例）
2. 走完 5 个验收场景（详见 §9 dogfood 验收）
3. 写 `docs/superpowers/demos/Project-Aware-Live-Panel-dogfood.md` —— 同 Quick Slice 报告风格，标 real vs fixture
4. **新写 `docs/cairn-events-table.md`** —— 给 daemon 侧 future schema migration 的 design memo（不是本 plan 实施范围，但本 plan 必须落地这份 design 让 daemon 侧能接得上）。内容含：
   - 为什么需要（本 plan §1.5 + §3.2）
   - 表结构提议（schema sketch）
   - daemon 侧 trigger 还是显式 INSERT 的取舍
   - 与 panel 的接口形态
   - migration 编号（下一个可用 = 011）

**Commit**：`feat(desktop-shell): Project-Aware Day 6 — dogfood + cairn_events memo`

**Day 6 DoD**：

- ✅ 5 验收场景全过（或量化覆盖率 + 缺口标注）
- ✅ dogfood doc 落地，real-vs-fixture 明确
- ✅ cairn-events design memo 落地
- ✅ 6 个 commit 一次性 push（origin + mirror）—— 等用户授权

---

## 6. 不做什么

来自任务边界 + PRODUCT.md v3 §1.3 + 防止滑坡。

### 6.1 不做（产品边界）

- ❌ desktop write actions（answer blocker / rewind / dispatch / resolve conflict from panel）—— D9 三前置未亮
- ❌ agent 自动派单 / 自动接管 task / 自动答 blocker
- ❌ AI PMO recommendations（"下一步建议"）
- ❌ Cursor-like 嵌入代码编辑器 / diff viewer
- ❌ Jira / Linear-like sprint / 看板 / story point / burn-down
- ❌ 跨机协作 / 多机 sync / multi-user shared daemon
- ❌ 企业 SSO / RBAC / 审计合规

### 6.2 不做（数据 / schema）

- ❌ 新增 schema migration（包括 `tasks.project_id` / `cairn_events` —— 这些是 Later daemon 工作；本 plan 仅写 design memo）
- ❌ 新增 MCP 工具
- ❌ 新增 npm dependency（前端框架 / TypeScript / bundler / Tailwind / 任何运行时库）
- ❌ 改 daemon 源码
- ❌ 改 mcp-server 源码——**唯一例外**：Day 1 的 presence integration（boot-time auto-register + 30s heartbeat），范围严格限定在 §3.4 描述。任何超出此范围的 mcp-server 改动 veto
- ❌ 触碰 spritesheet / LICENSE / RELEASE_DECISIONS / 2 个 package.json

### 6.3 不做（UI 范围）

- ❌ 完整 detail drawer 独立窗口（继续用 inline / panel 内 split pane）
- ❌ 实时事件推送（5-source polling + heartbeat 折叠 即可；高保真 Run Log 是 Later）
- ❌ workspace 自动扫描（registry 是手动添加；自动发现是 Hardening）
- ❌ 跨平台完整支持（Windows 11 主目标；macOS / Linux 留 Hardening）
- ❌ subagent 树形可视化（schema 没有 parent_agent_id，本 plan 不靠 hack 凑；Later schema 加列后再做）
- ❌ tray icon 高分辨率多档 .ico（保持 Quick Slice 16×16 base64 PNG）
- ❌ subagent result 全文展示（scratchpad view 整个进 Hardening；本 plan 仅在 Run Log 里出现 scratchpad 写事件折叠为 "wrote subagent/X/result"）

---

## 7. 预计工作量

**6 个工作日，每天 1 commit。** 不拆版本号，commit chain 一次 push。

| Day | 内容 | 范围 | 风险 |
|---|---|---|---|
| 1 | mcp-server presence integration（auto-register + 30s heartbeat） | `packages/mcp-server/` | R14 / R15（mcp-server 改动） |
| 2 | Project registry（project_root identity）+ multi-DB + L1 list + Unassigned | `packages/desktop-shell/` | R1 multi-DB 连接管理 / R2 registry 并发写 |
| 3 | L2 drill-down + Sessions tab + Unassigned drill-down | `packages/desktop-shell/` | R6 STALE 判定阈值 / R16 hint matching 边界 |
| 4 | Task tree + checkpoints + per-project Run Log | `packages/desktop-shell/` | R3 树渲染性能 / R4 query plan / R5 hints 链式 JOIN 成本 |
| 5 | Frameless panel + slide animation + marker → togglePanel | `packages/desktop-shell/` | R7 跨平台 / R8 jank |
| 6 | Dogfood + cairn_events memo + report | docs only | R9 缺真实 multi-project / R10 dogfood 主观度 |

**Day 1 单独 commit + 单独 package** 让 mcp-server 改动 diff 干净、可独立 review / revert。Day 2-5 都在 `packages/desktop-shell/`。Day 6 纯 docs。

参考 Quick Slice 实际 day 节奏（Day 1+2+3 三天交付 9 项 MUST），本 plan 6 天估值是保守的——project_root reframe + multi-DB + Unassigned + frameless slide-in 是 Quick Slice 没碰过的多块新工程，加上 Day 1 mcp-server 改动需要谨慎不破坏现有 329 测试。

降级方案：

- **Day 1 mcp-server 改动失败**（既有测试坏）：暂停整个 plan，分析根因；不强行往下走（presence 是 §0 完成判据的核心依赖）
- **Day 5 frameless slide-in 跨平台严重问题**：保留普通 BrowserWindow + 改贴右屏边 + 去掉动画——核心信息架构升级（Day 2-4）已交付，UI 形态不阻塞

---

## 8. 风险

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R1** | multi-DB 连接管理：注册 N 个 project → N 个 read-only handle，FD leak / 释放时机 | panel 长跑 OOM / FD 用尽 | 启动时全打开，registry remove 时显式 close；切 project 不重开（已经 hold all handles）；panel 退出 before-quit 全 close |
| **R2** | `~/.cairn/projects.json` 并发读写 | 损坏 registry | 写入用临时文件 + atomic rename；读取容错（解析失败回退到 legacy 单 DB） |
| **R3** | task tree 渲染性能：100 row × 多层 + filter 实时 | panel 卡 | 客户端构造树（一次 SELECT 全表）+ 虚拟滚动留 Hardening；ROW_LIMIT=200 + 树深 ≤ 5 hard cap |
| **R4** | 新 query 缺索引导致慢 | dogfood 真实数据下卡 | Day 3 跑 EXPLAIN QUERY PLAN per query；MVP 规模（≤100 task）下 sub-millisecond，记入 commit message |
| **R5** | `cairn_events` design 与 daemon 实施漂移 | Later 排期接不上 | Day 5 design memo 在 Hardening kickoff 前由 daemon owner review 一次；不在本 plan 实施 |
| **R6** | STALE 判定阈值（`now - last_heartbeat > heartbeat_ttl`）误报 | dogfood 看到全是 STALE 实则 ACTIVE | heartbeat_ttl 默认 60s；mcp-server 每 30s heartbeat（已落地）；STALE 判定加 grace period（× 1.5）；UI 标 "stale (X)" 而非 "dead" 让用户辨别 |
| **R7** | frameless panel 跨平台行为：macOS / Linux 不一样 | 跨平台破 | Quick Slice 的 R11 仍适用：Windows 主目标；macOS / Linux smoke-only；Day 4 失败保留普通窗口 fallback |
| **R8** | slide-in 动画 jank | UX 反例 | `setBounds` 步长粗一点（10 frames × 30ms = 300ms）；动画期间 polling 暂停 1 帧 |
| **R9** | 用户机器无 ≥ 2 个真实 project | dogfood 不到位 | Day 5 fixture script 接受 `--db` 参数支持注入到任意 project 路径；report 标注 "fixture 模拟第 2 project" |
| **R10** | dogfood 验收主观 | 验收过松 | §9 列 5 个具体场景 + 量化指标 + 失败明示 |
| **R11** | floating marker 降级让现有 demo 失效 | break dogfood-live-pet-demo | 不动 marker → legacy Inspector 路径在 tray 菜单中保留；marker click 改 togglePanel 或 no-op 时同步更新 README |
| **R12** | tray badge across-projects 计算成本 | 1s polling × N projects = N × 6 query | 每 project 缓存 5s；tray badge 用 cached aggregate；冷数据 staleness 显示在 tooltip |
| **R13** | UI 太密导致老花眼用户不友好 | 用户体验差 | 提供"舒适密度"切换（CSS class，不引设置面板） in Hardening；本 slice 默认高密度，dogfood 反馈定 |
| **R14** | mcp-server presence integration 破坏既有 329 测试 | Day 1 直接卡 | boot-time register 用现有仓储函数；测试用 fake-timers 隔离 setInterval；新增测试至多 ≤ 5 case；如 boot 路径影响既有 stdio-smoke / process-tool 测试，停下来 review，不绕过 |
| **R15** | mcp-server boot-time register 被误读为 "orchestration" 漂移 | 后续 PR 把 register 扩展成"自动派单 / agent 选型"等违反反定义的东西 | §3.4 严格界定改动范围：仅 register + heartbeat + 优雅退出；任何 PR 修改这块都需引用 §3.4 + PRODUCT.md §1.3 #4 双重审查 |
| **R16** | hint matching 漂移：mcp-server 实际写的 SESSION_AGENT_ID 与 panel registry 期待的 hint 不一致 | project view 永远空 / 全进 Unassigned | Day 1 实施时显式 log boot-time register 的 agent_id（debug 输出），让 panel 加进 hints 时能直接复制；Day 3 的 "Add to project…" 按钮把 Unassigned agent_id 一键 assign 是兜底路径；real dogfood 必走这个流程一次确认 |

---

## 9. Dogfood 验收方式

5 个具体场景；每场景标注 real / fixture / mixed；每场景定量 + 定性两条验收。

### Scenario A — Project Glance across 2 projects (sharing one DB)

**setup**：

- 在 `D:\lll\cairn` 启 mcp-server（Day 1 改动后会自动 register agent A）
- 在另一个 cwd（如 `D:\lll\scratch`，临时建一个空 dir 即可）启第二个 mcp-server（自动 register agent B，与 A 不同 SESSION_AGENT_ID）
- 两个都连默认 `~/.cairn/cairn.db`
- registry 加两条：
  - cairn-self：project_root=`D:\lll\cairn`, db_path=`~/.cairn/cairn.db`, hints=`[<agent_A>]`
  - scratch：project_root=`D:\lll\scratch`, db_path=`~/.cairn/cairn.db`, hints=`[<agent_B>]`

**步骤**：用户从 tray click 唤起 panel（slide-in），看 Projects list。

**验收**：

- ⏱ 定量：panel 启动到 L1 list 渲染 ≤ 1.5s（cold start ≤ 3s）；两张 card 显示 "shares DB with X" 标记
- 👁 定性：能 30 秒内回答"哪个 project 现在最需要我看"——基于 health 排序 + summary 摘要
- 🔬 关键检验：两张 card 的 active agents 各显示 1（不是 2）—— 证明 hints 过滤生效，没把对方 project 的 agent 算进自己

### Scenario B — Drill into project, see agent sessions

**setup**（沿用 Scenario A 的两 project + Day 1 mcp-server presence）：在 cairn-self 项目里再开 1 个 mcp-server（同 cwd，但显式 sleep 90s 不发 heartbeat —— STALE 验证用），cairn-self 现在有 2 个 ACTIVE + 1 个 STALE agent。

**步骤**：点 cairn-self card → 进 L2 → Sessions tab。

**验收**：

- ⏱ 定量：tab 切换响应 ≤ 200ms；STALE 判定与"now - last_heartbeat > heartbeat_ttl × 1.5"实算一致
- 👁 定性：ACTIVE / STALE / DEAD 三组分组到位；每个 agent 下 `└ owns N tasks` 计数与 SQL 实查一致（hints 过滤后）
- 🔬 关键检验：scratch project 的 agent 不出现在 cairn-self 的 Sessions tab 里（即使他们在同一个 DB）

### Scenario C — Task tree drill-down with checkpoints

**setup**：cairn-self project 跑过 W5 dogfood，至少有 1 个 task chain（2 层）+ 多个 checkpoint。

**步骤**：cairn-self → Tasks tab → 找到 W5 BLOCKED task → 展开 → 看到 blocker question + checkpoints list。

**验收**：

- ⏱ 定量：tree 渲染 ≤ 200ms；checkpoint 列表展开 ≤ 100ms
- 👁 定性：树形结构可视（parent_task_id 缩进正确）；checkpoint 显示 label + git_head + snapshot_status + size + 时间（**不显示 paths_affected_json，schema 没有此列**）；"复制 ckpt-id" 按钮把 `id` 写入剪贴板

### Scenario D — Run Log per project + filter

**setup**：fixture project 注入 5 source 全部各 ≥ 1 条事件 + 5 个 process.heartbeat。

**步骤**：fixture project → Run Log tab → filter by source = `outcomes` → filter by agent = `cairn-demo-agent-cc`。

**验收**：
- ⏱ 定量：filter 切换 ≤ 100ms；heartbeat 折叠成 1 条而非 5 条
- 👁 定性：6 source（含 checkpoints）都能渲染；filter 链式工作；空过滤态显示 "(no events match)"

### Scenario E — Frameless slide-in panel + marker → togglePanel

**setup**：N/A，纯 UI 验收。

**步骤**：tray click → panel slide-in → 操作几秒 → marker click → panel slide-out（marker 与 tray 行为一致）→ marker click 再来一次 slide-in。重复 3 次。

**验收**：

- ⏱ 定量：slide 动画 ≤ 300ms；3 次 toggle 无 leak（任务管理器 panel renderer process RSS 不显著上升）
- 👁 定性：panel 贴右屏边；frameless 无 OS title bar；marker 单击与 tray 单击行为一致（toggle panel）；legacy Inspector 仅在 tray 右键菜单可达，marker 永远不开 legacy

### 横切验收

- **Read-only 守住**：`grep '\.run\|\.exec' packages/desktop-shell/*.cjs *.js` ≤ 1 处（仍是 dev-only resolve-conflict）；panel 长跑 1h 后 cairn.db mtime 无明显变化
- **跨 view 一致**：tray badge 颜色 = max(per-project state)；切 project 后 tray badge 不应改变（across-projects state 不变）
- **不破坏 Quick Slice**：legacy Inspector 通过 tray 右键 still works；dogfood-live-pet-demo.mjs 可跑

### 报告模板

`docs/superpowers/demos/Project-Aware-Live-Panel-dogfood.md`：

- 5 个场景 × （real / fixture / mixed 标签 + 定量数据 + 定性观察 + 实际表现 vs 预期）
- 横切验收 checklist
- 发现的 bug / 后续 Hardening 优先级建议
- "若 cairn_events table 已存在，本 dogfood 能多覆盖什么" —— 给 daemon 侧 design memo 反馈

---

## 10. 与 PRODUCT.md v3 + Quick Slice 的关系

**v3 反定义全部保留**（PRODUCT.md §1.3 9 条），本 plan 不改一条。

**Quick Slice 不被废止**：

- `queries.cjs` / `panel.html` 大量复用，新视图叠加而非替换
- `inspector-legacy.{html,js}` 不动（legacy fallback 路径）
- mutation env flag (`CAIRN_DESKTOP_ENABLE_MUTATIONS`) 行为不变
- `SCHEMA_NOTES.md` 是真理，本 plan 所有 SQL 都依赖它的列名

**v3 §6.2 9 项 MUST 关系**：

| Quick Slice MUST | Project-Aware 状态 |
|---|---|
| MVP-1 project selector | 升级为完整 registry + L1 list |
| MVP-2 tray status icon | 保留，badge 改 across-projects 聚合 |
| MVP-3 side panel shell | 升级为 frameless slide-in |
| MVP-4 project summary card | per-project，进 L2 视图 |
| MVP-5 agent sessions view | 实质实施（Quick Slice 仅 summary 计数） |
| MVP-6 task chains view | 实质实施树形（Quick Slice 是平铺） |
| MVP-7 blockers + outcomes view | 折入 task tree L3，符合"按 task 组织" |
| MVP-8 Live Run Log | per-project + 加 checkpoints + heartbeat 折叠 |
| MVP-9 desktop dogfood | 升级为 multi-project dogfood |

**§11 Later Hardening 关系**：本 plan 把 Quick Slice 列为 Hardening 的 "agent sessions full view" / "blockers + outcomes 独立 view" / "checkpoints view" 三项**部分前移**到本 slice，但**没**做完整版 ——

- agent sessions：本 slice 做 ACTIVE/STALE/DEAD 分组 + owns tasks 计数；不做 heartbeat 长时间序列 / capabilities 详细页
- checkpoints：本 slice 在 task L3 可见；不做独立 timeline 视图
- blockers + outcomes：本 slice 在 task L3 + Run Log 可见；不做独立排序视图

完整版仍是 Hardening。本 plan 之后剩余的 Hardening 列表会更短但更具体。

---

## 11. 决策点（已锁定，2026-05-08 patch）

下面 5 项默认决策在 patch 阶段已被 user 确认。任何 day 内的改动想反这些默认要先 review，不能 agent 自决。

1. **registry 模型 = project_root + db_path + agent_id_hints**（**LOCKED**）。schema 加 project_id 是 Later daemon 工作。详 §1.1 + §3.1。
2. **floating marker click → togglePanel**（**LOCKED**）。与 tray click 一致；不再开 legacy Inspector。详 §4.2。
3. **slide-in 技术 = `BrowserWindow.setBounds()` per frame**（**LOCKED**）。备选 BrowserView + CSS transform 留 Hardening。详 §4.1。
4. **per-project Run Log 含 heartbeat（5min 折叠）**（**LOCKED**）。完全排除是 Quick Slice 行为，本 plan 加。详 §3.3 + Day 4。
5. **cairn_events memo 落地位置 = `docs/cairn-events-table.md`**（**LOCKED**）。plan 化 / 排期归 daemon owner。详 §3.2 + Day 6。
6. **mcp-server presence integration 容许**（**LOCKED**，本次 patch 新增）：Day 1 单独 commit；范围严格按 §3.4，不扩散。

如果实施期间发现某项默认决策触底层硬冲突（schema 实际无法支撑 / Electron API 不接），停下来 review，不强推。

---

## 12. Out-of-scope reminder（防止滑坡）

如果实施期间有人提以下需求，**直接 veto** 并指向：

- "panel 加输入框让用户答 blocker / 下指令" → PRODUCT.md §12 D9 / 本 plan §6.1
- "panel 嵌代码编辑器 / diff viewer" → PRODUCT.md §1.3 #2
- "panel 自动给下一步建议 / 接管 task" → PRODUCT.md §6.3 + 本 plan §6.1
- "顺手把 cairn_events 表加上吧" → 本 plan §3.2 + §6.2，daemon 侧另立工作
- "Run Log 做实时推送 / replay / 高级 grouping" → PRODUCT.md §11 Hardening
- "scratchpad 视图 / subagent 树可视化" → 本 plan §1.3 末段 + §6.3
- "做 macOS / Linux 完整支持" → 本 plan R7 / Hardening
- "加个 React 框架啊不然太难维护" → PRODUCT.md ADR-8 + CLAUDE.md frozen stack
- "把 mutation 解锁吧 D9 前置一个个补不嫌烦吗" → PRODUCT.md §12 D9（三前置必须**全亮**才解锁）

---

## 13. 上游依赖确认

- **PRODUCT.md v3** commit `3562f1f`（§1.2 四层架构 / §1.3 反定义 / §6.2 MUST / §6.3 Later / §8 UX / §12 D9 / §13 v1-v2-v3 演进）
- **Quick Slice MVP** commits `f088b56..4c24fb6`（panel.html / panel.js / queries.cjs / SCHEMA_NOTES.md / dogfood report）
- **CLAUDE.md** Agent Work Rules（commit `7048fc9`）+ docs sync（commit `b0f6081`）
- **README.md** v3 sync（commit `6f37ad9`）
- **ARCHITECTURE.md** v3 sync（commit `3e65912`）

如以上任一文档在本 plan 实施期间被改动到关键节，本 plan 同步更新。

---

> 本 plan 完成后停下，等 user review。不动源码。确认后再开 Day 1。
