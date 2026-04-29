# PoC-4 Dogfood 执行手册

> **文档版本**：v1
> **日期**：2026-05-04
> **状态**：待执行——W3 Day 1 setup，Day 2-4 跑 5 个任务，Day 5 写结果报告
> **关联文档**：
> - `docs/superpowers/plans/2026-04-29-pre-impl-validation.md` §3.4（PoC-4 完整设计）
> - `docs/superpowers/plans/2026-05-04-wedge-w3.md` §3 Day-by-day + §7 实施细节
> - `ARCHITECTURE.md` §6.4（消息可达 + 🚧 PoC-4 锚点）
> - `PRODUCT.md` §4.5（US-S Subagent 协作）

---

## 0. 文档定位

本文是 **PoC-4 dogfood 的可执行手册**，与上游 spec 文档的分工如下：

- `pre-impl-validation.md` §3.4 = 验证设计（目的 / 通过判据 / 失败应对）——不在本文重复
- `2026-05-04-wedge-w3.md` §7 = W3 层面的任务分解——本文是它的可执行补充
- **本文** = 实操层：完整 `.mcp.json` 配置示例 + 真实 system prompt（可直接 paste）+ 5 个任务的 subagent 级拆分 + tracking 空模板 + 每日 EOD checklist

**使用方式**：

1. W3 Day 1：读 §1，完成 setup，跑 §1.3 baseline 测试
2. W3 Day 2-4：每天开新任务前 paste §2 的 system prompt，按 §3 的任务描述派 subagent，完成后填 §4 tracking 表
3. W3 Day 5：按 §7 写 `2026-05-08-poc-4-results.md` 结果报告

**本文本身不填数据**：§4 tracking 表、§5 D-4 附录均为空模板，用户跑完任务后回填。

---

## 1. 前置 Setup（W3 Day 1，约 10 分钟）

### 1.1 .mcp.json 配置

