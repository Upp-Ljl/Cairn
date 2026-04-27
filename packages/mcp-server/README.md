# cairn-mcp-server

Cairn MCP wedge — 给你的 AI 编码 Agent（Claude Code 等）提供 `cairn.scratchpad.*` 跨轮次草稿存取，以及 `cairn.checkpoint.*` / `cairn.rewind.*` 基于 git stash 的文件回滚能力。

---

## 是什么 / 不是什么

| 是什么 | 不是什么 |
|---|---|
| 7 个 MCP 工具，暴露给宿主 Agent 调用 | 桌面 UI（v0.2 主体才有，见 PRODUCT.md §17.2） |
| SQLite (`~/.cairn/cairn.db`) 持久化 scratchpad | 子 Agent 调度 |
| git stash 兜底快照，**不动 .git/HEAD** | 模型记忆 checkpoint — rewind 只覆盖文件，不还原对话历史 |

---

## 安装（60 秒）

```bash
git clone https://github.com/Upp-renlab/Cairn.git
cd Cairn

# 1. 编译 daemon（持久层）
cd packages/daemon && npm install && npx tsc -p tsconfig.json

# 2. 编译 mcp-server
cd ../mcp-server && npm install && npx tsc -p tsconfig.json
```

在 Claude Code 的项目级 `.mcp.json`（或全局 `~/.claude/.mcp.json`）添加：

```json
{
  "mcpServers": {
    "cairn-wedge": {
      "command": "node",
      "args": ["<absolute-path>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

相对路径版本（仅从项目根启动 Claude Code 时有效）：见 `.mcp.json.example`。

**可选**：设置 `CAIRN_HOME` 环境变量改变 SQLite 落盘位置（默认 `~/.cairn`）：

```json
{
  "mcpServers": {
    "cairn-wedge": {
      "command": "node",
      "args": ["<absolute-path>/packages/mcp-server/dist/index.js"],
      "env": { "CAIRN_HOME": "/your/custom/path" }
    }
  }
}
```

---

## 接通后快速验证（30 秒）

重启 Claude Code 后，工具列表里应出现 `cairn-wedge`。在新会话里发：

```
请帮我验证 cairn 楔接通：
1. 调 cairn.scratchpad.list，应返回 { items: [] }
2. 调 cairn.scratchpad.write，参数 { key: "test", content: "hello" }，应返回 { ok: true, key: "test" }
3. 调 cairn.scratchpad.read，参数 { key: "test" }，应返回 { found: true, value: "hello" }
```

三步都过就接通了。任一步报错，参考下方 [故障排查](#故障排查)。

---

## 7 个工具速查

| Tool | Args | Returns | 用途 |
|---|---|---|---|
| `cairn.scratchpad.write` | `{ key, content }` | `{ ok, key }` | 跨 turn 存草稿 |
| `cairn.scratchpad.read` | `{ key }` | `{ key, found, value }` | 读回草稿 |
| `cairn.scratchpad.list` | `{}` | `{ items: [{ key, updated_at, updated_at_iso, has_value }] }` | 看本地有哪些草稿 |
| `cairn.checkpoint.create` | `{ label? }` | `{ id, git_head, stash_sha, warning? }` | 改大动作前先存档 |
| `cairn.checkpoint.list` | `{}` | `{ items: [{ id, label, git_head, created_at }] }` | 看历史档 |
| `cairn.rewind.preview` | `{ checkpoint_id }` | `{ checkpoint_id, files, git_head_at_checkpoint }` | rewind 前确认影响文件 |
| `cairn.rewind.to` | `{ checkpoint_id }` | `{ ok, restored_files }` | 真的回滚 |

---

## 对话示例

```
User: 帮我重写 src/auth.ts 的 token 刷新逻辑。先存个 checkpoint。

Claude: [calls cairn.checkpoint.create({ label: "before-token-refactor" })]
        已创建 checkpoint 01HXY...，包含 src/auth.ts 当前未提交改动。

User: 现在动手。

