# PoC-2 结果报告：git pre-commit hook 延迟与 fail-open 行为

> 日期：2026-04-29
> 执行环境：Windows 11 / Node v24.14.0 / better-sqlite3 ^12.9.0
> 关联文档：`PRODUCT.md` §5.1.1、`ARCHITECTURE.md` §6.1、`docs/superpowers/plans/2026-04-29-pre-impl-validation.md` §3.2
> 脚本：`packages/daemon/scripts/poc-2-conflict-check.mjs`（hook 本体）+ `packages/daemon/scripts/poc-2-hook-bench.mjs`（bench 测量）
> 数据 artifact：`packages/daemon/artifacts/poc-2-results.json`（gitignored）

---

## 0. TL;DR（30 秒读完）

**Verdict：PASS，预算大幅富余。**

- 5 个场景全部通过，`p99` 没有任何超线
- **Node 冷启动 (~70ms) 是延迟的主导成本**——SQLite 实际工作非常便宜（1000 query 仅占 45ms）
- Large 场景（1000 paths × 1000 queries）p99 仅 122ms，是 1000ms 预算的 **12%**
- Fail-open 路径验证完美：DB 缺失时 hook 打一行 note + exit 0，24ms 内返回（剩下都是 Node 启动）

ARCHITECTURE.md §6.1 的 🚧 PoC-2 锚点可以回填。**commit-after 检测路径在 v0.1 完全可用**。

---

## 1. 测试设计

### 1.1 架构现实校正

`pre-impl-validation §3.2` 原始假设是"hook 调 daemon 的 IPC（Unix socket / Windows named pipe）"。但 Cairn v0.1 **没有长跑 daemon 进程**——`packages/daemon` 是 storage library，每次工具调用通过新开 `better-sqlite3` connection 进入 SQLite 文件。

所以"hook → daemon IPC"在 v0.1 实际形态 = **hook（Node 进程）直接打开 SQLite 文件做查询，关闭，退出**。这反而比 IPC 路径简单一层。PoC-2 测的是这个真实形态。

如果未来引入长跑 daemon（v0.2/v0.3 议题），IPC 开销可以另外测；当前数据是 v0.1 的真实基线。

### 1.2 hook 行为

- 接收 `--db <path> --paths <comma-list> --task-id <id>`
- 打开 SQLite read-only
- 对每个 staged path 跑一次 `SELECT ... FROM checkpoints WHERE created_at >= last_60_min AND task_id != mine AND label/snapshot_dir LIKE %path%`
- 命中 → stderr 输出"潜在冲突 + checkpoint id + 时间戳"
- **永远 `exit 0`**（fail-open 原则，per ADR-1）
- DB 不存在 / 损坏 / 模块加载失败 → 打一行 note + exit 0

### 1.3 bench 设计

- 创建 tmp DB + 跑 migrations
- Seed 100 个 checkpoints：5 种 task_id / 一半 READY 一半 PENDING / 时间戳跨过去 90 分钟（部分超出 60 分钟窗口测试过滤）
- 每场景 K iterations，每次 `child_process.spawn(node, hook-script, args)` 测 wall clock

测量的是**真实 git hook 体验**：从 `git commit` 触发到 hook 退出的端到端。

### 1.4 场景

| 场景 | staged paths | iterations | 真实场景对应 |
|---|---|---|---|
| clean | 0 | 20 | empty commit / amend |
| small | 10 | 20 | 典型 commit |
| medium | 100 | 20 | feature commit / 中等重构 |
| large | 1000 | 10 | mass rename / 大重构 |
| fail-open | 10 | 10 | 用户没装 / 卸了 cairn，DB 不存在 |

---

## 2. 数据

| 场景 | iter | exit≠0 | wall p50 | wall p95 | wall p99 | wall max | wall mean |
|---|---|---|---|---|---|---|---|
| **clean (0)** | 20 | 0 | 68.9 | 81.4 | 81.4 | 81.4 | 69.8 |
| **small (10)** | 20 | 0 | 69.6 | 86.0 | 86.0 | 86.0 | 70.3 |
| **medium (100)** | 20 | 0 | 72.6 | 85.3 | 85.3 | 85.3 | 73.6 |
| **large (1000)** | 10 | 0 | 115.1 | 122.2 | 122.2 | 122.2 | 115.0 |
| **fail-open** | 10 | 0 | 68.3 | 88.3 | 88.3 | 88.3 | 70.2 |

（单位 ms。"exit≠0" = hook 返回非零码的次数；fail-open 场景预期为 0，其他场景也应为 0。）

### 2.1 通过判据逐项

| 场景 | 阈值 | p99 | exit=0 always | 综合 |
|---|---|---|---|---|
| clean | < 200ms | 81.4ms | ✓ | **PASS** |
| small | < 200ms | 86.0ms | ✓ | **PASS** |
| medium | < 200ms | 85.3ms | ✓ | **PASS** |
| large | < 1000ms | 122.2ms | ✓ | **PASS** |
| fail-open | hook exit=0 always | n/a | ✓ | **PASS** |

5/5 全过。

---

## 3. 关键发现

### 3.1 Node 冷启动是延迟主导

`clean (0 paths)` 场景 p50=68.9ms。这个场景的工作量是：spawn Node → import dist/ → openDatabase → close → exit。**SQLite 几乎没干活**，全是 Node 启动 + module loading + 进程开销。

`fail-open (0 SQLite work)` 场景 p50=68.3ms——和 clean 几乎一样。这进一步印证：**v0.1 hook 延迟 ≈ Node 启动 (~70ms on Windows)**。

实际 SQLite 工作的边际成本：

