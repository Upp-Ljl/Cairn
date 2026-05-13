# Cairn 用户测试指南

> 测试目标版本: post-Phase-1-bootstrap merge (feat/bootstrap-phase1, 2026-05-14)
> 测试平台: Windows 10/11 + Node.js >= 24 (CLAUDE.md 推荐)
> 文档作者视角: 把 Cairn 当作"陌生软件"交给你的 QA 同事
> 形态约定: Cairn 是常驻桌面 daemon-class app；用户首触是 panel 的 `＋ Add project…` 按钮，**不**是终端 CLI。CLI 仍保留给 power-user / CI。

---

## 0. 30 秒了解 Cairn

Cairn 是一个 **local project control surface** — 一个跑在你本地机器的 Electron 桌面侧边窗 + 系统托盘 + 悬浮宠物，用来观察和引导你机器上多个 AI coding agent (Claude Code / Cursor / Codex / Aider) 同时干活时的协作状态。

它**不写代码**，也不替你的 agent 做决策。它做的是：

- 看见 agent 在跑什么 task / 卡在哪个问题 / 输出失败 / 互相改了同一个文件
- 给可回滚的 checkpoint，搞砸了 5 秒回退
- 收集来自不同 session 的状态，让你换一只 agent / 隔天回来都接得上
- 内置一个 "Mentor"：当你离开屏幕时按 7 条规则 (D/E/G 当前已 wired) 自动 nudge / 升级，只在它处理不了时才打扰你

你在 Cursor / Claude Code 里照旧写代码 — Cairn 是旁边那张读 SQLite 的仪表盘。

---

## 1. Cairn 是什么 / 不是什么 (反定义先看)

### Cairn 是

- 一个 host-level 多 agent 协调 kernel (`processes` / `tasks` / `dispatch_requests` / `scratchpad` / `checkpoints` / `conflicts` / `blockers` / `outcomes` 8 张表)
- 一个项目控制面板 (桌面侧边窗 + 托盘 + 悬浮宠物)
- 一个 MCP server (`cairn-wedge`)，被 Claude Code / Cursor / Codex / Aider 通过 stdio 调用
- 一个 unattended pipeline — 没有"非人不可"的 HITL 中断点

### Cairn 不是

- 不是 agent / 不是 coding agent
- 不是 IDE / 不是 Cursor clone
- 不是 task daemon
- 不是 Jira / Linear / Asana 这类项目管理
- 不是通用 agent framework / SDK
- 不是云端服务 — 数据全在本地 `~/.cairn/cairn.db`

如果你期望 Cairn 替你写代码 / 替你的 agent 想问题，那你测试的是错误的产品 — 它不会做那些事。

---

## 2. 安装与首次启动

### 2.1 前置条件

| 项 | 要求 | 验证命令 |
|---|---|---|
| OS | Windows 10/11 | — |
| Node.js | >= 24 (CLAUDE.md 推荐) | `node -v` |
| Git | 任意现代版本 | `git --version` |
| 待协调的项目 | 至少一个 git 仓库 | `cd <你的 repo> && git status` |
| 一个 AI coding agent | Claude Code (带 MCP 支持) 最稳；Cursor / Codex / Aider 也行 | — |

### 2.2 编译

Cairn 当前**没有 npm publish**，必须 clone + build:

```bash
git clone https://github.com/Upp-Ljl/Cairn.git
cd Cairn
cd packages/daemon && npm install && npm run build
cd ../mcp-server && npm install && npm run build
cd ../desktop-shell && npm install
```

注意:
- `desktop-shell` 的 `postinstall` 跑 `prebuild-install --target 32.3.3 --platform win32 --arch x64` 拉 better-sqlite3 的 Electron 32 binary。如果走不通会无声跳过，启动时报 `MODULE_NOT_FOUND`。
- `better-sqlite3` 必须 `^12.9.0` (CLAUDE.md)，否则 Node 24 没 prebuilds，会触发 node-gyp。

### 2.3 把 Cairn 装到你的项目里

**用户首触路径 (推荐 — 2026-05-14 起)**：在 Cairn panel 里点 `＋ Add project…`，选你的项目文件夹。Cairn daemon 自己一键完成所有装载：

1. 注册项目到 registry
2. 写 `.mcp.json` + `.git/hooks/pre-commit` + `start-cairn-pet.{bat,sh}` (内部 spawn `cairn install --json`，等同于跑下面的 CLI)
3. **haiku-起草** `CAIRN.md`：扫你的 `CLAUDE.md` / `README.md` / `package.json` / 最近 git log → 写出 `## Whole` 北极星 + `## Goal` 当前里程碑 + ✅/⚠️/🛑 Mentor 授权清单。无 LLM provider 时落到空模板兜底。
4. 如果检测到已 attached 的 coding agent (CC / Cursor / Codex / Aider)，往它的 `scratchpad:agent_inbox/<agent_id>/<ulid>` 塞 refinement 请求 (anti-framing 嵌入 prompt 里，告诉 agent "你写的是 PM 工作描述，不是 Senior Engineer 的"，附带 haiku 草稿作输入)。Agent 下回合 inbox poll 时拿到，可替换或保留草稿。

**Power-user / CI 路径** (CLI 仍保留)：

```bash
cd <你的项目根目录>
node <cairn 绝对路径>/packages/mcp-server/dist/cli/install.js
# --json    输出机器可读 JSON (desktop-shell install-bridge 用这个)
# --dry-run 预览不写文件
```

CLI 本身**不**做 CAIRN.md haiku 起草——只写空模板。haiku 起草只在 panel "Add project" 路径触发 (因为它需要 desktop-shell 进程里的 LLM 客户端)。

幂等：CLI 或 panel 重跑都不破坏现有正确内容。

### 2.4 启动桌面壳

从 cairn 仓库里:

```bash
cd packages/desktop-shell
npm start
```

启动后会看到:

1. 控制台 (stdout) 打印 `cairn desktop-shell ready — mode=panel mutations=off tray=on projects=N dbs=M`
2. **系统托盘**出现一个灰色 (idle) 的小图标
3. 屏幕一角出现**悬浮宠物** (Electron `petWindow`，`alwaysOnTop`)
4. **侧边窗**贴右边缘弹出 — 标题栏 `Cairn — Projects` (L1 列表视图)

