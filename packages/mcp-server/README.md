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
git clone <repo>
cd cairn

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

## 7 个工具速查

| Tool | Args | Returns | 用途 |
|---|---|---|---|
| `cairn.scratchpad.write` | `{ key, content }` | `{ ok, key }` | 跨 turn 存草稿 |
| `cairn.scratchpad.read` | `{ key }` | `{ key, found, value }` | 读回草稿 |
| `cairn.scratchpad.list` | `{}` | `{ items: [{ key, updated_at, has_value }] }` | 看本地有哪些草稿 |
| `cairn.checkpoint.create` | `{ label? }` | `{ id, git_head, stash_sha }` | 改大动作前先存档 |
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

## W1 已知限制（重要）

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
