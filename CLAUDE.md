# Cairn — Claude 项目说明

> 这个文件给未来的 Claude 会话用。仓库特定的"踩过的坑"和"非显然的本地约定"放这里，避免每次重新诊断。

## Cairn 是什么（定位先看，再看下面）

Cairn 是**主机级多 agent 协作内核**（host-level multi-agent coordination kernel）。它**不是** agent / 不写代码 / 不拆任务 / 不替 agent reasoning / 不是 task daemon / 不是 agent framework / 不是 Linear-Asana 类项目管理。它坐在 Claude Code / Cursor / subagents / Aider / Cline 这些 agent 工具**之下**，维护这台机器上所有 agent / subagent work 的共享协作状态。

**v0.1 管理的 8 类 host-level state objects**：`processes`（runner 在线状态）/ `tasks`（durable multi-agent work items）/ `dispatch_requests`（可审计派发请求）/ `scratchpad`（共享上下文 + subagent 原始结果）/ `checkpoints`（可回滚状态锚点）/ `conflicts`（多 agent 写冲突）/ `blockers`（任务内等待答复）/ `outcomes`（结果验收状态）。`resume_packet` 是 read-only 聚合视图，不是独立持久状态。

W5 引入的 Task Capsule 是 Cairn 管理的一类 durable work item（`tasks` + `blockers` + `outcomes` 三表组合），是 OS primitive 之一，**不是** Cairn 本身——Cairn 不会因为加了 Task Capsule 就变成 task manager。任何文档 / commit message / pitch 写作都按这个 framing。完整 positioning 见 PRODUCT.md §0；不要漂回"Agent OS / solo task daemon / lead-subagent orchestrator"等模糊或错误措辞。

## Agent Work Rules

Claude 在本仓库工作时必须遵守的规则。新会话上来先读这一节，再做任何动作。

### Gates

- **多阶段 / >30min 任务先写 checklist**。开工前先写 ≤5 行验收 checklist：目标 / 不变量 / 验证命令或 dogfood / 不做什么 / 完成标准。结束时逐项自评，未达标先修。
- **改 IPC / 跨进程 / SQLite state / desktop-shell / DSL eval / MCP tool / filesystem 行为时，单测绿不算完成**。必须跑真实 dogfood 或 smoke，并在报告里给出具体命令与结果。Day-by-day plan 实施同此约束。
- **写 docs / pitch / README / PRODUCT / PR 描述前自检定位漂移**：是否把 Cairn 写成 agent / Cursor clone / Jira clone / task daemon / orchestrator / plain MCP service？命中任一则先改再交付。canonical 定位见 PRODUCT.md §0 / §1.3。

### Decision Rules

- **可逆 / 局部 / 5 分钟内能撤销**的实现细节由 agent 自决，但需在最终报告里说明（哪些选择 / 为什么）。
- **不可逆 / 影响 git 历史 / 外部系统 / 产品定位 / 安全边界 / license / release / push** 的决策必须**先问用户**。包括：force push / amend 已 push commit / 改 origin / 删 branch / 改 LICENSE / 打 tag / npm publish / 改 PRODUCT.md / 改反定义 / 引入新 npm dep。

### Delegation Rules

- 开工前判断**读写集**。读任务可并行（多 subagent / Read 并发）；写任务只有**文件集合不重叠**时才能并行。
- **关键路径上的阻塞任务不交给 subagent 等结果**——主 agent 自己做关键路径。subagent 用于：独立调研、并行读、辅助 schema check、并行测试 / smoke 验证、文档审计。
- subagent 报告必须包含：**修改了哪些文件、运行了哪些命令、测试结果、残余风险**。主 agent 接到报告后必须验证（trust but verify），不能直接转述。

### Reporting Rules

- 交付代码或文档时，**先列关键文件路径和 commit hash**，再解释内容。
- 报告必须明确：
  - 测试是否跑过 + 命令 + 结果
  - dogfood 是否跑过 + 哪个脚本 + 结果
  - **是否 push**（默认未 push）
  - **是否触碰 unrelated dirty files**（默认不碰）
- 不模糊用词："已完成"必须有验证证据；"应该可以"不算交付。

## 新会话起手入口