如果 (1)(2) 出现但 (3)(4) 没出现 — 检查是否 `LEGACY_MODE=1` 或 `CAIRN_DESKTOP_BOOT_TEST=1` 误设置 (BOOT_TEST 跑 3 秒自动退出)。

### 2.5 让 Claude Code 看见 Cairn

打开装了 `.mcp.json` 的那个项目根目录，启动 Claude Code (或重启已开着的 CC session 让它重读 `.mcp.json`)。问 CC:

> "What MCP tools do you have? Look for cairn-wedge."

期望它列出 `cairn.scratchpad.write` / `cairn.checkpoint.create` 等 28 个 `cairn.*` 工具。如果没有 — `.mcp.json` 没生效或 cairn build 没完成。

---

## 3. 主要功能 (12 张卡片)

每张卡按 What / Where / How / Success / Edges 写。Where 字段里的所有 `#xxx` 都是 panel.html 真实 DOM id，可以 Ctrl+F 查。

### 3.1 系统托盘 + idle / warn / alert 三色状态

**What it is** — 一个常驻系统托盘图标。颜色编码当前注册的所有项目里"最糟"的那个的健康状态：灰 = idle，琥珀 = warn (open blockers 或 WAITING_REVIEW tasks)，红 = alert (open conflicts 或 failed outcomes)。鼠标悬停 tooltip 显示具体 counts。点击托盘图标 = toggle 侧边窗显隐。

**Where to find it** — Windows 任务栏右下托盘区；图标实现在 `main.cjs::TRAY_IMAGES` (data-URL PNG，gray `#505050` / amber `#DCB432` / red `#C83232`)。

**How to test**
1. 启动 desktop-shell，观察初始托盘色 (空状态 = idle 灰)
2. 在 Claude Code 里调 `cairn.task.create({ intent: "..." })` 再 `cairn.task.block(...)` 让一个 task 进 BLOCKED → 托盘转琥珀
3. 调 `cairn.outcomes.terminal_fail(...)` 让 outcome FAIL → 托盘转红
4. 右键托盘看菜单 (Quit / Open panel / 等)
5. 点击托盘图标，验证侧边窗显隐切换

**What success looks like** — 三色随状态变化在 1 秒轮询周期内反映 (`refreshTray` 1s setInterval)；tooltip 文本格式 `Cairn — <project_count> projects · <counts>`。

**Edge cases worth poking**
- 在没注册任何 project 时强行让 unassigned agents 写 conflict → 看托盘是否仍升级 (`main.cjs` 注释说默认 DB 也参与计算)
- DB 文件被删 → tooltip 显示 `Cairn — DB unavailable`，托盘冷静不挂
- 同时 N=5 个 project 健康度不同 → 验证取 worst

---

### 3.2 项目列表视图 (L1) + Add project 按钮

**What it is** — 启动后默认看到的列表视图。把你机器上注册过的项目列成卡片，每张卡显示 tasks / blockers / conflicts 数。底部一条 `＋ Add project…` 大按钮把陌生 repo 装进 Cairn。

**Where to find it** — DOM `#view-projects-list` (panel.html L2286) 包裹 `#projects-list-body`；添加按钮 `#pl-add-btn`；header 菜单还有一份 `#menu-add-project` 同等效果。

**How to test**
1. 启动时不带任何 registered project → 看到 placeholder `loading…` 然后空状态
2. 点底部 `＋ Add project…`
3. Electron 系统对话框弹出 — 选一个 git repo 的根目录 (比如 `D:\lll\cairn` 自己)
4. 应该即时在列表里出现新卡片，显示项目名 + DB path
5. 点任一卡片 → 切换到 cockpit (L2) 视图 (`#view-cockpit`)

**What success looks like** — `add-project` IPC 返回 `{ ok: true, entry: {...} }`；列表立即多一行；ESC 从 L2 回 L1 不会"半透"叠层 (panel.html `[hidden]{display:none !important;}` 修过)。

**Edge cases worth poking**
- 选一个**不是 git 仓库**的目录 — `canonicalizeToGitToplevel` 会静默回退原路径；DB 默认会落到 `~/.cairn/cairn.db`
- 选一个有 `.cairn/cairn.db` 的目录 — 应该用项目本地 DB 而非 global
- 取消对话框 — 返回 `{ ok: false, error: 'cancelled' }`，列表不变化

---

### 3.3 单项目 cockpit 视图 (L2) — 整体布局

**What it is** — 从 L1 点任一项目进入的 5-模块驾驶舱。它是 v0.2 的核心 redesign — 替代了 v0.1 的"5 tab feature 博物馆"。

**Where to find it** — DOM `#view-cockpit` (L2629)。垂直从上到下依次是：cockpit-tabs (项目切换条) → 5 个模块依次堆叠。`setView('cockpit', proj)` 在 panel.js:3386 触发。

**How to test**
1. L1 点任一项目卡 → 验证 header 切到 `<project label>` 且 DB 路径显示在副标题
2. 上方有 `#cockpit-tabs` 横条 — 多项目时各列一个 tab，点击切换
3. 验证 5 个模块从上到下排列：State Strip → Steer → Activity → Safety → Needs You
4. 按 `Esc` 返回 L1；按 `?` 打开 help overlay (`#cockpit-help-overlay`)
5. 按 `/` 聚焦 steer 输入框；`j` / `k` 在 activity 列表里上下移动

**What success looks like** — 5 个模块全部渲染；onboarding 卡 (`#cockpit-onboarding`) 在没 goal 时显示 "Inbox is empty. Start by adding a project and defining a goal so Mentor can run."

**Edge cases worth poking**
- 5+ 项目同时注册 → cockpit-tabs 是否横向滚动 / 截断
- 项目 DB 路径是 `/dev/null` 或 `(unknown)` 哨兵 → 应回退到全局默认 DB (panel 不应空白)
- 没设置 goal → Mentor 不 tick，onboarding 持续显示 "Define goal" CTA

---

### 3.4 Module 1 — State Strip (项目实时状态条)

**What it is** — cockpit 第一块，单行 + 一个进度条 + 当前 task 一句话 + 上一条 Mentor nudge。回答"项目现在跑得怎样"。

