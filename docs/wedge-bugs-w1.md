# W1 楔期已知问题清单

> 范围：MCP 楔（W1 开发期）发现的 bug、别扭、未解决的问题。
> 与 `docs/wedge-friction-w1.md`（dogfood 体验感）分开记录 — 这里只记**功能问题**。

## 模板

```
- [ ] **[严重度: 高/中/低]** [模块]：现象描述
  - 复现步骤：
  - 期望行为：
  - 实际行为：
  - 临时绕过：
  - 优先级：W1 / W2 / 进 P2-P3 解决
```

## 已记录

> 来源：W2 dogfood（T2.3-T2.5）。详细体验感见 `docs/wedge-friction-w1.md`，本文件只记功能层面的"应该但没"或"做错了"。

- [x] **[高] checkpoint**：clean 工作树下 `cairn.checkpoint.create` 返回 `stash_sha: null`，但 API 不警告；后续 `rewind.preview` / `rewind.to` 对该 checkpoint 直接报错 "no stash backend recorded"
  - 复现步骤：
    1. `git status` 确认 clean
    2. 调 `cairn.checkpoint.create({ label: "x" })` → 返回 `{ id, git_head, stash_sha: null }`
    3. 修改任意 git-tracked 文件
    4. 调 `cairn.rewind.preview({ checkpoint_id: <id> })`
  - 期望行为：要么 step 2 直接拒绝创建 + 明确报错"工作树 clean，无可捕获的改动"；要么 checkpoint 生效，能撤销 step 3 的改动（用 `git checkout <git_head> -- <files>` 路径兜底）
  - 实际行为：step 2 静默成功，step 4 报 `error: "no stash backend recorded (clean checkpoint?)"` —— 用户已经损失 step 3 的工作
  - 临时绕过：dogfood 期间靠"先改一个文件再 checkpoint"绕开（即先制造 dirty tree）。但这反人类直觉
  - 优先级：**W2 必修**（friction #2 升级为 bug；T2.7-T2.9 处理）

- [x] **[中] rewind.preview**：错误信息使用内部术语 "stash backend"
  - 复现步骤：对一个 `stash_sha: null` 的 checkpoint 调 `cairn.rewind.preview`
  - 期望行为：错误信息用用户语言（"this checkpoint captured no changes" / "did you make changes before checkpointing?"）
  - 实际行为：返回 `"no stash backend recorded (clean checkpoint?)"` —— "stash backend" 是实现细节，用户读不懂
  - 临时绕过：无（用户只能猜）
  - 优先级：W2 必修（与上一条同 fix，文案一起改）

- [x] **[中] scratchpad.list**：`updated_at` 字段是 unix ms（如 `1777261555464`），人类不可读
  - 复现步骤：调 `cairn.scratchpad.list`
  - 期望行为：除 unix ms 外提供 ISO 字符串或 "X 分钟前" 相对时间
  - 实际行为：仅 unix ms。用户必须心算 / 借助外部工具
  - 临时绕过：让 Claude 解析（但每次响应都要解一次）
  - 优先级：W2 必修（响应字段加 `updated_at_iso`，向后兼容）

- [x] **[低] checkpoint.create**：`size_bytes` 总是 0
  - 复现步骤：任何 checkpoint，都看 DB 的 `checkpoints.size_bytes` 列
  - 期望行为：反映 stash 实际占用（git stash 没有目录概念，可以是 stash blob 大小总和）
  - 实际行为：W1 实现里 `markCheckpointReady` 写死 `size_bytes: 0`（git-stash backend 没有"目录大小"概念）
  - 临时绕过：忽略此字段
  - 优先级：进 P2 解决（要等真实 snapshot backend，rsync/APFS 才有 size 概念）

- [x] **[低] checkpoint.label 字段被楔自己嵌入了 `::stash:<sha>`**
  - 复现步骤：调 `cairn.checkpoint.create({ label: "x" })`，再调 `cairn.checkpoint.list`，看返回的 `label`
  - 期望行为：label 字段保持用户输入原样
  - 实际行为：被改写为 `"x::stash:<40 hex>"`，用户原 label 后面拼了实现细节
  - 临时绕过：UI 层在显示前 split 掉 `::stash:` 后的部分
  - 优先级：进 P2 解决（DESIGN_STORAGE.md §17.1 已记 P2 加 `backend_data` 列后从 label 迁出）
