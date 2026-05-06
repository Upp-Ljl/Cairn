# Cairn Subagent Protocol

> 版本：v1（W4 Day 2，2026-05-06）
> 目的：定义主 agent ↔ subagent 通过 Cairn scratchpad 通信的约定（消息可达 v1）
> 关联：ARCHITECTURE.md §6.4、PRODUCT.md §5.4 / §9.3

---

## 0. 前提

Cairn 的"消息可达"能力**不是技术强制**，是 **prompt 约定**。Cairn 提供持久化的 scratchpad CRUD 工具（`cairn.scratchpad.write` / `read` / `list` / `delete`），但是否调用、如何调用，由 prompt 中的指令引导。

如果 subagent 没按约定写，**这不是 bug，是 prompt 没有清晰传达约定**。本文档的任务是把约定固化下来，让任何会话都能 paste 一段标准模板。

---

## 1. 核心模板（subagent 退出前必须调用）

### 1.1 英文版（推荐用于跨语言场景）

```
# Cairn Subagent Protocol — Active for This Task

Before this subagent task ends, you MUST call cairn.scratchpad.write to
persist the full result. The main agent reads from there.

Call format:

  cairn.scratchpad.write(
    key:     "subagent/{AGENT_ID}/result",
    content: <full report — see required sections below>,
    task_id: "{TASK_ID}"
  )

Substitution rules:
  {AGENT_ID}: the identifier for this subagent (letter / index / role).
              Examples: "test-coverage-a", "review-stripe-flow", "migration-004-review".
  {TASK_ID}:  the task_id passed in by the main agent in this prompt.
              MUST match exactly so cairn.scratchpad.list(task_id=...) groups results.

Required content sections (minimum 50 characters total, all 5 must be present):

  1. Summary of completed work
     2-5 sentences describing what was actually done.

  2. Key decisions
     List with reasoning. What was chosen, what was rejected, why.
     Include trade-offs and alternatives considered.

  3. Unresolved issues
     Anything blocked, unclear, or deferred. Write "none" if clean.

  4. Recommended next steps
     Concrete actions for whoever picks up this work next.
     Write "none" if terminal.

  5. State useful to the main agent
     File paths, version constraints, naming conventions, test counts,
     anything the main agent needs to pick up the thread without rereading.

Failure to call cairn.scratchpad.write = task is considered incomplete.
```

### 1.2 中文版

```
# Cairn Subagent 协议 — 本任务激活

此 subagent 任务结束前，**必须**调用 cairn.scratchpad.write 持久化完整结果。
主 agent 从这里读取。

调用格式：

  cairn.scratchpad.write(
    key:     "subagent/{AGENT_ID}/result",
    content: <完整报告 —— 见下方必填段落>,
    task_id: "{TASK_ID}"
  )

替换规则：
  {AGENT_ID}：此 subagent 的标识（字母 / 索引 / 角色名）。
              示例："test-coverage-a"、"review-stripe-flow"、"migration-004-review"。
  {TASK_ID}： 主 agent 在 prompt 里传入的 task_id。
              必须**严格一致**，cairn.scratchpad.list(task_id=...) 才能聚合所有结果。

必填段落（总长度 ≥ 50 字符，5 段都要有）：

  1. 完成内容摘要
     2-5 句描述实际做了什么。

  2. 关键决策
     列表 + 理由。选了什么、排除了什么、为什么。
     含 trade-off 和考虑过的替代方案。

  3. 未解决问题
     被卡住的、不确定的、推迟的。如果都清了写 "none"。

  4. 建议后续步骤
     给接手者的具体行动。如果是终端任务写 "none"。

  5. 给主 agent 的状态信息
     文件路径、版本约束、命名规范、测试数字，主 agent
     不读全文也能续上的关键信息。

不调用 cairn.scratchpad.write = 任务视为未完成。
```

### 1.3 主 agent 派单时的标准 prompt 顶部段

派 subagent 时，把上面的英文或中文版 paste 进 subagent 的 prompt 顶部，**然后**写具体任务描述。`{TASK_ID}` 由主 agent 自己生成（推荐格式：`{date}-{topic}`，例如 `20260506-conflict-v1`），在 prompt 里替换字面值传给 subagent。

派完后，主 agent 在自己的 session 里记住这个 task_id，task 结束时用：

```
cairn.scratchpad.list(task_id: "20260506-conflict-v1")
```

回收所有 subagent 的 result keys，逐个 `cairn.scratchpad.read` 拿原文。

---

## 2. Key 命名规范（v1）

scratchpad 是单一共享空间，所有 agent 都能读所有 key。命名规范是**协议层约定**，不是数据库约束。

### 2.1 标准前缀