**Where to find it** — DOM `#cockpit-state` (L2651)：
- `#cockpit-status-dot` (○ / ● / ⚠)
- `#cockpit-status-text` ("loading…" / "running" / "blocked" / 等)
- `#cockpit-progress-bar` + `#cockpit-progress-text`
- `#cockpit-current-task` (当前 RUNNING task 的 intent 缩写)
- `#cockpit-mentor-nudge` (最新一条 mentor 写到 `scratchpad:mentor/<pid>/nudge/*` 的内容)

**How to test**
1. 项目有 RUNNING task 时 — 验证 status text 跟着 task state 转 (PENDING / RUNNING / BLOCKED / WAITING_REVIEW)
2. agent 在 30 秒内有动作 (heartbeat / scratchpad write) → state strip 应反映
3. 让 Mentor 触发一条 nudge (制造一个 BLOCKED task 带 question；见 §3.9) → mentor-nudge 行应在 ≤30s 内出现

**What success looks like** — 每 1 秒 polling 自动刷新；nudge 出现时不弹任何对话框 (Mentor 是悄悄做事的)。

**Edge cases worth poking**
- task 跨多个 session — 状态条仍只显示该 project 的当前 task
- task 已 DONE — current-task 行显示 "—" 或最近一条
- DB 不可读 — status text 应 fallback 显示 "DB unavailable" 类的友好错误而非崩溃

---

### 3.5 Module 2 — Steer (一句话引导 agent)

**What it is** — 一个输入框 + Send 按钮，不切 session 直接给当前活跃 agent 发条消息。两层投递：

- **Tier 1 (inject)** — 写到 `scratchpad:agent_inbox/<agent_id>/<ulid>`，Cairn-aware 的 agent (prompt 里包含 "check pending steer" 步骤的) 下一轮 iteration 会读
- **Tier 2 (clipboard fallback)** — 同时把 `[cockpit steer for <agent>] <message>` 拷到系统剪贴板，让用户 paste 到任何 agent 聊天框

**Where to find it** — DOM `#cockpit-steer` (L2665)：
- `#cockpit-steer-input` (text)
- `#cockpit-steer-send` (Send 按钮)
- `#cockpit-steer-status` (发送结果显示)

IPC handler: `main.cjs::cockpit-steer` (L859)。实现 `cockpit-steer.cjs::steerAgent`。

**How to test**
1. cockpit 里有至少一个 LIVE agent (process registered + heartbeat 新鲜)
2. 在 `#cockpit-steer-input` 里敲一句话 ("please stop and revert the last commit")
3. 点 Send 或按 Enter
4. 验证: status 行变绿显示 `delivered: inject, clipboard`；scratchpad 多一行 `agent_inbox/<agent>/<ulid>`；剪贴板里有 `[cockpit steer for <agent>] please stop...`

**What success looks like** — IPC 返回 `{ ok: true, delivered: ['inject','clipboard'], scratchpad_key: 'agent_inbox/...' }`。Activity feed (Module 3) 出现一行 "user-supervisor steer" 标签的事件 (D9.2 audit identity)。

**Edge cases worth poking**
- 输入超过 4096 字节 — 应被 `MAX_STEER_BYTES` 截断而不报错
- 没有 active agent — 返回 `{ ok:false, error: 'project_id_agent_id_message_required' }` 类
- 多 agent 时如何选 target — Module 2 是单 agent target 的 (`agent_id` 必传)。多 agent 场景下应有 UI 选择 (待验证：可能默认选最近 active 的)
- 关掉网络 — Tier 1 是本地 SQLite 写，应不受影响；Tier 2 是本地 clipboard，应不受影响

---

### 3.6 Module 3 — Activity Feed (时间排序流水账)

**What it is** — 5 类事件按时间倒序排：state changes (task transitions / outcomes) + agent writes + Mentor decisions + user steer + escalations。底色读起来像 `journalctl --follow` 或 Activity Monitor。

**Where to find it** — DOM `#cockpit-activity` (L2675)：
- `#cockpit-activity-list` (滚动容器)
- 过滤按钮 `data-filter="all|mentor|agent|state"`

**How to test**
1. 让一个 agent 通过 MCP 写 scratchpad / 创建 checkpoint / 提交 outcome — 验证事件冒出
2. 让 Mentor tick 触发一条 nudge — 验证带 `mentor` 标签的行出现
3. 用 `j` / `k` 上下滚 — 选中行应高亮
4. 点 `Mentor` 过滤按钮 — 只剩 mentor 来源；点 `agent` 只剩 agent；点 `all` 复原

**What success looks like** — 事件按 `ts` 降序；颜色编码 sev (info 蓝灰 / warn 黄底 / error 红底)；polling 1s 自动追加新行。

**Edge cases worth poking**
- 一次 1000+ 条事件 — 是否分页 / 截断 (未确认有上限)
- session 跨午夜 — timestamp 格式不爆掉
- 同一秒内 N 个事件 — 排序稳定 (按 ulid 二级排序)

---

### 3.7 Module 4 — Safety / Rewind (回退列表)

**What it is** — Cairn 的 "5 秒后悔药"。列出最近的 checkpoints (READY / PENDING / CORRUPTED 状态)，每个可以 Preview 看差异、Confirm 执行 git checkout 恢复。**包含安全 stash**：执行 rewind 前先 `git stash push -u`，自动写一行 auto-checkpoint，可再 rewind 回来。

**Where to find it** — DOM `#cockpit-safety` (L2689) + `#cockpit-checkpoints-list`。实现 `cockpit-rewind.cjs::previewRewind` / `performRewind`；IPC `cockpit-rewind-preview` / `cockpit-rewind-to` (main.cjs:884, 968)。

**How to test**
1. 在项目里手动跑 `cairn.checkpoint.create("before refactor")` 通过 CC
2. cockpit safety 区应出现该 checkpoint 行
3. 点 Preview — 弹出工作树 dirty/clean + 目标 git_head 可达性
4. 点 Confirm rewind (内联确认对话框是 D9.1 tier-B 闸门，必经)
5. 验证: 工作树文件回到 checkpoint 时的状态；`git stash list` 多一行 cairn 标签的 stash；checkpoints 列表多一行 auto-rewind 锚点 (可再回退)

**What success looks like** — preview 返回 `{ ok: true, current_dirty: <bool>, target_reachable: <bool>, summary: ... }`；execute 返回 `{ ok: true, stash_ref: ... }`。

