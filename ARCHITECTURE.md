# Cairn — 实现架构文档（ARCHITECTURE.md）

> 版本：v0.1（W5 Phase 3 闭环已交付，Phase 4 release polish 阶段）
> 最近更新：2026-05-28
> 状态：四能力 + Task Capsule + Outcomes DSL 全部实施完毕；本文为 v0.1 的实现层权威文档

---

## 0. 文档定位

### 0.1 本文是什么

本文是 Cairn v0.1 的**实现层指南**，回答"怎么造"，而非"造什么"或"为什么造"。

- **PRODUCT.md v2**：产品定义，回答"做什么、为什么这样定位、四能力是什么"——本文不重复产品理由，只在必要时引用节号。
- **DESIGN_STORAGE.md**：持久层详细设计，DDL / 状态机 / 事务边界等细节——本文引用，不复制。
- **ARCHITECTURE.md（本文）**：实现层决策，回答"为什么这么设计、各组件怎么组合、不确定的地方在哪"。

### 0.2 阅读顺序建议

首次接触项目：PRODUCT.md §0（TL;DR）→ PRODUCT.md §9（技术架构概念层）→ 本文 §1（全景图）→ 各能力对应节。
实施特定能力：本文 §6.x → 引用的 PRODUCT.md 节号 → DESIGN_STORAGE.md 对应章节。

### 0.3 锚点说明

🚧 PoC-X 表示该设计决策依赖 PoC 验证结果，落地前需回填。
🚧 D-X 表示依赖调研或 dogfood 数据，不是 PoC，是测量 / 观察任务。
两类锚点均在 `pre-impl-validation.md` 中有对应条目。

完整锚点清单见本文末尾的「附：🚧 锚点索引」，包含每个锚点出现的节次和回填触发条件，方便 `pre-impl-validation.md` 那边 cross-ref。

### 0.4 本文范围

- 覆盖 v0.1（W1-W12），重点是 W3-W7 四能力实施阶段
- 不覆盖 UI 层（UX 形态在 PRODUCT.md §8 描述）
- 不覆盖商业化 / 多用户 / 企业合规（均推迟到 v0.2+）
- 不覆盖部署自动化 / CI/CD pipeline（v0.1 手动构建 + 安装）

---

## 1. 系统全景图

Cairn 是 daemon-centric 的协作内核，**位于** Claude Code / Cursor / Aider / Cline / Claude Code Task subagents 这些 agent 工具**之下**——所有 agent 通过 MCP 工具与 daemon 通信，daemon 是唯一写者，SQLite 是状态权威。Cairn 不向上代理 agent 推理，不调度 lead-subagent，不替 agent 执行任务；它只是这些 agent 共享的 host-level coordination kernel。

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                       用户机器（本地）                           │
  │                                                                  │
  │   ┌──────────────┐  MCP stdio  ┌──────────────────────────────┐ │
  │   │ Claude Code  ├────────────►│                              │ │
  │   │  + subagents │◄────────────┤      Cairn mcp-server        │ │
  │   └──────────────┘             │      (Node.js 子进程)        │ │
  │                                │                              │ │
  │   ┌──────────────┐  MCP stdio  │   28 个工具（W1+W4+W5）      │ │
  │   │ Cursor /     ├────────────►│   全部已落地                 │ │
  │   │ Aider / Cline│◄────────────┤                              │ │
  │   └──────────────┘             └──────────┬───────────────────┘ │
  │                                           │ 函数调用            │
  │   ┌──────────────┐                        ▼                     │
  │   │ 用户          │          ┌─────────────────────────────────┐│
  │   │ (CLI / 手动) │          │        Cairn daemon             ││
  │   └──────┬───────┘          │     packages/daemon/            ││
  │          │ MCP / CLI        │                                  ││
  │          │                  │  ┌──────────────────────────┐   ││
  │          └─────────────────►│  │  8 host-level state objs │   ││
  │                             │  │  processes / tasks /     │   ││
  │                             │  │  dispatch_requests /     │   ││
  │                             │  │  scratchpad / checkpoints│   ││
  │                             │  │  conflicts / blockers /  │   ││
  │                             │  │  outcomes                │   ││
  │                             │  └──────────┬───────────────┘   ││
  │                             │             │                    ││
  │                             │  ┌──────────▼───────────────┐   ││
  │                             │  │  SQLite（WAL 模式）       │   ││
  │                             │  │  ~/.cairn/cairn.db        │   ││
  │                             │  │  10 migrations (001-010) │   ││
  │                             │  └──────────────────────────┘   ││
  │                             │                                  ││
  │                             │  ┌──────────────────────────┐   ││
  │                             │  │  git-stash backend        │   ││
  │                             │  │  snapshots/{ckpt_id}/     │   ││
  │                             │  └──────────────────────────┘   ││
  │                             └─────────────────────────────────┘│
  └─────────────────────────────────────────────────────────────────┘
```

**MCP 工具流向**：
- agent 调用工具（如 `cairn.checkpoint.create`）→ mcp-server 解析参数并做基本校验 → 调用 daemon 仓储层函数 → 写入 SQLite / 触发 git 操作 → 返回结果给 agent。
- 每一次 MCP 工具调用都是同步的（从 agent 视角），daemon 内部写操作包裹在事务里。
- DSL 评估（`cairn.outcomes.evaluate`）也是同步阻塞调用（per W5 Phase 3 LD-17）：mcp-server 串行跑各 primitive、聚合 AND 后 record 结果，再返回。

### 1.1 8 类 host-level state objects（v0.1 完整集）

Cairn 不是一个 single-purpose daemon，它管理这 8 类持久状态对象，agent 通过 MCP 工具读写它们：

| State object | Migration | 用途 | 读写工具命名空间 |
|---|---|---|---|
| `processes` | 004 | runner 在线状态 + capabilities + heartbeat | `cairn.process.*` |
| `tasks` | 007 | durable multi-agent work items（state machine 12 transitions） | `cairn.task.*`（除 resume_packet/submit_for_review） |
| `dispatch_requests` | 005 + 008 | 可审计派发请求 | `cairn.dispatch.*` |
| `scratchpad` | 002 | 共享上下文 + subagent 原始结果 | `cairn.scratchpad.*` |
| `checkpoints` | 003 | 可回滚状态锚点（PENDING → READY 两阶段） | `cairn.checkpoint.*` / `cairn.rewind.*` |
| `conflicts` | 004 + 006 | MCP-call + commit-after 双层检测 | `cairn.conflict.*` |
| `blockers` | 009 | 任务内等待答复（OPEN / ANSWERED / SUPERSEDED） | `cairn.task.block` / `cairn.task.answer`（不直接暴露 list/get） |
| `outcomes` | 010 | 结果验收状态（UNIQUE(task_id)，PENDING / PASS / FAIL / TERMINAL_FAIL） | `cairn.task.submit_for_review` / `cairn.outcomes.evaluate` / `cairn.outcomes.terminal_fail`（不暴露 list/get，LD-8） |

**`resume_packet` 是 read-only aggregate view**（`cairn.task.resume_packet` 工具按需聚合：task 行 + open/answered blockers + scratchpad keys + outcomes_criteria + audit summary），不是独立持久状态——它从上述 8 类对象组装而成，每次调用都重新计算。

### 1.2 两条 state loops（W5 Phase 1+2+3 闭环）

**Loop 1 — BLOCKED ↔ READY_TO_RESUME 接力**（W5 Phase 2）：

```
RUNNING ──block(question)──► BLOCKED ──answer(blocker_id)──► READY_TO_RESUME
                                                                    │
                                                                    ▼
                                                               start_attempt
                                                                    │
                                                                    ▼
                                                                RUNNING
```

agent A 在 RUNNING 状态遇到只能由用户回答的问题，调 `cairn.task.block(question)` 写 blocker 行 + 转 BLOCKED；agent A 进程可干净退出。任意时间后用户/另一 agent 调 `cairn.task.answer(blocker_id)` → READY_TO_RESUME。新 agent 通过 `cairn.task.resume_packet(task_id)` 拿到完整上下文（含已答 blocker），调 `cairn.task.start_attempt` 接力执行。

**Loop 2 — RUNNING ↔ WAITING_REVIEW outcomes 验收**（W5 Phase 3）：

```
RUNNING ──submit_for_review(criteria)──► WAITING_REVIEW
   ▲                                         │
   │                                         │ outcomes.evaluate
   │                                         ▼
   │                              ┌──── PASS ──► DONE
   └──── FAIL ◄──────evaluate─────┤
                                  └──── terminal_fail(reason) ──► FAILED
