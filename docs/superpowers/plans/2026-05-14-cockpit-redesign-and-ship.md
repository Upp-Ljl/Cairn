# Cockpit Redesign + Ship Pipeline — 2026-05-14

> Status: **LIVE PLAN**, opened 2026-05-14 after 4 rounds of CEO grill defining 17 product constraints + audit showing 41% complete + non-developers cannot download.
> Successor to `2026-05-14-phase8plus-roadmap.md` (which is now subsumed — §10 Mode B & §11 packaging are folded into this plan).
> Authoring agent: lead. Subagent model: **sonnet** for mechanical/parallel-shippable phases, **opus** reserved for strategic re-grill if画面再次 reframe.

## CEO 命题（2026-05-14 grill）

**"对项目的完全掌控感"** = 鸭总打开 Cairn 第一眼，看到：
- 当前在干什么 / 之前做了什么 / 每个 session 的 agent 任务执行脉络
- agent 每次干活前都要有状态显示（像 git commit 一样有结构化记录）
- 即使 idle 的 session 也显示（"session 在但没敲键也是一种存在"）
- 不要叙事压缩，要原始流水
- Mentor 是主功能（不是淡化），独立模块，能通过 todolist 派活给 agent

## 17 条产品约定（grill 定稿）

### L0 主屏
1. Projects list，按 health 排序，**保留当前 panel.html 形态**

### L1 模块新顺序（Mentor 上移到第 2 位）
2. M1 · State Strip（顶）：Whole + 灯 + Mentor saved badge + Last 24h glance
3. M2 · Mentor + Todolist（**从底部上移**）—— 鸭总中枢神经
4. M3 · Steer（喊话）：单句话发给某 session 的 agent_inbox
5. M4 · Sessions（**新增 / 替换原 Activity Feed**）：项目下所有 session 列表（含 idle）
6. M5 · Safety / Rewind（保留）

### M2 Mentor + Todolist 命题
7. Mentor 是主功能，不是淡化
8. Todolist **三方来源**：agent 自荐 + Mentor 汇总 + 鸭总手动加
9. 每条 todo 旁边 `[派给 ▾]` / `[Approve →]`
10. 派出 = 写 `dispatch_requests` 表，走 kernel R1-R6 兜底规则
11. M2 同时显示 Mentor 状态 + Needs you + Ack

### M4 Sessions 命题
12. Session 名 = agent 启动时**自动起的人话名**（不是 hex）
13. idle session 也显示

### L2 Session Timeline（点 session 进去）
14. Subagent 缩进展示（树形）
15. 历史深度 = session 启动以来全部，分页
16. Rewind 在 checkpoint 点（auto + agent + 用户主动 mark），读文件等不打
17. Timeline 粒度 = 有意义的步骤（agent 自定义边界 + 自报）

## 现状 audit（opus subagent, 2026-05-14）

完成度: **✅ 4 / ⚠️ 5 / ❌ 8 ≈ 41% 加权**

| Gap 类别 | 约定 | 现状 |
|---|---|---|
| L2 Session Timeline 整块 | 14-17 | ❌ **0% 完成** — 点 session 没有详情页 |
| M2 Mentor 上移 + Todolist + dispatch UI | 3, 7-11 | ❌ panel 完全没 todolist UI；Mentor 默认 hidden |
| Session 人话命名 | 12 | ❌ 当前是 `claude:7f5bf59f` hex 截断 |
| M4 Sessions 模块化 | 5 | ⚠️ 有 'Agent Activity' tab，不是 module |
| Mac .dmg 下载 | — | ❌ 从没 build 过，缺 icon.icns，Win 上 build 不出 |
| Win .exe 公开下载 | — | ❌ exe 仅在本机，GitHub Releases 空 |
| .exe self-contained | — | ❌ MCP server 没 bundle 进，用户还得 clone repo |

## 两轨道 phase 切分

### 轨道 A · 产品命题（17 条约定）

| Phase | 内容 | 约定# | 难度 | 估时 |
|---|---|---|---|---|
| **A3** | Sessions 升格 + 人话命名 | 5, 12, 13 | 中 | 1 session |
| **A4** | 模块顺序调整 + Steer 加 session 下拉 | 4, 6, 11 | 小 | 1 session |
| **A2** | Mentor + Todolist + dispatch_requests 派单 UI | 3, 7-11 | 大 | 2-3 sessions |
| **A1** | L2 Session Timeline 整模块（最大块）| 14-17 | 极大 | 3-4 sessions |

### 轨道 B · 上线分发（让朋友能下载）

| Phase | 内容 | 难度 | 估时 |
|---|---|---|---|
| **B1** | `build/icon.icns` 从 .ico 转 | 小 | 5 min |
| **B2** | `.github/workflows/release.yml` win+mac matrix build | 中 | 1 session |
| **B3** | electron-builder `extraResources` bundle mcp-server | 中 | 1 session |
| **B4** | 首次启动 onboarding wizard | 中 | 1-2 sessions |
| **B5** | 首发 v0.2.0 release （tag + artifact）| 小 | 鸭总点头才打 |