在 Claude Code 的 MCP 配置文件里加入 cairn server。**用绝对路径，不用相对路径。**

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["{ABSOLUTE_PATH_TO_REPO}/packages/mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

将 `{ABSOLUTE_PATH_TO_REPO}` 替换为仓库实际绝对路径，例如 `D:/lll/cairn`（Windows 用正斜杠）。

**配置文件位置**（根据环境选一个）：

| 环境 | 配置文件路径 |
|---|---|
| macOS Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux / WSL | `~/.config/claude-code/mcp.json` |
| Claude Code CLI（任意 OS）| 项目根 `.mcp.json`（推荐，不影响其他项目） |

**Windows 实际路径示例**（本机）：

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["D:/lll/cairn/packages/mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

**如果 dist 还没构建，先跑**：

```bash
cd D:/lll/cairn/packages/daemon && npm run build
cd D:/lll/cairn/packages/mcp-server && npm run build
```

两步都成功后，`packages/mcp-server/dist/index.js` 才存在。

### 1.2 验证 cairn 工具可用

配置完成后，打开 Claude Code，发以下消息：

```
列出 cairn 可用的 MCP 工具。
```

期望输出里包含以下 8 个工具（全部到位才算配置成功）：

- `cairn.scratchpad.write`
- `cairn.scratchpad.read`
- `cairn.scratchpad.list`
- `cairn.scratchpad.delete`
- `cairn.checkpoint.create`
- `cairn.checkpoint.list`
- `cairn.rewind.to`
- `cairn.rewind.preview`

**排查流程**（工具不出现或调用报错时）：

1. 确认 `dist/index.js` 存在：`ls D:/lll/cairn/packages/mcp-server/dist/index.js`
2. 手动测 daemon 启动：`node D:/lll/cairn/packages/mcp-server/dist/index.js`（应打印 MCP server ready 类信息，用 Ctrl+C 退出）
3. 检查 cairn DB 路径权限：首次调用会自动在 `~/.cairn/cairn.db` 创建数据库，确保该目录可写
4. Windows 上若用户名含中文或空格，DB 路径可能有编码问题（已知技术债，见 ARCHITECTURE.md §9）——临时绕法：在 `.mcp.json` 的 `env` 里加 `"CAIRN_DB_PATH": "D:/lll/cairn/.cairn-local/cairn.db"` 指定到纯 ASCII 路径
5. 查看 mcp-server 进程的 stderr：Claude Code 通常在工具调用失败时把 stderr 显示在对话中

**快速冒烟测试**（8 个工具都出现后）：

```
调用 cairn.scratchpad.write，key="poc4-smoke-test"，content="setup verified"
然后调用 cairn.scratchpad.read，key="poc4-smoke-test"
```

读出 `setup verified` 即为冒烟通过。

### 1.3 Baseline 测试：无 prompt 引导时的 subagent 行为

在 .mcp.json 已配置、cairn 工具可见的状态下，让 Claude Code 派一个简单的 subagent，**不加任何 cairn 相关的 system prompt**：

```
用 Task tool 派一个 subagent，让它读 README.md 然后给我一句话总结。
```

**预期结果**：subagent 完成任务，但**不会主动调用** `cairn.scratchpad.write`。

这是 PoC-4 的 baseline 确认：证明 cairn 工具可用但没有 prompt 引导时，subagent 不会自发写入 scratchpad。这说明 §2 的 system prompt 是必要的，而不是"subagent 本来就会调"。

如果 subagent 在这一步意外地调了 cairn 工具——记录下来，说明有什么 system-level 的 cairn prompt 已经注入了，需要排查来源，否则 PoC-4 数据会被污染（baseline 和有 prompt 的情况无法区分）。

---

## 2. PoC-4 System Prompt 模板（每次开新任务前 paste）

每次开一个新的 PoC-4 任务时，先在 Claude Code 主 session 发以下内容（整段 paste，不要只发部分）：

---

```
# Cairn Subagent Protocol — Active for This Task

This task uses Cairn for multi-subagent coordination. Every subagent you
spawn via Task tool MUST call cairn.scratchpad.write before finishing.

Required call format:

  cairn.scratchpad.write(
    key:     "subagent/{TASK_NAME}-{INDEX}/result",
    content: <full report — MUST include all five sections below>,
    task_id: "{TASK_ID}"
  )

  Replace {TASK_NAME} with the task identifier (e.g. "test-coverage-w3").
  Replace {INDEX} with this subagent's letter index (a, b, c, d ...).
  Replace {TASK_ID} with the task_id string you assign for this task.

Required content sections (minimum 50 characters total):
  1. Summary of completed work (2-5 sentences: what was done)
  2. Key decisions (list: what was chosen and why, what was rejected)
  3. Unresolved issues (if any; write "none" if clean)
  4. Recommended next steps (if any; write "none" if terminal)
  5. State useful to the main agent (file paths, version constraints,
     naming conventions, anything the main agent needs to pick up the thread)

Failure to call this tool = task is considered incomplete.

After all subagents finish, call cairn.scratchpad.list with the task_id
to verify every expected key is present. Report which keys are missing
if any are absent.
```

---

**使用说明**：

- 这段是给 Claude Code 主 agent 看的。粘贴后，主 agent 在派出每个 subagent 时会把这个约定带入 subagent 的 prompt。
- `{TASK_NAME}` 用下方 §3 各任务的 ID 替换（如 `test-coverage-w3`）。
- `{TASK_ID}` 是你为这次任务会话分配的任意唯一字符串（如 `w3-task1-20260505`），用于 `cairn.scratchpad.list` 过滤。
- 每开一个新任务就 paste 一次——旧任务的 prompt 不会延续到新 session。
- **不要修改 prompt 的英文主体**：subagent 读到的是英文约定，改成中文可能降低遵循率（待 PoC-4 数据验证）。

---

## 3. 五个推荐任务（W3 Day 2-4 执行）

每个任务给出：任务 ID、用户告诉主 CC 的描述、subagent 拆分、预期产出、预期耗时。

按建议顺序执行（Day 2 跑任务 1+2，Day 3 跑任务 3+4，Day 4 跑任务 5）。样本总数 ≥ 15 是 pre-impl-validation §3.4 的最小判据。

---

### 任务 1：补 daemon 测试覆盖率

**任务 ID**：`test-coverage-w3`

**告诉主 CC 的描述**：

```
扫 packages/daemon/src/ 下所有模块，找出测试覆盖最薄弱的地方。
为覆盖率最低的 1-2 个模块补单元测试，跑回归确认不破坏现有测试。
```

**subagent 拆分（推荐 4 个）**：

| subagent | 标识 | 具体任务 |
|---|---|---|
| test-coverage-w3-**a** | 覆盖率分析 | 跑 `npx vitest run --coverage`（如果 vitest config 未开 coverage reporter，先在 vitest.config.ts 加 `coverage: { reporter: ["text","json"] }`）；分析输出，列出覆盖率最低的前 3 个模块（按 uncovered lines 降序）；把分析结果写入 scratchpad |
| test-coverage-w3-**b** | 补测 module A | 针对 -a 选定的优先级第 1 模块，写 5-8 个新测试用例（边界场景 / error path 为主，不重复已有 happy path）；写入 scratchpad（含写了哪些 case + 放弃了哪些 + 原因） |
| test-coverage-w3-**c** | 补测 module B（可选）| 针对优先级第 2 模块，同 -b 方式补测；如果第 1 模块已覆盖足够，可改为补第 1 模块的 edge case |
| test-coverage-w3-**d** | 回归验证 | 跑 `cd packages/daemon && npm test`，确认所有新旧测试通过；跑 `npx tsc --noEmit`，确认类型正确；把回归结果（pass/fail 数）写入 scratchpad |

**预期产出**：1-2 个 commit（`test(daemon): cover <module> edge cases`）+ 4 个 scratchpad key

**预期耗时**：1-2 小时

---

### 任务 2：起 desktop-shell skeleton

**任务 ID**：`tauri-skeleton-w3`

**告诉主 CC 的描述**：

```
在 packages/desktop-shell/ 起一个最小 Tauri 应用（hello world 小窗口），
目标是让 Tauri 项目结构存在、能 build。不求功能完整，只求工程上跑通。
```

**subagent 拆分（推荐 3 个）**：

| subagent | 标识 | 具体任务 |
|---|---|---|
| tauri-skeleton-w3-**a** | 方案评估 | 评估两个 starter 方向：1) `npm create tauri-app@latest`（交互式脚手架）vs 2) 手写最小 Tauri 项目（`src-tauri/` + `index.html` + `tauri.conf.json`）；列出各自优劣（工程复杂度 / 构建依赖 / Windows 工具链要求）；给出推荐方案 + 理由；写入 scratchpad |
| tauri-skeleton-w3-**b** | 初始化项目 | 按 -a 推荐方案，在 `packages/desktop-shell/` 初始化 Tauri 项目；配置 `tauri.conf.json`：窗口无边框（`decorations: false`）、透明背景（`transparent: true`）、尺寸 400×300、右下角定位（`x: -400, y: -300` 相对屏幕右下）；确认 `package.json` 存在且 scripts 有 `tauri build` / `tauri dev`；把配置决策写入 scratchpad（含 tauri 版本选型） |
| tauri-skeleton-w3-**c** | 验证 + IPC stub | 加一个 README.md（仅 desktop-shell 内）说明 build 方式；在前端 JS 里加一个 dummy IPC 调用（`invoke("get_cairn_status")`，不要求 Rust 后端真实实现，只要编译通过即可）；尝试 `npm run tauri build` 或记录卡在哪一步（Rust 工具链 / MSVC 等环境问题属于预期障碍，记录即可不要求强行跑通）；把 build 结果（成功 / 卡在哪步 + 错误信息）写入 scratchpad |

