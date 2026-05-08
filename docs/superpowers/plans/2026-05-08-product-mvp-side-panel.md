# Product MVP Plan — Project-Scoped Agent Work Side Panel

> 日期：2026-05-08
> 状态：Plan ready for kickoff。源码尚未动。
> 上游：PRODUCT.md v3（commit `3562f1f`），§6.2 9 项 MUST + §12 D9 read-only 边界
> 实施位置：`packages/desktop-shell/`（不动 daemon / mcp-server 源码）
> 本 plan 不引入新 MCP 工具，不动 schema，不动 migrations。
>
> **Patch 历史**（本文件原地修订，未拆 commit）：
> - **2026-05-08 v0**：原 7-day Product MVP plan
> - **2026-05-08 v1**：收窄为 3-day Quick Product Slice + Later Hardening；锁 5 项 Decisions
> - **2026-05-08 v2**（current）：8 项必改 review patch + R13-R17：
>   - tasks 真实列名（`task_id` / `created_by_agent_id`，无 `id` / `current_attempt`）
>   - blockers 时间锚点 `raised_at`（不是 `created_at`）
>   - project selector 语义校正：DB path picker，不是 project 维度过滤
>   - legacy mutation button：JS 检查 `window.cairn.resolveConflict` 存在才渲染
>   - tray icon 资源：checked-in `.ico` 多分辨率，不用 webp / canvas / spritesheet
>   - tray lifecycle：`window-all-closed` 修复，关 panel 不退应用
>   - Day 1 抽 `queries.cjs` + 5 JSDoc typedef
>   - 不上 framework / TS / Vite（subagent verdict）
>   - R13-R17 五项新风险

---

## 0. 30 秒总览

把 Cairn 从 kernel + MCP 能力层接成一个**程序员看得见的 project control surface**。形态：tray + floating marker（已有）+ side panel（升级现有 Inspector window）。

3 天 Quick Slice 交付雏形：
- **Day 1**：side panel shell + project summary card（保留 legacy Inspector fallback）
- **Day 2**：Run Log low-fidelity（默认主视图，5 类事件源）+ tasks 列表 + inline expansion detail
- **Day 3**：tray icon + desktop dogfood（real + cairn-demo-* fixture 混合）

完整 Product MVP 的剩余项目移到 **Later Hardening**（§11）。Quick Slice DoD（§10）通过即可进入 Hardening 评估，不强求 9 项 MUST 在 3 天内全做完。

**关键复用**：`packages/desktop-shell/` 已有 Electron 骨架 + read-only SQLite 连接 + 一个简化版 Inspector window（agents / conflicts / dispatches / lanes 4 段，1s 轮询）。Quick Slice = 在这个骨架上加 tray + 改 layout + 加 Run Log + 加 task 列表，**不重写**，并保留 legacy Inspector 作为 debug fallback。

---

## 1. Goal

**Quick Product Slice 目标**：把 PRODUCT.md v3 的 project control surface 落到一个**可启动、可观察、可 dogfood 的雏形**。让用户在不离开 Codex / Claude Code / Cursor / Kiro 的前提下，从桌面入口看到当前 project 的：

- 状态现状：active agents、running / blocked / waiting_review tasks、open blockers、failed outcomes、open conflicts、recent dispatches
- 执行链：Run Log 把 5 类事件源（tasks / blockers / outcomes / conflicts / dispatch_requests）按时间排序呈现
- 入口形态：tray icon 常驻，唤起 side panel；不依赖 `npm start` 打开窗口

**不是**完整 MVP 终态。完整 9 项 MUST 中：
- ✅ Quick Slice 覆盖：MVP-2 tray、MVP-3 side panel shell（不含完整 detail drawer）、MVP-4 project summary、MVP-6 task chains（基础列表 + inline expansion，无完整 drill-down drawer）、MVP-8 Live Run Log low-fidelity（5 源版，非 8 表全量）、MVP-9 dogfood
- ⏳ Later Hardening：MVP-1 完整 project selector / 自动发现、MVP-5 完整 agent sessions view、MVP-7 完整 blockers + outcomes 独立视图（Quick Slice 仅在 summary + Run Log 可见）

---

## 2. Product framing（来自 PRODUCT.md v3）

- **主定位词**：project control surface / project-scoped agent work side panel
- **辅助 framing**："AI PMO layer"（介绍场景下用一次，不重复）
- **形态参考**：Activity Monitor、Windows 任务管理器、journalctl —— 信息密度高、read-only、实时刷新
- **形态反例**：Cursor / VS Code IDE、Jira / Linear / Asana、Figma / Slack、Cairn v1 桌面宠物 + 单对话面

读者一打开 panel 应该感觉像"看 OS 内部状态"，不是"用又一个 PM 工具"。

---

## 3. Non-goals（这个 Quick Slice 不做）

来自 PRODUCT.md v3 §6.3 + 任务边界：

- ❌ desktop write actions（answer blocker / rewind / dispatch / resolve conflict from panel）—— D9 升级前置条件未满足
- ❌ agent orchestration / 自动派 agent / 自动拆任务
- ❌ AI PMO recommendations（"下一步建议"）
- ❌ Jira/Linear-style sprint / 看板 / story point / burn-down
- ❌ Cursor-like IDE / 嵌入代码编辑器 / diff viewer
- ❌ 小团队 sync / 跨机协作
- ❌ 新增 MCP 工具
- ❌ 新增 schema migration / 新增 kernel primitive
- ❌ Live Run Log 高保真（实时推送 / 高级筛选 / grouping / replay）
- ❌ Live Run Log 8 表 UNION ALL（Quick Slice 只 5 类事件源；processes / scratchpad / checkpoints 进 Hardening）
- ❌ true event sourcing / events table / 后台 polling 框架重写
- ❌ 完整 detail drawer / 独立 drawer 窗口 —— 用 inline expansion 替代
- ❌ 完整 project selector 自动扫描 / workspace auto-discovery —— 仅支持手动指定 db path
- ❌ 完整 agent sessions / blockers / outcomes 独立视图 —— Quick Slice 中只在 summary + Run Log 可见，独立视图进 Hardening
- ❌ 系统通知集成（OPEN conflict 弹系统级通知）—— tray badge 是最小可见性
- ❌ Inspector NL panel UI（自然语言查 kernel）
- ❌ 复杂 tray badge 设计 / 高级图标动画 —— Quick Slice 颜色 + 数字 / tooltip 即可
- ❌ GUI 自动化测试框架 —— Quick Slice 走手动 smoke + dogfood