```

agent 完成工作后调 `cairn.task.submit_for_review(task_id, criteria)` 提交确定性 DSL 验收 criteria（7 原语 AND 聚合，no LLM grader in v1）+ 转 WAITING_REVIEW。`cairn.outcomes.evaluate(outcome_id)` 同步跑 criteria 决定 PASS/FAIL：PASS → DONE；FAIL → 回 RUNNING（agent 修代码，再调 submit_for_review，criteria 冻结、outcome_id 不变）。`cairn.outcomes.terminal_fail(reason)` 是用户主动放弃路径 → FAILED。

完整状态图见 `docs/superpowers/diagrams/w5-task-state.md`（12 条 transitions 全部 active；`WAITING_REVIEW → CANCELLED` 故意不存在，per Phase 3 P1.2 lock）。

### 1.3 Cairn 不做的事（架构层面 veto 清单）

- **不调度 lead-subagent**：Cairn 不决定哪个 agent 跑哪个任务、不分发 sub-task；那是 agent host（如 Claude Code Task tool）的职责。Cairn 只在用户主动调 `cairn.dispatch.request(nl_intent)` 时按 5 条 fallback rules 推荐目标 agent + 生成 prompt，等用户 confirm 后转发。
- **不替 agent 写代码 / 改文件**：Cairn 工具不修改用户代码；连 `cairn install` CLI 写的 `.mcp.json` / pre-commit hook / start-cairn-pet 脚本都是限定的 boilerplate，不碰用户业务文件。
- **不自动拆解任务**：Task Capsule (`tasks` 表) 是 agent / 用户主动调 `cairn.task.create(intent)` 创建的，Cairn 不会把一个 intent 自动展开成多个 child tasks。`parent_task_id` 字段允许手动构建 task tree，但没有自动拆解器。
- **不替 agent 决策**：仲裁建议（conflict diagnosis）、dispatch agent 选型、outcomes verdict 都是 deterministic 数据 + 给用户/agent 看，最终由用户拍板（dispatch.confirm）或 deterministic DSL（outcomes.evaluate）决定，不是 LLM 替决。

---

## 2. 进程模型与部署形态

### 2.1 为什么这样设计

选择单机单实例、本地优先，因为这是 PRODUCT.md §7 第 3 条原则（本地优先）的直接落地——数据不离开用户机器，除非用户明确选择。daemon 作为长跑进程也是"Cairn 默认隐形"原则的实现：用户不需要每次调工具时都启动进程，daemon 常驻、安静运行。

### 2.2 进程角色

| 进程 | 角色 | 启动方式 | 生命周期 |
|---|---|---|---|
| **Cairn daemon** | 核心服务，唯一写者，管理 SQLite 和 git 操作 | 用户或 OS 启动（开机自启动，v0.1 手动） | 长跑，用户主动停止或机器关机 |
| **mcp-server**（`packages/mcp-server/`） | stdio MCP server，暴露工具给 agent host | 由 agent host（Claude Code）通过 `.mcp.json` 配置启动 | 随 agent host 会话生命周期 |
| **agent host**（Claude Code / Cursor 等） | MCP client，调用 Cairn 工具 | 用户启动 | 独立，Cairn 不管理 |

> 注：v0.1 的 mcp-server 直接 import daemon 的 `dist/` 函数运行，并非通过 IPC 连接独立 daemon 进程。两者实际上在同一个 Node 进程里。独立 daemon 进程（IPC 通信）是 v0.2 的架构演进方向，v0.1 阶段这种简化足够用，不引入不必要的进程间通信复杂度。

### 2.3 部署约束

- **本地优先，无云端依赖**（Dispatch 的 LLM 调用除外，见 §6.3 + ADR-2）
- **单机单实例**：同一台机器上不应启动多个 daemon 实例（v0.1 没有强制互斥，依赖用户约定）
- **数据目录**：`~/.cairn/`，见 DESIGN_STORAGE.md §2.2
- **SQLite 模式**：`PRAGMA journal_mode=WAL` + `busy_timeout=5000ms`，支持 mcp-server 和 CLI 的只读并发访问

### 2.4 启动 / 崩溃恢复

daemon 启动时执行（顺序固定）：
1. `runMigrations(db)` — 应用未落地的 migration（migration runner 是幂等的，跑两遍无副作用）
2. 扫描 `snapshot_status='PENDING' AND created_at < now()-5min` 的 checkpoint → 标为 `CORRUPTED`（DESIGN_STORAGE.md §8 的崩溃恢复逻辑）
3. 释放孤儿锁：`state='REVERTING' AND lock_expires_at < now()` 的 lane → 重置 lock_holder
4. （规划）GC 过期 scratchpad（`expires_at IS NOT NULL AND expires_at < now()`）——v0.1 的 GC 实现延后到 P3 补齐

崩溃重启后状态完整性：
- scratchpad / checkpoint 完整保留在 SQLite，重启不丢
- in-flight MCP 调用若 daemon 崩溃则该调用从 agent 视角超时，agent 需重试
- auto-checkpoint（`auto:before-*` 类型）若在 PENDING 状态崩溃，启动时标为 CORRUPTED，不影响主流程

---

## 3. Monorepo 包结构

### 3.1 为什么这样分包

daemon 和 mcp-server 分包的理由：职责边界清晰——daemon 负责数据和状态，mcp-server 负责协议翻译和工具暴露。两者分开也方便独立测试（daemon 的 67 个单元测试不依赖 MCP 协议）。

### 3.2 已落地（v0.1 W1 + W4 + W5 全部）

```
packages/
├── daemon/                    # 持久层 + 业务逻辑（411 tests / 29 test files）
│   ├── src/
│   │   ├── storage/
│   │   │   ├── db.ts          # 数据库连接 + PRAGMA 初始化
│   │   │   ├── migrations/    # 001..010 全部已落（详见 §4.2）
│   │   │   ├── repositories/  # scratchpad / checkpoints / lanes / ops / compensations
│   │   │   │                   # / processes / conflicts / dispatch / tasks / blockers / outcomes
│   │   │   ├── tasks-state.ts # 12-transition state machine（W5 Phase 1+2+3 全部 active）
│   │   │   └── types.ts       # StoredOutcomeCriterion 类型擦除接口（P2.1 boundary lock）
│   │   ├── snapshots/
│   │   │   └── git-stash.ts   # git stash backend（capture / restore / affectedFiles）
│   │   ├── dispatch/          # NL intent parsing + 5 fallback rules（R1/R2/R3/R4/R6）
│   │   └── index.ts           # 占位（独立 daemon 进程入口推迟 v0.2）
│   ├── dist/                  # tsc 输出（含 .d.ts），供 mcp-server import
│   └── tsconfig.json          # declaration: true
│
└── mcp-server/                # MCP stdio server（329 tests + 1 skip / 17 test files）
    ├── src/
    │   ├── index.ts           # 28 工具的 schema + switch dispatch
    │   ├── tools/             # 工具实现（task / outcomes / scratchpad / checkpoint /
    │   │                       # rewind / process / conflict / dispatch / inspector）
    │   ├── dsl/               # W5 Phase 3：parser / evaluator / spawn-utils /
    │   │                       # path-utils / primitives / types
    │   ├── resume-packet.ts   # read-only aggregate view 组装
    │   ├── workspace.ts       # auto SESSION_AGENT_ID + ws.cwd / ws.db
    │   └── cli/install.ts     # `cairn install` CLI
    ├── scripts/               # W5 Phase 1/2/3 dogfood scripts（real MCP stdio）
    └── tests/                 # 单测 + acceptance + dsl/ + stdio-smoke
