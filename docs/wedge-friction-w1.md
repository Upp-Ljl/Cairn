# W1 楔期摩擦点清单（dogfood 产生）

> 范围：MCP 楔（W1/W2 dogfood 阶段）感知到的体验不流畅。
> 与 wedge-bugs-w1.md 分开 — 这里记"功能正确但用起来别扭"的感受。

## 字段说明

| 字段 | 含义 |
|---|---|
| 场景 | 在哪个操作步骤感知到 |
| 期望 | 用户期望发生什么 |
| 实际 | 实际发生了什么 |
| 严重度 | 高（阻断使用）/ 中（每次都烦）/ 低（偶尔注意到） |
| 修复 idea | 初步方向，不是承诺 |

## 记录

### #1 — Subagent 调不到楔（架构级）

| 字段 | 内容 |
|---|---|
| 场景 | 父会话调 `subagent_type=general-purpose` 的 subagent，希望它替我跑 dogfood 任务 |
| 期望 | subagent 也能调 `cairn.scratchpad.*` / `cairn.checkpoint.*` 等楔工具 |
| 实际 | subagent 的 MCP 连接表里没有 `cairn-wedge`。楔只活在父 Claude Code 进程里，不可下传 |
| 严重度 | 中（限制了"subagent-driven dogfood"模式，但符合产品定位 — 楔是宿主 Agent 本地工具，不是分布式服务） |
| 修复 idea | 短期不修。长期做 daemon 主进程 + IPC 后，subagent 能通过 daemon 间接访问。在 README 里明确说 "wedge is per-host-Agent only"。 |

### #2 — Clean 工作树下 checkpoint 是无用 artifact

| 字段 | 内容 |
|---|---|
| 场景 | 我把所有改动都 commit 了，工作树 clean，然后调 `cairn.checkpoint.create({ label: "before-readme-edit" })`，准备改 README |
| 期望 | checkpoint 应该捕获"当前 commit 的状态"作为基准。改完 README 后调 `rewind.to` 应该能把 README 还原回 clean 状态（即丢弃我的未提交改动） |
| 实际 | `checkpoint.create` 返回 `stash_sha: null`（clean tree, nothing to stash）。改完 README 后调 `rewind.preview` 返回 `error: "no stash backend recorded (clean checkpoint?)"` + `files: []`。**checkpoint 完全不能用来撤销我接下来的改动** |
| 严重度 | **高** — 直接违反用户心智模型。"clean tree → checkpoint → 改 → 后悔 → rewind" 这条最自然的工作流在 W1 楔里走不通 |
| 修复 idea | `toolCreateCheckpoint` 检测到工作树 clean 时，应该：(a) 明确返回警告"checkpoint will not capture future edits, only marks current HEAD"；或 (b) 在 metadata 里记 git_head + 一个"watch list"（用户后续指定哪些文件要被这个 checkpoint 兜底），rewind 时用 `git checkout HEAD -- <files>` 回滚。后者实现复杂但更符合直觉。短期至少改文案。 |

### #3 — `rewind.preview` 错误信息用了内部术语

| 字段 | 内容 |
|---|---|
| 场景 | 调 `cairn.rewind.preview` 对一个 stash_sha=null 的 checkpoint |
| 期望 | 错误信息能让用户知道"为什么这个 checkpoint 不能 rewind" + "下一步该做什么" |
| 实际 | 返回 `"no stash backend recorded (clean checkpoint?)"` — "stash backend" 是实现术语，用户读完不知所措 |
| 严重度 | 中（每次都烦） |
| 修复 idea | 改成 `"this checkpoint was created with no uncommitted changes — there are no files to rewind. did you forget to make changes before checkpointing?"`。 |

### #4 — 接通本身 0 摩擦（正面记录）

| 字段 | 内容 |
|---|---|
| 场景 | 接通 `.mcp.json` 后第一次启动 Claude Code |
| 期望 | 工具能被识别 |
| 实际 | 工具列表里直接出现 `cairn-wedge` 的 7 个工具，list/write/read 三步验证一次通过 |
| 严重度 | 低（正面信号 — 不算 friction，但作为 baseline 记录） |
| 修复 idea | 无需修。这条用来对比未来如果接通流程退化时的回归 |

### #5 — 工具名带点号在 Markdown 渲染器里被识别为链接

| 字段 | 内容 |
|---|---|
| 场景 | 用户在 Claude Code 消息里写 `cairn.scratchpad.read`（不加 backtick），被渲染成 `[cairn.scratchpad.read](http://cairn.scratchpad.read)` |
| 期望 | 工具名按字面显示 |
| 实际 | 被自动链接化。工具调用本身不受影响，但用户文档/复述时 confusing |
| 严重度 | 低（不影响功能，影响阅读） |
| 修复 idea | README 里所有工具名都用 inline code 包裹（`cairn.xxx`）。我们已经这么做了，但"对话示例"段里 `cairn.checkpoint.create({...})` 这种一行长 call 不在 backtick 里，可考虑改成 fenced code block。 |