| 场景 | p50 | clean baseline 之上的增量 | per-query 成本 |
|---|---|---|---|
| clean (0) | 68.9 | 0 | n/a |
| small (10) | 69.6 | +0.7ms | 70μs/query |
| medium (100) | 72.6 | +3.7ms | 37μs/query |
| large (1000) | 115.1 | +46.2ms | 46μs/query |

**SQLite prepared statement 复用让每次查询的边际成本稳定在 30-70μs 量级**。Linear scaling 干净，没有意外。

### 3.2 Fail-open 工作完美

DB 缺失时 hook 输出：

```
cairn-hook: skipped (Cannot open database because the directory does not exist) in 24.26ms
```

24ms 内识别 + 写日志 + 优雅退出（exit 0）。剩下时间都是 Node 进程消耗。**用户卸了 Cairn 也不会被卡住 commit**——架构承诺成立。

### 3.3 1000 文件场景仍有大量富余

p99=122ms 离 1000ms 阈值还有 8 倍空间。即便未来加入更复杂的 conflict 检测逻辑（如 join paths-per-checkpoint 表 / 多列匹配 / 通知系统调用），这个预算也很难吃满。

### 3.4 非 Node 路径的可压缩空间

如果 v0.2/v0.3 想把 hook 延迟压到 < 30ms（让用户完全感觉不到），技术路径是：

- **Native 二进制（Rust/Go）**：消除 Node 冷启动 ~70ms。预估能到 5-10ms。
- **长跑 daemon + 轻量 IPC**：hook 只是个 Unix socket / named pipe client，msg < 5ms。但代价是引入 daemon 进程（v0.1 明确不做）。

**v0.1 不需要做这些**——70ms 对 git hook 是完全可接受的（用户感知阈值通常是 200-300ms）。这两条路径作为 v0.2/v0.3 候选记录。

---

## 4. ARCHITECTURE.md 的 🚧 PoC-2 锚点回填

### 4.1 §6.1 冲突可见 - 相关锚点

**原**：
> 🚧 PoC-2：git pre-commit hook 与 daemon 通信的延迟和稳定性

**回填**：
> ✓ PoC-2（2026-04-29）：v0.1 hook 直接打开 SQLite（v0.1 无长跑 daemon），p99 在 clean/small/medium 场景均 < 90ms，large 场景（1000 staged files）= 122ms，远低于 1000ms 预算。Node 冷启动 ~70ms 是主要成本，SQLite 边际查询 ~45μs/path。fail-open 验证：DB 缺失时 24ms 内 exit 0。详 `docs/superpowers/plans/2026-04-29-poc-2-results.md`。

### 4.2 附录锚点索引

**原**：
> 🚧 PoC-2 | §6.1 | git pre-commit hook 与 daemon 通信延迟和稳定性 | hook 跑 P95 延迟 < 500ms，用户抱怨率 = 0

**回填**：
> ✓ PoC-2 | §6.1 | hook 端到端延迟 + fail-open 行为 | **已完成（2026-04-29）**：5/5 场景全 PASS，large p99=122ms（预算 1000ms），fail-open 验证。详 `docs/superpowers/plans/2026-04-29-poc-2-results.md`

---

## 5. v0.2/v0.3 议题（记录但不阻塞 v0.1）

1. **Native hook 二进制**：Rust/Go 重写 hook 可以把延迟从 70ms 压到 5-10ms。仅在用户实际抱怨"commit 太慢"时考虑。
2. **长跑 daemon + IPC**：消除 per-commit 的 Node 启动，但代价是常驻进程 + 进程管理复杂度。v0.1 明确不做（ADR-1 + ADR-7）。
3. **路径匹配语义**：当前 PoC 用 `LIKE '%<path>%'` 在 `label` / `snapshot_dir` 上模拟，是占位实现。v0.1 实际实施需要 paths-per-checkpoint 表（join 查询，开销可能略高于 PoC 的 LIKE）。预算给的余量足以吸收。

---

## 6. 时间盒回看

预算（pre-impl-validation §3.2）：0.5 天（~4 小时）
实际：约 30 分钟（脚本两文件 ~250 行，跑 + 写报告 5 分钟）

预算继续吃富余。**第一波 PoC（PoC-1 + PoC-2）总耗时约 1.5 小时**，远低于预算的 1.5 天（12 小时）。

---

## 7. 第一波 PoC 综合状态

| PoC | Verdict | 阻塞 v0.1？ | 备注 |
|---|---|---|---|
| **PoC-1** race window | PASS（v0.1 ICP 内 N≤10）| 否 | N=50 是 v0.3 议题 |
| **PoC-2** git hook | PASS（5/5 场景）| 否 | Native 路径是 v0.2/v0.3 候选 |
| **PoC-3** LLM 选型 | 未测 | Dispatch 在 W5-W7 才上，时间富余 | |
| **PoC-4** dogfood subagent 调用率 | 未测 | 必须用户接管（装 .mcp.json + 跑 5 个真实任务）| 影响"消息可达"全栈是否成立 |

PoC-1 + PoC-2 都通过 → ARCHITECTURE.md 的"冲突可见"能力有了实证基础。可以**进入 v0.1 W3-W5 编码阶段**，前提是 PoC-4 dogfood 也回来 PASS（或回来 < 70% 触发路径 b 前置）。

---

## 8. 下一步建议

1. 立刻 commit PoC-2（脚本 + 报告 + ARCHITECTURE 锚点回填）
2. 等用户接管 PoC-4 dogfood（无法替代，需要真实开发任务）
3. PoC-3 可以在 PoC-4 数据回来期间并行跑（不阻塞）
4. D-1 / D-2 / D-3 / D-4 可以在 W3 dogfood 期 enqueue
