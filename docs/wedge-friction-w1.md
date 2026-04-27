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

### #6 — Dirty tree 下 checkpoint/preview 完全正常（friction #2 的对照）

| 字段 | 内容 |
|---|---|
| 场景 | T2.4 dispatching subagent 加 JSDoc 后，工作树脏（scratchpad.ts modified），调 `cairn.checkpoint.create({ label: "after-jsdoc-dirty-tree-test" })` |
| 期望 | 能正常捕获脏改动并允许 preview/rewind |
| 实际 | 完美工作 — 返回 `stash_sha: "19f29845..."`，`rewind.preview` 准确列出 `["packages/daemon/src/storage/repositories/scratchpad.ts"]` |
| 严重度 | 正面信号（不算 friction） |
| 修复 idea | 无需修。这条用来 **对比验证 friction #2 是 clean-tree 专属**，dirty-tree 路径不需要重写。修补丁时只需 `toolCreateCheckpoint` 在 `stash_sha === null` 分支增加处理（警告 / 退化策略 / 文件 watch list），不动现有的 stash 路径 |

### #7 — `scratchpad.list` 返回的 `updated_at` 是 unix ms，肉眼不可读

| 字段 | 内容 |
|---|---|
| 场景 | 调 `cairn.scratchpad.list` 看本会话所有草稿 |
| 期望 | 能直接看到"哪条最近写的"或"X 分钟前" |
| 实际 | 返回 `"updated_at": 1777261555464`，需要心算或工具解读 |
| 严重度 | 中（每次都烦，但有信息） |
| 修复 idea | 工具响应保持 unix ms（机器读），但**附加** `updated_at_iso: "2026-04-27T07:25:55.464Z"` 字段。或者在 list 工具上加可选 `format: "iso"` 参数。低复杂度 |

### #8 — Subagent-driven dogfood 的隔层感

| 字段 | 内容 |
|---|---|
| 场景 | T2.4 派 sonnet subagent 加 JSDoc，我（父 agent）只调楔工具 |
| 期望 | 能像直接做一样直观感受楔的位置 |
| 实际 | 隔了一层 — 我调 checkpoint 的时机（before subagent / after subagent）变成产品决策。最终我两次都调了：before（无效 because clean）+ after（dirty，工作）。这种"两次 checkpoint 包夹一次代码改动"的 pattern 是楔在多 agent 工作流里的真实位置，但 README 没讲过 |
| 严重度 | 中（影响产品定位的清晰度） |
| 修复 idea | README 加一节"在多 agent 工作流里怎么用"，给 before/after 双 checkpoint 的示例。或者把"先 commit 再 checkpoint"的反模式明确写出来劝退 |

### #9 — `cairn.rewind.to` 实际 e2e 工作（正面记录）

| 字段 | 内容 |
|---|---|
| 场景 | T2.5 故意搞坏：建临时文件 v1 → checkpoint → 改成 v2/v3/中文乱码 → `rewind.to` |
| 期望 | 文件回到 v1，git HEAD 不动 |
| 实际 | 完美工作。`rewind.to` 返回 `{ ok: true, restored_files: [...] }`，文件内容字节级 v1，wedge-bugs-w1.md 内容也保留 |
| 严重度 | 正面信号（不算 friction） |
| 修复 idea | 无需修。这是楔最核心卖点的一次端到端确认 |

### #10 — `rewind.preview` 暴露"stash 捕获范围 ≠ 用户当前关注范围"

| 字段 | 内容 |
|---|---|
| 场景 | T2.5 我以为 checkpoint 只会捕获我刚建的 rewind-demo.md，结果 preview 列出了**两个文件**（demo 文件 + 之前已 dirty 的 wedge-bugs-w1.md） |
| 期望 | 用户心智："checkpoint 我即将工作的内容"。实际行为："checkpoint 此刻所有 dirty 文件" |
| 实际 | 不丢数据（stash 里 wedge-bugs-w1.md 的内容就是当前内容，rewind 写回等于无变化）。但 preview 输出会让用户惊讶："为什么列了那个文件？" |
| 严重度 | 中（不损失数据，但用户每次都要心理 reconcile） |
| 修复 idea | 三选一：(a) `checkpoint.create` 接受可选 `paths` 参数，只 stash 指定文件；(b) preview 输出时，把"checkpoint 时已 dirty 但与 HEAD 一致的文件" mark 为 "(unchanged from HEAD)"；(c) 文档明示"checkpoint = snapshot of all dirty"。短期做 (c)，长期做 (a)。 |
