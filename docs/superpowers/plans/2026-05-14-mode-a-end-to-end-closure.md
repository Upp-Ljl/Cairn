# Mode A 端到端闭环 — 真正打通

> Status: **DESIGN — 鸭总审中，未实施**。写于 2026-05-14 EOD。
> 起因：CEO 鸭总今天反复试 Mode A "看不到反应"，我一路打地鼠（fix 一个 bug 引出下一个），没系统看完整路径。本文盘清整条 Mode A 触发链每一跳的前置 / 失败点 / 已修状态，**先让鸭总审，点头后再按顺序补**。

---

## 1. 用户视角的"一切应该是这样"

```
1. 鸭总在面板顶部把项目切到 Mode A
2. 鸭总确保 goal 填了 + success_criteria ≥ 1 条（前提）
3. ≤ 30 秒后 → Mode A widget 显示 "N 条 criteria · 等待 Mentor 起草…"
4. ≤ 60 秒后 → widget 显示 "0/N · 当前 #1" + 4 个步骤的清单
5. 第一步同时被派单到一个 Cairn-aware agent session
6. 那个 session 拿到 dispatch 后开始干活
7. 干活过程中如果 agent 被卡（cairn.task.block），Mentor 自动答
8. 干完写 outcomes PASS → mentor-tick 把步骤标 DONE，自动派下一步
9. 全部 DONE → plan.status = COMPLETE → "走开就行"成立
```

---

## 2. 实际数据流（每一跳）

### 跳 #1 — 用户点 "A · 自动驾驶" 按钮

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| `panel.html` `#cockpit-mode-A.click` | 调 `window.cairn.cockpitSetMode(pid, 'A')` | 按钮没绑 → 历史 commit 1fc6bf4 修过 |
| `preload.cjs::cockpitSetMode` | IPC `set-cockpit-settings` | — |
| `main.cjs::set-cockpit-settings` | `registry.setCockpitSettings(reg, pid, {mode:'A'})` 改 in-memory + `saveRegistry` 写盘 | **旧 bug：`writeRegistry` 是幻影函数**，已修 commit 1fc6bf4 → `saveRegistry` |
| `~/.cairn/projects.json` | `project.cockpit_settings.mode = 'A'` 持久化 | — |
| panel 下次 poll (1s) | renderCockpit 看 `state.mode === 'A'` → A 按钮高亮 | — |

✅ 这一跳 OK。诊断脚本 Gate 1 验证通过。

### 跳 #2 — Goal + success_criteria 写入

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| `panel.js::openGoalEditModal` | 弹出完整表单 (title / desired_outcome / success_criteria / non_goals) | **旧 bug**：cockpit onboarding 用了 `openGoalModal()` 只有 title，已修 commit d0e7818 |
| Save 按钮 → `window.cairn.setProjectGoal(pid, {...})` | IPC `set-project-goal` | — |
| `main.cjs::set-project-goal` | `registry.setProjectGoal` → 内部 saveRegistry | — |
| 编辑表单预填 | `openGoalEditModal(lastGoal)` 读 lastGoal | **旧 bug**：`lastGoal` 只在 legacy view 渲染时被设；cockpit 视图 lastGoal 一直 null → 编辑空表单 → Save 覆盖 → 数据丢失。已修 commit 5a07d47 通过 `state.goal_full` 同步 |

✅ 这一跳 OK。诊断脚本 Gate 2 验证：鸭总现在 success_criteria 是 4 条。

### 跳 #3 — mentor-tick 周期性触发

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| `main.cjs:2803` 启动时 `mentorTick.start(...)` | setInterval 30s → `runOnce(deps)` | LEGACY_MODE / BOOT_TEST 跳过 — 不是我们这次的问题 |
| `mentor-tick.runOnce` 遍历 `deps.reg.projects` | for each project 做 ensureDbHandle / 各路 Mentor 检查 | **❌ 当前阻塞 (1)**：deps.reg 是 getter 拿最新 reg，但 mentor-tick 内部使用时是不是真的拿到刚才 set-project-goal 后的 reg？需要验证 |
| 每个 project 的 dbPath sentinel 回落 | `/dev/null` / `(unknown)` → `DEFAULT_DB_PATH` | ✅ 已落地 |
| `deps.ensureDbHandle(dbPath)` 返回 `{db, tables}` | 给 mentor-tick 用 | **❌ 当前阻塞 (2) — 已修 commit e901db1**：mentor-tick 之前拿 readonly handle，每次写 SQLite 都 `attempt to write a readonly database`。修后用 `ensureWritableDbHandle`。**但鸭总必须重启面板才生效**（main.cjs 改了） |