**关于现有 resolve-conflict mutation**（在 `main.cjs` 已存在）：详 §6 Decision 1 + §10 R1 处理决策 = dev flag 隔离。

---

## 4. Current desktop-shell inventory

`packages/desktop-shell/` 当前文件清单 + 每个的当前职责：

| 文件 | 行数 | 职责 | Quick Slice 处理 |
|---|---|---|---|
| `package.json` | ~20 | Electron 32 + better-sqlite3 12 + `npm start` | 不动；**不新增 npm dep** |
| `main.cjs` | 233 | Electron bootstrap、pet window、Inspector window、IPC handlers、SQLite read-only + 一个 lazy write handle（resolve-conflict） | **Day 1 改**：加 tray、加 project path 切换、加新 read-only IPC handlers、resolve-conflict 隔离到 `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` env flag（Decision 1） |
| `preload.cjs` | 14 | contextBridge 暴露 `window.cairn` API | **Day 1 改**：加新 channel；mutation channel 仅在 dev flag 下注册 |
| `preview.html` / `preview.js` | 49 + 266 | pet sprite 渲染 + 拖动 | 不动（floating marker 已落地） |
| `inspector.html` / `inspector.js` | 49 + 97 | 现有 Inspector window（4 段：active agents / open conflicts / recent dispatches / active lanes）；polling 1s | **保留为 legacy fallback**：`inspector-legacy.html` / `inspector-legacy.js`（Decision 1）；新建 `panel.html` / `panel.js` 作为新主视图；Electron route 支持快速切回 legacy |
| `state-server.js` | 120 | 浏览器 fallback（HTTP @ 7842，调试用） | 不动 |
| `dogfood-live-demo.mjs` / `dogfood-live-pet-demo.mjs` | — | 已有 demo script | 不动；Day 3 新写 `mvp-quick-slice-dogfood.mjs`（独立脚本，不替代旧的） |
| `spritesheet.webp` / `spritesheet.v0.webp` | — | floating marker sprite 资源 | **不碰**（working tree 中已有 dirty 状态） |
| `README.md` | 40 | desktop-shell 自身 README | **Day 3 改**：加 panel + tray 启动说明 + dev flag 文档 |
| `node_modules/` | — | 装了 `better-sqlite3@^12.9.0` + `electron@^32.0.0` | 不动 |

**关键复用决策**：

- **不**为 side panel 重新立项 / 切框架 / 引新 stack。继续用 Electron + 原生 HTML/CSS/JS，无 React / Vue / 任何前端框架
- **legacy Inspector 保留**为 `inspector-legacy.html` / `.js`，Electron 启动参数支持切回（Decision 1 + Day 3 右键菜单 "Open Legacy Inspector"）
- IPC 走现有 `contextBridge` + `ipcMain.handle` 模式，加新 channel
- SQLite 路径继续用 `~/.cairn/cairn.db` 默认；Day 1 加手动指定 path（Decision 3）

---

## 5. Data sources from SQLite

只用现有 8 类 host-level state objects 的 read-only 查询，不动 schema。Quick Slice 实际只动 5 张表（Decision-tied; Hardening 才做 8 表）。

| Quick Slice 用法 | 读哪些表 | 示例 |
|---|---|---|
| Project summary card | `processes` / `tasks` / `blockers` / `outcomes` / `conflicts` / `dispatch_requests` | 6 个 COUNT 聚合（一次查询多个 SELECT 拼成 JSON） |
| Tasks list | `tasks` | `SELECT task_id, parent_task_id, state, intent, created_at, updated_at, created_by_agent_id FROM tasks ORDER BY updated_at DESC LIMIT 100` |
| Task inline detail | `tasks` + `blockers`（filter task_id）+ `outcomes`（filter task_id） | per-task 多 query，按需触发（点击 task row 才查） |
| Blockers join with tasks | `blockers` + `tasks` | `SELECT b.*, t.intent FROM blockers b JOIN tasks t ON t.task_id=b.task_id ORDER BY status='OPEN' DESC, b.raised_at DESC` |
| Run Log low-fidelity | **5 类事件源**：`tasks` / `blockers` / `outcomes` / `conflicts` / `dispatch_requests` | UNION ALL → 客户端排序 → 取前 200，详 §7.4 |
| Tray badge / tooltip | summary 子集（agents 计数 / blockers OPEN / outcomes FAIL / conflicts OPEN） | 复用 summary query |

**Quick Slice 不读**（进 Hardening）：`scratchpad`、`checkpoints`、`processes` 全字段、`processes.last_heartbeat` 作为 Run Log 事件源。

**已知 schema 注意点**（R2，已根据 schema check 收口）：

- 当前 `main.cjs` 查 `lanes` 表 —— `lanes` 不在 8 类 host-level state objects 列表里，是 v0.1 之前的 legacy schema。Quick Slice **不**依赖 `lanes`，新查询全部走 6 表的子集
- **`tasks` 真实列**：`task_id` / `parent_task_id` / `state` / `intent` / `created_at` / `updated_at` / `created_by_agent_id`。**没有 `id` 列、没有 `current_attempt` 列**——任何查询都不要写 `tasks.id` / `tasks.current_attempt`
- **`blockers` 真实列**：时间锚点是 **`raised_at`**（不是 `created_at`）+ `answered_at`。任何 ORDER BY / 投影都用 `raised_at`
- 其他列名（`processes.last_heartbeat` / `outcomes.status` / `conflicts.detected_at` / `dispatch_requests.status` 等）以实际 schema 为准（migrations 004/007/009/010），Day 1 schema check 必须验证 + 落到 SCHEMA_NOTES.md
- **缺表 graceful empty**：每个查询前先 `getTables()` 检查表存在，缺则返回空数组 + 在 UI 显示 "(no data — schema missing)"，不崩

Day 1 第一件事 = 跑一遍真实 schema check（`PRAGMA table_info(...)` for `processes` / `tasks` / `blockers` / `outcomes` / `conflicts` / `dispatch_requests`），列差异表写到 `packages/desktop-shell/SCHEMA_NOTES.md`，再写查询代码。

---