不熟悉 repo 的新 session：先读 `README.md`（30 秒上手）→ `PRODUCT.md` §0 + §1（定位 + 反定义）→ `ARCHITECTURE.md` §1+§4（系统图 + state objects）→ 当前活跃 plan（`docs/superpowers/plans/2026-05-28-w5-phase4-closure.md` 或下一个）。Phase 1+2+3 demo 证据见 `docs/superpowers/demos/README.md`。再回头读本文（CLAUDE.md）拿 push / TLS / 测试命令等本地约定。

## 项目坐标

- **仓库（origin，主）**：https://github.com/Upp-Ljl/Cairn （**注意大小写**：`Cairn`，不是 `cairn`）
- **mirror（legacy）**：https://github.com/Upp-renlab/Cairn — W4 之前的旧 owner，保留作镜像
- **本地路径**：`D:\lll\cairn`
- **主分支**：`main`
- **设计文档**：`PRODUCT.md`（产品定义）、`DESIGN_STORAGE.md`（持久层）
- **执行计划**：`docs/superpowers/plans/2026-04-23-*.md`（P1-P4 + W1 楔）
- **会话归档**：`426归档.md` 等，按日期命名

## 推送（push）必读

### 当前布局（2026-05-07 起）

origin 已切到 Upp-Ljl/Cairn——与 commit author 同账号，不再有 push 身份不一致问题。Upp-renlab/Cairn 改名 `mirror` 保留。

```
git remote -v
# origin   https://github.com/Upp-Ljl/Cairn.git    （主，写）
# mirror   https://github.com/Upp-renlab/Cairn.git （旧 owner，保留）
```

### 两条 push 路径

**A. 用户自己跑（推荐，简单）**

GCM 已缓存 Upp-Ljl 凭证。用户在自己终端跑 `git push origin main`（或在 Claude Code 里用 `!` 前缀），凭证直接走 GCM，不弹窗。Claude Code 自己跑裸 push **不行**——无 TTY，GCM 弹窗会卡住。

**B. PAT URL 直拼（脚本场景）**

Token 文件（已 gitignored）：
```
D:\lll\cairn\.cairn-push-token\ljl-token.txt   # Upp-Ljl 的 PAT，对应当前 origin
D:\lll\cairn\.cairn-push-token\token.txt       # Upp-renlab 的旧 PAT，留着 push mirror 用
```

push 命令（**failed 时切 backend 重试**，详见下条）：

```bash
cd D:/lll/cairn
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')
# 默认先 openssl
git -c http.sslBackend=openssl push "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" main
# 注意：每次输出都要 sed 把 TOKEN 替换成 <REDACTED>，不要泄露到日志

# 推 mirror（用旧 token）
TOKEN_MIRROR=$(cat .cairn-push-token/token.txt | tr -d '[:space:]')
git push "https://x-access-token:${TOKEN_MIRROR}@github.com/Upp-renlab/Cairn.git" main
```

### TLS 坑（2026-04-29 EOD 多次复现）

git push 偶发报：

```
fatal: unable to access '...': TLS connect error:
error:0A000126:SSL routines::unexpected eof while reading
```

观察：curl 一直能连通 GitHub（HTTP 200），失败仅出现在 git push。`schannel`（git for Windows 默认）和 `openssl` 两个 backend **都会出现**这个错，但**会交替成功**——不是某一个 backend 锁死失败。

**解法**：push 失败时切 backend 重试。建议这个顺序：

```bash
# 1) openssl
git -c http.sslBackend=openssl push ... main
# 2) 失败则 schannel
git -c http.sslBackend=schannel push ... main
# 3) 都失败则 sleep 5s 再从 1 重试
```

实测一次 EOD 工作流：4 次 push 中 1 次 openssl 通、3 次失败；schannel 1 次重试通。**换 backend 比死等同一 backend 重试更快**。

根因未深究（可能 GitHub TLS session reuse / Windows 网络栈 MTU / EDR / 本地 anti-virus 扫描 SSL 流量）。如果未来稳定一边失败，再深挖。