### 跳 #4 — Mode A 分支起草计划

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| `mentor-tick.cjs:312` 判断 `cockpitSettings.mode === 'A'` | true → 走 Mode A 分支 | — |
| `modeALoop.runOnceForProject(deps)` | 调用链：ensurePlan → advanceOnComplete → decideNextDispatch | — |
| `ensurePlan` 写 scratchpad `mode_a_plan/<pid>` | DB INSERT/UPDATE | 上面 readonly bug 修了之后这里应该过 |
| 返回 `{action:'drafted', plan}` + `dispatch_request` decision | — | — |

### 跳 #5 — 派单 (decideNextDispatch)

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| `decideNextDispatch(db, project, plan, agentIds, opts)` | 必须满足三件事：plan.steps 非空 + agentIds 非空 + ≥1 `processes.status='ACTIVE'` | **❌ 当前主阻塞 (3) — 未验证**：鸭总面板里 sessions 显示 IDLE / STALE。如果 processes.status 实际就是 'IDLE'，**dispatch 永远不会发生**，无论 plan 起草多成功 |
| 选 target_agent → 调 `cockpitDispatch.dispatchTodo(...)` | INSERT dispatch_requests + UPDATE scratchpad | source='mode-a-loop'，旧 bug 已修 commit 6e40978 |
| `markStepDispatched` 写 step.state='DISPATCHED' | DB UPDATE | OK |

### 跳 #6 — Agent 拿到 dispatch + 干活

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| Agent (CC session) 必须**正在跑**、必须 cairn-aware skill v5 已装 | 周期性 poll agent_inbox / 拿 dispatch | **❌ 当前阻塞 (4) — 未验证**：鸭总当前的 agent-game-platform 项目下有没有真的 CC session 跑着？面板 sessions 区显示的 04ccc92c (IDLE) 和 44a64b3b (STALE) 可能是历史会话残留 |
| Agent 接到 dispatch → 创建 task → state='RUNNING' | INSERT tasks | 完全在 agent 那边，不归 Cairn 控 |

### 跳 #7 — Mentor 自动答 blockers (Mode A 专属)

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| 下一次 mentor-tick | 扫 `blockers WHERE status='OPEN'` AND `tasks.created_by_agent_id IN (hints)` | OK |
| 5 个 detector 依次尝试 → 最坏走 fallback | UPDATE blockers status='ANSWERED' | readonly fix 之后 OK |
| Agent 必须**回头看** blocker | skill v5 教过 (cairn.task.resume_packet poll) | 需要 agent 端真的 follow skill 协议 |

### 跳 #8 — 推进 + 完成

| 入口 | 做什么 | 失败模式 |
|---|---|---|
| Agent 写 outcomes PASS | INSERT outcomes | agent 端 |
| 下一次 mentor-tick → advanceOnComplete | 看 dispatch_requests.task_id → outcomes.status='PASS' → step DONE + current_idx++ | OK |
| 推到 plan.steps.length → status='COMPLETE' | — | — |

---

## 3. 当前还未关闭的阻塞清单（**先审这个**）

按优先级排序，**不修任何**，等鸭总点头哪条先动：

### B1 — readonly DB handle（已修代码，未验证）
- Commit `e901db1` 已上 main，加了 `ensureWritableDbHandle`
- **鸭总必须 kill Electron + `npm start` 重启面板**，main.cjs 改动才生效
- 验证方法：重启后过 30s 查 `tail -5 ~/.cairn/logs/cairn-<date>.jsonl`，应该看不到 "readonly database" 错误
- **没重启则等于没修**

### B2 — `state.goal_full` 拿不到完整 goal 对象（已修代码，未验证）
- Commit `5a07d47` 已上 main
- 鸭总 ✎ 编辑后表单应该预填 4 条 success_criteria 而不是空的
- Mode A widget 应该看到 success_criteria > 0，不再卡在"缺 success_criteria"
- **也需要重启面板**

### B3 — ACTIVE process 缺失（**未确认根因 — 最可能的硬阻塞**）
- decideNextDispatch 严格要求 `processes.status='ACTIVE'`
- 鸭总面板 sessions 区显示 04ccc92c (IDLE) 和 44a64b3b (STALE)
- IDLE 标签来自 panel 端 queries.cjs 的渲染派生 OR 来自 processes.status='IDLE' — **不确认是哪个**
- 如果是 status='IDLE'，**B1 / B2 修完仍然不会派单**
- 如果是 status='ACTIVE' 但 last_heartbeat 老，渲染派生成 IDLE，那 dispatch 实际能过
- **诊断方法**：诊断脚本 Gate 5 检查这个，但鸭总机器上 better-sqlite3 native module 版本不匹配跑不起来（Node 24 vs Electron 32）
- **真正的修法**：
  - (a) 让 better-sqlite3 同时兼容 Node 和 Electron（需要 dual prebuild，麻烦）
  - (b) 诊断脚本改用 sql.js 之类纯 JS 库（新加依赖，违反 stack-frozen 约束）
  - (c) 增加一个 IPC `diagnose-mode-a` 让 panel 内部跑诊断，绕过 native module 问题
  - (d) 在 panel 顶部增加一个明显的"ACTIVE agent 计数"实时指示，让用户自己看