**预期产出**：`packages/desktop-shell/` 目录骨架 + tauri 配置文件 + 1 个说明 build 状态的 scratchpad key

**预期耗时**：2-3 小时（含 Rust 工具链首次 setup；如果 Rust 未装，`tauri-skeleton-w3-c` 的 build 验证可能受阻——记录即可，不阻塞 PoC-4 数据收集）

---

### 任务 3：整理文档残余技术债

**任务 ID**：`doc-debt-w3`

**告诉主 CC 的描述**：

```
扫 PRODUCT.md 和 ARCHITECTURE.md，找出 v1→v2 转向时遗漏的：
过时引用 / 死节号链接 / 未关闭的 TODO 标记 / v1 概念词残留。
整理成清单，能直接 fix 的 fix（只改注释类内容，不改正文功能设计），不能 fix 的列出来给用户决策。
```

**subagent 拆分（推荐 3 个）**：

| subagent | 标识 | 具体任务 |
|---|---|---|
| doc-debt-w3-**a** | 节号引用核查 | 用 grep 找 PRODUCT.md 和 ARCHITECTURE.md 里所有 `§X.Y` 格式的引用；验证每个引用的目标节号存在（对照文档当前的 `##` / `###` 标题）；列出悬空引用（目标节不存在或节号已漂移）；写入 scratchpad（含引用列表 + 是否悬空） |
| doc-debt-w3-**b** | v1 概念词残留 | 搜索文档里的 v1 概念词列表：`桌面宠物`、`Outward Agent`、`单 agent`（注意区分"单 agent 退化"等正常用法 vs 旧路线描述）、`v1` 等；确认每次出现是否在"反定义"（明确区分 v1 vs v2）语境下，还是游离在外的残余；把游离的列出来；写入 scratchpad |
| doc-debt-w3-**c** | W1/W2 plan 残余扫描 | 扫 `docs/superpowers/plans/2026-04-23-*.md` 和 `2026-04-27-wedge-w2.md` 里的 task list，标出哪些 task 对应的功能已被 v2 推翻或重新定义，且 plan 文档里没有注明"已过时"；写入 scratchpad（含文件路径 + 具体行号 + 推翻原因） |