## 6. Locked Decisions（5 项）

来自 review patch。这 5 项是 Quick Slice 实施期间不可重新讨论的边界。

### Decision 1 — resolve-conflict 处理：dev flag 隔离

- 现有 `resolveConflict` IPC handler 在 `main.cjs` **不删除**（避免破坏 `dogfood-live-pet-demo.mjs`）
- 触发条件改为 env：`CAIRN_DESKTOP_ENABLE_MUTATIONS=1`
- 默认（无此 env）：
  - `resolveConflict` IPC channel **不注册**（preload 也不暴露）
  - UI 上 `Resolve` 按钮 **不渲染**
  - 任何 mutation action UI 都隐藏
- dev mode（env=1）：
  - 仅 legacy Inspector 显示 Resolve 按钮（panel.html 不显示）
  - 启动 console 打印 `⚠ desktop mutations enabled (dev only)` 警示
- 任何 PR 加新 mutation channel 都要走 dev flag

### Decision 2 — detail drawer 折入 panel（不做独立小窗）

- Quick Slice 中 task / row 的 detail = **inline expansion**：点行展开下方 6-12 行附加信息，再点收起
- 或 panel 内固定 detail 区（底部 ~30% 高度的 split pane）—— Day 2 实施时二选一
- **不**新建 BrowserWindow / 不做拖拽小窗
- 完整 detail drawer 设计 → Hardening

### Decision 3 — "project selector" = DB path picker（不是真 project model）

**重要语义校正**：当前 schema 没有真正的 `project_id` / `cwd` 字段对 row 做 project 维度过滤。Quick Slice **不能**承诺"按 project 过滤"——这是工程事实，必须在 plan / UI 文案上一致。

具体落点：

- Quick Slice **假设** `selected DB == active project`（一个 SQLite 文件 = 一个 project 范围）
- panel header 显示的是 **workspace / project label**（取 db path 的 dirname 或 basename），是给用户的视觉锚，不是数据过滤维度
- Day 1 仅做"切换 DB path 文件"：保存到 `~/.cairn/desktop-shell.json`；切换后重开 SQLite 连接 + 旧连接 close（防 fd leak，R7）
- **不做** workspace auto-discovery / 多 project 列表 / 项目自动识别
- 真正 project model（schema 加 project 维度 + 跨 db 视图 + workspace discovery）→ §11 Hardening
- UI 上**不要**写"当前 project 内 ..."这种暗示数据过滤的文案；改为"current workspace: D:\lll\cairn"或"DB: ~/.cairn/cairn.db"

### Decision 4 — Run Log 是默认主视图

- panel 启动后默认 tab = **Run Log**，不是 Tasks 不是 Summary
- Tasks / Summary card 是辅助：Summary 常驻 panel 顶部 header 下方；Tasks 是次要 tab
- 这条 ties to PRODUCT.md v3 §8.4 "Live Run Log 是 v3 主视图"
- **不**把 Run Log 藏到二级菜单 / 折叠 / 默认隐藏

### Decision 5 — dogfood 用 real + fixture 混合

- Day 3 dogfood **不**坚持纯真实
- 主流程：跑真实 MCP / SQLite 数据（用户当前 D:\lll\cairn 已有的 W5 dogfood 痕迹）
- 缺口（无活跃 BLOCKED / FAIL outcome / OPEN conflict / handoff 等状态）用 `cairn-demo-*` 前缀的 fixture rows 补：
  - 所有 fixture id / agent_id / task_id 都以 `cairn-demo-` 开头
  - dogfood 结束自动 cleanup（DELETE WHERE id LIKE 'cairn-demo-%' OR agent_id LIKE 'cairn-demo-%' …）
- dogfood 报告里 **明确区分 real vs fixture**：每条观察标注数据来源
- fixture script `mvp-quick-slice-dogfood.mjs` 同时含 setup / cleanup 两个模式

---

## 7. UI structure (Quick Slice)

### 7.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [Tray icon, system tray] (Day 3)                            │
│   tooltip: "1A · 1B · 1F" or text                           │
│   click → toggle side panel                                 │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────┐  ┌─ Floating marker (existing) ─┐
│  Side panel (~480×600)   │  │  pet @ bottom-right          │
│  ┌────────────────────┐  │  │  click → open side panel     │
│  │ Header             │  │  │  schema → sprite (§8.5)      │
│  │ workspace: D:\lll..│  │  └──────────────────────────────┘
│  │ DB: ~/.cairn/...db │  │
│  │ [⋯ menu]           │  │
│  ├────────────────────┤  │
│  │ Project summary    │  │
│  │ 2 agents · 3 tasks │  │
│  │ 1 blocker · 1 FAIL │  │
│  │ 1 conflict · 5 dis │  │
│  ├────────────────────┤  │
│  │ Tabs:              │  │
│  │ [Run Log*][Tasks]  │  │  * = default
│  ├────────────────────┤  │
│  │ Active view body   │  │
│  │ (scrollable, click │  │
│  │  row → inline      │  │
│  │  expand detail)    │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

### 7.2 Side panel views（Quick Slice = 2 个 tab）

| Tab | 内容 | 点 row → |
|---|---|---|
| **Run Log** (default) | 5 源事件聚合，按时间倒序，每行 = `time / source pill / type / agent_id / target / detail` | Day 2 阶段：仅高亮关联 row（不跳 tab）；Day 3+ 可加跳 Tasks |
| **Tasks** | `tasks` 列表（不是树渲染 —— Quick Slice 简化）：state pill + `task_id` + intent 摘要 + parent_task_id（如有）+ created_by_agent_id + updated_at(rel) | inline expansion：展开 6-12 行附加（task 行下方）显示 blockers + outcomes summary（filter by task_id） |

**Project summary card** 常驻 panel 顶部，不是 tab；每 1s 与各 tab 数据同步刷新。

**Quick Slice 不实现的 tab**（→ Hardening）：Sessions / Blockers + Outcomes 独立 tab / Checkpoints / Scratchpad。它们的数据在 Quick Slice 中通过 Summary card（计数）+ Run Log（事件流）+ Task inline detail（per-task 关联）已可见。

### 7.3 Tray icon (Day 3)

Windows 系统托盘 / macOS Menu Bar 常驻：