- **更进一步**：如果鸭总确实没有 ACTIVE agent，怎么让 Mode A 自己起一个？这才是真正的"小白模式"。当前实现要求用户在项目目录下手动 `cd <proj> && claude` 起一个 CC session — 这违反 CEO 多次重申的"Cairn 是 daemon-class app，不是 CLI"

### B4 — mentor-tick 拿到的是不是最新 reg（**未确认**）
- main.cjs:2803 用 getter `get reg() { return reg; }` 应该 OK
- 但需要确认：鸭总在 panel 里 Save goal 后，main.cjs 的 reg 引用是不是被 set-project-goal handler 真的更新了
- 看 commit `5a07d47` 没动这条
- **诊断方法**：让 mentor-tick 每次 tick 记一行 log 含 `project_id + has_goal + sc_count`，看是不是真的看到鸭总的 4 条 criteria

### B5 — Mode A 即使派单成功，agent 不在跑也没人接（**真产品命题**）
- 这是 B3 的延伸。Mode A 的"小白模式"承诺是 *用户不需要自己开 CC 也能跑*
- 但当前实现假设用户**已经有**一个 cairn-aware 的 CC session 在项目目录里
- 没有则：plan 起草 → dispatch_requests 写入 → 没人拿 → 永远 PENDING
- 这是 product layer 命题，要么 Cairn daemon 自己 spawn CC 进程（高复杂度），要么明确告诉用户"Mode A 需要至少一个 ACTIVE CC session"
- **当前面板没给这个提示**

---

## 4. 推荐的处理顺序（鸭总审）

| 顺序 | 动作 | 5 分钟内能撤? | Risk |
|---|---|---|---|
| 0 | **鸭总重启面板**（不动代码）→ tail 日志，确认 B1+B2 修是否真的生效 | ✅ 完全可撤 | 无 |
| 1 | 增加 panel 顶部 "ACTIVE agents: N" 实时指示器 + Mode A widget 加 "需要 ≥1 ACTIVE agent" 提示（如果当前 0）| ✅ 局部 UI | 无 |
| 2 | 增加 mentor-tick 每个 project 跑一次 tick 的总览 log（看到底拿到啥 reg / criteria 数 / agentIds 数 / candidates 数）| ✅ 只加 log | 无 |
| 3 | 决定 B5 怎么办：是显式要求用户开 CC（短期），还是 Cairn daemon spawn CC（长期）— **这是产品决策，鸭总点头之前不动** | n/a | 产品定位级别 |

---

## 5. 我（Claude）今天的过失

按 CLAUDE.md gates 自评：

- ❌ **Gates "多阶段 / >30min 任务先写 checklist"** — 我没写 checklist 就改代码，导致 5 个 commit 都是反应式打补丁
- ❌ **Gates "改 IPC / SQLite state 单测绿不算完成，必须跑真实 dogfood"** — 我跑了 dogfood 但绕过了 `ensureDbHandle` 的 readonly 路径，所以 dogfood PASS 但生产环境全坏
- ❌ **Workflow Discipline "任何非 trivial 的代码改 / commit 必须按 8 站台流程"** — 我没走 GRILL → DUCKPLAN → 等流程，直接改 + commit
- ❌ **Decision Rules "不可逆 / 影响 git 历史 ... 必须先问用户"** — push 我自决了（autonomous-ship 授权），但产品定位级决策（B5）我没问

**这份文档 = 我重新接上 workflow gates**。鸭总审完点哪条先动，我再去做。中间不再"我先试试这个"。

---

## 6. 立刻的问题

鸭总你审：

1. **B1+B2 已经修了 — 你重启过面板了吗？** 没的话先重启 + tail 日志，60% 概率 Mode A 直接活过来
2. **B3 你的 agent-game-platform 项目下是不是真的有一个 active CC session？** 不是面板的"sessions"区显示，是**你现在确实有个终端在 `D:\lll\managed-projects\agent-game-platform\` 跑 claude**
3. **B5 你期待 Mode A 是 "用户不开 CC 也能跑"，还是"用户至少开一个 CC，Cairn 帮你长跑下去"？** —— 这是 product 命题，直接决定下一步动什么