fetch 同理（如果本地 `origin/main` 引用没跟上）：

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')
git fetch "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" main:refs/remotes/origin/main
```

### 不要用的方式（Claude Code 上下文）

- `git push origin main`（裸，从 Claude Code 跑） — 触发 GCM 弹窗 → 无 TTY，会卡住或报 `/dev/tty: No such device`。**用户自己终端跑没问题**，Claude Code 跑不行
- `GIT_TERMINAL_PROMPT=0 git push origin main` — 报 `terminal prompts disabled`，无凭证
- `Authorization: Bearer ${TOKEN}` extraheader — GitHub HTTPS 不接受 Bearer，必须用 `x-access-token:TOKEN@host` URL 形式
- `gh` CLI — 这台机器没装

### 如果 token 失效

1. 去 GitHub Settings（**用 Upp-Ljl 账号登录**）→ Developer settings → Personal access tokens 撤销旧的
2. 新建一个，scope 给 `repo`（write）
3. 写入 `.cairn-push-token/ljl-token.txt`（**不要 commit**，已被 .gitignore）
4. 或者让用户在自己终端跑 `git push origin main` — GCM 缓存 Upp-Ljl 凭证就够，不需要 PAT

### Tag 推送

Tag 不会跟着 `git push origin main` 走，要单独推：

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')
git push "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" --tags
```

已有的 tag：`storage-p1`（P1 持久层完成节点）

## 环境特点

