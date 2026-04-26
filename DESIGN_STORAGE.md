# Cairn v0.1 持久层设计（DESIGN_STORAGE.md）

> **状态**：设计草案 · 2026-04-23 · 等待拍板
> **范围**：v0.1 MCP 楔（前 3 周）至桌面主体（W4–W13）共享的持久层
> **对标**：`PRODUCT.md` §8.2（进程模型）、§8.3（Checkpoint/Rewind 边界）、§11.2（技术风险：daemon 稳定性 / 多 sub-agent 资源竞争）、§16（开放问题）
> **非目标**：
> - 不覆盖模型端对话历史 / 记忆快照（推迟 v0.2，见 PRODUCT.md §8.3）
> - 不引入迁移框架（Knex / Prisma / Sequelize），自写 ~50 行 runner
> - 本文档只约束数据层；daemon ↔ ui ↔ cli 的 IPC 契约另议

---

## 1. 为什么现在要做

### 1.1 PoC 现状（仓库中的既有证据）

```
cairn-poc/compensator/<场景>/lanes/lane-<ts>-<rand>.json
```

- 场景目录共 8 个：`01-github-issue` … `08-vercel-deploy`
- 每条 lane 是一份完整 JSON：`{laneId, endpoint, target, createdAt, compensator, forwardRequest, forwardResponse, beforeImage}`
- 写入方式：`fs.writeFileSync` 同步覆写
- 没有 `state` 字段、没有 schema version、没有跨场景索引
- `better-sqlite3` 在 PoC 里**只**被 mock server 拿来扮演 Postgres（见 `03-postgres-update`），不是 cairn 自己的持久层

### 1.2 三个已知痛点

| 痛点 | 触发场景 | 本设计如何解决 |
|---|---|---|
| 无法跨场景查"这个 sub-agent 的所有 lane" | 桌面 UI 的任务树视图 | `lanes.task_id` / `sub_agent_id` 索引 |
| 回滚中途崩溃后无法恢复进度 | daemon OOM 重启 | `lanes.state` 状态机 + `compensations` 独立表（含 attempt、last_error） |
| checkpoint 回滚时文件和 DB 可能不一致 | 突然断电 | Checkpoint 两阶段提交（PENDING → READY），崩溃扫描 |

---

## 2. 介质与目录布局

### 2.1 介质

- **主库**：SQLite @ `~/.cairn/cairn.db`
  - `PRAGMA journal_mode=WAL`
  - `PRAGMA busy_timeout=5000`（毫秒）
  - `PRAGMA foreign_keys=ON`
  - `PRAGMA synchronous=NORMAL`（WAL 模式下足够持久，写入代价低）
- **大对象**：`~/.cairn/snapshots/{ckpt_id}/` 或 `~/.cairn/blobs/{sha256[:2]}/{sha256}`
  - 阈值 **128 KB**：`<` 阈值入 DB JSON 列；`>=` 阈值走文件，DB 只存路径

### 2.2 目录

```
~/.cairn/
├── cairn.db                 # 主库（WAL 模式下多一个 .db-wal + .db-shm）
├── snapshots/
│   └── {ckpt_id}/           # checkpoint 文件快照（见 §8）
├── blobs/
│   └── {ab}/{sha256}        # ops.before_image / compensations.payload 的大对象
└── logs/
    └── daemon-{date}.log    # 非本文档范围
```

### 2.3 为什么选 SQLite 而不是 Postgres / DuckDB / 纯文件

- **本地优先硬要求**（PRODUCT.md §6 产品原则）：用户电脑离线也要能跑
- **单写者**架构下 SQLite + WAL 足以应对桌面宠物级别的并发
- Postgres 需要另开 server 进程，违反"桌面应用一键装"的交付承诺
- 纯文件 = PoC 现状 = 已被证伪

---

## 3. 数据模型总览

### 3.1 ER 关系

```
tasks ──< sub_agents ──< lanes ──< ops ──< compensations
  │                       │         │
  │                       └─►checkpoints（lanes.checkpoint_id FK）
  │
  └──< scratchpad（task_id 可空）
```

### 3.2 表清单（7 张核心 + 1 迁移）