- **idle**：灰色图标，无 badge
- **alert**：颜色编码（黄=有 OPEN blocker / 红=有 FAIL outcome 或 OPEN conflict）+ tooltip 文本（如 "1 agent · 1 blocker · 1 FAIL"）
- 颜色 + 数字编码规则参考 PRODUCT.md v3 §8.5 floating marker 优先级（review > waiting > running > idle），但 tray 不做动画
- click tray → toggle side panel 显隐
- 右键菜单：
  - Open Cairn
  - Open Legacy Inspector（debug only —— 即使 dev flag 关也可见，方便回退）
  - Quit

Day 3 的 icon 资源（**已根据 R13 收口**）：

- **不**用 `spritesheet.webp` runtime 抠图——Electron Tray 在 Windows 上需要 `.ico`（多分辨率），webp 会静默渲染空 tray
- **不**用 runtime canvas 画图——增加复杂度、调试困难
- 改为**两种方案二选一**：
  - **方案 A（推荐）**：checked-in 静态资源 `packages/desktop-shell/icons/tray-{idle,warn,alert}.ico`（16/32/48 多分辨率）+ macOS 兼容用 `.png` 备份。三档预生成
  - **方案 B（次选）**：base64 DataURL 内嵌 `nativeImage.createFromDataURL(...)`——免文件管理但调试不便
- **不碰** `spritesheet.webp` / `spritesheet.v0.webp`（这两个文件是 working tree dirty 状态，本 plan 范围外）
- 完整 icon 设计 / 动画 → Hardening

### 7.4 Run Log low-fidelity 事件投影（Day 2）

5 张表 → 统一 event schema（前端渲染层面，不改 schema）：

```
event = {
  ts: number,           // unix ms
  severity: string,     // 'info' | 'warn' | 'error'
  source: string,       // 'tasks' | 'blockers' | 'outcomes' | 'conflicts' | 'dispatch'
  type: string,         // e.g. 'task.created' / 'blocker.opened' / 'outcome.failed'
  agent_id: string|null,
  task_id: string|null,
  target: string|null,  // path / blocker_id / dispatch_id
  message: string,      // human-readable one-liner
}
```

每张表 → SELECT 投到 event：

| 表 | 取哪些时间锚点 | type → severity 推导 |
|---|---|---|
| `tasks` | `created_at` (= 'task.created'), `updated_at`（粗略当作 state change） | task.created/state 变更 → info；task.FAILED → error |
| `blockers` | **`raised_at`** ('blocker.opened') / `answered_at` ('blocker.answered') | opened → warn；answered → info |
| `outcomes` | `created_at` ('outcome.submitted')、`evaluated_at` ('outcome.{status}') | PASS → info；FAIL/TERMINAL_FAIL → error |
| `conflicts` | `detected_at` / `resolved_at` | detected → warn；resolved → info |
| `dispatch_requests` | `created_at` (status pill) | status=PENDING → warn；FAILED → error；其他 → info |

UNION ALL（客户端拼也行：每张表分别 query 然后 JS sort/merge）→ 按 ts DESC → 取前 200 行。**每 1s polling**（与现有 Inspector 一致）。

**Quick Slice 不做**：实时推送、replay、grouping、按 agent/task filter（最简的"按 source 过滤" toggle 也放 Hardening；Day 2 只做单一时间倒序滚动列表）。

**进 Hardening 的 Run Log 升级**：

