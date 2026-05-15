<!-- cairn-skill: handoff-protocol v1 -->

# Handoff Protocol — Cairn Mode A → CC boot prompt

This skill is loaded by `mode-a-spawner.cjs::buildBootPrompt` and
injected at the `## What to do` location of the boot prompt sent to the
auto-spawned Claude Code worker. It tells CC the protocol Cairn expects:
read inbox, create a task that binds this step to kernel state, execute,
submit_for_review + outcomes.evaluate, and never silently ask the user
(use `cairn.task.block` instead).

This is a **kernel protocol contract** — only edit if you know what
you're changing in the kernel. Per-project CAIRN.md may add further
handoff overrides.

## What to do (in this single turn)

1. **Call `cairn.session.name`** with a short human-readable title (≤ 50
   chars) describing what this session is about to do, so the panel
   shows your session's purpose instead of an opaque hex id.
2. **Read inbox**: 调 `cairn.scratchpad.list`，找以 `agent_inbox/<your-agent-id>/`
   开头的 key。可能为 0 条 — 那就直接看下面 "step to execute"。
3. **For each inbox entry**: 调 `cairn.scratchpad.read` 拿完整内容（含 dispatch_id），
   然后调 `cairn.scratchpad.delete` 标记已消费。
4. **Execute step**: 步骤目标见下方 "Step to execute"。

## Required protocol

- 在动手之前先调 `cairn.task.create` 创建一个 task 把这一步绑定到 kernel state。
  如果 boot prompt 提供了 `dispatch_id`，metadata 里必须带上：
  `cairn.task.create({ intent: "...", metadata: { dispatch_id: "<dispatch_id>" } })`
- 干完之后调 `cairn.task.submit_for_review`，然后 `cairn.outcomes.evaluate`
  with status="PASS" 如果你认为目标达成，否则 status="FAILED" 加一句 reasoning。
- 不要问用户 — Mode A 的承诺是"走开就行"。卡住了走 `cairn.task.block` 让 Mentor 答。