**Edge cases worth poking**
- 工作树脏 + 没 commit — 应 stash 后才动；如果 stash 失败应 abort
- checkpoint 状态是 CORRUPTED — Preview 应直接 refuse，不让 Confirm
- 项目根不是 git repo — `cockpit-rewind.cjs` 用 spawnSync 调 git，应返回 `{ ok:false, error: 'not_a_git_repo', hint: ... }`
- rewind 期间 agent 还在写 — 没有真锁，但 stash 保护用户文件；测试时建议先静默 agent

---

### 3.8 Module 5 — Needs You (升级队列)

**What it is** — Mentor 处理不了的 PENDING 升级停在这里。**这是唯一会打扰人的地方**。每个 escalation 显示原因 + 来源 agent + 可点击 ack。Ack 后从队列消失。

**Where to find it** — DOM `#cockpit-needs` (L2728) + `#cockpit-needs-list`；空状态显示 "Mentor handling — agent on track."
IPC `cockpit-ack-escalation` (main.cjs:957)。升级写在 `scratchpad:escalation/<pid>/<ulid>` with `status: 'PENDING'`。

**How to test**
1. 触发一条 Mentor 规则 D 的 🛑 escalate 路径 — 比如让 CC 写 `cairn.task.block({ question: "should I npm publish?" })`，CAIRN.md 中 `🛑 npm publish` 会匹配
2. ≤30s 内 Module 5 应出现一行 PENDING 升级
3. 点 ack — 升级消失，scratchpad 行 status 变 `ACKED`

**What success looks like** — 默认空态文案 "Mentor handling — agent on track."；有升级时 needs-list 不空；托盘升级为琥珀或红。

**Edge cases worth poking**
- 多个并发 escalation — 按 ts 排序还是按 priority (代码: ulid 降序)
- ack 后 agent 又触发同样升级 — 应新写一行 (status 不会被 reused)
- 整个 CAIRN.md 缺失 — Rule D 走"conservative escalate"路径，**所有** blocker 都会冒到 Module 5 (这是有意的安全 fallback)

---

### 3.9 Mentor 自动 tick 引擎

**What it is** — 30 秒一次的内部循环 (`mentor-tick.cjs::runOnce`)，遍历所有注册项目 → 找 RUNNING tasks → 按 7 条规则 (当前 D/E/G wired；B/F 等 tail.log；A/C 是 LLM 占位) 决定 nudge / 升级 / 静默。**这是"你走开，Cairn 接管"的核心**。

**Where to find it** — `mentor-tick.cjs` + `mentor-policy.cjs` + `mentor-project-profile.cjs` (CAIRN.md 缓存) + `mentor-agent-brief.cjs`。`main.cjs:2432` 在非 LEGACY 模式启动。

**当前生效的规则**:
- **Rule D** — BLOCKED task 带 question。3-layer 决策：L1.0 CAIRN.md `Known answers` 子串 → 直接 nudge；L1.1 `🛑 escalate` 匹配 → 升 Module 5；L1.2 `✅ auto_decide` → 静默 nudge；L1.3 `⚠️ decide_and_announce` → nudge + announce；都不匹配 → conservative escalate。
- **Rule E** — task time budget 命中 80% → 升 Module 5 (默认 `defaultTaskBudgetMs=0` 即无 budget；得 per-project 配置)
- **Rule G** — outcome 评估 FAIL → 第一次重试，第二次升

**未生效**：Rule B (编译/测试错) 和 Rule F (abort 关键字 `rm -rf` / `force push` 等) 都需要 tail.log 扫描，roadmap。Rule A / C (LLM 判断 ambiguity / off-goal drift) Phase 6 hook，placeholder。

**How to test**
1. CAIRN.md 内里写一条 `Known answers` 行：`- which language => TypeScript`
2. 让 CC 起一个 task 然后 `cairn.task.block({ question: "which language should I use?" })`
3. 等 ≤30s — 应在 Activity feed 看到一条 mentor nudge，content 引用 "TypeScript"；blocker 应 auto-answer 进 ANSWERED；task 走到 READY_TO_RESUME
4. 测试 🛑 路径：再起一个 task，question = "should I npm publish?"。CAIRN.md 默认有 `🛑 npm publish`。等 30s — Module 5 出现 PENDING 升级，task 不被 auto-answer

**What success looks like** — `runOnce` 每 30 秒打一行 `cairn mentor auto-tick — started (every 30s)` (启动时)；每次 tick 在 stdout 静默 — 验证靠观察 scratchpad keys (`mentor/<pid>/nudge/*` / `escalation/<pid>/*`) 多了行。

**Edge cases worth poking**
- CAIRN.md 改了 — 下一个 tick 用新内容 (mtime-gated cache reload)
- agent_brief 老于 30 分钟 — Rule D 仍读，但加 `stale` 标记
- 同一个 task 反复 BLOCKED 同一 question — 应保持 nudge count 在 `mentor_state/<task_id>`，避免无限重试

---

### 3.10 CAIRN.md — 每项目策略文件

**What it is** — 一个 commit 进 git 的 markdown，规定本项目里 Mentor 可以决策什么、必须升级什么、有什么 Known answers。**它是 Mentor 决策的 L1 输入**。Schema 见 `docs/CAIRN-md-spec.md`。`cairn install` 首次会脚手架空模板。

**Where to find it** — 项目根 `CAIRN.md` (与 `CLAUDE.md` 并列，两份角色不同：CAIRN.md 是项目主的策略；CLAUDE.md 是给 coding agent 的 playbook)。

**包含的章节** (全部 optional)：
- `## Goal` — 一句话项目目标
- `## What this project IS / IS NOT` — IS / IS NOT 双 bucket
- `## Mentor authority (decision delegation)` — ✅ / ⚠️ / 🛑 三 bucket，**核心**
- `## Project constraints` — 跨切面约束
- `## Known answers` — `question substring => canonical answer` 行
- `## Current phase` — 当前阶段 + this/next week

**How to test**
1. 装 cairn 进一个新项目，看 `CAIRN.md` 被脚手架
2. 编辑 `✅` bucket 添一行 `- ✅ pick vitest when blocker asks "which test framework"`
3. 让 CC 起 task + `cairn.task.block({ question: "which test framework should I use?" })`
4. ≤30s Mentor 应 auto-answer (静默 nudge 进 Activity)
5. 改一行进 `🛑` bucket - `- 🛑 modify production database` 然后让 CC block 一个匹配的 question — Mentor 走 escalate 路径