- **OS**：Windows 10/11，shell 是 bash（git-for-windows 自带）
- **Node**：v24.14.0
- **路径风格**：bash 用 `/`，Windows 工具吃 `\`，Read/Write 工具用绝对 Windows 路径（`D:\lll\cairn\...`）
- **better-sqlite3**：必须 `^12.9.0` 或更新，11.x 没有 Node 24 prebuilds，会触发 node-gyp（Windows 上多半没装 VS C++ 工具链）
- **commit author**：`Upp-Ljl <2226957164@qq.com>` —— 自 2026-05-07 起 origin 也是 Upp-Ljl，身份统一

## monorepo 结构

```
packages/
├── daemon/         # P1 持久层（SQLite + 仓储层 + git-stash backend）
└── mcp-server/     # W1 楔→W4（17 个 MCP 工具，stdio）
```

跨包 import 走 daemon 的 `dist/`（不是源码）：

```ts
import { openDatabase } from '../../daemon/dist/storage/db.js';
```

`packages/daemon/tsconfig.json` 开了 `declaration: true` 以输出 .d.ts 给 mcp-server 用。

## 测试

每个包独立跑：

```bash
cd packages/daemon && npm test           # 411 tests / 29 test files（W5 Phase 3 后；含 19 outcomes 仓储 + 6 WAITING_REVIEW transition）
cd packages/mcp-server && npm test       # 329 tests / 17 test files / 1 pre-existing skip（含 21 parser + 22 spawn/path utils + 32 primitives + 11 evaluator + 12 outcomes acceptance）
```

**Live dogfood**（W5 Phase 3 闭环，跨 3 个真实 MCP stdio session）：

```bash
cd packages/mcp-server && npm run build && node scripts/w5-phase3-dogfood.mjs   # 32/32 assertions PASS
```

不要给 `cd packages/daemon` 加 `cd D:/lll/cairn &&` 前缀 — 工作目录已经是仓库根。

## 常见任务参考

### 新加一个 migration（P1-W1 之后的工作）

1. `packages/daemon/src/storage/migrations/00X-<name>.ts` 写 DDL
2. 在 `migrations/index.ts` 的 `ALL_MIGRATIONS` 数组里按 version 顺序插入
3. 在 `tests/storage/migrations.test.ts` 末尾追加 schema 测试（PRAGMA table_info + CHECK 验证）
4. **不要修改已落地的 migration**（checksum guard 会拒绝）

### W1 已经吃掉了 P2/P3 的部分编号

- migration `002` = scratchpad（P3 计划里原编号 005）
- migration `003` = checkpoints（P2 计划里原编号 002）
- 详情见 `DESIGN_STORAGE.md` §17.1，P2/P3 计划顶部各有 W1 偏离通告

### 跑全套测试 + tsc

```bash
cd packages/daemon && npm test && npx tsc --noEmit
cd packages/mcp-server && npm test && npx tsc --noEmit
```

两个都要绿。

## 风格约定

- 与用户对话主要用中文，代码 / 命令 / 文件路径英文
- commit message 用 conventional commits（feat / fix / chore / docs / test）+ 中文不进 message 主体（用英文短句）
- **不加 `Co-Authored-By: Claude` 等共创 trailer**（用户 2026-04-27 EOD 明示）
- 用户口味：直说，不空话；产出物先给路径再讲内容；3 选 1 选项题给清单不给散文
- `subagent-driven-development` 模式：每个 task 一只新 sonnet，避免上下文积累；mechanical task 用 haiku；战略分析用 sonnet

## 当前阶段

v0.1 **W5 Phase 1+2+3 全部已交付**（2026-05-28，commit chain `cd20159..9ed613b` 已 push 到 origin）。

| 阶段 | 内容 | Commit / 状态 |
|---|---|---|
| W1 楔 | 持久层 + 8 MCP tools | `feat/storage-p1` 已合并 + tag `storage-p1` |
| W4 Phase 1-4 | processes / conflicts / dispatch 三表 + 累计 17 工具（W1 楔 8 + W4 新增 9 个 process / conflict / inspector / dispatch）+ auto agent_id + R6 + `cairn install` CLI | 2026-05-06 done |
| W5 Phase 1 | Task Capsule lifeline（tasks 表 + 5 task tools） | 2026-05-07~14 |
| W5 Phase 2 | Blockers + resume_packet（blockers 表 + 3 task tools） | 2026-05-14~21 |
| W5 Phase 3 | Outcomes DSL + review/retry/terminal_fail 闭环（outcomes 表 + 3 outcomes tools + DSL stack 7 原语） | 2026-05-22~28，dogfood 32/32 PASS |
| Phase 4 | Product unification + release polish | 进行中（本批次） |

**v0.1 当前 28 个 MCP 工具 / 10 个 migration（001-010）**。下一个可用 migration 编号 = `011`。已落地：001-init / 002-scratchpad / 003-checkpoints / 004-processes-conflicts / 005-dispatch / 006-conflict-pending-review / 007-tasks / 008-dispatch-task-id / 009-blockers / 010-outcomes。

## 已落地约定（新会话必读）

- **SESSION_AGENT_ID 自动注入**：mcp-server 启动时自动生成并写入 `process.env.CAIRN_SESSION_AGENT_ID`（格式 `cairn-<sha1(host:cwd).slice(0,12)>`）。`process.register` / `heartbeat` / `status` / `checkpoint.create` 的 `agent_id` 参数均为可选，缺省取该值。**测试不应传 agent_id，除非在断言显式覆盖逻辑**。
- **pre-commit hook 写 DB**：staged paths 与 OPEN 冲突有重叠时，hook INSERT 新 `PENDING_REVIEW` 行。`CAIRN_DISPATCH_FORCE_FAIL=1` 可强制 dispatch 写 FAILED（demo hook）。
- **`cairn install` CLI**：bin entry `cairn` 在 `packages/mcp-server`（`npm run build` 后生效）。写 `.mcp.json` + pre-commit hook + start-cairn-pet 脚本，三者幂等可重跑。非 npm-published，当前需 file-link（clone + build + 绝对路径）。
- **Dispatch 兜底规则共 5 条**：R1 / R2 / R3 / R4 / R6；R4b / R5 推迟 v0.2。`applyFallbackRules` helper 有单元测试覆盖各规则中英关键词。
- **W5 状态机 12 条 transition 全部 active**（`tasks-state.ts` `VALID_TRANSITIONS`）；`WAITING_REVIEW → CANCELLED` **故意不存在**（P1.2 锁，evaluate 是 sub-second 中转态，超时返 RUNNING 后再 cancel）。
- **Task Capsule 复用约定**：`subagent` 派单时 main agent 通过 prompt 传 `task_id`；scratchpad 用 `subagent/{agent_id}/result` key 命名（详见 `docs/cairn-subagent-protocol.md`）。
- **DSL stack frozen 约束**：`packages/mcp-server/src/dsl/spawn-utils.ts` 是唯一可 import `child_process` 的文件；所有 path 校验经 `path-utils.assertWithinCwd`。grep 强制约束写在 plan §7.1.1。
- **outcomes 仓储 6 个 named export**：`OutcomeStatus` / `OutcomeRow` / `submitOutcomesForReview`（upsert 语义） / `recordEvaluationResult`（PENDING-only） / `markTerminalFail`（PENDING-only） / `getOutcomeByTask`（read-only 聚合用）。绝不暴露 `cairn.outcomes.list/get` MCP 工具（LD-8 锁）。