| # | 表 | Phase | 作用 | 写入者 |
|---|---|---|---|---|
| 0 | `schema_migrations` | **P1** | 版本 + checksum | MigrationRunner（启动期） |
| 1 | `lanes` | **P1** | 外部调用 batch | daemon |
| 2 | `ops` | **P1** | 单次 HTTP 调用 + before_image | daemon |
| 3 | `compensations` | **P1** | 补偿 step（独立表，不内嵌 ops） | daemon |
| 4 | `checkpoints` | P2 | 文件 + git 快照 | daemon |
| 5 | `tasks` | P3 | 顶层任务 | daemon（桌面阶段）/ daemon-lite（MCP 楔期） |
| 6 | `sub_agents` | P3 | sub-agent 实例 | daemon |
| 7 | `scratchpad` | P3 | MCP 楔 KV | daemon |

**Phase 1（本 sprint 范围）** = 能让 PoC 的 8 个场景切到 SQLite 跑通 + 支持 lane 级别的崩溃恢复。其余推后。

---

## 4. 完整 DDL

> **执行顺序**：按下列顺序写入 `migrations/001_init.sql`。SQLite 在 `foreign_keys=ON` 下对 FK 检查发生在 DML 时，CREATE TABLE 时允许前向引用，但人读起来按依赖顺序更清晰。