**What success looks like** — Cairn 自己 dogfoods 自己 — `D:\lll\cairn\CAIRN.md` 是真实的 production CAIRN.md，可以参考。

**Edge cases worth poking**
- 文件不存在 — `loadProfile` 返回 `{ exists: false }`，Mentor 走 conservative escalate
- 文件存在但 sections 全空 — 等价于不存在
- mid-tick 删除 CAIRN.md — cache 还在，下次 mtime 检查后 invalidate
- bullet 用 ASCII tag (`auto:` / `announce:` / `escalate:`) 替代 emoji — 应被 scanner 同样识别 (CAIRN-md-spec.md §"Section semantics")

---

### 3.11 LLM 辅助 helpers (tail summary / conflict explainer)

**What it is** — 4 个挂钩 (Phase 6 wired 2 个，2 个 stubbed)：

| Helper | 默认 | 用途 |
|---|---|---|
| tail.log → 3 行总结 (did / stuck / next) | **ON** | 长 worker tail 一秒看懂 |
| conflict diff explainer | **ON** | 两个 agent 改同文件，给一行解释 |
| inbox smart sort | OFF | Stub |
| goal input assist | OFF | Stub |

**Where to find it** — `cockpit-llm-helpers.cjs`；IPC `cockpit-summarize-tail` (L912) / `cockpit-explain-conflict` (L924)。Provider 走 `llm-client.cjs` — 读环境变量 (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等；具体见 llm-client.cjs)。

**How to test**
1. 在 shell 里 `export ANTHROPIC_API_KEY=sk-ant-...` (或对应 provider)
2. 启动 desktop-shell
3. 触发一个长 worker tail (managed loop) 或手动调 IPC `cockpit-summarize-tail`
4. 期望返回 `{ ok: true, content: "did: ...\nstuck: ...\nnext: ..." }`

**What success looks like** — 3 行总结 ≤80 字符每行；返回 `model` 字段标明用的哪个 cheap model (haiku 类)。

**Edge cases worth poking**
- 无 API key — 返回 `{ ok:false, reason: 'no_provider' }`
- HTTP 429 — 现在的 dogfood-llm-tail-summary.mjs 有"INFRA-OK grace" — 测试时碰到 rate limit 不应崩 panel
- Tail 太长 — 代码截最后 6000 字节

---

### 3.12 桌面宠物 / 悬浮 marker

**What it is** — 屏幕一角的小窗口，alwaysOnTop，承担"环境感知"功能 — 你在做别的事时它仍然在 (类似 Discord 小窗 / Activity Monitor 小窗)。

**Where to find it** — `petWindow` (`main.cjs:258`)，load `preview.html`。`setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces`。

**How to test**
1. 启动 desktop-shell，看屏幕一角是否有小窗
2. 用鼠标拖动 — 应该可拖
3. 切到全屏 / 别的 workspace — pet 仍可见
4. 关掉主面板 (X 按钮) — pet **不应**关闭 (托盘 + 宠物保活；只有托盘菜单 Quit 真退出)

**What success looks like** — pet always on top，不被普通窗口盖；关闭面板后还在。

**Edge cases worth poking**
- pet sprite 当前查 legacy schema `lanes` (README §Roadmap "Floating-marker schema drift fix") — **已知 bug**，roadmap 修。你可能看到 pet 状态不准。
- 多显示器 — pet 应跟最近的活跃窗口屏

---

### 3.13 Legacy Inspector (隐藏，env 触发)

**What it is** — v0.1 之前的旧 5-tab inspector 视图。**默认不可达**。设置 `CAIRN_DESKTOP_ENABLE_MUTATIONS=1` 后，菜单出现 "Open Legacy Inspector"，里面有一个 conflict Resolve 按钮 (唯一 enable-mutations 之外解锁的 write 路径)。

**Where to find it** — `inspector-legacy.html` + `inspector-legacy.js`。`main.cjs:106 MUTATIONS_ENABLED` 读 env。

**How to test (开发/QA 才需要)**
1. `set CAIRN_DESKTOP_ENABLE_MUTATIONS=1 && npm start`
2. 启动后控制台应有 `⚠ desktop mutations enabled (CAIRN_DESKTOP_ENABLE_MUTATIONS=1) — dev only`
3. 头部菜单 (⋯) 多 "Open Legacy Inspector" 项
4. 内部 conflict 视图可点击 Resolve

**Edge cases worth poking**
- 不设 env 时菜单项应**不可见**，IPC 应拒绝 mutation 调用
- 这是开发后门，不是产品功能 — 别把它当 QA case 主流

---

## 4. 测试路径

### 4.1 Happy Path (端到端)

> 目标：从全新机器 → Cairn 跑起来看到一个真实 agent 干完小活 → 重启后状态保留。

1. **Build**
   - clone Cairn → `cd packages/daemon && npm install && npm run build`
   - `cd ../mcp-server && npm install && npm run build`
   - `cd ../desktop-shell && npm install`
2. **Launch desktop-shell** (在 cairn 仓库)
   ```bash
   cd packages/desktop-shell && npm start
   ```
   控制台应打印 `cairn desktop-shell ready — mode=panel mutations=off tray=on projects=N`
3. **托盘 + pet + 侧边窗都起来** — 灰色托盘 / 屏幕角 pet / 右侧 L1 列表
4. **Add Cairn repo as a project** — 点 `＋ Add project…` → 选 `D:\lll\cairn`
   - L1 卡片出现
   - **后台 daemon 一键完成**：`.mcp.json` + pre-commit hook + start-cairn-pet 脚本写入项目根目录；haiku (如果配了 provider) 起草 `CAIRN.md` (写 `## Whole` 北极星 + ✅/⚠️/🛑)；若已 attached CC，往它的 `agent_inbox` 塞 refinement 请求。
   - 验证: `.mcp.json` / `.git/hooks/pre-commit` (含 `# cairn-pre-commit-v1`) / `CAIRN.md` 都存在 (这个 repo 已有 CAIRN.md 会被 preserve；新 repo 会拿到 haiku 起草版或 scaffold 兜底版)
   - Panel cockpit Module 1 顶部应出现一行带绿色侧条的 `Whole: <一句话>` (CAIRN.md `## Whole` 字段) ← schema-v2 surface (2026-05-14)
