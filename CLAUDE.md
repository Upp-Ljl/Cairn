# Cairn — Claude 项目说明

> 这个文件给未来的 Claude 会话用。仓库特定的"踩过的坑"和"非显然的本地约定"放这里，避免每次重新诊断。

## 项目坐标

- **仓库**：https://github.com/Upp-renlab/Cairn （**注意大小写**：`Cairn`，不是 `cairn`）
- **本地路径**：`D:\lll\cairn`
- **主分支**：`main`
- **设计文档**：`PRODUCT.md`（产品定义）、`DESIGN_STORAGE.md`（持久层）
- **执行计划**：`docs/superpowers/plans/2026-04-23-*.md`（P1-P4 + W1 楔）
- **会话归档**：`426归档.md` 等，按日期命名

## 推送（push）必读

### 当前可工作的方式

仓库 owner 是 `Upp-renlab`。Git Credential Manager（GCM）默认缓存的账号可能是 `Upp-Ljl`，**该账号没有 cairn 仓库的写权限**，GitHub 会用 `Repository not found` 掩盖鉴权失败。

唯一稳定的 push 方式：**用 PAT token 直接拼到 URL 里**。

Token 文件（已 gitignored）：
```
D:\lll\cairn\.cairn-push-token\token.txt
```

push 命令：

```bash
cd D:/lll/cairn
TOKEN=$(cat .cairn-push-token/token.txt | tr -d '[:space:]')
git push "https://x-access-token:${TOKEN}@github.com/Upp-renlab/Cairn.git" main
# 注意：每次输出都要 sed 把 TOKEN 替换成 <REDACTED>，不要泄露到日志
```

fetch 同理（如果本地 `origin/main` 引用没跟上）：

```bash
git fetch "https://x-access-token:${TOKEN}@github.com/Upp-renlab/Cairn.git" main:refs/remotes/origin/main
```

### 不要用的方式

- `git push origin main`（裸） — 触发 GCM，弹凭证 UI，但 Claude Code 无 TTY，会卡住或报 `/dev/tty: No such device`
- `GIT_TERMINAL_PROMPT=0 git push origin main` — 报 `terminal prompts disabled`，无凭证
- `Authorization: Bearer ${TOKEN}` extraheader — GitHub HTTPS 不接受 Bearer，必须用 `x-access-token:TOKEN@host` URL 形式
- `gh` CLI — 这台机器没装

### 如果 token 失效

1. 去 GitHub Settings → Developer settings → Personal access tokens 撤销旧的
2. 新建一个，scope 给 `repo`（write）
3. 写入 `.cairn-push-token/token.txt`（**不要 commit**，已被 .gitignore）
4. 或者让用户在自己终端跑 `git push origin main` — GCM 会弹浏览器，登录 `Upp-renlab` 账号，之后 GCM 缓存的就对了

### Tag 推送

Tag 不会跟着 `git push origin main` 走，要单独推：

```bash
TOKEN=$(cat .cairn-push-token/token.txt | tr -d '[:space:]')
git push "https://x-access-token:${TOKEN}@github.com/Upp-renlab/Cairn.git" --tags
```

已有的 tag：`storage-p1`（P1 持久层完成节点）

## 环境特点

- **OS**：Windows 10/11，shell 是 bash（git-for-windows 自带）
- **Node**：v24.14.0
- **路径风格**：bash 用 `/`，Windows 工具吃 `\`，Read/Write 工具用绝对 Windows 路径（`D:\lll\cairn\...`）
- **better-sqlite3**：必须 `^12.9.0` 或更新，11.x 没有 Node 24 prebuilds，会触发 node-gyp（Windows 上多半没装 VS C++ 工具链）
- **commit author**：`Upp-Ljl <2226957164@qq.com>`（不是 `Upp-renlab`，与 push 身份不一致 — 见上）

## monorepo 结构

```
packages/
├── daemon/         # P1 持久层（SQLite + 仓储层 + git-stash backend）
└── mcp-server/     # W1 楔（7 个 MCP 工具，stdio）
```

跨包 import 走 daemon 的 `dist/`（不是源码）：

```ts
import { openDatabase } from '../../daemon/dist/storage/db.js';
```

`packages/daemon/tsconfig.json` 开了 `declaration: true` 以输出 .d.ts 给 mcp-server 用。

## 测试

每个包独立跑：

```bash
cd packages/daemon && npm test           # 67 tests
cd packages/mcp-server && npm test       # 9 tests (8 acceptance + 1 stdio smoke)
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

v0.1 13 周计划，**W2 周一**（2026-04-27）。
- ✅ W1 楔技术雏形（`feat/storage-p1` 已合并 + tag `storage-p1`）
- ⏳ 等用户在 Claude Code 里加 `.mcp.json` + dogfood
- ⏳ 等 W1-T12 friction 反馈 → W2 修 bug → W2 末发种子用户