Claude: [edits src/auth.ts]
        [calls cairn.scratchpad.write({ key: "decisions", content: ["chose RFC 7517 jwks", "skip refresh on 401"] })]
        已重写。决策记录存进草稿 (key: "decisions")。

User: 不对，这个方向错了，回到刚才那个 checkpoint。

Claude: [calls cairn.rewind.preview({ checkpoint_id: "01HXY..." })]
        会回滚 1 个文件：src/auth.ts。.git/HEAD 不变。要继续吗？

User: 继续。

Claude: [calls cairn.rewind.to({ checkpoint_id: "01HXY..." })]
        已回滚。草稿记录还在，以备复用。
```

---

## 在多 Agent 工作流里使用

楔的工具只暴露给**当前 Claude Code 进程**。如果你的工作流是"父 agent 派发 subagent 干代码活"，subagent 调不到楔工具——楔的能力不可下传。这是产品定位（楔 = 宿主 Agent 的本地工具），不是 bug。

实际工作流中的 checkpoint 时机：

```
父 agent  → checkpoint.create (before-subagent)   ← 推荐：先 commit 后 checkpoint，让 stash 抓得到 dirty 文件
父 agent  → 派发 subagent 改代码
父 agent  → checkpoint.create (after-subagent)    ← 想精确回滚到 subagent 的工作前后状态
父 agent  → rewind.preview/to                     ← 选择回到哪个状态
```

**反模式**：在工作树 clean 时调 `cairn.checkpoint.create`。返回的 `stash_sha: null` + `warning` 提示这个 checkpoint 不能撤销未来改动。先 dirty 工作树（哪怕只是改一个字符），再 checkpoint。

---

## W1 已知限制（重要）

> **W2 已修**（2026-04-27）：
> - clean-tree checkpoint 现在返回明确的 `warning` 字段
> - rewind 错误信息改为用户语言（不再用 "stash backend" 内部术语）
> - `scratchpad.list` 返回 `updated_at_iso` ISO 字符串

**首要限制**：rewind 只覆盖 git-tracked 文件。新文件在 `git add -A` 暂存后也会被 stash 捕获，但已 commit 的历史不动 — 这是楔期约定。

其他限制：

- **仅 git 仓库内可用 checkpoint**。非 git 目录调 `cairn.checkpoint.create` 会得到 `stash_sha: null`（失败但不抛异常）。
- **纯 git stash backend**，无 snapshot 目录概念。大文件 / 二进制 / 跨平台 COW 不支持，推迟到 P2。
- **scratchpad 没有 TTL**。写入的 key 永久保留。W1 未暴露 delete 工具；需要手动清理可直接在 SQLite 里执行 `DELETE`。
- **rewind 不还原对话历史**。回滚后 Claude 仍然"记得"它做过的事，文件变回去了但对话上下文不变。这是 v0.2 候选功能。
- **stash SHA 暂存于 `checkpoints.label` 字段**（W1 技术债）。P2 加 `backend_data` 列后修正。
- **无 CORRUPTED 自动扫描**。PENDING checkpoint 不会自动 cleanup — P2 补。

---

## 故障排查

| 现象 | 排查步骤 |
|---|---|
| `cairn-mcp` 进程没启动 | 手动跑 `node packages/mcp-server/dist/index.js`，看 stderr |
| `stash_sha: null` | 当前目录不是 git 仓库 / 工作树 clean / git 命令找不到 |
| rewind 没还原文件 | 先调 `cairn.rewind.preview`，看 `files` 是否为空 — 空则 stash 不含该文件 |
| `~/.cairn/cairn.db` 锁定 | 另一个 cairn-mcp 进程在运行，关掉即可 |

---

## 反馈与 bug 记录

- W1 期间 bug 记到 `docs/wedge-bugs-w1.md`（仓库内）
- W1 期间使用别扭点记到 `docs/wedge-friction-w1.md`（dogfood 期间产生）
- W2 起开 issue

---

## 引用

- 完整产品定义：`PRODUCT.md`
- 持久层设计：`DESIGN_STORAGE.md`
- W1 工作计划：`docs/superpowers/plans/2026-04-23-wedge-w1.md`