```

**跨包 import 规则**：mcp-server import daemon 走 `../../daemon/dist/`，不走源码。这是已知技术债（见 §9），等 monorepo 工具引入时统一。`packages/desktop-shell/` 也已存在（W4 落地的 Electron 悬浮标 ambient UI），通过 main process 直接 require better-sqlite3 读 `~/.cairn/cairn.db`。

### 3.3 v0.2 候选新包

| 候选包 | 触发条件 | 说明 |
|---|---|---|
| `packages/desktop-shell/` | **v0.1 已实施** | 悬浮标 + Inspector panel，Electron 实施。main process 直接 require better-sqlite3 读 ~/.cairn/cairn.db。详 PRODUCT.md §8.2。 |
| `packages/conflict-engine/` | 冲突检测逻辑复杂度超过单文件可维护范围 | 冲突检测 + 诊断逻辑模块 |
| `packages/dispatcher/` | Dispatch LLM 调用逻辑独立成服务 | NL 意图解析 + agent 选型 + prompt 生成 |
| `packages/process-bus/` | 进程总线有专属 GC / 心跳超时逻辑 | agent 注册 / 心跳 / 状态查询 |
| `packages/inspector-cli/` | Inspector NL 查询独立为 CLI 工具 | 独立发布，不依赖 mcp-server |

以上均为候选，v0.1 不实施，所有逻辑优先放入 daemon 或 mcp-server。

### 3.4 包间依赖规则（硬约束）

1. `mcp-server` 可以 import `daemon/dist/`，反向不允许
2. 未来新包（conflict-engine 等）可以 import `daemon/dist/`，但不能 import `mcp-server/`
3. 所有包的测试必须能独立跑（`cd packages/X && npm test`），不依赖其他包的开发服务器
4. 新 migration 必须只加新表 / 新列，不修改已存在的 migration 文件（checksum guard 会拒绝）

---

## 4. SQLite Schema

### 4.1 为什么这样组织

引用 DESIGN_STORAGE.md §2.3 的选型理由（SQLite vs Postgres / 纯文件），不重复。
本节补充 v2 定位带来的新表需求，以及与已落地 schema 的关系。

### 4.2 已落地（migration 001-010）

| Migration | 表 / 内容 | 状态 |
|---|---|---|
| `001-init.ts` | `schema_migrations` / `lanes` / `ops` / `compensations` | ✅ W1 |
| `002-scratchpad.ts` | `scratchpad`（含 key / value / task_id / expires_at） | ✅ W1 |
| `003-checkpoints.ts` | `checkpoints`（含 task_id / git_head / snapshot_status） | ✅ W1 |
| `004-processes-conflicts.ts` | `processes` + `conflicts`（含冲突类型 / agent_a,b / paths_json / status） | ✅ W4 Day 1 |
| `005-dispatch.ts` | `dispatch_requests`（含 nl_intent / parsed_intent / status CHECK） | ✅ W4 Day 2 |
| `006-conflict-pending-review.ts` | `conflicts.status` 枚举扩展加 `PENDING_REVIEW`（pre-commit hook 写入） | ✅ W4 Phase 3 |
| `007-tasks.ts` | `tasks`（含 intent / state / parent_task_id / created_by_agent_id / metadata_json） | ✅ W5 Phase 1 |
| `008-dispatch-task-id.ts` | `dispatch_requests.task_id` 列追加（任务级派发归属） | ✅ W5 Phase 1 |
| `009-blockers.ts` | `blockers`（OPEN / ANSWERED / SUPERSEDED CHECK + FK CASCADE on tasks） | ✅ W5 Phase 2 |
| `010-outcomes.ts` | `outcomes`（UNIQUE(task_id) + criteria_json frozen + 4-status CHECK） | ✅ W5 Phase 3 |

下一个可用编号：`011`。完整 DDL 见 DESIGN_STORAGE.md §4 + W5 Phase 1/2/3 plan 文件。

### 4.3 v0.1 四能力新增表（已落地，供参考）

**processes（进程总线）**
```sql
CREATE TABLE processes (
  agent_id     TEXT    PRIMARY KEY,
  agent_type   TEXT    NOT NULL,          -- 'claude-code' / 'cursor' / 'cline' / 'custom'
  capabilities TEXT,                       -- JSON 数组：['scratchpad', 'checkpoint']
  status       TEXT    NOT NULL CHECK (status IN ('ACTIVE', 'IDLE', 'DEAD')),
  registered_at  INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  heartbeat_ttl  INTEGER NOT NULL DEFAULT 60000  -- ms，超时则视为 DEAD
);
CREATE INDEX idx_processes_status ON processes(status);
```

**conflicts（冲突日志）**
```sql
CREATE TABLE conflicts (
  id           TEXT    PRIMARY KEY,       -- ULID
  detected_at  INTEGER NOT NULL,
  conflict_type TEXT   NOT NULL CHECK (conflict_type IN (
                  'FILE_OVERLAP',         -- 同文件写入意图重叠
                  'STATE_CONFLICT',       -- rewind 影响其他 agent 的 checkpoint
                  'INTENT_BOUNDARY'       -- 意图越界（v0.1 文件范围）
               )),
  agent_a      TEXT    NOT NULL,          -- 发起方 agent_id
  agent_b      TEXT,                      -- 另一方 agent_id（可空，如边界越界场景）
  paths_json   TEXT    NOT NULL,          -- 冲突文件路径列表（JSON 数组）
  summary      TEXT,                      -- 人读摘要
  status       TEXT    NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
  resolved_at  INTEGER,
  resolution   TEXT                       -- 用户仲裁决定摘要
);
CREATE INDEX idx_conflicts_detected_at ON conflicts(detected_at);
CREATE INDEX idx_conflicts_status      ON conflicts(status);
```

**dispatch_requests（派单请求）**
```sql
CREATE TABLE dispatch_requests (
  id           TEXT    PRIMARY KEY,       -- ULID
  nl_intent    TEXT    NOT NULL,          -- 用户原始自然语言
  parsed_intent TEXT,                     -- LLM 解析结果（JSON）
  context_keys TEXT,                      -- 检索到的 scratchpad key 列表（JSON 数组）
  generated_prompt TEXT,                  -- 最终生成的 agent prompt
  target_agent TEXT,                      -- 选定的目标 agent_id
  status       TEXT    NOT NULL CHECK (status IN (
                  'PENDING',              -- 等待用户确认
                  'CONFIRMED',            -- 用户确认，已转发
                  'REJECTED',             -- 用户拒绝
                  'FAILED'               -- 转发失败
               )),
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER
);
```

### 4.4 索引和 VACUUM 策略

🚧 D-2：idle / busy 两种状态下 `conflicts` 和 `dispatch_requests` 的写入频率待 dogfood 实测。dogfood 数据收集后补充索引决策和 `VACUUM` 触发阈值。

---

## 5. MCP 工具清单

### 5.1 已落地 17 个工具（W1+W2 + Phase 1-4）

| 工具 | 一句话语义 |
|---|---|
| `cairn.scratchpad.write(key, content, [task_id])` | 持久化命名草稿，支持 task_id 切片；写前自动落 `auto:before-scratchpad-write` checkpoint |
| `cairn.scratchpad.read(key, [task_id])` | 读取命名草稿原文，不压缩 |
| `cairn.scratchpad.list([task_id])` | 列出草稿列表，支持按 task_id 过滤 |
| `cairn.scratchpad.delete(key, [task_id])` | 删除命名草稿（完成 CRUD） |
| `cairn.checkpoint.create(label, [task_id])` | 对当前工作目录创建快照（两阶段提交：PENDING→READY） |
| `cairn.checkpoint.list([task_id])` | 列出 checkpoint，支持按 task_id 过滤 |
| `cairn.rewind.to(checkpoint_id, [paths])` | 回滚到指定 checkpoint；支持 paths 子集；工作树干净时走 git checkout + clean，否则走 stash；执行前自动落 `auto:before-rewind` checkpoint |
| `cairn.rewind.preview(checkpoint_id, [paths])` | 预览回滚影响的文件（会变 / 不变两个清单），不执行 |

**auto-checkpoint 机制**：`scratchpad.write` 和 `rewind.to` 在执行前各自落一个 `auto:before-*` 节点，保证操作可逆。这个机制已落地，无需额外配置。

### 5.2 已落地工具（W4 Phase 1-4，全部实施完毕）

**冲突可见**

| 工具 | 语义 |
|---|---|
| `cairn.inspector.query(nl_query)` | 自然语言查询状态（15 个确定性 SQL 模板，纯关键词匹配，不走 LLM） | ✅ 落地 |
| `cairn.conflict.list([since])` | 列出冲突历史，可按时间过滤 | ✅ 落地 |
| `cairn.conflict.resolve(conflict_id, resolution)` | 将 OPEN/PENDING_REVIEW 冲突标为 RESOLVED；Inspector panel 对应 Resolve 按钮 | ✅ 落地（Phase 2） |

**进程总线**

| 工具 | 语义 |
|---|---|
| `cairn.process.register([agent_id], agent_type, capabilities)` | agent 注册自身到进程总线；agent_id 默认由 SESSION_AGENT_ID 自动填充 |
| `cairn.process.heartbeat([agent_id])` | 更新 last_heartbeat；agent_id 可省略 |
| `cairn.process.list()` | 列出当前活跃 / IDLE 的 agent |
| `cairn.process.status([agent_id])` | 查询指定 agent 状态；agent_id 可省略 |

**需求可派**

| 工具 | 语义 |
|---|---|
| `cairn.dispatch.request(nl_intent)` | 提交派单请求（NL→意图解析→待确认），内置 5 条兜底规则（R1/R2/R3/R4/R6） |
| `cairn.dispatch.confirm(request_id)` | 用户确认派单，触发 prompt 转发给目标 agent |

**消息可达（无新工具，复用 scratchpad CRUD）**

消息可达能力的实现路径是约定，不是新工具。具体约定见 §6.4 和 §9.3（PRODUCT.md）。

### 5.3 v0.2+ 候选工具（仅列名，不展开）

- `cairn.rewind.snapshot(agent_id)` — 对 agent 会话历史创建截断点（L3 粒度，v0.2）
- `cairn.echo.diff(agent_id)` — 反汇总：对比 subagent 原文与主 agent 复述（v0.2）
- `cairn.dispatch.cancel(request_id)` — 取消待确认的派单

---

## 6. 四能力实施路径

### 6.1 冲突可见

**为什么这一节存在**：冲突检测不是"做一个功能"，而是"在系统里植入多个钩子"。每个钩子的延迟和误判率都不同，必须把架构选择和它的限制一起说清楚。产品理由见 PRODUCT.md §5.1。

**检测层设计（双层）**

| 层 | 机制 | 延迟 | v0.1 状态 |
|---|---|---|---|
| MCP-call 级 | agent 调用 `checkpoint.create` 或 `scratchpad.write` 时，daemon 在提交写入前对比其他 agent 的 in-flight 路径记录 | 工具调用粒度（毫秒级） | 待实现 |
| commit-after 级 | git pre-commit hook 调用 daemon，比对 staged 文件路径与 checkpoint 路径记录 | commit 粒度（秒级） | 待实现 |

不做 fs syscall 实时拦截（v0.3+）。不做 CI 级（status quo 已有）。理由见 ADR-1。

**MCP-call 级数据流**

```
agent 调用 cairn.checkpoint.create(label, paths=[...])
  → mcp-server 转发到 daemon
  → daemon 查询 processes 表中其他活跃 agent 的 in-flight 元数据
  → 比对 paths 集合（是否有交集）
  → 若有交集：写入 conflicts 表（conflict_type='FILE_OVERLAP'）+ 触发通知
  → 继续执行 checkpoint 创建（冲突检测不阻断操作，只通知）