### 4.1 迁移表

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL  -- unix ms
);
```

### 4.2 tasks（P3）

```sql
CREATE TABLE tasks (
  id              TEXT    PRIMARY KEY,            -- ULID
  title           TEXT    NOT NULL,
  description     TEXT,
  description_vec BLOB,                            -- 预留 sqlite-vec，v0.1 不启用
  status          TEXT    NOT NULL CHECK (status IN (
                     'PENDING','RUNNING','PAUSED','DONE','FAILED','CANCELLED'
                  )),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status     ON tasks(status);
CREATE INDEX idx_tasks_updated_at ON tasks(updated_at);
```

### 4.3 sub_agents（P3）

```sql
CREATE TABLE sub_agents (
  id         TEXT    PRIMARY KEY,
  task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  role       TEXT,
  status     TEXT    NOT NULL CHECK (status IN (
               'IDLE','RUNNING','PAUSED','DONE','FAILED'
             )),
  started_at INTEGER,
  ended_at   INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sub_agents_task_id ON sub_agents(task_id);
```

### 4.4 checkpoints（P2）

```sql
CREATE TABLE checkpoints (
  id              TEXT    PRIMARY KEY,
  task_id         TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  label           TEXT,
  git_head        TEXT,                            -- 可空：未落 git 的场景
  snapshot_dir    TEXT    NOT NULL,                -- ~/.cairn/snapshots/{id}/
  snapshot_status TEXT    NOT NULL CHECK (snapshot_status IN (
                     'PENDING','READY','CORRUPTED'
                  )),
  size_bytes      INTEGER,
  created_at      INTEGER NOT NULL,
  ready_at        INTEGER                           -- NULL 直到状态切 READY
);
CREATE INDEX idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX idx_checkpoints_status  ON checkpoints(snapshot_status);
```

### 4.5 lanes（P1 · 核心）

```sql
CREATE TABLE lanes (
  id               TEXT    PRIMARY KEY,            -- 沿用 PoC 的 lane-<ts>-<rand>
  task_id          TEXT    REFERENCES tasks(id)      ON DELETE SET NULL,
  sub_agent_id     TEXT    REFERENCES sub_agents(id) ON DELETE SET NULL,
  checkpoint_id    TEXT    REFERENCES checkpoints(id),
  endpoint         TEXT    NOT NULL,               -- 'github.issue.patch'
  scenario         TEXT,                            -- '01-github-issue'（PoC 兼容）
  state            TEXT    NOT NULL CHECK (state IN (
                      'RECORDED','REVERTING','REVERTED',
                      'PARTIAL_REVERT','HELD_FOR_HUMAN','FAILED_RETRYABLE'
                   )),
  lock_holder      TEXT,                            -- 'daemon@<pid>@<host>'
  lock_expires_at  INTEGER,                         -- unix ms，NULL 未持锁
  error            TEXT,                            -- 最近一次错误摘要
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_lanes_task_id       ON lanes(task_id);
CREATE INDEX idx_lanes_sub_agent_id  ON lanes(sub_agent_id);
CREATE INDEX idx_lanes_state         ON lanes(state);
CREATE INDEX idx_lanes_checkpoint_id ON lanes(checkpoint_id);
CREATE INDEX idx_lanes_endpoint      ON lanes(endpoint);
```

### 4.6 ops（P1 · 核心）

```sql
CREATE TABLE ops (
  id                   TEXT    PRIMARY KEY,        -- ULID
  lane_id              TEXT    NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL,           -- lane 内自增顺序（0..n）
  method               TEXT    NOT NULL,           -- 'PATCH' / 'POST' / ...
  url                  TEXT    NOT NULL,
  target               TEXT,                       -- 业务标识：'repo:octo/demo#1'
  request_body_json    TEXT,                       -- <128KB 内联
  request_body_path    TEXT,                       -- >=128KB 外联 blobs/
  response_status      INTEGER,
  response_body_json   TEXT,
  response_body_path   TEXT,
  before_image_json    TEXT,                       -- <128KB 内联
  before_image_path    TEXT,                       -- >=128KB 外联
  classification       TEXT    NOT NULL CHECK (classification IN (
                         'SAFE_REVERT',      -- ① 幂等反向调用可直接撤回
                         'SEMANTIC_REVERT',  -- ② 需语义补偿（refund vs charge）
                         'MARKED_REVERT',    -- ③ 只能标注作废不能真删
                         'NO_REVERT'         -- ④ 不可撤回，通知人
                       )),
  created_at           INTEGER NOT NULL,
  UNIQUE(lane_id, seq)
);
CREATE INDEX idx_ops_lane_id        ON ops(lane_id);
CREATE INDEX idx_ops_classification ON ops(classification);
```

**内联/外联规则**：插入时对 `request_body`、`response_body`、`before_image` 分别判断序列化后字节数；一个字段要么 `*_json` 非空，要么 `*_path` 非空，不会同时非空。仓储层封装一个 `writeBlob(obj): {json?, path?}` 工具。

### 4.7 compensations（P1 · 核心）

```sql
CREATE TABLE compensations (
  id              TEXT    PRIMARY KEY,
  op_id           TEXT    NOT NULL REFERENCES ops(id) ON DELETE CASCADE,
  strategy        TEXT    NOT NULL,                -- 'reverse_http' / 'soft_delete' / 'notify_human'
  payload_json    TEXT,                             -- <128KB 内联
  payload_path    TEXT,                             -- >=128KB 外联
  status          TEXT    NOT NULL CHECK (status IN (
                     'PENDING','IN_PROGRESS','SUCCESS','FAILED','SKIPPED'
                  )),
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_attempt_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_compensations_op_id  ON compensations(op_id);
CREATE INDEX idx_compensations_status ON compensations(status);
```

**为什么独立表而不是 ops 的列**：一个 op 可能对应多次补偿尝试（重试）或多步补偿（组合策略），把 attempt / last_error / status 塞进 ops 会把 ops 变成可变状态表，破坏"ops 是 append-only 事实表"的心智模型。

### 4.8 scratchpad（P3）

```sql
CREATE TABLE scratchpad (
  key        TEXT    PRIMARY KEY,                  -- namespaced: 'mcp:<agent>:<name>'
  value_json TEXT,
  value_path TEXT,
  task_id    TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  expires_at INTEGER,                               -- unix ms，NULL 永不过期
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scratchpad_task_id    ON scratchpad(task_id);
CREATE INDEX idx_scratchpad_expires_at ON scratchpad(expires_at);
```

---

## 5. 状态机：`lanes.state`

```
             ┌─────────────────────────────────────────────┐
             ▼                                             │
   ┌──────────────┐  startRevert   ┌──────────────┐       │
   │   RECORDED   │ ─────────────► │  REVERTING   │       │
   └──────────────┘                └──────┬───────┘       │
         │                                │               │
         │                  ┌─────────────┼──────────────┐│
         │                  ▼             ▼              ▼│
         │          ┌───────────┐ ┌──────────────┐ ┌─────────────┐
         │          │ REVERTED  │ │PARTIAL_REVERT│ │FAILED_RETRY │
         │          └───────────┘ └──────────────┘ └──────┬──────┘
         │                                                │
         │ holdForHuman                                   │ retry
         ▼                                                │
   ┌─────────────────┐                                    │
   │ HELD_FOR_HUMAN  │ ◄──────── escalate ────────────────┘
   └─────────────────┘
```

| 状态 | 语义 | 允许的前驱 |
|---|---|---|
| `RECORDED` | 调用已完成并记录 before_image，未触发补偿 | 初始态 |
| `REVERTING` | 补偿正在进行中（有 lock_holder） | `RECORDED`, `FAILED_RETRYABLE` |
| `REVERTED` | 所有 ops 的 compensations 全部 `SUCCESS` 或 `SKIPPED(NO_REVERT)` | `REVERTING` |
| `PARTIAL_REVERT` | 部分 ops 成功补偿，剩余 NO_REVERT 已通知人 | `REVERTING` |
| `HELD_FOR_HUMAN` | 语义补偿需要人类确认，暂停 | `RECORDED`, `REVERTING`, `FAILED_RETRYABLE` |
| `FAILED_RETRYABLE` | 补偿失败但可重试（网络 5xx 等） | `REVERTING` |

**不变量**：
- `state ∈ {REVERTING}` ⇔ `lock_holder IS NOT NULL AND lock_expires_at > now()`
- `state = REVERTED` ⇒ 该 lane 的所有 `compensations.status ∈ {SUCCESS, SKIPPED}`
- `state = PARTIAL_REVERT` ⇒ 至少一个 `compensations.status = SKIPPED AND strategy='notify_human'`

---

## 6. 并发模型（三进程读写矩阵）

对标 PRODUCT.md §8.2（daemon / ui / cli 三进程）。

| 进程 | 读 | 写 | 怎么连 |
|---|---|---|---|
| **daemon** | ✅ | ✅（唯一常驻写者） | `better-sqlite3` 直连，常开 |
| **ui**（Tauri） | ✅ | ❌ | 直连 + `PRAGMA query_only=ON`；用完即关 |
| **cli** | ✅ | ⚠️ 见开放问题 #4 | 二选一，未决 |

### 6.1 daemon 写路径

- 所有业务写操作包裹在 `db.transaction(() => { ... })` 中
- **事务内禁止**：HTTP 调用、文件 I/O、`await` 任何非 DB promise
- 写 lane 时持有的"lock"是 DB 行级概念（`lock_holder` + `lock_expires_at`），不是 OS 锁

### 6.2 ui 只读

```ts
const db = new Database(path, { readonly: true });
db.pragma('query_only = ON');
```

如需实时更新，ui 通过 IPC 订阅 daemon 的事件；DB 只做"查历史"用途。

### 6.3 cli 写操作（开放问题 #4）

- **方案 A**：cli 直连 DB，写前 `BEGIN EXCLUSIVE`，依赖 `busy_timeout=5000` 兜底
- **方案 B**：cli 全走 daemon IPC，daemon 没起来时拒绝写

本文档不预选，留待拍板。

---

## 7. 事务边界（硬规则）

1. **禁止**在 `db.transaction()` 回调里做：`fetch`、`fs.promises.*`、`child_process`、任何异步等待
2. 大对象写文件 → 再写 DB：**失败时 blob 可能泄漏**，用启动期 GC 清理孤儿 blob
3. 补偿执行是两段式：
   ```
   db.tx: compensations.status = IN_PROGRESS, attempt++
   [出事务] 执行 HTTP / 文件反向操作
   db.tx: compensations.status = SUCCESS / FAILED, last_error = ?
   ```
4. 补偿的幂等性由 strategy 实现层保证（如 `reverse_http` 通过 `If-Match: ETag`），持久层不兜底

---

## 8. Checkpoint 两阶段提交

```
① db.tx:  INSERT INTO checkpoints (..., snapshot_status='PENDING')
② 文件:   copy / git stash / rsync → snapshots/{ckpt_id}/
③ db.tx:  UPDATE checkpoints SET snapshot_status='READY', ready_at=? WHERE id=?
```

**崩溃恢复**：daemon 启动时扫描 `snapshot_status='PENDING' AND created_at < now()-5min` 的记录 → 标 `CORRUPTED`，顺带清理残留目录。

**快照机制选型见开放问题 #2。**

---

## 9. Agent 检索 SQL 金句

> 下列是桌面 UI 和 daemon 自省最常用的查询，作为仓储层 API 的设计依据。

```sql
-- 1) 某 task 下所有未回滚的 lane
SELECT * FROM lanes
WHERE task_id = ? AND state IN ('RECORDED','FAILED_RETRYABLE','HELD_FOR_HUMAN')
ORDER BY created_at DESC;

-- 2) 需要人工介入的挂起 lane（宠物红点）
SELECT l.*, COUNT(c.id) AS pending_comps
FROM lanes l
LEFT JOIN ops o ON o.lane_id = l.id
LEFT JOIN compensations c ON c.op_id = o.id AND c.status IN ('PENDING','FAILED')
WHERE l.state = 'HELD_FOR_HUMAN'
GROUP BY l.id;

-- 3) 某 lane 的完整回放（按 seq 拼接 ops + 最新一次补偿尝试）
SELECT o.seq, o.method, o.url, o.classification,
       c.strategy, c.status, c.attempt, c.last_error
FROM ops o
LEFT JOIN compensations c ON c.op_id = o.id
WHERE o.lane_id = ?
ORDER BY o.seq ASC;

-- 4) 孤儿锁（daemon 崩了没释放）
SELECT * FROM lanes
WHERE state = 'REVERTING'
  AND lock_expires_at < strftime('%s','now')*1000;

-- 5) checkpoint 可挂载列表（UI 时间线）
SELECT * FROM checkpoints
WHERE task_id = ? AND snapshot_status = 'READY'
ORDER BY created_at DESC LIMIT 50;