**预期产出**：1-2 个 commit（`docs: fix dangling section refs`，只提交确定性 fix）+ 3 个 scratchpad key；非确定性问题留给用户决策

**预期耗时**：1-1.5 小时

---

### 任务 4：起 v0.1 release packaging plan

**任务 ID**：`release-pack-w3`

**告诉主 CC 的描述**：

```
v0.1 W11-W12 要 ship 给种子用户。整理 release packaging 需要解决的问题：
mcp-server 怎么发布（npm？手动 clone + build？）、daemon 是库还是 vendored、
desktop-shell（Tauri）打包流程。这个任务只起 plan 文档草稿，不实施。
```

**subagent 拆分（推荐 4 个）**：

| subagent | 标识 | 具体任务 |
|---|---|---|
| release-pack-w3-**a** | mcp-server 发布方案 | 调研 `@cairn/mcp-server` npm 发布方案：package.json 的 `name` / `version` / `main` / `bin` 设置；版本策略（`0.0.1-alpha.1` → `0.1.0`）；`npm publish` 所需的账号 / scope 配置；用户安装方式（`npm install -g @cairn/mcp-server`？或者 `npx @cairn/mcp-server`？）；把方案选项 + 推荐写入 scratchpad |
| release-pack-w3-**b** | daemon 打包策略 | 调研 daemon 是作为独立 npm 包（`@cairn/daemon`）发布，还是 vendor 进 mcp-server（mcp-server build 时把 daemon dist 打包进去）；两种方案的 bundle size / 用户安装步骤 / monorepo 工具链要求对比；写入 scratchpad（含推荐方案 + 理由） |
| release-pack-w3-**c** | Tauri desktop-shell 打包 | 调研 Tauri v1/v2 的 build + sign + distribution 流程（Windows `.msi` / macOS `.dmg` / Linux `.AppImage`）；GitHub Release 自动化（GitHub Actions + Tauri Action）；code signing 需求（Windows SmartScreen / macOS Gatekeeper）；概估工作量（天）；写入 scratchpad |
| release-pack-w3-**d** | 综合 plan 草稿 | 综合 -a/-b/-c 的调研，起草 `docs/release-packaging-plan.md`（新文件）草稿，结构：0 TL;DR / 1 mcp-server 发布方案 / 2 daemon 策略 / 3 desktop-shell 打包 / 4 用户安装流程（end-to-end）/ 5 工作量估算 / 6 已知风险；把草稿路径写入 scratchpad |