- 加 processes（heartbeat 折叠）/ scratchpad（subagent/* + echo/*）/ checkpoints 三类源 → 8 表全量
- 真正的 event sourcing（events 表 + trigger）
- 实时推送（SQLite update_hook 跨进程方案 / file mtime 监听）
- 高级 filter / grouping / search

---

## 8. Day-by-day implementation plan (Quick Product Slice — 3 days)

3 个工作日，每天 1 commit。

### Day 1 — Side Panel Shell + Project Summary

**目标**：把现有 desktop-shell 从 pet + 简陋 Inspector，推进到 project-scoped side panel shell。

**任务**：

1. **schema check**：
   - `PRAGMA table_info(...)` 对照 migrations 004/007/009/010 列差异，写到 `packages/desktop-shell/SCHEMA_NOTES.md`
   - **必须验证**：`tasks` 列名（`task_id` / `parent_task_id` / `state` / `intent` / `created_at` / `updated_at` / `created_by_agent_id`，**没有 `id` / `current_attempt`**）+ `blockers.raised_at`（不是 `created_at`）—— 这两条来自 review patch，是已知点，schema check 验证它们仍正确
   - 缺表 / 缺列时确认 graceful empty 处理点
2. **抽 `queries.cjs`**（避免 `main.cjs` 在 Day 2 后爆炸）：
   - 把 `main.cjs` 现有 `queryState` / `queryActiveAgents` / `queryOpenConflicts` / `queryRecentDispatches` / `queryActiveLanes` 等函数迁到 `packages/desktop-shell/queries.cjs`
   - `main.cjs` 只保留 Electron / IPC / window / tray / lifecycle 逻辑
   - `queries.cjs` 接受一个 `db` 参数（read-only handle），返回 plain JS 对象，**不**触碰 IPC / Electron API
   - 在 `queries.cjs` 顶部加 5 个 JSDoc `@typedef`：`Task` / `Blocker` / `Outcome` / `Conflict` / `DispatchRequest`（依据 SCHEMA_NOTES.md 实际列名），让 `panel.js` 拿到 IDE 自动补全，**不引 TypeScript / Vite / 任何 build pipeline**
3. **legacy Inspector 隔离**：
   - 复制 `inspector.html` → `inspector-legacy.html`、`inspector.js` → `inspector-legacy.js`
   - `main.cjs` 加启动参数 `--legacy` 走旧 Inspector window；不加参数走新 panel
   - **legacy JS 自身**：检查 `window.cairn.resolveConflict` 是否存在；不存在则 `Resolve` 按钮 hide（renderConflicts 内 conditional render）。这样 dev flag 关时 legacy 也是纯 read-only
4. **panel shell**：
   - 新建 `panel.html` + `panel.js`（深色 monospace，**复用 `inspector.js` 现有 render 函数 + polling 模式**——见 R17，不从空白起手）
   - 顶部 header：workspace label + DB path 显示（**不用"current project"措辞**，避免暗示 project 维度过滤——见 Decision 3）+ `[⋯]` 菜单按钮（菜单含 "Switch DB / workspace" + "Open Legacy Inspector"）
   - Project summary card：6 行计数 —— active agents / running+blocked+waiting_review tasks / open blockers / failed outcomes / open conflicts / recent dispatches (last 1h count)
   - Tabs 占位（Run Log / Tasks）—— Day 1 仅占位空内容
   - polling 1s 刷新 summary
5. **DB path 切换（不是 project 自动发现）**：
   - 启动读 `~/.cairn/desktop-shell.json` 拿默认 path（不存在则用 `~/.cairn/cairn.db`）
   - menu "Switch DB / workspace" 弹文件选择（指向 `.db` 文件）→ 更新 path → 重开 SQLite + 旧连接 close
   - workspace label = path 的 dirname / basename，是给用户的视觉锚而已（Decision 3）
6. **mutation 隔离**（Decision 1）：
   - 启动检查 `CAIRN_DESKTOP_ENABLE_MUTATIONS` env
   - 默认（无 env）：`resolveConflict` IPC handler 不注册；preload 也不暴露 `window.cairn.resolveConflict`
   - dev 模式：注册 + console 警示；legacy Inspector 因 `window.cairn.resolveConflict` 存在自动渲染 Resolve 按钮
   - panel.html 永远不渲染 mutation 按钮（即使 dev flag 开）
7. **新 IPC channels**（read-only）：
   - `getProjectSummary` / `getTasksList` / `getTaskDetail(taskId)` / `getRunLogEvents` / `setDbPath(path)`
   - Day 1 仅 `getProjectSummary` 实质实现，其他先返回 `[]` 或 `null`

**Commit**：`feat(desktop-shell): Quick Slice Day 1 — side panel shell + project summary`

**Day 1 DoD**：

- ✅ `npm start` 能打开 side panel shell（`panel.html`），显示 workspace label + DB path + summary card
- ✅ legacy Inspector 可通过 `npm start -- --legacy` 或菜单回退；dev flag 关时 legacy 不显示 Resolve 按钮
- ✅ 默认 UI 没有 mutation action（不显示 Resolve 按钮 / 不显示任何写按钮）
- ✅ schema check 文档落地，`tasks` / `blockers` 关键列名验证一致
- ✅ `queries.cjs` 抽好 + 5 JSDoc typedef
- ✅ Switch DB 切换后数据更新，无 fd leak（手动观察）
- ✅ 不碰 daemon / mcp-server 源码
- ✅ 不新增 npm dependency
- ✅ 不碰 `spritesheet.webp` / `spritesheet.v0.webp`

---

### Day 2 — Run Log Low-Fidelity + Tasks View

**目标**：Run Log 作为默认主视图，5 类事件源；Tasks 简单列表 + inline expansion detail。

**任务**：

1. **Run Log tab**（设为 default）：
   - 实现 `getRunLogEvents()` 在 `queries.cjs` —— 5 源各自 query → JS 合并 → ts DESC → LIMIT 200
   - **每个 source query 跑一次 `EXPLAIN QUERY PLAN`**（开发期），确认时间锚点列（`tasks.updated_at` / `blockers.raised_at` + `answered_at` / `outcomes.created_at` + `evaluated_at` / `conflicts.detected_at` + `resolved_at` / `dispatch_requests.created_at`）有索引或表小到不需要——见 R16；如发现 full scan 且行数过万，加注释 + 进 Hardening 优化
   - 渲染：等宽字体表格，列 `time(rel) / source pill / type / agent_id / target / message`
   - severity 配色：error=红 / warn=黄 / info=灰
   - polling 1s
2. **Tasks tab**：
   - 列表（不做树）：state pill + `task_id` + intent 摘要 + parent_task_id（如有）+ created_by_agent_id + updated_at(rel)
   - **使用真实列名**：`task_id`（不是 `id`）；**不使用** `current_attempt`（schema 没有此列）
   - 排序：state 优先级（FAILED > BLOCKED > WAITING_REVIEW > RUNNING > READY_TO_RESUME > PENDING > DONE > CANCELLED）+ then updated_at DESC
   - 每行点击 → **inline expansion**（Decision 2）：行下方展开 6-12 行
3. **Task inline detail**：
   - 显示：task 完整状态 + blockers (filter by `task_id`, OPEN/ANSWERED/SUPERSEDED 各计数 + 最新 question/answer 摘要，按 `raised_at` DESC) + outcomes (single row by task_id, criteria 计数 + status + FAIL detail 摘要)
   - 不显示 scratchpad / checkpoints（Hardening）
   - 再点行 → 收起
4. **panel layout 微调**：summary card 与 tab 衔接平滑；tab 切换不闪烁；inline expansion 不阻塞 polling

**Commit**：`feat(desktop-shell): Quick Slice Day 2 — run log low-fidelity + tasks view`

**Day 2 DoD**：

- ✅ Run Log 是默认主视图（panel 打开默认显示）
- ✅ 5 类事件源（tasks / blockers / outcomes / conflicts / dispatch_requests）能渲染
- ✅ Tasks view 可切换查看
- ✅ 点击 task 可看到最小 inline detail
- ✅ polling 不明显卡顿（手动观察 ≥ 5 分钟 panel 仍流畅）
- ✅ read-only 路径保持（grep `\.run\|\.exec` 仅 1 处 dev-only）
- ✅ 不新增 schema / MCP tool

---

### Day 3 — Tray / Status Icon + Desktop Dogfood

**目标**：让 Cairn 像一个本机产品，而不是只靠 `npm start` 打开窗口。

**任务**：

1. **tray icon**（Electron `Tray` API）：
   - **icon 资源**（R13）：checked-in 三档静态资源 `packages/desktop-shell/icons/tray-{idle,warn,alert}.ico`（Windows 多分辨率 16/32/48）+ 同名 `.png` 备份（macOS）；或 base64 DataURL 内嵌。**不用 webp、不 runtime canvas、不抠 spritesheet**
   - 状态机（idle / warn / alert）由 summary 数据驱动：
     - alert（红）：OPEN conflicts > 0 OR FAIL outcomes > 0
     - warn（黄）：OPEN blockers > 0 OR WAITING_REVIEW tasks > 0
     - idle（灰）：以上都为 0
   - tooltip：动态文本 "Cairn — N agents · N blockers · N FAIL · N conflicts" 或 "idle"
   - click tray → toggle side panel 显隐
   - 右键菜单：`Open Cairn` / `Open Legacy Inspector` / `Quit`
2. **Tray lifecycle 修复**（R14）：
   - 当前 `main.cjs` 有 `app.on('window-all-closed', () => app.quit())` —— 与 tray 模式冲突（关 panel 就退应用，tray 失效）
   - 改为：
     - panel close → 仅 `hide()`，不退应用；tray 仍在
     - pet window close → 同上
     - 仅菜单 "Quit" 调 `app.quit()` —— 显式退出
     - macOS 兼容：保留 dock 菜单 hidden behavior
   - 测试：关 panel 后 tray icon 仍在 + click tray 重新显示 panel
3. **Desktop dogfood prep**（Decision 5）：
   - 写 `packages/desktop-shell/scripts/mvp-quick-slice-dogfood.mjs`
   - `--setup`：插入 cairn-demo-* fixture rows（3 个 demo task：1 BLOCKED w/ open blocker / 1 WAITING_REVIEW w/ FAIL outcome / 1 RUNNING；2 demo agents；1 demo OPEN conflict；1 demo dispatch PENDING）
   - **fixture INSERT 必须用真实列名**：`tasks(task_id, parent_task_id, state, intent, created_at, updated_at, created_by_agent_id)`、`blockers(... raised_at ...)`，详 SCHEMA_NOTES.md
   - `--cleanup`：DELETE 所有 cairn-demo-* 前缀的 row（一次性）
   - `--status`：列出当前 cairn-demo-* row 计数
4. **Desktop dogfood 执行**（人工跑 1 次）：
   - 关：跑 `--setup` 注入 fixture
   - 启动：`cd packages/desktop-shell && npm start`
   - 验证（`packages/desktop-shell/SMOKE.md` checklist）：
     - summary card 计数与真实+fixture 一致
     - Run Log 显示 5 源事件，含 fixture 来源
     - Tasks tab 显示 fixture 任务
     - 点击 BLOCKED demo task → inline detail 显示 blocker question
     - 点击 FAIL demo task → inline detail 显示 outcome FAIL detail
     - tray icon 颜色 = 红（因为有 FAIL + conflict）
     - tray tooltip 文本反映状态
     - 默认 UI 无任何 mutation 按钮（grep DOM）
     - 关 panel 后 tray icon 仍在 + click tray 重新显示 panel（R14 验证）
     - 切回 legacy Inspector 可见；dev flag 关时 legacy 也无 Resolve 按钮
   - 结束：跑 `--cleanup`；验证 db 中 cairn-demo-* row = 0
5. **Dogfood 报告** 写到 `docs/superpowers/demos/MVP-quick-slice-desktop-dogfood.md`：
   - 哪些观察来自 real / 哪些来自 fixture（每条标注）
   - 5 个 US-P 场景（PRODUCT.md v3 §4.1-§4.5）哪些覆盖 / 哪些差距
   - tray + panel + Run Log + Tasks 四类组件实际可用性
   - 发现的 bug / Hardening 优先级建议
6. **README.md 更新**：panel 启动 / tray 行为 / dev mutation flag 文档 / dogfood 脚本用法 + 注明 `postinstall --target 32.3.3` 硬编码升级时需改（R15）

**Commit**：`feat(desktop-shell): Quick Slice Day 3 — tray icon + dogfood`

**Day 3 DoD**：

- ✅ tray icon 出现在 Windows 系统托盘（用 `.ico`，不是 webp）
- ✅ click tray 可 toggle side panel 显隐
- ✅ **关 panel 后 tray 仍在 + click tray 能重新显示 panel**（R14 验证；`window-all-closed` 不再 quit）
- ✅ 状态 tooltip / 颜色能反映 blocked / failed / conflict
- ✅ 右键菜单可用（Open Cairn / Open Legacy Inspector / Quit）
- ✅ dogfood 脚本可跑 setup + cleanup（fixture 用真实列名，不再写 `id` / `current_attempt` / `blockers.created_at`）
- ✅ demo rows 自动清理（cleanup 后 grep cairn-demo-* 计数 = 0）
- ✅ Dogfood 文档区分 real vs fixture
- ✅ README 更新（含 R15 硬编码 target 提示）
- ✅ 无 daemon / mcp-server 源码改动
- ✅ 不 push（除非用户授权）

---

## 9. Dogfood scenario (Day 3)

**主场景**（用户视角，real + fixture 混合）：

> 周一早上，开 D:\lll\cairn 项目。已有真实 W5 dogfood 历史数据（tasks / outcomes 等）。跑 `--setup` 注入 cairn-demo-* fixture rows，模拟一个活跃 multi-agent project：
>
> 1. 启动 `npm start` —— 直接看 tray icon 出现（红色，因为 demo FAIL + conflict）
> 2. tray tooltip：`Cairn — 2 agents · 1 blocker · 1 FAIL · 1 conflict`
> 3. click tray → side panel 展开，**默认 Run Log tab**
> 4. **Project summary card** 显示 6 行计数（含 fixture 影响）
> 5. **Run Log** 看到事件流：cairn-demo-T1 BLOCKED / cairn-demo-O2 FAIL / cairn-demo-C3 detected / dispatch PENDING ……
> 6. 切到 **Tasks tab**，看到 cairn-demo-T1 BLOCKED 行 → 点击 → inline 展开 → 看到 fixture blocker question
> 7. 切到 cairn-demo-T2 WAITING_REVIEW → 点击 → inline 展开 → 看到 outcome FAIL detail
> 8. **不**从 panel 点任何 mutation 按钮（确认 UI 没暴露）
> 9. 用户实际走 agent / CLI 答 blocker / 重跑 outcome（real 路径）—— 几秒后 panel 自动刷新（real 数据），fixture 行不变
> 10. 退出前跑 `--cleanup` 清 fixture，再启 panel 验证回到 real-only 状态

**子场景**（Quick Slice 各自能覆盖到的程度）：

- **Project Glance**（US-P1）：✅ summary card + Run Log + tray
- **Project History**（US-P2）：⚠️ 部分 —— Run Log 显示事件时间线；完整 task drill-down timeline 进 Hardening
- **Recovery**（US-P3）：⚠️ 部分 —— Tasks inline detail **不**显示 checkpoints（Hardening），用户得跳到 git log 找回退点
- **Subagent Result**（US-P4）：❌ 不覆盖 —— scratchpad view 进 Hardening
- **Conflict**（US-P5）：✅ tray badge + Run Log + summary card

Dogfood 报告里明示哪些场景覆盖了 / 哪些差距，作为 Hardening 优先级输入。

---

## 10. Risks (Quick Slice)

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R1** | 现有 `resolve-conflict` IPC + 按钮违反 D9 read-only | panel 上线时 D9 已破 | **Decision 1**：dev flag 隔离；默认 UI 无任何 mutation 按钮；legacy Inspector 仅在 dev mode 显示按钮 |
| **R2** | desktop-shell 现有 SQL 引用 `lanes` 等 legacy 表，新 schema 列名不一致 | Day 1 起就错 | Day 1 第一件事跑 schema check + 写 SCHEMA_NOTES.md；缺表 graceful empty + UI 显示 "(no data — schema missing)" |
| **R3** | 原 7-day plan Day 5 同时上 tray + Run Log 容易 overload | 一天做不完 | **已通过 3-day Quick Slice 解决**：Run Log 在 Day 2、tray 在 Day 3 分天做 |
| **R4** | Run Log overreach（8 表 UNION ALL / true event sourcing / 实时推送） | 范围爆炸 | Quick Slice 仅 5 类事件源（tasks / blockers / outcomes / conflicts / dispatch_requests），processes / scratchpad / checkpoints 进 Hardening；不做 events 表；不做 update_hook |
| **R5** | dogfood 不稳定（真实环境缺 BLOCKED / FAIL / conflict 状态） | 验证不到关键 view | **Decision 5**：real + cairn-demo-* fixture 混合；setup / cleanup 脚本；报告区分 real vs fixture |
| **R6** | UX overdesign（追求 polished dashboard） | 时间花在视觉不在功能 | 不做 polished 设计；信息密度优先；继续用现有 monospace dark theme；tray icon 临时纯色 dot 即可 |
| **R7** | 多 project 切换时 SQLite 连接 leak | 长跑后 fd 用尽 | `setProject` IPC 内 `db.close()` 旧连接再开新（Day 1 显式做） |
| **R8** | Quick Slice 不覆盖 US-P4（subagent result）—— dogfood 验收过低 | 关键场景缺位被忽略 | dogfood 报告**明示**哪些场景未覆盖 + 进 Hardening 优先级；不假装 Quick Slice = 完整 MVP |
| **R9** | Run Log 5 源 query × 1s polling 性能问题 | panel 卡 | Day 2 加 `console.time` 测 query latency（应 < 50ms total）；如慢，单 query / 改 5s polling 兜底 |
| **R10** | Inline expansion 信息过多导致单行展开后 panel 难读 | UX 反例 | 设硬上限：每个 expansion ≤ 12 行；blocker / outcome 各最多显示最近 1 条 |
| **R11** | tray icon 跨平台行为差异 | macOS/Linux 表现不一 | Quick Slice 主目标 **Windows 11**（用户主机）；macOS 简化 smoke（启动 + tray 出现即可）；Linux 不验 |
| **R12** | better-sqlite3 Electron rebuild 失败 | 用户跑不起 | README 写清 `npx electron-rebuild` 步骤（已有）；Day 1 先验证用户环境跑得起再开工 |
| **R13** | Tray icon 格式不兼容（webp 在 Windows tray 静默渲染空） | Day 3 tray 看不见 | Day 3 用 checked-in `.ico`（多分辨率 16/32/48）+ macOS `.png` 备份；**不**用 webp / runtime canvas / spritesheet 抠图 |
| **R14** | `app.on('window-all-closed', () => app.quit())` 与 tray 模式冲突 | 关 panel 就退应用，tray 失效 | Day 3 改 lifecycle：panel close 仅 hide；仅菜单 Quit 退出；DoD 含验证步骤 |
| **R15** | `package.json postinstall` 硬编码 `--target 32.3.3`，Electron 升级时 silent break | 升级后 NODE_MODULE_VERSION mismatch / tray dev session 启动失败 | Day 3 README 加注释提示；Day 1 跑通环境前先确认当前 32.x 版本与 target 一致；不在 Quick Slice 改 postinstall（属于 Hardening 的 build pipeline 工作） |
| **R16** | Run Log 5 源 UNION ALL ORDER BY 时间锚点列若无索引，dogfood 真实数据下慢 | Run Log 卡顿 | Day 2 每个 source query 跑 `EXPLAIN QUERY PLAN`；如发现 full scan 且行数过万，加注释 + 进 Hardening 优化；MVP 先跑得通再优化 |
| **R17** | 从空白起手写 panel renderer 重复劳动 + 偏离现有模式 | 浪费时间 + 风格漂移 | Day 1 panel.js **复用 `inspector.js` 现有 render 函数 + polling 模式**（lines 14-62 是 `renderAgents` / `renderConflicts` 等的范式）；扩展，不重写 |

---

## 11. Later Hardening（从原 7-day plan 迁移过来）

Quick Slice 不做的内容，作为 *eventually* 范畴。Quick Slice dogfood 完成后再排优先级，**不绑时间表**。

**Side panel 功能完善**：

- 完整 project selector / workspace auto-discovery（自动扫描机器上所有 cairn db）
- agent sessions 完整视图（`processes` 全字段 + 排序 + sessions tab）
- blockers + outcomes 精细独立视图（按 task 分组的 sections / OPEN+ANSWERED+SUPERSEDED 分组）
- checkpoints 视图 + paths preview 集成
- scratchpad / subagent result 视图（namespace 分组浏览）
- resume_packet 风格聚合 preview（task drill-down 完整版）
- 完整 detail drawer 设计（独立 drawer 区域 / 多级 drill-down）
- 从 Run Log 跨 tab 跳转 + 高亮关联 row（Quick Slice 仅高亮不跳）

**Run Log 升级**：

- 加 processes（heartbeat 5min 折叠）/ scratchpad（subagent/* + echo/* prefix）/ checkpoints 三类源 → 8 表全量
- True event sourcing：events 表 + insert trigger（需新 migration）
- 实时推送：SQLite update_hook 跨进程方案 / file mtime watch / WebSocket
- 高级 filter（按 agent / task / source 多选） / grouping / search
- replay（回放历史事件）

**架构 / infra**：

- GUI 自动化测试框架（Playwright Electron / Spectron 评估）
- multi-day dogfood + 量化覆盖率
- macOS / Linux 完整支持
- Electron 打包成 installer（electron-builder）
- 性能优化（如 polling → push）

**Mutation 路径解锁**（D9 升级前置条件全亮才考虑）：

- desktop write actions：answer blocker from desktop / rewind from desktop / dispatch from desktop / resolve conflict from desktop
- supervisor identity 模型设计 + audit trail 区分 panel 写 vs agent 写
- daemon 独立进程化 + 稳定 IPC API（当前 mcp-server 直接 import `daemon/dist/`）

**跨 host / 跨机**：

- 小团队 sync / 跨机协作
- multi-user shared daemon

**floating marker drift 修复**：

- 现有 sprite 规则查 `lanes` 表（legacy schema），需迁到 8 host-level state objects（PRODUCT.md §8.5 known issue）

---

## 12. Test / verification plan (Quick Slice)

**没有大规模自动化 UI 测试**（GUI 测试框架是 Hardening）。代之以：

1. **手动 smoke checklist**（`packages/desktop-shell/SMOKE.md`，Day 3 落地）：
   - panel 启动不崩；summary 渲染 ≤ 1.5s
   - 2 个 tab（Run Log / Tasks）切换都渲染
   - summary card 数字与 SQLite 实查一致（spot check 2-3 行用 `sqlite3 ...` 命令对比）
   - Run Log 5 源事件齐全
   - Tasks inline expansion 开关不阻塞 polling
   - tray badge / 颜色 / tooltip 实时变化
   - Switch project 切换后数据更新
   - dev mutation flag 默认关时 UI 无任何 mutation 按钮
   - legacy Inspector 仍可通过 menu / 启动参数访问

2. **schema 一致性测试**：Day 1 SCHEMA_NOTES.md 列的差异在每 view 实施完后 re-verify

3. **read-only 边界测试**：
   - `grep -n "\.run\|\.exec" packages/desktop-shell/*.cjs *.js` 确认 ≤ 1 处（dev-only resolve-conflict）
   - 跑 panel 1 小时（dev flag 关）后 cairn.db 的 mtime / size 增长应近 0

4. **query 性能**：summary / Run Log 各 query 单跑 timing（应 < 50ms）

5. **dogfood 验收**（Day 3 / DoD）：完成 §9 主场景 + 5 个子场景标注 + 报告

---

## 13. Final DoD for Quick Slice

下面 13 条全部 ✓ 才算 Quick Slice 通过：

1. ✅ PRODUCT.md v3 已作为定位依据（commit `3562f1f`）
2. ✅ plan 已 patch 成 3-day Quick Product Slice + 已收口 8 项 schema/lifecycle review patch
3. ✅ desktop-shell 能作为 project-scoped side panel 启动（`npm start`）
4. ✅ Run Log 默认主视图可用，5 类事件源齐全（含 `blockers.raised_at` / `tasks.task_id` 真实列）
5. ✅ project summary card 可用，6 行计数与 SQLite 实查一致；UI 文案为 workspace label + DB path（不暗示 project 维度过滤）
6. ✅ tasks 可见（列表 + inline expansion detail）
7. ✅ blockers / outcomes / conflicts 至少在 summary 或 Run Log 中可见
8. ✅ tray / status icon 可用（`.ico` 多分辨率；idle / warn / alert 三档；click toggle panel；右键菜单）
9. ✅ Tray lifecycle 正确（关 panel 不 quit；仅 Quit 菜单退出）
10. ✅ 默认 read-only（无 `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` 时 panel + legacy 都无 mutation 按钮）
11. ✅ `queries.cjs` 抽取 + 5 JSDoc typedef
12. ✅ dogfood 证明从桌面入口能看到一个长程 agent project 的状态现场（real + fixture 混合，报告区分）
13. ✅ 无新 kernel primitive / 无新 MCP tool / 无新 schema migration / 无新 npm dependency / 不碰 spritesheet / 无 push（除非授权）

---

## 14. Out-of-scope reminder（防止滑坡）

如果实施过程中有人提以下需求，**直接 veto** 并指向 PRODUCT.md v3 §1.3 / §6.3 / §12 D9 + 本 plan §3 / §11：

- "panel 加输入框让用户答 blocker / 派 agent / 评估 outcome" → §12 D9 升级前置条件未满足
- "panel 加 sprint / 看板 / story point" → §1.3 #5
- "panel 嵌代码编辑器 / diff viewer" → §1.3 #2
- "panel 自动给下一步建议" → §6.3 Later
- "Run Log 加实时推送 + 高级筛选 + replay" → §11 Hardening
- "Run Log 加 processes / scratchpad / checkpoints" → §11 Hardening（Quick Slice 仅 5 源）
- "做完整 detail drawer 独立窗口" → Decision 2 折入 panel；完整 drawer 进 §11 Hardening
- "做 workspace 自动扫描" → Decision 3 仅手动 path；自动扫描进 §11
- "macOS + Linux + Windows 三平台同步交付" → R11 Quick Slice Windows 优先；其他进 §11
- "新加 MCP 工具 / 加 schema migration / 加 kernel primitive" → 任务边界明示禁止
- "把 floating marker sprite 规则修对" → R11 / §11，单独 patch

---

## 15. 上游依赖确认

本 plan 依赖的 PRODUCT.md v3 章节（commit `3562f1f`）：

- §1.1 / §1.2 / §1.3：定位 + 反定义
- §4 US-P1..P5：用户故事
- §5.0 / §5.5：能力 → panel view 映射
- §6.1.1：8 类 host-level state objects
- §6.2 MVP MUST 9 项（Quick Slice 覆盖 6 项 / 部分覆盖 1 项 / 未覆盖 2 项）
- §6.3 Later
- §7 原则 2（可见性先于可解决性）+ 原则 9（不版本化）
- §8 全节：UX 形态
- §9.1 / §9.6 / §9.7：架构边界（read-only SQLite path）
- §11.4 风险
- §12 D8 / D9 / D10
- §13.2 v3 reframe 的关键不变

如 PRODUCT.md v3 后续 patch 改动以上章节，本 plan 同步更新。

---

> 本 plan 完成后停下，等 user review。不动源码。确认后再开 Day 1。