-- 6) classification 分布（用于产品指标：SAFE_REVERT 占比多少）
SELECT classification, COUNT(*) FROM ops
WHERE lane_id IN (SELECT id FROM lanes WHERE task_id = ?)
GROUP BY classification;
```

---

## 10. 仓储层 API（v0.1 P1 最小集）

> 位置：`packages/daemon/src/storage/`

```ts
// repositories/lanes.ts
createLane(input: NewLane): LaneRow
getLaneById(id: string): LaneRow | null
listLanesByTask(taskId: string | null, state?: LaneState): LaneRow[]
acquireLaneLock(id: string, holder: string, ttlMs: number): boolean
releaseLaneLock(id: string, holder: string): void
transitionLaneState(id: string, from: LaneState, to: LaneState): boolean  // CAS

// repositories/ops.ts
appendOp(laneId: string, input: NewOp): OpRow   // 自动分配 seq
listOpsByLane(laneId: string): OpRow[]

// repositories/compensations.ts
createCompensation(opId: string, input: NewComp): CompRow
markCompensationInProgress(id: string): void
markCompensationResult(id: string, ok: boolean, err?: string): void
listPendingCompensationsByLane(laneId: string): CompRow[]

// migrations/runner.ts
runMigrations(db: Database): void
```

所有函数必须可接入临时 SQLite 文件的单元测试（见 §12）。

---

## 11. 迁移策略（自写 ~50 行 Runner）

```ts
// packages/daemon/src/storage/migrations/runner.ts
interface Migration {
  version: number;        // 001, 002, ...
  name: string;           // 'init'
  up: (db: Database) => void;   // 同步，不做 I/O 外的事
}