| 前缀 | 用途 | 谁写 | 谁读 |
|---|---|---|---|
| `subagent/{AGENT_ID}/result` | subagent 完成结果原文 | subagent | 主 agent + 任意 inspector |
| `subagent/{AGENT_ID}/intermediate` | subagent 中间状态（可选） | subagent | 主要给主 agent 调试用 |
| `session/{SESSION_ID}/{key}` | 会话级共享数据（多任务通用） | 任意 agent | 任意 agent |
| `dispatch/{REQUEST_ID}/prompt` | dispatch.confirm 写入的 agent prompt | daemon | 目标 agent |
| `dispatch/{REQUEST_ID}/context` | dispatch.confirm 写入的历史上下文 | daemon | 目标 agent |
| `conflict/{CONFLICT_ID}/summary` | 冲突检测自动生成的摘要（v0.2 候选） | daemon | 用户 / inspector |
| `echo/{AGENT_ID}/restatement` | 主 agent 对 subagent 结果的复述（反汇总，v0.2 候选） | 主 agent | 自己 / 反汇总 diff |

### 2.2 反例（不要这样写）

| Anti-pattern | 问题 |
|---|---|
| `result` / `output` / `data` | 没有前缀 → 与其他 agent 撞 key，最后写者覆盖前者 |
| `subagent_a_result`（下划线） | 与"以 `/` 分隔"的命名规范不一致，list/read 时不能用前缀过滤 |
| `subagent/{ROLE_NAME_WITH_SPACES_OR_/}` | 含 `/` 的 AGENT_ID 会破坏前缀解析；含空格在 shell / URL 不安全 |
| 直接以 task 内容做 key（如 `fix bug in auth`） | 不可枚举，主 agent 不知道该读哪个 key |
| 大于 128 KB 不分段 | 触发 blob spill；如果是大型报告，先分段写入多个 sub-key |

### 2.3 格式约束

- AGENT_ID：仅 `[a-zA-Z0-9-]`，不含 `/` `_` 空格中文
- key 整体长度 ≤ 256 字符（避免 SQLite 索引过大）
- content 长度建议 ≤ 100 KB（超过会触发 blob spill，仍可读，但 inspect 时较慢）

---

## 3. 主 agent 收尾流程（推荐）

任务结束后主 agent 应该：

1. **`cairn.scratchpad.list(task_id=...)`** —— 拿到所有 keys
2. 检查是否每个预期的 subagent 都写了 `subagent/{AGENT_ID}/result`
3. **如果有 subagent 未写**：
   - **不是 bug**，是 prompt 没生效。记录到日志，下次派单时 prompt 模板加强
   - 可选：补救——派一个 review subagent 去问"你之前那个 X 任务的结果是什么？"
4. **逐个 `cairn.scratchpad.read`** 拿原文，组合最终汇报
5. 任务完全结束后**可选** `cairn.scratchpad.delete` 清理（或保留作历史，下次会话回头查）

---

## 4. v1 限制 + v0.2 演进

### v1 当前不做（personal-build §3.3 决策）

- **不强制**：subagent 没写不会报错（写不写完全靠 prompt 约定）
- **不做反汇总**：主 agent 复述 subagent 结果时不自动 diff（v0.2 加 `echo/` key + `cairn.echo.diff` 工具）
- **不做强制 reload**：主 agent 读 subagent 结果前不强制 cairn.scratchpad.list 对账（依靠 prompt 模板里的"不调用 = 任务未完成"指令）

### v0.2 候选演进

- **反汇总**：主 agent 写 `echo/{AGENT_ID}/restatement`，cairn.echo.diff 跟 `subagent/{AGENT_ID}/result` 对比，发现复述偏离 → 警告
- **强制 reload 钩子**：主 agent 读 subagent 任务结果前自动 list + check 完整性
- **subagent 退出 hook**（如果 host 支持 subagent lifecycle event）：自动注入 scratchpad.write 调用，无需 prompt 约定

### v0.3 候选

- 跨机协作：scratchpad 同步到中央 broker（CRDTs 或事务日志）
- subscription model：agent 只能读自己订阅的 key 空间（取代 v1 单空间模式，详 ADR-3）

---

## 5. 与其他文档的关系

- `PRODUCT.md` §5.4（消息可达能力）+ §9.3（实现路径 a/b/c）—— 产品层定义
- `ARCHITECTURE.md` §6.4 + §5.1 + §10.4（向后兼容不变量）—— 架构层数据流
- `personal-build.md` §3.3（W4-W8 实施）—— 路线节奏
- 本文档（cairn-subagent-protocol.md）—— **协议层约定**，prompt 模板的源头

下次会话或新用户要派 subagent，**只读本文 §1.1 或 §1.2 即可**，无需读上游设计文档。

---

## 6. 测试与自测（personal-build §3.3.3）

**自测场景**：用 cairn 跑一个真实的多 subagent 任务（不是合成测试）。

**PASS 判据**：
- 每个 subagent 退出前写了对应的 `subagent/{AGENT_ID}/result` key（用 `cairn.scratchpad.list` 验证）
- 主 agent 用 `cairn.scratchpad.read(key)` 读到的内容完整（含 5 段必填）
- 内容长度 ≥ 50 字符，不是空洞摘要

**注意**：消息可达**不是技术实现，是约定**。如果某个 subagent 没写，自测目标是看 **prompt 模板有没有清晰传达约定**，不是看 cairn 工具有没有 bug。

---

*W4 Day 2 落地。任何修订请在底部加 changelog，不要重写正文（保持 prompt 模板可重复 paste）。*

## Changelog

- **2026-05-06 v1**：初始落地（personal-build §3.3.1 + §3.3.2）