```

**commit-after 级数据流**

```
用户执行 git commit
  → git pre-commit hook（安装时写入 .git/hooks/pre-commit）
  → hook 调用本地 CLI：cairn conflict check --staged-files <paths>
  → daemon 比对路径与最近 N 分钟内的 checkpoint 记录
  → 若冲突：打印警告 + 写入 conflicts 表
  → hook 退出 0（不阻断 commit，只记录）
```

**通知机制**：v0.1 基础版走 stdout 打印 + CLI 查询（`cairn.conflict.list`）。系统通知（macOS 通知中心 / Windows 通知）的具体形式 🚧 D-2 dogfood 后定，v0.1 先打文字通知。

**✓ v0.1 W4 Day 1 实施（2026-05-06）**：

migration 004（`processes` + `conflicts` 表）已落地，进程总线 4 工具 + 冲突检测 service + `cairn.conflict.list` 工具 + git pre-commit hook (`cairn install`) 全部到位。daemon tests 90 → 147（+57），mcp-server tests 42 → 64（+22）。

**v1 简化（必须知道，否则误判检测能力）**：

1. **`checkpoints` 表无 `agent_id` 列也无 `paths_json` 列**（migration 003 已锁，append-only）。conflict-detection 只能用 `task_id` 作为 agent 身份代理——**约定 caller 把 agent_id 作为 task_id 传入** `cairn.checkpoint.create`，否则不归因
2. **"overlapping paths" 在 v1 直接返回 caller 声明的 paths**（不算真交集）。要做精确"两 agent 真改了同一文件"判断，需 migration 005 给 `checkpoints` 加 `paths_json` 列（v0.2 议题）
3. **冲突检测窗口默认 5 分钟**，超出窗口的历史 checkpoint 不参与比对
4. **agent_id 在 `cairn.checkpoint.create` 是可选参数**（向后兼容），未传则跳过冲突检测

**相关锚点**：
- ✓ PoC-1（2026-04-29）：在 N=2/5/10 并发 writer 下 SQLite WAL + busy_timeout=5000ms 提供完整事务隔离 + 零数据丢失，p99 < 6ms。conflict-detection 应用层逻辑可以直接叠加，不需要更强的并发原语。N=50 极端场景下 p99=449ms（架构天花板，记录为 v0.3 议题）。详见 `docs/superpowers/plans/2026-04-29-poc-1-results.md`。
- ✓ PoC-2（2026-04-29）：v0.1 hook 直接打开 SQLite（v0.1 无长跑 daemon），p99 在 clean/small/medium 场景 < 90ms，large（1000 staged files）= 122ms，远低于 1000ms 预算。Node 冷启动 ~70ms 是主要成本，SQLite 边际查询 ~45μs/path。fail-open 验证：DB 缺失时 24ms 内 exit 0。详 `docs/superpowers/plans/2026-04-29-poc-2-results.md`。
- ✓ W4 Day 1（2026-05-06）：v1 落地。后续精度提升见上「v1 简化」段
- 🚧 D-4：假阳性率（自用阶段自己感知；personal-build 决策 36 已砍 dogfood 大样本）

### 6.2 状态可逆

**为什么这一节存在**：已落地。这一节主要说清楚 task_id 的多 agent 约定——这是一个协议，必须写在文档里，代码层没有强制。

**已落地（v0.1 全部，无新增工作）**

| 粒度 | 覆盖 | 实现 |
|---|---|---|
| L0 文件全量 | 工作目录所有文件 + git HEAD | `cairn.checkpoint.create` + `rewind.to` |
| L1 paths 子集 | 指定目录 / 文件 | `rewind.to` 的 `paths` 参数 |
| L2 scratchpad | 所有 scratchpad key-value | `cairn.scratchpad.*` CRUD |

L3~L6 粒度推迟到 v0.2，见 PRODUCT.md §5.2 粒度矩阵。

**task_id 多 agent 约定（必须写入文档而非代码强制）**

`task_id` 是 agent 间协调隔离的关键字段。v0.1 的约定：
- `task_id` 由 **host agent（主 agent）** 在派发 subagent 时生成并通过 prompt 传递
- daemon **不分配**，不校验，不强制——这是应用层约定，不是协议强制
- 同一 task 下的所有 scratchpad key 和 checkpoint 共享同一 `task_id`，便于 `cairn.scratchpad.list(task_id)` 过滤
- subagent 写入时必须携带主 agent 传入的 `task_id`，否则数据落入 `task_id=NULL` 的公共空间

**clean-tree rewind 逻辑**：
- 工作树干净（`git status --porcelain` 输出为空）→ `git checkout <commit> -- .` + `git clean -fd`
- 工作树有未提交改动 → 先 `git stash`，再切换，stash 信息记录在 checkpoint 的 `label` 字段（W1 技术债，见 §9）

**rewind 前置条件检查**（`cairn.rewind.to` 的执行顺序）：
1. 验证 checkpoint_id 存在且 `snapshot_status='READY'`
2. 若指定 paths，验证 paths 在 checkpoint 快照里存在
3. 落 `auto:before-rewind` checkpoint（当前状态备份）
4. 执行 git 操作（clean-tree 或 stash 路径）
5. 从 `snapshots/{ckpt_id}/` 恢复文件
6. 返回结果（成功：已恢复的文件数 + 边界说明；失败：错误详情 + auto-checkpoint 的 ID 供用户手动恢复）

### 6.3 需求可派

**为什么这一节存在**：Dispatch 是四能力里唯一需要 LLM 深度参与的动词，且 LLM 选型尚未锁定。必须把流程和不确定性分开说。产品流程见 PRODUCT.md §5.3。

**实现流程**

```
用户 NL → cairn.dispatch.request(nl_intent)
  → daemon 调 LLM（🚧 PoC-3 决定选哪个）解析意图
  → 检索相关 scratchpad / checkpoint（确定性 SQL 查询，不走 LLM）
  → 查询 processes 表：当前活跃 agent 列表
  → LLM 辅助选型（若只有一个 agent，退化为直接转发）
  → 生成 agent prompt（含历史上下文附件）
  → 写入 dispatch_requests 表（status='PENDING'）
  → 返回 request_id + 生成的 prompt 给用户审查

用户审查 → cairn.dispatch.confirm(request_id)
  → daemon 标记 dispatch_requests.status='CONFIRMED'
  → 通过 scratchpad 写入目标 agent 的 dispatch key（`dispatch/{request_id}/...`）
  → agent 读取后执行（Cairn 退出，不跟踪后续执行）