function runMigrations(db: Database, migrations: Migration[]) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (...)`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  for (const m of migrations.sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) {
      // 可选：校验 checksum
      continue;
    }
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(
        m.version, m.name, sha256(m.up.toString()), Date.now()
      );
    })();
  }
}
```

- 只前进、不回滚（`down` 不实现）
- `checksum` 用函数源码 sha256；历史迁移被改动则启动期报错
- 迁移文件以 TS 模块形式注册，不读文件系统

---

## 12. 测试策略（TDD 强制）

- 每个仓储函数 → 单元测试，使用 `better-sqlite3` 对临时文件（`fs.mkdtempSync` + afterEach 清理）
- **不 mock** DB，不用 `:memory:` 以外的替身；`:memory:` 可用于纯逻辑测试，文件模式测试 WAL 行为
- 状态机 CAS（`transitionLaneState`）必须有并发测试：两个事务尝试从同一 from → 不同 to，断言其中一个失败
- 迁移 runner 必须有幂等测试：跑两遍，第二遍 no-op
- Checkpoint 两阶段提交要有"PENDING 残留 → 重启 → 标 CORRUPTED"的集成测试

---

## 13. 与 PoC 的映射（向后兼容路径）

| PoC JSON 字段 | 新表字段 |
|---|---|
| `laneId` | `lanes.id` |
| `endpoint` | `lanes.endpoint` |
| `target` | `ops.target` |
| `createdAt` | `lanes.created_at` |
| `compensator` | `compensations.payload_json`（strategy='reverse_http'） |
| `forwardRequest` | `ops.request_body_*` |
| `forwardResponse` | `ops.response_*` |
| `beforeImage` | `ops.before_image_*` |
| *（隐含）* "场景目录名" | `lanes.scenario` |

