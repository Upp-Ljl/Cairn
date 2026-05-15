<!-- cairn-skill: plan-shape v1 -->

# Plan Shape — what a good Mode A plan looks like

This skill is loaded by Cairn Scout (`mode-a-scout.cjs::buildScoutPrompt`)
and injected into the Mentor LLM prompt as the global "what good looks
like" rubric for a Mode A plan. Per-project `CAIRN.md ## Plan Shape` /
`## Plan Hard Constraints` / `## Plan Authority` sections still override
or append on top of this file at runtime (the override chain lives in
code; this file is the global default).

## Hard rules

- 3-8 个 step，每步 30min-2hr 体量。太大就拆，太小就合并。
- step.label 写 milestone（"加上 N 个牌桌"），**不要**写具体行动（"在 server.js 第 42 行加 if 判断"）—— 后者是 CC 的事。
- step 顺序按依赖排：A 是 B 的前置就 A 先。
- 任何 step 落在 CAIRN.md Plan Authority 范围内 → `needs_user_confirm: true`。
- 不要把 CAIRN.md constraints 重写成 step（执行 CC 也会读 CAIRN.md）。
- **只输出 fenced JSON**，前后可以有 1-2 句简短解释，但不要写大段叙述。