```

**LLM provider**：v0.1 走 OpenAI-compatible 接口抽象，用户自配（MiniMax / DeepSeek / Qwen / OpenAI / Anthropic / Ollama 等）。详见 ADR-4。🚧 PoC-3 验证默认 provider 选型 + 接口可移植性。

**单 agent 退化**：当 `processes` 表里只有一个活跃 agent 时，"agent 选型"步骤退化为"直接转发"，不调用 LLM 选型逻辑。这保证了单 agent 用户场景的可用性。

**用户确认机制**：v0.1 走 CLI 交互（`cairn.dispatch.confirm` 工具调用 + 生成的 prompt 展示在 agent 的上下文里）。GUI 确认界面是 W6+ UI 设计的议题。

**✓ v0.1 W4 Day 2 实施（2026-05-06）**：

migration 005（`dispatch_requests` 表）已落地。Dispatch v1 端到端可跑：

| 层 | 落地 |
|---|---|
| Schema | `dispatch_requests`：id ULID / nl_intent / parsed_intent JSON / context_keys JSON 数组 / generated_prompt / target_agent / status CHECK PENDING/CONFIRMED/REJECTED/FAILED / created_at / confirmed_at；2 个索引 |
| Repo | `DispatchRequestRepo`：create / get / list（status/since/limit 过滤）/ confirm / reject / fail，状态机 PENDING → CONFIRMED/REJECTED/FAILED |
| LLM 客户端 | `packages/daemon/src/dispatch/llm-client.ts`：`loadConfig` 4 级优先级（显式 path → env → ~/.cairn/config.json → dev fallback `.cairn-poc3-keys/keys.env`）；`completionWithRetry` mock/real 双路径，3 次重试指数 backoff，30s timeout；`completionStrictJson` 断言 object 结果；think 块和 markdown fence 自动剥离（复用 PoC-3 runner 验证逻辑） |
| Mock 模式 | **默认 mode='mock'**——`CAIRN_LLM_MODE=real` 才走真实 API。stub JSON 结构与 PoC-3 system instruction 输出对齐。npm test 不依赖网络 |
| MCP 工具 | `cairn.dispatch.request`（NL → 解析 + 检索 scratchpad + 选 agent + 应用层兜底 4 条 + 写 PENDING 行）+ `cairn.dispatch.confirm`（PENDING → CONFIRMED + 写 scratchpad `dispatch/{id}/prompt`） |
| Inspector v1 | `cairn.inspector.query`：15 个确定性 SQL 模板（中英关键词），不走 LLM；活跃/已死 agent / 最近冲突 / open 冲突 / today 冲突 / path 冲突 / checkpoint by task / scratchpad / pending dispatch / confirmed dispatch / stats 摘要等 |

**应用层兜底 4 条 acceptance（已 wire up，不依赖 LLM 判断）**：

| ID | 触发关键词（中英） | 注入到 generated_prompt 的内容 |
|---|---|---|
| R1 不可逆操作 preview 强制 | rewind / 回滚 / 回退 / delete / 删除 / 清空 / drop / truncate / `rm ` | "[FALLBACK R1] 这是一个不可逆 / 删除操作。执行前必须先调用 cairn.rewind.preview 或等价 dry-run 命令展示影响范围给用户确认；用户明确确认后再执行实际操作。" |
| R2 外部 API 知情同意 | external api / 外部 api / openai / anthropic / claude api / 上传 / 发送 / 云端 / send to / upload | "[FALLBACK R2] 此任务涉及外部 API / 数据离机。执行前先告知用户：(a) 数据将发送到 [具体 endpoint]，(b) API key / 凭证管理风险，(c) token 费用预估；用户明确同意后再执行。" |
| R3 多 agent 路径重叠串行化 | processCount >= 2 时触发（v1 简化：不解析具体路径） | "[FALLBACK R3] 当前有 N 个活跃 agent，目标路径有重叠风险。建议串行：先让一个 agent 完成此任务，确认提交后再开始下一个；或先用 cairn.conflict.list 查看现有冲突。" |
| R4 SQL 操作走 cairn 工具 | sqlite / sql / 数据库 / .db / drop table / alter table / vacuum | "[FALLBACK R4] 不要直接操作 SQLite 文件。所有数据库变更必须走 cairn 工具（cairn.scratchpad.* / cairn.checkpoint.* / cairn.rewind.* 等）；DDL 变更必须用 migration 而非 ALTER 现网。" |

每条规则触发与否独立；可叠加。`applyFallbackRules(promptDraft, nlIntent, processCount, hasPathOverlap)` 是 dispatch.ts 内部 helper，被单元测试直接断言（不经 DB）。

**v1 简化（必须知道）**：

1. **R3 不解析具体文件路径**——只看活跃 agent 数 ≥ 2 就触发提示。要做精确"路径重叠"判断需要给 dispatch_requests 加 paths 字段或者从 nl_intent 用正则抽取（v0.2 候选）
2. **target_agent 选择优先级**：用户显式指定 > LLM agentChoice 模糊匹配 processes 表 > processes 表第一条 > "default"
3. **inspector.query 不走 LLM**——纯关键词字符串匹配 + 预定义 SQL；不能处理"复合查询"或"自然语言推理"。要走 LLM 是 v0.2 候选

**测试**（W4 Day 2 历史快照）：daemon 207 / mcp-server 132 / 总 339 PASS；端到端 acceptance：mock LLM → request → DB 写 PENDING → confirm → scratchpad 写 dispatch/{id}/prompt（验证链路完整）。当前 W5 Phase 3 baseline 见 §3.2（411 / 329）。

### 6.4 消息可达

**为什么这一节存在**：消息可达的实现不是新工具，而是一个 key 命名约定 + 一个 prompt 引导模式。必须在架构文档里写清楚，否则每个 agent 用各自的命名，约定失效。产品边界见 PRODUCT.md §5.4 §9.3。

**IPC 协议：共享 scratchpad**

agent 间通信通过共享 scratchpad 实现，命名规范（v0.1 约定，v0.2 正式化）：

| Key 前缀 | 含义 | 写入者 |
|---|---|---|
| `session/{session_id}/...` | 会话级别共享数据 | 任意 agent |
| `subagent/{agent_id}/result` | subagent 完成结果原文（不压缩） | subagent |
| `echo/{agent_id}/restatement` | 主 agent 对 subagent 结果的复述（v0.2 反汇总的 diff 端） | 主 agent |
| `conflict/{timestamp}/...` | 冲突记录 | daemon 自动写入 |
| `dispatch/{request_id}/...` | 派单请求和响应 | daemon |

**路径 (a) MCP-native（v0.1 唯一路径）**

subagent 在任务结束前被 prompt 引导主动调用 `cairn.scratchpad.write`，把完整报告写入 `subagent/{agent_id}/result`。Cairn 作为被动存储，agent 写来即存，不做 magic 探测。

这依赖 **prompt 纪律**，是 v0.1 的主要失败模式之一（见 PRODUCT.md §11.2）。

**兜底机制**：🚧 PoC-4（CC 的 Task tool 实际调用率）决定 v0.1 是否需要"主 agent 在读 subagent 结果前强制 reload"机制。PoC-4 的测量方法：在 dogfood 中记录主 agent 召回 subagent 结果时，scratchpad 里实际存在对应 key 的比例。若比例 < 80%，需要补充 prompt 模板；若比例 < 50%，需要评估兜底机制。

**反汇总（v0.1 不做）**：层 3（语义 diff）推迟到 v0.2，前提是主 agent 也写 `echo/{agent_id}/restatement`。v0.1 只覆盖持久化（层 1）+ 可查询（层 2）。

**v0.1 消息可达的 prompt 模板建议**（供用户在 system prompt 或任务描述里使用，也是 onboarding 文档的核心内容）：

```
当这个 subagent 任务完成时，在退出前调用：
cairn.scratchpad.write(
  key: "subagent/{agent_id}/result",
  content: <完整报告，包含所有关键决策和实际结果>,
  task_id: "{task_id}"
)
```

这个模板是 Cairn 的 onboarding 文档的核心内容，不是代码强制。

**✓ v0.1 W4 Day 2 文档化（2026-05-06）**：

完整协议（含中英双语模板 + key 命名规范 + 反例 + 主 agent 收尾流程 + v0.2 演进路径）落地到独立文档：

→ **`docs/cairn-subagent-protocol.md`**

这是新会话 / 新用户派 subagent 时的**唯一权威 prompt 模板源**。本节保留作为概念解释，**实际 paste 时从该文档复制**（避免文档间漂移）。

key 命名规范在该文档 §2 已固化（含 `subagent/` `session/` `dispatch/` `conflict/` `echo/` 5 个标准前缀 + 反例清单 + 格式约束）。

---

## 7. ADR（架构决策记录）

### ADR-1：v0.1 选 MCP-call 边界而非 fs syscall 实时拦截

**决策**：v0.1 冲突检测走 MCP-call 级 + commit-after 双层，不做 fs syscall 实时拦截。

**理由**：
- fs hook 跨平台复杂度高：Windows 需要 Volume Filter Driver（需签名）、macOS 需要 Endpoint Security framework（需 entitlement）、Linux 需要 fanotify（需 CAP_SYS_ADMIN 或 eBPF）。
- 与企业 EDR 工具（SentinelOne / CrowdStrike / Microsoft Defender）存在冲突风险，已有用户反馈。
- MCP-call 粒度已经比 CI 级检测提前了一个数量级，实现成本和跨平台稳定性都可控。

**代价**：agent 必须主动调用 Cairn 工具，纯磁盘层操作的 agent 对 Cairn 透明。这在文档和 UI 里明示。

**再评估时间点**：v0.3+，届时评估 eBPF（Linux）/ ES framework（macOS）的成熟度和 Windows 路径。

---

### ADR-2：本地优先，无云端默认

**决策**：所有持久数据（scratchpad / checkpoint / conflicts / dispatch）默认存在用户本机的 `~/.cairn/`，不同步到云端。Dispatch 的 LLM 调用（外部 API）是唯一例外，且用户可替换为本地模型（v0.2）。

**理由**：PRODUCT.md §7 第 3 条原则；用户信任（数据不离本机）；GDPR / 隐私合规默认满足；离线可用。

---

### ADR-3：共享 scratchpad 单空间 + task_id 切片，不做 agent-level namespace

**决策**：v0.1 scratchpad 是单一共享空间，所有 agent 都能读所有 key，以 task_id 字段做软分片。

**理由**：
- 单空间实现简单，task_id 过滤已足够 v0.1 的隔离需求。
- agent 间共享数据本身是目的（消息可达的语义），过度隔离反而破坏 IPC 总线的用途。

**代价**：Agent A 理论上能读 Agent B 的所有 scratchpad key，包括敏感中间状态。v0.1 接受这个风险，因为 v0.1 只面向信任环境（单用户本地）。

**再评估时间点**：v0.2，考虑显式订阅模型（agent 只能读自己订阅的 key 空间）。

---

### ADR-4：Dispatch LLM 走 provider-agnostic 接口（不锁定单一供应商）✓ PoC-3 partial（2026-04-29）— 第二 provider 待补

**为什么这一节存在**：v2 项目维护方测试期间使用 MiniMax / DeepSeek / Qwen 等中国模型 coding plan（成本敏感 + 数据驻留中国），最终用户的 LLM 选型更碎（OpenAI / Anthropic / Chinese LLMs / 本地 Ollama）。锁死任何一家供应商都和"开源 + 本地优先 + 成本敏感"调性冲突。Dispatch 必须走 provider-agnostic 接口。

**决策**：

1. **接口层**：v0.1 Dispatch 走 OpenAI-compatible API 抽象（业界事实标准；Anthropic / MiniMax / DeepSeek / Qwen / Kimi / Ollama 都有 OpenAI-compatible endpoint）
2. **配置层**：用户在 `~/.cairn/config.json`（或环境变量）指定 provider + endpoint + API key + model name；Cairn 不内嵌任何供应商凭证
3. **默认策略**：v0.1 不预设默认 provider，首次启动 onboarding 让用户选 / 配
4. **测试覆盖**：PoC-3 用 ≥ 2 个 provider（MiniMax + DeepSeek 起步）跑同一套 20 条 NL 测试集，验证：
   - (a) 接口抽象在多 provider 下是否真的可移植（指令格式 / 输出格式 / temperature 参数 / token limit 都得抽象）
   - (b) 不同 provider 在 Dispatch 任务上的质量分布

**评估维度**（PoC-3 需要测量的）：
- 5 维度 rubric 均分（详见 `docs/superpowers/plans/2026-04-29-poc-3-prep.md` §4）
- 是否需要 provider-specific 的 prompt 调整（如：Chinese models 是否需要中文 instruction 才稳定输出 JSON）
- 平均响应延迟（不同 provider 的差异）
- 单次 Dispatch 调用的 token 成本（不同 provider 的成本对比）

**通过判据**（按 PoC-3 prep §6）：
- 单个 provider 均分 ≥ 7.0 → 该 provider 进入"v0.1 推荐 provider 清单"
- 任一 provider 均分 < 5.0 → 该 provider 不推荐，但接口本身仍可用
- ≥ 2 个 provider 通过 → ADR-4 接口抽象成立；用户可自由切换

**✓ PoC-3 partial 执行结果（2026-04-29）**：

单 provider 跑完（user 暂无 DeepSeek 等第二 provider key，"接口可移植性"命题留待增量补跑）：

| 维度 | MiniMax-M2.7（runner 因 Text-01 plan 限制自动 fallback；reasoning model；中文 instruction） |
|---|---|
| 整体均分 | **7.36/10** |
| 类别均分 | A=9.32 / B=8.40 / C=6.92 / **D=4.80** |
| 维度均分 | 意图=7.25 / agent选型=8.45 / prompt=7.20 / 历史关键词=8.10 / **风险提示=5.70** |
| HTTP 200 | 20/20 |
| JSON parse 成功 | 18/20（C.3 语法错；D.3 reasoning 模型只输出 think 块无 JSON） |
| Instruction-following 违规率 | 30%（6/20：markdown 包裹 / JSON 前后散文 / 无 JSON 输出 / 语法错） |
| 平均 latency | 13.8s（reasoning 思考时间，约为典型 chat completion 5-10×） |

**Verdict**：

1. **MiniMax-M2.7 进 v0.1 推荐 provider 清单**（整体 ≥ 7.0）
2. **Dispatch v0.1 走 LLM-driven (OpenAI-compat 接口)**（按 §6.2 决策矩阵 ≥ 7.0 档位）
3. **关键警示**：D 类（危险/边界）4.80 + 风险维度 5.70 是悬崖式断崖——LLM 自身识别不可逆操作 / 架构约束的能力**系统性不足**
4. **接口可移植性**：partial 验证——MiniMax-M2.7 通过 OpenAI-compat endpoint 跑通 20/20，无需 provider-specific prompt 调整。第二 provider 跑通后才能完整断言

**对 W5-W7 Dispatch v1 编码的硬要求（应用层兜底清单）**：

LLM 不能完全依赖。W5-W7 plan 的 acceptance 必须含以下 4 条：

1. **不可逆操作（rewind / delete）一律强制 preview**——不依赖 LLM 自动识别（D.2/D.3 数据：模型在 scratchpad 批量删 / SQLite 直接改场景下系统性失败）
2. **调外部 API 类任务一律强制 user 知情同意提示**——违反 ADR-2 本地优先时显式 warn（D.5 数据：模型直接写脚本，未识别本地优先原则）
3. **同文件多 agent 并行一律提示串行化**——LLM 即使识别了冲突仍可能给出并行 prompt（D.4 数据）
4. **直接 SQL 操作一律走 cairn 工具路径**——LLM 可能完全失败输出 JSON（D.3 数据）

详见 `docs/superpowers/plans/2026-04-29-poc-3-results.md`。

**✓ W4 Day 2 实施验证（2026-05-06）**：4 条兜底规则全部 wire up 到 `cairn.dispatch.request` 工具，关键词触发不依赖 LLM。详见 §6.3 "v0.1 W4 Day 2 实施" 表格 + `packages/mcp-server/src/tools/dispatch.ts`。`applyFallbackRules` helper 单元测试覆盖各规则中英关键词。

**v0.1 范围**：
- 实现 OpenAI-compatible 接口适配器（一份代码跑所有 OpenAI-compatible provider）
- 推荐 provider 清单（PoC-3 跑过且均分 ≥ 7 的）写进 README + 首次启动 onboarding
- 不实现 provider-specific 适配（如 Anthropic native API / Google Gemini API），用户要用就靠 OpenAI-compatible proxy（litellm 等）

**v0.2 候选**：
- 本地 Ollama 接入（也走 OpenAI-compatible，零额外工作）
- provider-specific 优化（如启用 Anthropic 的 prompt caching）
- 多 provider 路由（按任务类型挑 provider，例：意图解析用便宜的，prompt 生成用质量高的）

**未决**：
- 中文 instruction 在 reasoning model 上稳定性偏低（partial PoC-3 数据：30% instruction-following 违规率）。增量跑 non-reasoning model（如 deepseek-chat、MiniMax-Text-01 升级 plan 后）能验证"reasoning 模型 attention 占用导致 instruction 守纪律下降"假说
- 第二 provider（DeepSeek / Qwen / Kimi 等）的接口可移植性数据——user 拿到 key 后增量补跑 partial PoC-3
- Chinese model 用户在没有 Anthropic key 的情况下，CC（Claude Code）这条 host 链路怎么办——这是 Cairn ICP 之外的问题（CC 自己的供应商绑定不归 Cairn 管），但需要在文档里说明 Cairn 不替代 CC 的 LLM 选择
- temperature / top_p / max_tokens 等通用参数的默认值（v0.1 用 PoC-3 实测的 temperature=0.3 + max_tokens=2048 作为 baseline）

---

### ADR-5：进程总线轻量化，v0.1 只做注册 + 心跳 + 查询

**决策**：`processes` 表 + 4 个 MCP 工具（register / heartbeat / list / status）。不做 RPC、不做 event push、不做订阅。

**理由**：
- v0.1 的核心用例是 Inspector 查询"现在哪些 agent 在跑"，简单查表够用。
- event push 需要 daemon 维护持久连接给 agent，这和 stdio MCP 的请求/响应模式不兼容，架构成本高。
- 保持进程总线轻量，等 v0.2 再评估是否需要 WebSocket 或 IPC 事件推送。

---

### ADR-6：v0.1 不支持非 MCP-aware agent（Cursor / Cline）

**决策**：v0.1 只支持通过 `.mcp.json` 接入的 MCP-native agent。非 MCP-aware 工具不做适配。

**理由**：wrapper / sidecar 方案需要为每个 agent 写专属适配层，维护成本线性增长；且非 MCP-aware agent 的行为感知需要 fs hook（已在 ADR-1 排除）。

🚧 D-1：v0.2 评估非 MCP-aware agent 的接入路径（wrapper 实现成本 + 用户需求强度）。

---

### ADR-7：daemon 单实例（同一台机器）

**决策**：v0.1 约定同一台机器只跑一个 Cairn daemon 实例。

**理由**：SQLite 是单写者架构，多实例写同一个 `~/.cairn/cairn.db` 会产生竞争；进程总线的 agent 注册语义在多 daemon 下失去意义（哪个 daemon 是权威？）。

**代价**：没有硬性互斥（v0.1 不写 PID 文件锁），依赖用户约定。

**多实例场景**：多用户多实例（每个用户一个 daemon）是 v0.3+ 议题，需要独立的 `~/.cairn/` 或 per-user 隔离机制。

---

### ADR-8：悬浮标技术栈选 Electron（已从 Tauri 切换）

**决策**：v0.1 桌面 UI 用 Electron（Node + Chromium）实施，不选 Tauri 或 Native+WebView。

**理由**：

| 维度 | Electron | Tauri | Native+WebView |
|---|---|---|---|
| 体积 | ~80-150MB | ~5-10MB | ~3-5MB（每 OS 独立） |
| 工具链 | Node.js（整栈统一） | Rust + Node 双栈 | 各 OS 原生语言 |
| 跨平台 | 一套代码（Chromium） | 一套代码（Rust + WebView） | macOS / Windows / Linux 各写一遍 |
| SQLite 集成 | main process 直接 import better-sqlite3 | 需跨语言 IPC 桥接 | 各 OS 独立实现 |

- 整栈 Node 化：daemon、mcp-server、SQLite 调用全在 Node 生态，Electron main process 即 Node，可直接内联查询逻辑，省去独立 state-server 进程
- 工具链统一：避免引入 Rust（VS Build Tools ~5GB + Rust ~1.5GB + 跨语言 IPC，对 1 人 + AI 项目偏重）
- 体积代价可接受：cairn 目标用户（开发者）已运行 Cursor / VS Code / Claude Desktop / Slack 等 Electron / Chromium 应用，再增 100MB 不构成感知噪声

**后果**：
- Electron main process 直接 `require('better-sqlite3')` 读 `~/.cairn/cairn.db`，无独立 state-server 进程
- `packages/desktop-shell/` 是新加的 Electron 应用，`preview.html`/`preview.js` 保留为 browser fallback
- electron-builder 打包；native module rebuild 用 `electron-rebuild`

**未决**：
- 打包尺寸优化（ASAR、按需 Chromium 裁剪）留 v0.3+
- macOS 公证 / Windows 签名留正式发布时处理

---

### ADR-9：Auto SESSION_AGENT_ID + `cairn install` CLI + pre-commit 写 DB（Phase 1/3/4）

#### 9a. Auto SESSION_AGENT_ID（Phase 1）

**决策**：mcp-server 启动时自动计算 `cairn-<sha1(hostname:cwd).slice(0,12)>` 作为当前会话的 agent_id，挂到 `ws.agentId`，写入 `process.env.CAIRN_SESSION_AGENT_ID`。

`cairn.process.register` / `heartbeat` / `status` 和 `cairn.checkpoint.create` 的 `agent_id` 参数变为可选，缺省时自动取 SESSION_AGENT_ID。MCP schema 不再标记 `agent_id` 为 required。

```
mcp-server 启动
  → sha1(os.hostname() + ':' + process.cwd()).slice(0,12)
  → CAIRN_SESSION_AGENT_ID = "cairn-<hash>"
  → 所有工具的 agent_id 参数缺省时读此值