**预期产出**：`docs/release-packaging-plan.md` 草稿 + 4 个 scratchpad key

**预期耗时**：2-3 小时

---

### 任务 5：起 v0.2 MVP plan 草稿

**任务 ID**：`v02-mvp-w3`

**告诉主 CC 的描述**：

```
基于 PRODUCT.md §10.3 v0.2 扩展列表 + ARCHITECTURE.md §10 v0.2/v0.3 议题 +
本周 PoC 数据，起 v0.2 MVP plan 草稿（W16-W30 路线）。
优先级排序：按"什么阻塞最多 v0.1 种子用户升级"排。
```

**subagent 拆分（推荐 3 个）**：

| subagent | 标识 | 具体任务 |
|---|---|---|
| v02-mvp-w3-**a** | v0.2 议题整理 | 从以下来源收集 v0.2 工作项：`PRODUCT.md §10.3`、`ARCHITECTURE.md §10.2`、`ARCHITECTURE.md §10.3`（v0.3 议题里哪些实际应该提前到 v0.2）、PoC-1/-2/-4 结果中标注"v0.2"的条目（如 `path-b-wrapper`、反汇总层 3）、Floating Marker（ADR-8）；把完整清单 + 来源引用写入 scratchpad |
| v02-mvp-w3-**b** | 优先级排序 | 对 -a 整理的工作项，按"对 v0.1 种子用户升级路径的阻塞程度"排序（越阻塞越优先）；对每项估工作量（小：1-2 周 / 中：3-4 周 / 大：5-6 周）；特别标注 PoC-4 若调用率 < 70% 时的 path-b-wrapper（这会从"中"变"高优先"）；写入 scratchpad（含优先级列表 + 估算 + 前提条件依赖） |
| v02-mvp-w3-**c** | 起草 plan 文件 | 在 `docs/superpowers/plans/` 新建 `2026-XX-XX-v02-mvp-plan.md`（文件名的日期用 W16 预计开始日期：`2026-06-08`）；结构：0 定位与目标用户 / 1 v0.2 核心工作项（含优先级 + 工作量）/ 2 W16-W30 路线（按 2 周一个 milestone）/ 3 前提：v0.1 exit criteria（需先满足什么才能启动 v0.2）/ 4 v0.3 议题指针；把草稿文件路径写入 scratchpad |

**预期产出**：`docs/superpowers/plans/2026-06-08-v02-mvp-plan.md` 草稿 + 3 个 scratchpad key

**预期耗时**：2-3 小时

---

## 4. 数据收集 Tracking 表

**填写说明**：
- 每个 subagent 完成后立即填一行，不要等到 Day 5
- "调用 scratchpad.write"列：✓（调用且内容 ≥ 50 字）/ ✗（未调用）/ △（调用但内容 < 50 字或明显空洞）
- "内容质量 (1-3)"：1 = 空洞（< 50 字 / 缺关键决策 / 没风险）/ 2 = 基础（覆盖"做了什么"，缺"决策依据"）/ 3 = 完整（5 段全有）
- "content 长度 (字)"：调用时估算字数（scratchpad.read 读出后数）；未调用则留空
- "备注"：subagent 未调用时记录可能原因（任务太短？prompt 被截断？主 agent 没把约定传给 subagent？）

### 4.1 任务 1：test-coverage-w3

| # | subagent ID | subagent 描述 | 调用 scratchpad.write? | content 长度 (字) | 内容质量 (1-3) | 备注 |
|---|---|---|---|---|---|---|
| 1 | test-coverage-w3-a | 跑覆盖率分析，列最低 3 模块 | | | | |
| 2 | test-coverage-w3-b | 为优先级第 1 模块补测 | | | | |
| 3 | test-coverage-w3-c | 为优先级第 2 模块补测（可选） | | | | |
| 4 | test-coverage-w3-d | 跑回归验证（npm test + tsc） | | | | |

**任务 1 小计**：调用数 / 总数 = ___/___ ，调用率 = ___%

### 4.2 任务 2：tauri-skeleton-w3