5. **打开 Claude Code 在 D:\lll\cairn 里**，让 CC 重读 `.mcp.json`。问 CC: "list the files in packages/daemon" — 让它实际跑一个小任务，最好这样开局：
   - "create a cairn task with intent='list daemon files', start_attempt, then write the result to scratchpad key 'demo/result' and submit_for_review with criteria=[{primitive: 'scratchpad_key_exists', args:{key:'demo/result'}}]"
6. **观察 cockpit (L2)**
   - 在 panel 里点项目卡 → 进入 cockpit
   - State Strip 顶部出现 `Whole: <一句话>` (CAIRN.md `## Whole` 行)
   - State Strip 中段显示 task = RUNNING 然后 WAITING_REVIEW 然后 DONE
   - Activity feed 应出现一连串 state 转换事件 + scratchpad write 事件
7. **观察 Mentor**
   - 在 CC 那头加一步：`cairn.task.block({ question: "which test framework should I use?" })`
   - 等 ≤30s — 因为 `D:\lll\cairn\CAIRN.md` 的 Known answers 里有 `which test framework => vitest...`，Mentor 应自动 answer 这个 blocker
   - Activity feed 出现一条 `mentor/.../nudge/*` 行；Module 5 应仍空 (Mentor 处理了)
8. **检查 rewind 列表** — Module 4 应有刚才 CC 创建的 checkpoint (如果 CC 调过 checkpoint.create)
9. **退出 Cairn** — 托盘右键 → Quit
10. **重启 Cairn** — 再跑 `npm start`，L1 仍显示该项目；cockpit 仍能看到刚才的 task DONE 历史 (SQLite 持久化)

#### Happy path 全绿验收

- [ ] 托盘有图标且颜色随状态变
- [ ] L1 出现刚 add 的项目
- [ ] cockpit 5 模块全显示
- [ ] task 走完完整状态机
- [ ] Mentor 触发了至少 1 次 nudge
- [ ] Module 5 在 Mentor 处理时保持空 (不打扰用户)
- [ ] 重启后所有状态保留

### 4.2 Branch A — 中途删了 CAIRN.md

1. happy path 跑到第 6 步后，删了 `D:\lll\cairn\CAIRN.md`
2. 让 CC 触发一个 `task.block({ question: "which test framework?" })`
3. **期望**：Mentor 走 "conservative escalate" 路径，Module 5 出现 PENDING 升级，**不**自动 answer。这证明 Mentor 没有"幻觉"答案 — 没有 CAIRN.md 就保守。
4. 把 CAIRN.md 恢复 (`git checkout CAIRN.md`)，触发下一个 tick (等 30s) — 下次 blocker 又能自动处理

### 4.3 Branch B — agent 想做 npm publish 之类的危险操作

1. 让 CC 发起 `cairn.dispatch.request({ intent: "npm publish @cairn/mcp-server" })` 或 task.block 时 question 含 "npm publish"
2. CAIRN.md 默认有 `🛑 npm publish`
3. **期望**：升级直接进 Module 5；scratchpad `escalation/.../<ulid>` status=PENDING
4. 点 ack — 升级消失，user 显式接管这个决策

### 4.4 Branch C — 加一个不是 git 仓库的目录

1. L1 点 `＋ Add project…` → 选一个普通文件夹 (比如 `C:\Users\<you>\Downloads`)
2. **期望**：项目仍被添加 (`canonicalizeToGitToplevel` 静默回退原路径)；但 cockpit 进去后:
   - 没有 checkpoints 可用 (Module 4 空)
   - rewind 任何尝试都返回 `{ ok:false, error: 'not_a_git_repo' }` 类错误
   - Activity feed 仍能收 MCP 事件 (如果该目录里有 agent 跑)
3. 这是 graceful degradation 测试 — 不应崩，只是某些功能不可用

### 4.5 Branch D — Mentor LLM helper 没 provider

1. 不设任何 `*_API_KEY` 环境变量
2. 触发 tail summary (managed loop 或直接 IPC 调用)
3. **期望**：返回 `{ ok:false, reason: 'no_provider' }`；panel 显示"helper unavailable"类提示，**不**应 throw

### 4.6 Branch E — 多个 agent session 同时跑

1. 在 Cairn repo 里开两个独立 terminal session，各自启动一个 Claude Code (或一个 CC + 一个 Cursor)
2. 每个 mcp-server 启动时生成独立 `cairn-session-<12hex>` agent_id
3. 两个 agent 同时改 `shared/types.ts` (或随便同一个文件)，都通过 cairn.checkpoint.create 表达写意图
4. **期望**：cockpit Activity feed 显示两个 agent 的活动；conflicts 表写入 OPEN 行；托盘转红 (alert)；Module 5 不一定升级 (conflict 是非阻塞的，pipeline 继续)
5. 让一个 agent 调 `cairn.conflict.resolve` — Activity 显示解决，托盘回 idle

---

## 5. 期望行为 vs 已知边界 (容易误以为 bug)

| 现象 | 是 bug 吗 | 原因 |
|---|---|---|
| "Mentor 没 nudge" | **No** | 可能 (a) 没 CAIRN.md / 该 bucket 空，走 conservative escalate (b) tick 间隔 30s 还没到 (c) task 不是 RUNNING (d) project 没有可发现的 agent_id_hints |
| "Activity feed 偶尔空" | **No** | feed 是 1s polling SQLite，没事件就空。Run Log 高保真版是 Later。 |
| "我点 Send 但消息没发，剪贴板却被改了" | **By design** | Steer 是双层投递 (inject + clipboard)；inject 失败 (没活 agent) 时 clipboard 是 fallback。Tier 2 是 D9.1 tier-A first-class，无环境标志可关。 |
| "面板没 mutation 按钮 (Resolve / Cancel task)" | **By design** | D9 lock：默认 read-only。Steer (Module 2) 和 Rewind (Module 4) 是 D9.1 tier-A/B 解锁的第一类例外。其它 mutation 走 legacy + `CAIRN_DESKTOP_ENABLE_MUTATIONS=1`。 |
| "关掉 panel 程序还在跑" | **By design** | 托盘 + pet 才是退出入口；X 只 hide。`window-all-closed` handler 守护此行为。 |
| "Pet 状态看着不对" | **Known bug** | `preview.js` sprite 规则查的是 legacy `lanes` schema (README §Roadmap "Floating-marker schema drift fix")。等 migration。 |
| "BLOCKED task 在那放 1 小时没动" | **Not a HITL gate** | 严格说 `BLOCKED` 是 escalation path，不是阻塞门。任何 caller (另一个 agent / 用户) 调 `cairn.task.answer` 都能继续。Mentor 没匹配规则就只是不动。 |
| "Cairn 不能帮我决定要不要发 PR" | **By design** | Cairn 不写代码 / 不做战略决策。`🛑` 类决策永远走外部 coding agent。 |
| "没有 npm install @cairn/mcp-server" | **By design (v0.1)** | 还没 npm publish (CHANGELOG.md [0.1.0])。装是 clone + build + 绝对路径。 |
| "Module 1 progress bar 看不出进度" | **Unknown** | 当前查 task counts，不是真实 progress；后续可能 LLM-derived。 |