```

**测试约定**：测试不应传 `agent_id` 除非在断言显式覆盖行为；auto-inject 路径是默认路径。

#### 9b. pre-commit hook 写 DB（Phase 3）

**决策**：pre-commit hook 从只读查询升级为读写模式。当 staged paths 与近期 OPEN 跨 agent 冲突有重叠时，hook 额外 INSERT 一条新冲突行（`conflict_type='FILE_OVERLAP'`, `status='PENDING_REVIEW'`），触发桌面宠物切换到 review 动画。Migration 006 扩展 `conflicts.status` 枚举加入 `PENDING_REVIEW`。

`CAIRN_DISPATCH_FORCE_FAIL=1` 环境变量可强制 `dispatch.request` 写入 FAILED 行（demo/测试 hook，不走 LLM）。

#### 9c. `cairn install` CLI（Phase 4）

**决策**：`packages/mcp-server` 新增 bin entry `cairn`（`npm run build` 后可用），提供 `cairn install` 子命令，在目标 repo 执行：

```
cairn install
  → 写/合并 .mcp.json（cairn-wedge server 入口）
  → 安装 git pre-commit hook
      标记行：# cairn-pre-commit-v1
      若已有非 cairn hook → 旁挂到 .cairn/ 目录，主 hook 调用两者
  → 生成 start-cairn-pet.bat + .sh 启动脚本（保留已有文件）