| # | subagent ID | subagent 描述 | 调用 scratchpad.write? | content 长度 (字) | 内容质量 (1-3) | 备注 |
|---|---|---|---|---|---|---|
| 5 | tauri-skeleton-w3-a | 评估 starter 方案 | | | | |
| 6 | tauri-skeleton-w3-b | 初始化 Tauri 项目 + 配置窗口 | | | | |
| 7 | tauri-skeleton-w3-c | 加 README + IPC stub + build 验证 | | | | |

**任务 2 小计**：调用数 / 总数 = ___/___ ，调用率 = ___%

### 4.3 任务 3：doc-debt-w3

| # | subagent ID | subagent 描述 | 调用 scratchpad.write? | content 长度 (字) | 内容质量 (1-3) | 备注 |
|---|---|---|---|---|---|---|
| 8 | doc-debt-w3-a | 节号引用核查（两份文档） | | | | |
| 9 | doc-debt-w3-b | v1 概念词残留扫描 | | | | |
| 10 | doc-debt-w3-c | W1/W2 plan 残余扫描 | | | | |

**任务 3 小计**：调用数 / 总数 = ___/___ ，调用率 = ___%

### 4.4 任务 4：release-pack-w3

| # | subagent ID | subagent 描述 | 调用 scratchpad.write? | content 长度 (字) | 内容质量 (1-3) | 备注 |
|---|---|---|---|---|---|---|
| 11 | release-pack-w3-a | mcp-server npm 发布方案调研 | | | | |
| 12 | release-pack-w3-b | daemon 打包策略调研 | | | | |
| 13 | release-pack-w3-c | Tauri desktop-shell 打包调研 | | | | |
| 14 | release-pack-w3-d | 综合 plan 草稿（docs/release-packaging-plan.md） | | | | |

**任务 4 小计**：调用数 / 总数 = ___/___ ，调用率 = ___%

### 4.5 任务 5：v02-mvp-w3

| # | subagent ID | subagent 描述 | 调用 scratchpad.write? | content 长度 (字) | 内容质量 (1-3) | 备注 |
|---|---|---|---|---|---|---|
| 15 | v02-mvp-w3-a | v0.2 议题收集整理 | | | | |
| 16 | v02-mvp-w3-b | 优先级排序 + 工作量估算 | | | | |
| 17 | v02-mvp-w3-c | 起草 v0.2 MVP plan 文件 | | | | |

**任务 5 小计**：调用数 / 总数 = ___/___ ，调用率 = ___%

---

### 4.6 全局汇总（Day 5 填）

| 统计项 | 数值 |
|---|---|
| 总 subagent 数（目标 ≥ 15） | |
| 完整调用（✓，content ≥ 50 字） | |
| 未调用（✗） | |
| 空洞调用（△，< 50 字或缺关键段） | |
| **整体调用率**（✓ / 总数） | |
| 内容质量 3 分的数量 | |
| 内容质量 2 分的数量 | |
| 内容质量 1 分或空洞的数量 | |

**初步 verdict（Day 4 中间结论）**：

对照 `pre-impl-validation.md` §3.4 决策矩阵：

| 调用率 | 含义 | 本次结果 |
|---|---|---|
| ≥ 90% | 路径 (a) 可行，按 ARCHITECTURE.md §6.4 原设计走 | |
| 70-90% | 可行但需兜底：主 agent 读 scratchpad 前先 check 未回报 subagent 列表 | |
| < 70% | 路径 (a) 不可靠，立即起 `docs/path-b-wrapper-design.md`，记为 ADR-9 候选 | |

**调用率**（填完后在上表勾选对应行）：____%，结论：___________________________

---

## 5. D-4 假阳性观测附录（与 PoC-4 同期记录）

**背景**：v0.1 当前没有实装冲突检测（W4-W5 才编码）。W3 期间用 dogfood 任务观测**理论冲突**：如果 cairn 的冲突检测已经上线，它会不会在这次操作上误报？这些记录用于评估 W4-W5 编码后的预期假阳性率。