## 第一波并行（这次 session 启动）

按 TEAMWORK N+1+2N + worktree 隔离 + 文件集合不重叠：

| 任务 | Owner | Worktree | 改的文件 |
|---|---|---|---|
| **B1 + B2 + B3** | sonnet subagent | `.cairn-worktrees/b-track-ship-pipeline/` | `build/icon.icns` (新) / `.github/workflows/release.yml` (新) / `packages/desktop-shell/package.json` (electron-builder extraResources) |
| **A3-part1 Session 人话命名** | sonnet subagent | `.cairn-worktrees/a3-session-naming/` | `packages/desktop-shell/agent-activity.cjs` / 新 MCP tool `cairn.session.name` / smoke |
| **A3-part2 M4 Sessions 模块升格** | 主 agent（我）| `.cairn-worktrees/a3-sessions-module/` | `packages/desktop-shell/panel.html` (cockpit modules) / `panel.js` (renderSessions) |

**文件集合不重叠** ✓ ——三个 worktree 可同时跑。

## 下一波（这次 session 收工后）

按依赖关系：
- 等 A3-part1 + A3-part2 merge → A4 模块顺序调整（依赖 M4 sessions 落地）
- B-track 完成 → 鸭总点头打 v0.2.0 release tag (B5)
- A1 L2 Session Timeline（依赖 A3 完成）—— 单独大 phase
- A2 Mentor + Todolist + dispatch UI —— 独立大 phase

## 工作流守则

- 每个 worktree 完成走 AUTOSHIP（commit on feat branch → push → fast-forward main per Phase 1-7 precedent）
- Subagent 报告必须包含：文件路径、测试命令、dogfood 结果、是否 push、是否触碰 unrelated dirty files
- 主 agent trust-but-verify subagent 报告（不直接转述）
- 不打 v0.2.0 release tag 不发 GitHub Release（destructive，鸭总点头）

## 2026-05-14 EOD progress (live)

**Shipped today (local main, 27+ commits queued for push)**:

| Phase | Status | Commits |
|---|---|---|
| A1.1 Timeline data convention + cairn-aware skill v3 | ✅ | `c68ea67` |
| A1.2 L2 Session Timeline drill-down view | ✅ | `9705094` + integration |
| A3-part1 Session 人话命名 + cairn.session.name | ✅ | `876a334` |
| A3-part2 M4 Sessions module + querySessions | ✅ | `2d2a388` |
| A2.0 Module 5 → Mentor module upgrade | ✅ | `559709a` |
| A2.1 Todolist UI shell + queryTodoList | ✅ | `e237a56` |
| A2.2 cockpit-todo-dispatch IPC + cockpit-dispatch.cjs | ✅ | `16706d8` |
| A2.x wiring panel buttons → dispatch IPC | ✅ | `273bd9d` |
| A4 module reorder + Steer dropdown | ✅ | `8cf7b4f` |
| B1+B2+B3 icon + GH Actions + extraResources bundle | ✅ | `26c3b7d` |
| B4 first-launch onboarding wizard | ✅ | `e52f6be` |
| Rule C prompt tune (domain-mismatch) | ✅ | `b4dd1bf` |
| Rule C strict-mode (high-confidence) | ✅ | `500f246` |
| Defensive double-encoded parse + protocol fix | ✅ | `e31f4e3`, `d0b7f4e` |
| Workflow rules field 13/14/14-stricter | ✅ | `2040176`, `be05230` |
| Module DOM order structural smoke | ✅ | — |
| Real-agent dogfood (9 timeline + 3 agent_proposals via live MCP) | ✅ | — |
| Auto-instrument task transitions (sonnet subagent) | ⏳ | in flight |

**17 product constraints**: 17/17 ✅ (約定 17 closed via real-agent dogfood; kernel auto-instrument will guarantee it works for non-cairn-aware agents too)

**Hard blocker**: push 撞 PAT scope `workflow`. 27 local commits waiting on either: (a) 鸭总 adds `workflow` scope to PAT at https://github.com/settings/tokens, or (b) 鸭总 runs `! git push origin main` from their terminal (GCM cached creds).

**Smoke regression**: 410+ assertions across 11 smokes + 75 dogfood assertions zero regression.

**Next session queue (live agent_proposals in `~/.cairn/cairn.db`)**:
- Mode B Continuous Iteration — 3-5 session, biggest lever
- 打 v0.2.0 release tag — triggers CI win/mac matrix
- 真实 Electron GUI dogfood — visual verification

## 反定义守卫线

- A2 Mentor todolist 派活 = 写 `dispatch_requests` 表，走 Cairn kernel R1-R6 → 不撞 §1.3 D9 read-only（D9 守的是 panel 绕过 kernel 直接 mutate task 状态）
- 任何 todo 必须鸭总 Approve / 鸭总手按"派给"才进 dispatch ——Mentor 不能自己派
- M4 Sessions 列表 = 读 processes 表 + scratchpad agent_brief，不是新 schema
- A1 L2 Timeline = 读 scratchpad agent execution events + tasks transitions，不写 task 状态