```

**当前状态**：非 npm-published；需 file-link 安装（clone 后 `cd packages/mcp-server && npm install && npm run build`，然后用绝对路径调用 `node dist/index.js`）。`cairn install` 直接可运行，无需全局 install。

---

## 8. 横切关注点

### 8.1 资源占用基线

🚧 D-2：目标是在 dogfood 阶段测量 idle 和 busy 两种状态下的 RAM / CPU。

预期约束（未验证）：
- daemon 空闲状态：< 50 MB RSS（SQLite WAL + Node.js 基础占用）
- daemon 忙碌状态（多 agent 并发写 scratchpad）：待测
- mcp-server：随 agent host 生命周期，agent 关闭后进程退出

在这两项数据有 dogfood 结论之前，不做资源占用优化。

**测量方法**（D-2 执行计划）：
- 安装 dogfood 版本后，用 `process.memoryUsage()` 每 30 秒采样 daemon RSS
- 同时跑 2 个 agent（Claude Code 主 + subagent）并发写 scratchpad，采集 CPU spikes
- 收集 1 周数据后回填到本文档 §8.1 和 §4.4

### 8.2 假阳性率

🚧 D-4：冲突检测的假阳性（两 agent 实际上没有冲突，但 Cairn 误报）在 dogfood 阶段测量。

v0.1 的保守策略：
- 只在文件路径完全相同时触发 `FILE_OVERLAP` 冲突，不做模糊匹配（如同目录不同文件不触发）
- 用户可以通过 `cairn.conflict.list` 查历史，手动标记 IGNORED 来处理误报
- 系统通知不阻断操作（冲突检测是通知，不是锁）

若 dogfood 期间假阳性率 > 20%，收紧检测策略；若漏报率高，放宽。

### 8.3 错误处理与失败模式

| 失败场景 | daemon 行为 | agent / 用户感知 |
|---|---|---|
| daemon 崩溃 | 无感知（已崩溃）；重启后执行 §2.4 启动恢复 | in-flight MCP 调用超时，agent 需重试；重启后 scratchpad / checkpoint 完整 |
| SQLite BUSY（写冲突，5s 超时） | `better-sqlite3` 抛出 SQLITE_BUSY 错误 | MCP 工具调用返回 error；agent 需重试或降级 |
| git stash 失败（工作树有冲突） | checkpoint 标为 CORRUPTED | `cairn.rewind.to` 返回错误详情；用户需手动解决 |
| LLM API 调用失败（Dispatch）| 写入 dispatch_requests.status='FAILED' | `cairn.dispatch.request` 返回错误；用户可重试 |
| agent 心跳停止 | daemon 在下次 `process.list` 时，`last_heartbeat + heartbeat_ttl < now()` 的 agent 标为 DEAD | Inspector 查询时显示 DEAD 状态 |

### 8.4 安全与信任边界

**daemon 进程权限**：以普通用户权限运行，不需要 root / admin。避免权限提升。

**scratchpad 数据可读性**：所有 scratchpad 数据以明文存储在 SQLite 中，无加密。v0.1 接受这个限制（本地单用户场景）。SQLite 加密（SQLCipher）是 v0.2 候选。

**SBOM 和审计日志**：v0.1 不输出正式 SBOM。SQLite 表本身有 `created_at` / `updated_at` 字段，可作为轻量审计日志。完整审计日志格式是 v0.2+ 企业方向议题。

**信任边界**：daemon 信任所有来自本机的 MCP 调用，不做 caller 鉴权。这适用于 v0.1 的单用户本地场景；多用户场景的权限隔离是 v0.3+ 议题。

### 8.5 可观测性

v0.1 不做 metrics / tracing，理由是在单用户本地场景里 overhead 不值得。

实际可观测手段：
- **SQLite 表自带审计**：所有 scratchpad / checkpoint / conflict / dispatch 操作都有时间戳，`cairn.inspector.query` 可以查询。
- **日志文件**：`~/.cairn/logs/daemon-{date}.log`，结构化 JSON 行，按日期滚动。
- **git history**：checkpoint 的 git_head 字段记录操作时的 commit，可以 `git log` 追溯。

v0.2 若有 Inspector GUI，考虑展示简单的事件时间线，不引入 Prometheus / OpenTelemetry。

---

## 9. 已知技术债与风险

| 项目 | 位置 | 影响 | 清理时机 |
|---|---|---|---|
| stash SHA 编码在 `checkpoints.label` | `packages/daemon/src/storage/repositories/checkpoints.ts` | P2 加 `backend_data TEXT` 列后需迁移 | P2 落地时 |
| `checkpoints` 表缺 `agent_id` + `paths_json` 列 | `packages/daemon/src/storage/migrations/003-checkpoints.ts` | conflict-detection v1 用 task_id 作 agent 代理，"overlapping paths" 不是真交集 | v0.2 加 migration 005（ALTER TABLE checkpoints ADD COLUMN）或新建关联表 |
| mcp-server 直接 import daemon `dist/` | `packages/mcp-server/src/tools/` | monorepo 工具引入时统一治理 | 引入 pnpm workspaces / nx 时 |
| `packages/daemon/src/index.ts` 是占位 | `packages/daemon/src/index.ts` | 真正的 daemon 主入口实现时覆盖 | v0.2 daemon 独立进程 |
| migration 没有 down migration | `packages/daemon/src/storage/migrations/` | 无法回滚 schema 变更（见 DESIGN_STORAGE.md §11） | v0.2 评估是否需要 |
| SQLite WAL 在 Windows 含中文 / 空格路径的行为未测 | `~/.cairn/cairn.db` | 潜在路径编码问题 | W3 dogfood 启动时集成测试覆盖 |
| 17 个工具的并发安全性 | `packages/daemon/tests/` `packages/mcp-server/tests/` | W1+W2 单线程测试覆盖；v0.1 ICP 假设的并发度（N≤10）由 PoC-1（2026-04-29）覆盖，零失败 | N≥50 尾延迟天花板见 §10 v0.3 议题 |
| v0.1 没有 release packaging | 仓库根 | 用户需要手动 clone + build 安装 | v0.1 ship（W11-W12）前补 |
| `processes` 表心跳 GC 未实现 | `packages/daemon/src/storage/repositories/` | DEAD 状态的 process 行会积累 | 进程总线实现时补 `gcDeadProcesses()` |
| conflict 表无自动 GC | `packages/daemon/src/storage/repositories/` | RESOLVED / IGNORED 记录长期积累 | dogfood 数据决定 GC 策略（按天 / 按量） |

**Windows 路径风险**：SQLite 数据库路径 `~/.cairn/cairn.db` 在 Windows 上展开为 `C:\Users\<name>\.cairn\cairn.db`。`better-sqlite3` 接受正斜杠，但若用户名包含空格或中文，Node 的路径处理需额外测试。W3 dogfood 启动时在 Windows 11 上做集成测试覆盖这个场景。

---

## 10. 与 v0.2 / v0.3 路线承接点

### 10.1 v0.2 触发条件

- 五条用户故事（US-D / US-R / US-A / US-I / US-S）在 release candidate 上端到端 dogfood 跑通（每条至少 3 次连续成功）
- §4.6 验收标准（PRODUCT.md）逐条通过
- Jess 类用户（subagent 重度用户）确认"消息可达"基础版（层 1 + 层 2）在真实工作流里可用
- 🚧 PoC-1~4 有明确结论

### 10.2 v0.2 关键扩展（架构层影响）

| 扩展 | 架构变化 |
|---|---|
| **桌面悬浮标 + Inspector panel UI** | Electron 实施，`packages/desktop-shell/` 包已落地（v0.1）。Inspector 展示 agents / conflicts / dispatches / lanes。技术细节见 PRODUCT.md §8.2。 |
| 路径 (b) Task tool wrapper | 新增 per-agent 适配层（强 CC 耦合），需独立包 |
| 反汇总（层 3）| `cairn.echo.diff` 新工具 + LLM 调用 + `echo/` key 读取逻辑 |
| daemon 独立进程（IPC 通信）| mcp-server 改为通过 IPC 连接 daemon，不再直接 import dist/ |
| SQLCipher（加密）| `better-sqlite3` 替换为 `better-sqlite3-sqlcipher` 或同等方案 |

### 10.3 v0.3 议题

- 路径 (c) fs hook（eBPF / ES framework / Volume Filter Driver）
- 跨机协作（多机 daemon 同步，需要 CRDTs 或中央协调）
- 多用户多实例（per-user daemon 隔离）
- agent 市场 / 模板

### 10.4 版本承接的不变量

以下在 v0.1 → v0.2 → v0.3 全程保持：
- migration 只前进，不回滚（checksum guard 拒绝已落地 migration 的任何修改）
- daemon 是 SQLite 的唯一写者（架构约束；CLI 紧急通道是唯一例外，见 DESIGN_STORAGE.md §6.3 OQ-4）
- `~/.cairn/` 是单机状态目录（v0.3 跨机时再调整）
- scratchpad key 命名规范（§6.4）保持向后兼容；新的 key 前缀必须在本文档 §6.4 表格里注册
- 8 个已落地工具的接口签名不做 breaking change（参数改动只加可选参数，不删已有参数）

### 10.5 v0.1 → v0.2 过渡的迁移事项

| 事项 | 具体操作 |
|---|---|
| stash SHA 迁出 `checkpoints.label` | P2 加 `backend_data TEXT` 列（migration 004）+ 解码脚本 |
| mcp-server 改为 IPC 连接 daemon | 新增 daemon 主入口（替换 `src/index.ts` 占位），mcp-server 改用 IPC client |
| scratchpad GC（gcExpiredScratch）| P3 补实现，daemon 启动时调用 |
| 冲突检测钩子植入（git hook 安装）| W3-W5 实施时，`cairn install` 命令自动写入 `.git/hooks/pre-commit` |

---

## 附：🚧 锚点索引

本索引供 `pre-impl-validation.md` cross-reference 使用。每个锚点在本文出现的节次 + 它等待的信息。

| 锚点 | 出现节 | 内容 | 回填触发条件 |
|---|---|---|---|
| ✓ PoC-1 | §6.1 §9（技术债） | MCP-call 边界 race window；SQLite 锁语义；并发 `checkpoint.create` 语义 | **已完成（2026-04-29）**：N=2/5/10 PASS，N=50 p99=449ms 记录为 v0.3 议题。详 `docs/superpowers/plans/2026-04-29-poc-1-results.md` |
| ✓ PoC-2 | §6.1 | hook 端到端延迟 + fail-open 行为 | **已完成（2026-04-29）**：5/5 场景全 PASS，large p99=122ms（预算 1000ms），fail-open 验证。详 `docs/superpowers/plans/2026-04-29-poc-2-results.md` |
| ✓ PoC-3 partial | §6.3 ADR-4 | Dispatch LLM 接口可移植性 + 默认 provider 选型 | **partial（2026-04-29）**：MiniMax-M2.7 整体均分 7.36/10 PASS，进 v0.1 推荐清单；Dispatch 走 LLM-driven (OpenAI-compat)；但 D 类 4.80 + 风险维度 5.70 触发应用层兜底要求 4 条（详 ADR-4 + `docs/superpowers/plans/2026-04-29-poc-3-results.md`）。第二 provider 接口可移植性命题待 user 拿到 key 后增量补跑 |
| 🚧 PoC-4 | §6.4 | CC Task tool 实际调用 `cairn.scratchpad.write` 的频率；v0.1 是否需要"强制 reload"兜底 | **personal-build 决策 36 已砍大样本 dogfood**；改为自用阶段感知。Prompt 模板已在 `docs/cairn-subagent-protocol.md` v1 固化（中英双语 + 反例 + 5 段必填），后续若发现 prompt 失效率高再加兜底机制 |
| 🚧 D-1 | ADR-6 | 非 MCP-aware agent（Cursor / Cline）接入路径调研 | 用户反馈 Cursor / Cline 接入需求的强度 |
| 🚧 D-2 | §4.4 §8.1 §6.1（通知机制） | daemon 资源占用 baseline（idle / busy 两种状态 RAM / CPU）；通知形式；索引 / VACUUM 策略 | dogfood 阶段 1 周实测数据 |
| 🚧 D-3 | ADR-4 | provider 间质量差距测量（MiniMax / DeepSeek / Qwen 等 vs Anthropic / OpenAI 在 Dispatch 任务上的均分对比） | PoC-3 多 provider 测试集结果 |
| 🚧 D-4 | §6.1 §8.2 | 冲突检测假阳性率（dogfood 实测数据）；误报导致用户关闭通知的阈值 | dogfood 阶段记录所有冲突通知 + 用户标记 IGNORED 的比例 |

---

## 附 2：关键常量 / 默认值一览

本节把散落在各节的数字集中列出，方便调整时单点修改。

| 常量 | 当前值 | 出处 / 理由 |
|---|---|---|
| SQLite `busy_timeout` | 5000 ms | DESIGN_STORAGE.md §2.1；允许短时并发写冲突等待 |
| `heartbeat_ttl` 默认值 | 60000 ms（1 分钟） | §4.3 `processes` 表；agent 1 分钟无心跳视为 DEAD |
| checkpoint PENDING 超时阈值 | 5 分钟 | DESIGN_STORAGE.md §8；超时则标 CORRUPTED |
| scratchpad 默认 TTL（选项 A） | 86400000 ms（24 小时） | DESIGN_STORAGE.md §15 OQ-5 |
| 大对象内联 / 外联阈值 | 128 KB | DESIGN_STORAGE.md §2.1；小于 128 KB 内联 JSON，大于走 blob 文件 |
| in-flight 冲突检测窗口 | 由应用层 SELECT + INSERT 构成（无显式 window）；SQLite WAL + busy_timeout=5000ms 提供并发隔离 | PoC-1（2026-04-29）已验证至 N=10 |
| Dispatch LLM 超时 | 30s（含 reasoning 思考时间） | PoC-3 partial（2026-04-29）：MiniMax-M2.7 平均 13.8s / max 25.2s；30s timeout 留足头空间 |
| Dispatch LLM temperature | 0.3 | PoC-3 partial：低温确保严格 JSON 输出；过高会增加 instruction-following 违规率 |
| Dispatch LLM max_tokens | 2048 | PoC-3 partial：reasoning model 含 think 块单条最大 ~800 completion tokens，2048 留 2.5× 头空间 |