**填写说明**：
- "类型"三选一：实际冲突（两个 subagent 真的改了同一个文件）/ 假阳性（cairn 若实现了会误报）/ 漏报（冲突发生了但 cairn 不会检测到）
- "涉及 paths"：哪个文件或目录触发了分析
- "用户判断"：你认为这是真冲突吗？（是 / 否 / 不确定）

| 时间 | 任务 | 类型 | 涉及 paths | 描述 | 用户判断 |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |

**每周统计**（W3 末）：

- 观测到的潜在冲突场景总数：___
- 其中理论假阳性（若实现会误报）：___
- 其中真冲突：___
- 理论假阳性率：___% （假阳性 / 总观测）

对照 `pre-impl-validation.md` §4.4 判据（< 5% 继续保守策略 / 5%-20% 提高阈值 / > 20% 静默通知）：当前 W3 数据预测值 ____%，结论：___________________________

**注意**：W3 样本量通常很小（3-5 个任务，不是连续协作），本次数据主要是记录方法的试演，真实假阳性率数据要到 W4-W6 持续 dogfood 后才有统计意义。

---

## 6. 每日 EOD Checklist（W3 Day 2-4 各跑一遍）

每天结束前用 5 分钟对照以下清单：

### Day 2（周二）EOD

- [ ] 任务 1（test-coverage-w3）所有 subagent 在 §4.1 填上调用情况
- [ ] 任务 2（tauri-skeleton-w3）所有 subagent 在 §4.2 填上调用情况
- [ ] 当天调用率算出：__/__  = ___%
- [ ] 异常 case 的可能原因写到备注列（如 -b 没调，-c content 极短）
- [ ] D-4 附录 §5 当天的理论冲突观测已记录（哪怕"0 次"也写上）
- [ ] 本文已 commit 到 `docs/superpowers/plans/2026-05-04-poc-4-tracking.md`（`docs(poc-4): day2 tracking update`）

### Day 3（周三）EOD

- [ ] 任务 3（doc-debt-w3）所有 subagent 在 §4.3 填上调用情况
- [ ] 任务 4（release-pack-w3）所有 subagent 在 §4.4 填上调用情况
- [ ] 当天调用率算出：__/__  = ___%
- [ ] 累计调用率（Day 2 + Day 3）算出：__/__  = ___%
- [ ] 异常 case 的可能原因写到备注列
- [ ] D-4 附录 §5 当天观测记录
- [ ] 本文已 commit（`docs(poc-4): day3 tracking update`）

### Day 4（周四）EOD

- [ ] 任务 5（v02-mvp-w3）所有 subagent 在 §4.5 填上调用情况
- [ ] §4.6 全局汇总表填完
- [ ] **初步 verdict 写入 §4.6 末尾**（≥ 90% / 70-90% / < 70%）
- [ ] 如果调用率 < 70%：`docs/path-b-wrapper-design.md` 草稿今天就起，不等 Day 5
- [ ] D-4 附录 §5 收尾，W3 末统计栏填完
- [ ] 本文已 commit（`docs(poc-4): day4 tracking update + interim verdict`）

**Day 4 commit 是本文最重要的一次 commit**：此时已有 ≥ 15 个样本，调用率数字清晰，W3 plan §3.4.2 要求的"初步 verdict"在此产出。

---

## 7. W3 Day 5：写 PoC-4 Results 报告

W3 Day 5 用本文 §4 的数据，写正式结果报告。

**输出文件**：`docs/superpowers/plans/2026-05-08-poc-4-results.md`

**结构**（仿 `2026-04-29-poc-1-results.md` 格式）：

### 0. TL;DR + Verdict

- 一句话：调用率 X%，verdict PASS / NOTE / FAIL
- 决策：路径 (a) 直接走 / 路径 (a) + 兜底机制 / 路径 (b) wrapper 前置（ADR-9）

### 1. 测试设计

- 5 个任务的清单（任务 ID + 描述 + spawn 规则）
- system prompt 模板全文（§2 的原文）
- 判定标准：完整调用 = 调用 + content ≥ 50 字 + 5 段齐

### 2. 数据汇总

从 §4.6 复制，补内容长度分布（按 subagent 列）：