---

## 6. 边角与诊断

### 6.1 启动命令

```bash
cd packages/desktop-shell

# 正常启动 (default panel + tray + pet)
npm start

# 开发模式 (启用 legacy inspector + 解锁 Resolve 等 mutation)
set CAIRN_DESKTOP_ENABLE_MUTATIONS=1
npm start

# Smoke 模式 (boot test，3 秒自动 quit)
set CAIRN_DESKTOP_BOOT_TEST=1
npm start

# Legacy-only 视图 (跳过 panel，直接旧 inspector)
set CAIRN_DESKTOP_LEGACY=1
npm start
```

### 6.2 SQLite 看现场

```bash
# 全局 DB
sqlite3 %USERPROFILE%\.cairn\cairn.db "SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 10;"

# Per-project DB (如果项目用本地 DB)
sqlite3 <repo>\.cairn\cairn.db "SELECT key, value_json FROM scratchpad WHERE key LIKE 'mentor/%' ORDER BY updated_at DESC LIMIT 20;"

# 看 Mentor 升级
sqlite3 %USERPROFILE%\.cairn\cairn.db "SELECT key, value_json FROM scratchpad WHERE key LIKE 'escalation/%' AND value_json LIKE '%PENDING%';"
```

### 6.3 跑 smoke 验证 (开发者重现 QA bug 时)

```bash
cd packages/desktop-shell

# Mentor 3-layer 决策路径 (64/64 assertions)
node scripts/smoke-mentor-3layer.mjs

# Mentor tick engine (16/16)
node scripts/smoke-mentor-tick.mjs

# Cockpit state aggregate (48/48)
node scripts/smoke-cockpit-state.mjs

# Steer module (22/22)
node scripts/smoke-cockpit-steer.mjs

# Rewind module (25/25)
node scripts/smoke-cockpit-rewind.mjs

# 跨 3 session 的 W5 闭环 (32/32)
cd ../mcp-server && npm run build
node scripts/w5-phase3-dogfood.mjs

# Real LLM dogfood (需 API key；429 容忍)
cd ../desktop-shell
node scripts/dogfood-llm-tail-summary.mjs
node scripts/dogfood-llm-3layer.mjs
```

### 6.4 卡住的时候

| 症状 | 检查 |
|---|---|
| `Cannot find module 'better-sqlite3'` | `npm install` 是否跑过；prebuild-install 是否拉到 Electron 32 binary |
| `cairn desktop-shell ready` 不打印 | Electron 是否启动 (任务管理器看 `electron.exe`)；防火墙拦不拦 |
| CC 看不到 `cairn.*` 工具 | `.mcp.json` 路径是绝对吗；CC 是否重启过；`node <path>/index.js` 手跑能否打印 stdio handshake |
| 托盘图标显示但点不响 | `tray.on('click', togglePanel)` (main.cjs:626) — 检查 panelWindow 是否被 destroyed 而非 hidden |
| Mentor 完全不动 | 控制台是否打印 "cairn mentor auto-tick — started"；如果没打印 — 检查 `LEGACY_MODE` 和 `BOOT_TEST` env |

---

## 7. 测试清单 (Checklist 表格)

### 7.1 安装与启动

- [ ] daemon 和 mcp-server 都成功 `npm run build`
- [ ] `cairn install` 在测试 repo 里写入 `.mcp.json` / pre-commit / `CAIRN.md` / launcher
- [ ] `cairn install --dry-run` 不写入任何文件
- [ ] `cairn install --help` 退出 0，列出 flags
- [ ] `cairn install --version` 打印版本号
- [ ] 未知 flag (`cairn install --foo`) 退出 2，给 usage hint

### 7.2 桌面壳启动

- [ ] `npm start` 弹出 panel + tray icon + pet (三者皆有)
- [ ] 控制台打印 `cairn desktop-shell ready — mode=panel mutations=off tray=on ...`
- [ ] 控制台打印 `cairn mentor auto-tick — started (every 30s)`
- [ ] 关掉 panel 后 tray 仍在；通过 tray Quit 才真退

### 7.3 L1 项目列表

- [ ] 空状态有 `＋ Add project…` 按钮
- [ ] 点 Add 弹原生目录选对话框
- [ ] 取消对话框不报错
- [ ] 选 git repo → 新卡片显示 + DB path
- [ ] 选非 git 目录 → 仍添加，graceful
- [ ] 点卡片进 cockpit；ESC 回 L1 (没"半透"叠层)

### 7.4 L2 cockpit 5 模块

- [ ] State Strip 显示 dot + status + progress + current task + mentor nudge
- [ ] Steer 输入 + Send 后 status 行变绿；scratchpad 多 `agent_inbox/...`；剪贴板有内容
- [ ] Activity feed 按时间倒序显示；过滤按钮 (all/mentor/agent/state) 工作
- [ ] Safety 区显示 checkpoints；Preview 不破坏工作树；Confirm 之前有 inline 确认
- [ ] Needs You 默认空文案 "Mentor handling — agent on track."

### 7.5 键盘快捷键

- [ ] `j` / `k` 在 activity 列表上下
- [ ] `/` 聚焦 steer 输入
- [ ] `Enter` 在 steer 输入里发送
- [ ] `Esc` 从 cockpit 回 L1；从 help overlay 关闭 overlay
- [ ] `?` 打开 help overlay

### 7.6 Mentor 行为