**迁移脚本**（可选，P1 不强求）：遍历 `cairn-poc/compensator/*/lanes/*.json` → 批量 insert，场景目录名写入 `lanes.scenario`、`task_id=NULL`（见开放问题 #1）。

---

## 14. Embedding 预留

- `tasks.description_vec BLOB` 保留列，v0.1 不写入
- 未来挂 [sqlite-vec](https://github.com/asg017/sqlite-vec)：`SELECT ... FROM tasks JOIN vec_index ON vec_index.rowid = tasks.rowid WHERE vec_distance_L2(description_vec, ?) < 0.5`
- 不引入 vec 依赖的前提：`description_vec` 为 NULL 的行在任何查询里不会被排除（LEFT JOIN）

---

## 15. 开放问题（待拍板 · 不收敛本文档）

### OQ-1｜MCP 楔期 NULL task_id 数据如何归并？

**现状**：v0.1 前 3 周只有 MCP server，外部 Agent 调 `cairn.record_lane`，没有 task 概念 → `lanes.task_id = NULL`。

**选项**：
- A. W4 切桌面时，所有 NULL task_id 的 lane 聚合成一个 "pre-desktop" 迁移任务
- B. 按 `scenario` / `endpoint` 聚类，每类一个 task
- C. 永久保留 NULL，UI 在"未归属"分区展示

**推荐**：C（保留 NULL）+ 提供"选中一批 lane → 新建 task → UPDATE" 的 UI 操作。

### OQ-2｜Checkpoint 快照用什么机制？

**选项**：
- A. **COW**（macOS APFS clonefile / Linux reflink / Windows 不支持）
- B. **git stash**（复用 .git，但 stash 栈是单链路，多 checkpoint 难管）
- C. **rsync --link-dest**（跨平台，慢但稳）

**推荐**：C 为 v0.1 基线；A 作为 macOS / APFS 的快速路径。git stash 只用于无 untracked 文件的降级场景（对应 PRODUCT.md §11.2 的"最坏情况降级"）。

### OQ-3｜状态命名：`REVERTED` vs `SUCCESS`、`PARTIAL_REVERT` vs `PARTIAL_UNDO`？

**现状**：PoC 里两套命名都出现过。本设计默认用 **REVERTED / PARTIAL_REVERT**（贴近"补偿"语义而非"撤销"UI 词）。

**待拍板**：最终以哪套为准，统一整个代码库（包括 UI 文案）。

### OQ-4｜cli 写操作路径？

- A. cli 直连 DB + `BEGIN EXCLUSIVE` + `busy_timeout=5000`
- B. cli 全走 daemon IPC，daemon 未起则拒绝

**权衡**：A 更简单但破坏"daemon 是唯一写者"的不变量；B 强制 daemon 常驻但 cli 在 daemon 宕机时丧失救回能力（和 cli 的存在理由矛盾，见 PRODUCT.md §8.1 "用户真的卡住时能用命令行救回来"）。

**倾向**：A（cli 作为紧急通道必须能独立写），接受 lock_holder 短时冲突，由 CAS 状态机保护。

### OQ-5｜scratchpad 的 TTL / GC 策略？

**选项**：
- A. 写入时必须指定 `expires_at`，daemon 启动扫描过期项删除
- B. LRU：总容量封顶（N 条或 N MB），超限按 `updated_at` 淘汰
- C. 不 GC，用户手动清

**倾向**：A + 缺省 TTL 24h；短命 MCP 会话足够用。

---

## 16. 本设计**不**解决什么

- 对话历史 / 模型记忆快照（v0.2）
- 多机同步 / 云备份（v0.2+）
- DB 加密（v0.2，考虑 SQLCipher）
- 分析型查询性能优化（vec、FTS5 索引推迟）
- 企业审计日志格式（范围外）

---

## 17. 落地顺序（供 writing-plans 消化）

```
Phase 1（本 sprint · 目标：PoC 8 场景切 SQLite）
  ├─ migrations 表 + MigrationRunner
  ├─ lanes / ops / compensations DDL
  ├─ 仓储层 API（§10 列出的函数）
  └─ PoC 数据迁移脚本（可选）

Phase 2（桌面启动前）
  └─ checkpoints 两阶段提交 + 崩溃扫描

Phase 3（桌面主体 W4–W6）
  ├─ tasks / sub_agents
  └─ scratchpad + TTL GC

Phase 4（按需）
  └─ description_vec 接入 sqlite-vec
```

---

**拍板后下一步**：把 §17 喂给 `/superpowers:writing-plans`，产出每个 phase 的 TDD 任务序列。

---

## 17.1 W1 楔期 MVP 路径偏离记录

> **写入日期**：2026-04-26（W1 末尾）
> **背景**：W1 采纳路径 B（参考 `docs/superpowers/plans/2026-04-23-wedge-w1.md`），从 P2/P3 抽出最小子集落地以赶上 PRODUCT.md §9.1 的 MCP 楔 W1-W3 deadline。

### 已提前落地的 schema（与 P2/P3 计划一致，**勿重写**）

| Migration | 原计划归属 | W1 实际编号 | 状态 |
|---|---|---|---|
| `001-init.ts` | P1 | 001 | ✅ 已落（lanes/ops/compensations） |
| `002-scratchpad.ts` | P3 原 005 | **002** | ✅ 已落（schema 与 P3 §4.8 完全一致） |
| `003-checkpoints.ts` | P2 原 002 | **003** | ✅ 已落（schema 与 §4.4 完全一致） |

### 已提前落地的代码（裁剪过逻辑量，但接口稳定）

- `src/storage/repositories/scratchpad.ts` — 仅 `putScratch / getScratch / listAllScratch / deleteScratch` + blob 分流。**未实现**：`gcExpiredScratch`、namespace 解析、`listScratchByTask`、TTL 默认值。这些 P3 加，**不动表**。
- `src/storage/snapshots/git-stash.ts` — git-stash backend 全实现（capture / restore / affectedFiles）。**未实现**：rsync、APFS clonefile（P2 补）。
- `src/storage/repositories/checkpoints.ts` — 仅 `createPendingCheckpoint / markCheckpointReady / getCheckpointById / listCheckpoints`。**未实现**：CORRUPTED 5 分钟扫描、`captureCheckpoint` 两阶段提交 helper（W1 由 MCP server 工具层组合实现）、snapshot 目录 GC。这些 P2 加，**不动表**。

### 已知 W1 技术债（P2/P3 落地时需要清理）

1. **stash SHA 暂存于 `checkpoints.label` 字段**：W1 用 `<userLabel>::stash:<sha>` 编码，因为 schema 没有给 backend 留专门的列。P2 加 `backend_data TEXT` 列后，写一个 migration 把 label 解码迁出去。
2. **`packages/mcp-server` 直接 import daemon `dist/`**（而不是源码或 package exports map）。daemon `tsconfig.json` 启用了 `declaration: true` 以支持这种用法。等我们引入 monorepo 工具（pnpm workspaces / nx）时统一治理。
3. **`packages/daemon/src/index.ts` 是空 placeholder**（来自 P1 Task 0 — tsc 需要至少一个源文件）。等真正的 daemon 主入口实现时覆盖。

### P2/P3 真正执行时的对照修正

- P2 计划中 "Migration 002 checkpoints" → **跳过**（已是 W1 migration 003）
- P2 计划的 snapshot backend 三选一 → **只做 rsync 和 APFS**（git-stash 已落）
- P2 计划的 CORRUPTED scan → **保留**（W1 跳过的，必须 P2 补上）
- P3 计划中 "Migration 005 scratchpad" → **跳过**（已是 W1 migration 002）
- P3 计划的 scratchpad 仓储 → **只补 gcExpired / listByTask / namespace**（基础 CRUD 已落）

### 不变量（保证 W1 落地不堵 P2/P3）

- W1 没有引入任何 P2/P3 不知道的新 schema 列或新表
- W1 写入的所有 SQL 在 P2/P3 后仍是合法的（CHECK 约束、FK、INDEX 都对得上）
- W1 的 MCP 楔本身（`packages/mcp-server`）不在 P2/P3 范围内，独立演进