| 任务 | subagent 数 | 完整调用 | 未调用 | 空洞调用 | 调用率 |
|---|---|---|---|---|---|
| test-coverage-w3 | | | | | |
| tauri-skeleton-w3 | | | | | |
| doc-debt-w3 | | | | | |
| release-pack-w3 | | | | | |
| v02-mvp-w3 | | | | | |
| **合计** | | | | | |

### 3. 关键发现

- 调用率数字
- 未调用的原因分析（任务太短？prompt 传递链断掉？subagent 没读到约定？）
- 内容质量分布（多少达到 3 分 / 2 分 / 1 分）
- 任意异常现象（如某类任务系统性不调、某个 subagent 调了但 key 格式错误）

### 4. Verdict + ARCHITECTURE.md §6.4 锚点回填文本

对照 `pre-impl-validation.md` §3.4 决策矩阵写 verdict；同时准备用来回填 ARCHITECTURE.md §6.4 🚧 PoC-4 锚点的文本（一段话，含调用率数字 + 路径决策 + 若有兜底机制的描述）。

### 5. 失败应对（调用率 < 90% 时）

- **70-90%**：兜底机制设计（主 agent 在 `cairn.scratchpad.list` 返回前插入"哪些预期 subagent 未写入"的检测逻辑）；W4 plan 加 1-2 天 task
- **< 70%**：立即起 `docs/path-b-wrapper-design.md`（Task tool wrapper 强注入约定）；ADR-9 起草；W4 Day 1-2 做 wrapper 设计，冲突可见 v1 编码后移

### 6. D-4 附录数据

从 §5 复制，加上 W3 数据对 W4-W6 假阳性率的预测（小样本，仅参考）。

### 7. 时间盒回看

PoC-4 实际耗时（W3 Day 1 setup 到 Day 5 报告）vs 计划 2-3 天；影响因素分析。

---

## 8. 失败时退路（与 W3 plan §5 对齐）

| 情景 | 退路方案 | 对 W4 的影响 |
|---|---|---|
| 调用率 70-90% | 在 PoC-4 results §5 提议兜底检测；W4 plan 加 1-2 天实现"未回报 subagent 检测"逻辑；ARCHITECTURE.md §6.4 更新说明兜底机制 | W4 工期不变；W5 消息可达多 1-2 天 |
| 调用率 < 70% | 当天起 `docs/path-b-wrapper-design.md` 草稿；W4 Day 1-2 做 wrapper 设计；ADR-9 起草；冲突可见 v1 编码推迟一周 | W4 头 2 天做 wrapper；编码从 Day 3 才开始 |
| 5 任务总样本 < 15 | 加跑第 6 个任务（用户从当前 cairn backlog 任意挑一个能 spawn 3+ subagent 的）；15 是最小判据，低于此不能做架构决策 | 可能 W3 推迟 1 天，不影响 W4 方向 |
| subagent 完成了任务但没调 cairn | 重要数据：说明 prompt 引导没有生效；分析 prompt→subagent 的传递链（system prompt 有没有被截断？Task tool 的 prompt 参数有没有把约定带进去？）；写入 PoC-4 results §3 失败原因分析 | prompt 模板需要调整；若普遍发生则升级为 < 70% 应对 |
| cairn 8 工具自身出 bug | 记录到 `docs/wedge-bugs-w3.md`（新建）；不阻塞 PoC-4 数据收集（工具 bug 和调用率数据是独立维度）；bug 优先级和修复时间按严重性决定 | 工具 bug 不影响 PoC-4 的 verdict 判断 |
| Tauri 任务因工具链未装而完全卡住 | tauri-skeleton-w3-c 记录卡在哪一步 + 错误信息，视为"任务完成但受环境限制"；仍算 3 个 subagent 样本；Tauri build 是 W3 的可选产出，不是 PoC-4 成功的前提 | 不影响调用率数据；Tauri skeleton 推到 W4 初完成 |

---

*本文由 subagent（sonnet）根据 W3 plan + pre-impl-validation 起草，2026-05-04。执行时如发现步骤与实际工具行为不符，直接修改本文对应段落并 commit。*