- [ ] CAIRN.md `Known answers` 命中 → 自动 nudge，不打扰用户
- [ ] CAIRN.md `🛑` 命中 → Module 5 升级
- [ ] CAIRN.md 缺失 → conservative escalate (所有 blocker 升级)
- [ ] 30 秒 tick 周期 (tail `mentor/<pid>/nudge/*` ulid 时间戳验证)
- [ ] 同一 task 反复 BLOCKED 不会无限重试 (nudge_count 计数)

### 7.7 状态持久性

- [ ] Quit Cairn → 重启 → L1 项目仍在
- [ ] 跨 session task 状态 (PENDING/RUNNING/DONE) 保留
- [ ] 重启后 Activity feed 仍能读历史事件

### 7.8 工具调用 (通过 Claude Code)

- [ ] `cairn.task.create` / `start_attempt` / `submit_for_review` / `outcomes.evaluate` 走完整 DONE
- [ ] `cairn.scratchpad.write` 大于 128KB 自动 spill 到 `~/.cairn/blobs/`
- [ ] `cairn.checkpoint.create` 生成 PENDING → READY 两阶段记录
- [ ] `cairn.rewind.preview` 显示 will-change / will-not-change 列表
- [ ] `cairn.conflict.list` 在 pre-commit hook 触发后多新行

### 7.9 已知限制 (确认覆盖，不一定要修复)

- [ ] 默认 read-only — panel 没有显式 Resolve / Cancel 按钮
- [ ] Pet sprite 状态偶尔不准 (legacy schema drift)
- [ ] 没 LLM provider key 时 helpers 优雅退化
- [ ] 大并发 (N=50) 写入有性能下降 (PoC-1 documented)

---

## 附录 A. 命令与脚本速查

```bash
# 编译
cd packages/daemon       && npm install && npm run build
cd packages/mcp-server   && npm install && npm run build
cd packages/desktop-shell && npm install

# 装到目标项目
cd <target-repo>
node <cairn-path>/packages/mcp-server/dist/cli/install.js
# flags: --help / --version / --dry-run

# 启动桌面壳
cd packages/desktop-shell && npm start

# 测试 (开发者侧)
cd packages/daemon     && npm test    # 411 tests
cd packages/mcp-server && npm test    # 359 tests (W5 + cockpit baseline)

# Smoke (desktop)
cd packages/desktop-shell
node scripts/smoke-mentor-3layer.mjs       # 64/64
node scripts/smoke-mentor-tick.mjs          # 16/16
node scripts/smoke-cockpit-state.mjs        # 48/48
node scripts/smoke-cockpit-steer.mjs        # 22/22
node scripts/smoke-cockpit-rewind.mjs       # 25/25

# 真 LLM dogfood (需 ANTHROPIC_API_KEY / OPENAI_API_KEY)
node scripts/dogfood-llm-tail-summary.mjs
node scripts/dogfood-llm-3layer.mjs

# 端到端 (3 session real stdio)
cd packages/mcp-server && npm run build
node scripts/w5-phase3-dogfood.mjs          # 32/32

# 环境变量
CAIRN_DESKTOP_ENABLE_MUTATIONS=1   # 解锁 legacy mutation (dev only)
CAIRN_DESKTOP_LEGACY=1             # 直接进 legacy inspector，不开 panel
CAIRN_DESKTOP_BOOT_TEST=1          # 3 秒自动 quit，CI 用
CAIRN_DISPATCH_FORCE_FAIL=1        # 强制 dispatch 进 FAILED (demo)
```

---

## 附录 B. 名词表

| 词 | 含义 |
|---|---|
| **Cairn** | 本产品。一个 host-level 多 agent 协调 kernel + 项目控制面板 |
| **kernel layer** | 底层；8 张 SQLite 表 + 28 个 MCP 工具，提供给 agent 调用 |
| **product layer** | 用户看到的；侧边窗 + 托盘 + 悬浮宠物 |
| **MCP** | Model Context Protocol，Anthropic 推的工具协议；Cairn 实现 `cairn-wedge` MCP server |
| **cairn-wedge** | MCP server 在 `.mcp.json` 里的标识；Claude Code 通过它调 cairn 工具 |
| **agent_id** | 一个 Cairn session 的唯一标识；格式 `cairn-session-<12hex>`；自动注入 |
| **task** | 一个 durable work item，跨 session 存活；状态机 8 态 |
| **blocker** | task 卡住等答的问题；status OPEN/ANSWERED |
| **outcome** | task 完成验收记录；评估 DSL criteria PASS/FAIL |
| **checkpoint** | git 工作树快照锚点；可 rewind |
| **conflict** | 两个 agent 写意图重叠的记录；OPEN/PENDING_REVIEW/RESOLVED |
| **dispatch** | NL 意图 → 选择 agent + 生成 prompt → 待确认；R1-R6 fallback rules |
| **scratchpad** | 共享 key-value store；agent 写中间结果给其它 agent / Mentor 看 |
| **agent_inbox** | scratchpad 命名空间 `agent_inbox/<agent>/<ulid>`；Steer 写到这 |
| **mentor nudge** | Mentor 自决的 hint，写到 `mentor/<pid>/nudge/<ulid>`；不打扰用户 |
| **escalation** | Mentor 升级，写到 `escalation/<pid>/<ulid>` status PENDING；进 Module 5 |
| **agent_brief** | 来自 agent 自己的自述 (L2 决策输入)；scratchpad `agent_brief/<agent_id>` |
| **CAIRN.md** | 项目策略文件 (L1 决策输入)；规定 ✅/⚠️/🛑 + Known answers |
| **L1 / L2 / L3** | 在 Mentor 上下文：决策的三层 (CAIRN.md / agent_brief / LLM polish)；**不同于** UI 视图的 L1=项目列表 / L2=cockpit |
| **D9 / D9.1** | PRODUCT.md 的 desktop-shell 默认 read-only 决定 + responsible mutation 三层例外 |
| **HITL** | Human-in-the-loop；Cairn 设计上**没有**真正阻塞性 HITL，只有 escalation paths |
| **happy path** | 测试用最常见无错误流程；本指南 §4.1 |

---

> 本文档基于 commit `17b0358` (2026-05-13 HEAD) 编写。代码或行为相对此 commit 漂移时，以代码为准、回溯本文件 git history 重对。
