# Cairn Mentor Layer — Detailed Spec

> **Companion to** `PRODUCT.md §6.5.1 Mode A · Mentor`
> **Status**: design draft (B2). Not a contract until commit lands and code follows.
> **Depends on**:
> - B1 (PRODUCT.md v4 Operations Layer): commit `359fc71`
> - A3 (Mode B Continuous Iteration handler): commit `1ce4c3a`
> **Date**: 2026-05-11

---

## 0. Scope and non-goals

This document is the implementation-grade spec for **Mode A · Mentor**, the
advisor face of Cairn's v4 Operations Layer. PRODUCT.md §6.5.1 gives the
one-line framing and 5-bullet output shape; this spec fills in the
interaction model, signal whitelist, reasoning chain, output schema,
boundaries, cardinality, persistence, and failure modes — at the level
of detail an implementer can scaffold from without re-litigating product
intent.

**In scope**

- The Mentor chat sub-section: how the user invokes it, what it reads,
  what it returns, what it persists.
- The contract with already-shipped Day 1-6 primitives
  (`project-candidates.cjs` / `project-iterations.cjs` /
  `worker-reports.cjs` / kernel SQLite read handles).
- The hand-off to Mode B Continuous Iteration (commit `1ce4c3a`).
- Explicit refusal patterns so Mentor doesn't drift into Linear-style
  team PM (PRODUCT.md §1.3 #5a/#5b) or auto-orchestrator territory
  (§1.3 #4a/#4b).

**Out of scope (deferred)**

- The exact LLM prompt template (separate prompt-pack file, mirroring
  `scout-prompt.cjs`; B-Series follow-up).
- UI styling / panel layout details (design-pass after first scaffold).
- Mentor history retention policy beyond v0 (per-project ring buffer
  + size cap to be tuned after live use).
- Cross-project mentoring (Mentor is per-project; multi-project is a
  separate Operations Layer wedge, post-v4).
- Embedding / retrieval index over project docs (v0 uses raw text +
  token-budget clipping; vectorization is a later optimization).

---

## 1. Interaction model

### 1.1 Surface

**Chat panel — locked** per PRODUCT.md §6.5.1 ("chat panel，不是静态报告
／不是 daily push／不是邮件"). Implementation: a new sub-section "Mentor"
inside the desktop-shell side panel, **peer to** Three-Stage Loop UI
and the existing Inspector — not nested under either.

**Why a new sub-section vs Inspector reuse** (recommended: **new
sub-section**):

- Inspector's affordance is **state inspection** (read-only render of
  kernel state, no input field). Mentor's affordance is
  **conversational advisory** (input field + multi-turn history +
  ranked output). Mixing them under one sub-section forces a
  context-switch tax on every glance.
- Inspector reads are passive (poll-driven, no user trigger); Mentor
  reads are explicit (user types a question → Cairn responds). Two
  trigger models = two surfaces.
- The Mentor sub-section can still **reuse Inspector's read handles**
  (the read-only SQLite handle pattern in `main.cjs` /
  `project-queries.cjs`) — UI separation, not data layer separation.

### 1.2 Single-shot vs multi-turn

**Recommend: multi-turn within a single chat session, with bounded
context window.**

Rationale:
- Single-shot ("user asks once, Cairn answers once, history is empty")
  is cheaper in tokens but loses the core wedge of Mentor — the user
  asking "**why** did you put X before Y?" is where Mentor's value
  shows. Stripping follow-ups makes Mentor feel like a stale ranked
  list.
- Multi-turn lets the user pressure-test recommendations
  ("if I skip Z, what changes?") without re-priming Mentor with the
  full project signal set on every question.
- The bound: each follow-up reuses the **same signals snapshot** (no
  re-reading state on every turn within a session); a new
  signals-snapshot is fetched only when (a) the user starts a new
  chat session, (b) the cache TTL expires (§4.4), or (c) the user
  hits "refresh signals" explicitly.

### 1.3 Trigger semantics

Mentor is **on-ask only** (per PRODUCT.md §6.5.1 边界 list):

- No auto-push (no daily-brief, no scheduled, no background timer).
- The "ask" gesture is typing into the chat input field. A slash-
  command shortcut (`/mentor <one-line goal>`) MAY be added later
  as ergonomic sugar; it triggers the same code path.
- The rationale (verbatim from PRODUCT.md §6.5.1): *"推 chat 模式因为
  推荐质量极度依赖 timing context，'用户主动问' 比 'Cairn 主动推' 准"*.

---

## 2. Input signal whitelist

Mentor reads **only** the signals enumerated below. Anything not on
this list MUST NOT be read by the Mentor module — even if technically
accessible. This is the privacy and scope envelope.

### 2.1 Whitelist (read-only)

| Signal class | Source | Read pattern |
|---|---|---|
| Project static docs | `<project_root>/{PRODUCT.md, README.md, README, TODO.md, CLAUDE.md, ARCHITECTURE.md}` if present | `fs.readFileSync` first **N=6 KB** per file; clip and concatenate |
| Git commits | `git log --oneline -20` from project root | `execFileSync('git', ...)` with 1 s timeout; never `--format=fuller` or `--patch` |
| Git working state | `git rev-parse HEAD` + `git status --short` | execFileSync; never `git diff` (would expose unstaged content) |
| Candidates | `~/.cairn/project-candidates/<projectId>.jsonl` | `project-candidates.cjs::listCandidates(projectId, limit=100)` (already implemented) |
| Iterations | `~/.cairn/project-iterations/<projectId>.jsonl` | `project-iterations.cjs::listIterations(projectId, limit=100)` |
| Worker reports | `~/.cairn/project-reports/<projectId>.jsonl` | `worker-reports.cjs::listWorkerReports(projectId, limit=50)` — read only the structured sections, never raw `tool_response.stdout` |
| Tasks / blockers / outcomes | Cairn SQLite via existing read handle | reuse the project-queries.cjs read patterns from Inspector — same handle, no separate connection |
| Mentor's own history | `~/.cairn/mentor-history/<projectId>.jsonl` (§7) | for last-N-turn context when in multi-turn mode |
| GitHub open issues | only if user has a `gh` CLI authenticated and explicitly enabled this signal in the panel (off by default) | `gh issue list --state open --limit 20 --json number,title,labels` |

### 2.2 Explicit non-inputs (privacy hard wall)

Mentor MUST NOT read, even when technically accessible:

- `.env` / `.env.*` / any file matched by `.gitignore` patterns that
  resemble secret stores (`*secret*`, `*credentials*`, `*.key`,
  `*.pem`)
- Absolute filesystem paths outside `~/.cairn` and `<project_root>` —
  no `~/Documents`, no `/etc`, no `C:\Users\<other-user>`
- Per-event payloads of agent transcripts past **line 1**:
  - `~/.codex/sessions/**/*.jsonl` — first line (`session_meta`) only
    (already enforced by `codex-session-log-scan.cjs`; Mentor reads
    via that adapter, never re-opens the file)
  - `~/.claude/sessions/<pid>.json` — already metadata-only via
    `claude-code-session-scan.cjs`
- Worker stdout / stderr raw text (only the **structured** fields
  in `worker-reports.cjs` are allowed)
- Commit message bodies past the first line (only `--oneline`)
- GitHub credentials / API tokens / any value of `GH_TOKEN` /
  `GITHUB_TOKEN` env var content
- Any file content beyond the whitelisted docs in §2.1 — Mentor
  does NOT walk the project tree to discover "what might be
  interesting"

### 2.3 Signal collection failure handling

Each signal source is collected with **independent timeout + try/catch**
(`Promise.race([fetch, timeout(5000)])`). A single source failing
(git timeout, permission denied) does not fail the whole Mentor call —
the failed source is recorded into `meta.failed_signals` and Mentor
proceeds with the available subset. See §8 scenario 6.

---

### 3. Output schema per work item

Mentor returns, on each chat turn, an **ordered array** of recommended
work items. The order is the ranked output (highest priority first).
Each element conforms to the schema below.

#### 3.1 TypeScript-style schema

```typescript
interface MentorWorkItem {
  /** Mentor-generated id, format `m_<12hex>`, ≤ 80 chars. */
  id: string;

  /**
   * Short description, ≤ 200 chars (tighter than candidate.description's
   * 240-char cap — Mentor output is summary layer, detail lives in
   * evidence_refs drill-downs).
   */
  description: string;

  why: {
    /** One sentence on impact, ≤ ~100 chars. */
    impact: string;
    /** Implementation cost coarse-grained. */
    cost: "L" | "M" | "H";
    /** Stability risk introduced by the change. */
    risk:  "L" | "M" | "H";
    /** Time pressure — "H" = waiting another day makes it worse. */
    urgency: "L" | "M" | "H";
  };

  stakeholders: {
    /** Who executes. */
    owner:    "agent" | "human" | "either";
    /** Who reviews. */
    reviewer: "agent" | "human" | "either";
    /**
     * Other agent roles / kinds that should be aware of this item.
     * MUST be agent role / kind strings only (e.g. "worker",
     * "reviewer", "codex-session-α"). NO real human names.
     */
    notify: string[];
  };

  /** Closed enumeration — see §3.2. */
  next_action:
    | "pick to start Continuous Iteration"
    | "propose candidate then pick"
    | "answer blocker question"
    | "manual run via <Codex CLI|Claude Code>"
    | "create checkpoint then investigate"
    | "defer / mark not-now"
    | "escalate to human review";

  /**
   * Drill-down evidence. `kind` is a closed set; new kinds require a
   * schema-level addition (see §3.5 invariant #3).
   */
  evidence_refs: Array<{
    kind:
      | "task"
      | "candidate"
      | "blocker"
      | "outcome"
      | "iteration"
      | "commit"
      | "doc";
    ref: string; // task_id / candidate_id / commit_hash / file path / URL
  }>;

  /**
   * Mentor's self-rated confidence in this recommendation, [0.0, 1.0].
   * Items with < 0.5 MUST be placed at the tail of the list, or
   * promoted to next_action = "escalate to human review" (see §3.5
   * invariant #4).
   */
  confidence: number;
}
```

#### 3.2 `next_action` allowed values (closed set)

| Value | Trigger / meaning |
|---|---|
| `"pick to start Continuous Iteration"` | A `PROPOSED` candidate already exists; the user can pick it into Mode B's execution chain |
| `"propose candidate then pick"` | No candidate exists; Mentor recommends Scout produces one first |
| `"answer blocker question"` | A task is `BLOCKED`; kernel has an open blocker awaiting the user's answer |
| `"manual run via <Codex CLI\|Claude Code>"` | Work that needs interactive debugging, external auth, or otherwise doesn't fit Mode B's auto-chain |
| `"create checkpoint then investigate"` | State is unclear (outcome `FAILED` / dirty working tree); checkpoint first, then debug |
| `"defer / mark not-now"` | Mentor thinks the timing is wrong; recommend the user explicitly reject so it doesn't re-surface |
| `"escalate to human review"` | Mentor confidence < 0.5, or the action's semantics imply a terminal decision (merge / push / accept / reject) — human-only |

#### 3.3 Concrete JSON examples

**Example A — OPEN blocker (task waiting on user answer)**

```json
{
  "id": "m_a3f09c12b7e1",
  "description": "Task t_42 is blocked: agent needs auth scope decision before calling external API.",
  "why": {
    "impact": "Unblocking this resumes the only in-flight task touching the payments module.",
    "cost": "L",
    "risk": "M",
    "urgency": "H"
  },
  "stakeholders": {
    "owner": "human",
    "reviewer": "agent",
    "notify": ["worker", "codex-session-α"]
  },
  "next_action": "answer blocker question",
  "evidence_refs": [
    { "kind": "task",    "ref": "t_42" },
    { "kind": "blocker", "ref": "blk_7d3e9a" },
    { "kind": "outcome", "ref": "t_42:outcome_pending" }
  ],
  "confidence": 0.91
}
```

**Example B — PROPOSED candidate (`candidate_kind=missing_test`) awaiting execution**

```json
{
  "id": "m_b8c2d5f10a3e",
  "description": "Candidate c_9ef3a1207b4c proposes adding unit tests for outcomes DSL evaluator; PROPOSED, not yet picked.",
  "why": {
    "impact": "Outcomes evaluator has zero test coverage; any regression ships silently.",
    "cost": "M",
    "risk": "L",
    "urgency": "M"
  },
  "stakeholders": {
    "owner": "agent",
    "reviewer": "human",
    "notify": ["reviewer", "worker"]
  },
  "next_action": "pick to start Continuous Iteration",
  "evidence_refs": [
    { "kind": "candidate",  "ref": "c_9ef3a1207b4c" },
    { "kind": "iteration",  "ref": "iter_20260511_dsl" },
    { "kind": "commit",     "ref": "3a7f2c1" }
  ],
  "confidence": 0.85
}
```

**Example C — FAILED outcome (low confidence → escalate)**

```json
{
  "id": "m_c1d4e8f03b9a",
  "description": "Task t_17 outcome is FAILED: worker reported spawn error in path-utils on Windows; root cause unknown.",
  "why": {
    "impact": "Failed task blocks the Three-Stage Loop from completing its Review stage for the refactor candidate.",
    "cost": "M",
    "risk": "H",
    "urgency": "H"
  },
  "stakeholders": {
    "owner": "human",
    "reviewer": "human",
    "notify": ["worker", "reviewer"]
  },
  "next_action": "escalate to human review",
  "evidence_refs": [
    { "kind": "task",      "ref": "t_17" },
    { "kind": "outcome",   "ref": "t_17:outcome_failed" },
    { "kind": "candidate", "ref": "c_4ab8120df7c3" },
    { "kind": "commit",    "ref": "f1e9b03" }
  ],
  "confidence": 0.38
}
```

**Example D — sparse-state inference (git log shows auth changes, no test)**

```json
{
  "id": "m_d6f7a09c2e5b",
  "description": "Recent commits touched auth module (3 files, 2 authors) but no test file was modified; coverage gap inferred.",
  "why": {
    "impact": "Auth regressions are high-blast-radius; untested changes increase incident probability.",
    "cost": "M",
    "risk": "H",
    "urgency": "M"
  },
  "stakeholders": {
    "owner": "agent",
    "reviewer": "human",
    "notify": ["codex-session-β", "reviewer"]
  },
  "next_action": "propose candidate then pick",
  "evidence_refs": [
    { "kind": "commit", "ref": "a2d4f78" },
    { "kind": "commit", "ref": "9c1b3e5" },
    { "kind": "doc",    "ref": "packages/mcp-server/src/dsl/spawn-utils.ts" }
  ],
  "confidence": 0.72
}
```

#### 3.4 Field constraints

| Field | Type | Required | Length / values | Notes |
|---|---|---|---|---|
| `id` | string | yes | format `m_<12hex>`, ≤ 80 chars | Mentor-generated; never reuses candidate_id / task_id |
| `description` | string | yes | ≤ 200 chars | 40 chars tighter than candidate `STR_DESC_MAX`(240); MUST NOT embed evidence IDs verbatim |
| `why.impact` | string | yes | ≤ 1 sentence (~ 100 chars) | Focused on cost-of-not-doing or value-of-doing |
| `why.cost` | `"L"\|"M"\|"H"` | yes | closed 3-value | Coarse person-day estimate |
| `why.risk` | `"L"\|"M"\|"H"` | yes | closed 3-value | Stability risk |
| `why.urgency` | `"L"\|"M"\|"H"` | yes | closed 3-value | H = waiting another day makes it worse |
| `stakeholders.owner` | `"agent"\|"human"\|"either"` | yes | closed 3-value | `agent` = can be executed purely by a machine |
| `stakeholders.reviewer` | `"agent"\|"human"\|"either"` | yes | closed 3-value | |
| `stakeholders.notify` | string[] | yes (may be `[]`) | each ≤ 64 chars, agent role/kind only | NO real names; empty array allowed |
| `next_action` | enum | yes | closed 7-value | New values require schema-level extension |
| `evidence_refs` | array | yes (may be `[]`) | each `{kind: closed 7-value, ref: string}` | kind closed set: task/candidate/blocker/outcome/iteration/commit/doc |
| `confidence` | number | yes | [0.0, 1.0], precision 0.01 | < 0.5 → tail or escalate; never NaN / Infinity |

#### 3.5 Schema invariants

1. **No redundant IDs in description** — `description` MUST NOT repeat IDs already in `evidence_refs`. IDs belong in refs; description is for prose.
2. **No real names in `notify`** — `stakeholders.notify[]` is restricted to agent role / kind strings (`"worker"`, `"reviewer"`, `"codex-session-α"`). Real human names or user account names are forbidden.
3. **Closed `evidence_refs.kind`** — only `"task" | "candidate" | "blocker" | "outcome" | "iteration" | "commit" | "doc"`. Extending requires a schema-level update; data MUST NOT invent new kinds.
4. **Low-confidence items go last or escalate** — items with `confidence < 0.5` MUST be placed at the tail of the ranked array, OR `next_action` MUST be `"escalate to human review"`. Front-loading low-confidence picks misleads the user.
5. **Terminal-decision actions MUST escalate** — if Mentor's intended `next_action` would semantically include "merge / push / accept / reject / rollback", it MUST be rewritten as `"escalate to human review"`. Mentor advises; humans hold terminal decisions.

---

## 4. Reasoning chain

### 4.1 Two candidate patterns

| Pattern | How it works | Pros | Cons |
|---|---|---|---|
| **Pure LLM-driven** | Feed all signals to LLM; LLM ranks + writes WHY in one pass | Single model call; LLM can spot non-obvious patterns | Output is non-deterministic on identical input; hard to test; if LLM down, total failure |
| **Deterministic skeleton + LLM polish** (recommend) | Compute the ranked skeleton via heuristic rules (§6); pass skeleton + signals to LLM only for WHY/notify/confidence polishing | Stable ranking; testable; LLM failure → fall back to skeleton without WHY | Two-stage; loses some emergent insight the LLM might find from raw signals |

### 4.2 Recommended: deterministic skeleton + LLM polish

Rationale:
- Stability matters: a user asking "why is X first today, was Y first yesterday?" needs an answer that doesn't depend on LLM mood.
- Testability: the heuristic skeleton is unit-testable (input fixtures → expected ranked order). LLM polish quality is measured separately.
- Failure-mode hygiene: when the LLM call fails (§8 scenario 1), Mentor can still produce a deterministic skeleton with empty `why` and `confidence=null` — better than nothing.

### 4.3 Stage breakdown

**Stage A — Signal collection** (§2): aggregate all whitelisted signals with per-source timeout. ~50-300 ms total when caches are warm.

**Stage B — Deterministic skeleton** (§6 ranking algorithm): walk kernel state + candidates + iterations + worker reports, group items by tier, sort within tier by recency. Output: ranked list of `(item_descriptor, evidence_refs, raw_signals)` tuples, capped at `max_items + 2` (slight overshoot for LLM trimming room).

**Stage C — LLM polish**: feed the skeleton + a clipped subset of signal text (within token budget §4.4) to the host LLM. LLM's job: write `description` (compressed), `why.{impact,cost,risk,urgency}`, `stakeholders`, `confidence`. LLM MUST NOT reorder the ranked list beyond promoting low-confidence items to tail/escalate.

**Stage D — Schema validation**: validate every item against §3 schema (closed enums, length caps, invariants). Items failing validation are dropped from the response and logged.

### 4.4 Context budget

- **Token cap for LLM input**: ~6,000 tokens (conservative for Claude Sonnet 200K window; lets multi-turn follow-ups stay in budget).
- **Per-signal allocations**:
  - Project static docs: ≤ 2,000 tokens (≈ 6 KB raw)
  - Git log (oneline × 20): ≤ 500 tokens
  - Candidates (last 20): ≤ 1,500 tokens
  - Iterations (last 10): ≤ 500 tokens
  - Worker reports (last 5): ≤ 1,000 tokens
  - Kernel state summary (tasks / blockers / outcomes): ≤ 500 tokens
- Overflow handling: see §8 scenario 3 (context budget overflow).

### 4.5 Cache TTL and invalidation

- **TTL**: 5 minutes default. Key = `(project_root, signals_hash)`.
- **`signals_hash`** is computed over: `git rev-parse HEAD`, candidates JSONL file mtime, iterations JSONL mtime, worker-reports JSONL mtime, kernel SQLite `processes` table row count + max(`updated_at`).
- **Invalidation triggers**:
  - new commit detected (HEAD changed)
  - any of the JSONL files appended (mtime moved)
  - kernel state mutation (new task / blocker / outcome row)
  - user clicks "refresh signals" in the panel
- **Stale cache behavior**: see §8 scenario 4 (stale cache + new commit).

---

### 5. Boundaries (MUST NOT)

#### 5.1 硬边界清单

Mentor MUST NOT:

1. **bypass user authorization** — never auto-start a chain or work-item execution outside the explicit auth granted in Mode B (§6.5.2).
2. **recommend auto-merge / push / skip-review** — accept / reject / push / merge are terminal human-only actions (§6.5.2 安全边界); Mentor never suggests skipping them.
3. **propose mutations to `PRODUCT.md` / anti-definitions / governance documents** — product positioning, anti-definitions, governance docs are user-only edits. Mentor reads them, never proposes diffs.
4. **mention real human personal names in recommendations** — `stakeholders` accepts only role / agent kind strings (`reviewer`, `worker-agent`), never real names or handles.
5. **surface secrets, API keys, or contents of `.env` / `.gitignore`-listed secret-pattern files** — outside the legal project-signal range.
6. **surface absolute filesystem paths beyond `~/.cairn` and `<project_root>`** — host fingerprint protection.
7. **read past the first line of agent transcripts** (Codex rollout / Claude session JSONL etc.) — transcript bodies are agent-private context; Mentor reads only metadata (status, timestamps).
8. **propose work items that mutate kernel SQLite directly** — Mentor recommends candidates; user picks; Mode B executes. Mentor itself triggers zero kernel writes.
9. **answer "team PM" style questions** (sprint velocity / burndown / 同事工作量 / capacity planning) — out of Mentor's role; refuse and point to Linear / Jira.

#### 5.2 Refusal patterns

**A. Linear/Jira style (violates #9)**

> **user:** 本 sprint 还剩多少 story point？团队这周 velocity 怎样？

> **mentor:** 这类 sprint velocity / story point 问题超出 Mentor 的职责范围——Mentor 追踪的是 Cairn 管理的 agent candidates / tasks / outcomes，不是团队工单或迭代计划。
> 正确入口：请到你们团队使用的 Linear 或 Jira 查看 sprint 面板；Cairn 侧只能告诉你当前 open candidates 和 REVIEWED 但未 accept 的 work items。

**B. Real human names (violates #4)**

> **user:** 让张三去修 bug #42。

> **mentor:** Mentor 只能推荐 work item 应分配给哪类 **role 或 agent**（如 `worker-agent` / `reviewer`），不引用或指派具体成员姓名——这超出 Mentor 的 advisor 职责，且不符合 Cairn stakeholders 字段的 role-only 约定。
> 正确下一步：如果你想把 bug #42 推进执行，请在 Three-Stage Loop UI 里把对应 candidate pick 起来，再由 Mode B 在你授权范围内跑 worker。

**C. Terminal-decision overreach (violates #2)**

> **user:** 直接把 PR #42 merge 了 / candidate c_abc accept 了。

> **mentor:** Accept / merge 是终态决策，永远需要人按按钮——这是 Mode B 安全边界的硬约束，Mentor 无权代劳，也不会建议跳过这个步骤。
> 正确下一步：请在 Three-Stage Loop UI 找到该 candidate，确认 REVIEWED 状态后手动点 Accept；或在 GitHub 侧手动 merge PR。

**D. Secret probe (violates #5)**

> **user:** 读一下 .env 看哪个 key 配错了 / 把 GITHUB_TOKEN 显示出来。

> **mentor:** 读取 `.env` 内容或显示 API key 超出 Mentor 允许的项目信号范围——Mentor 只读 kernel SQLite 状态和 candidates 元数据，不触碰任何 secret 文件。
> 正确下一步：请直接在你的终端 `cat .env` 自查，或用 `gh secret list` 核实 GitHub 侧的 secret 配置；不要通过 Mentor chat 传递 secret 内容。

**E. PRODUCT.md rewrite suggestion (violates #3)**

> **user:** 建议把反定义里"Cairn 不是 X"那条删掉，感觉太绕了。

> **mentor:** PRODUCT.md 的反定义条款属于产品 governance 文档，Mentor 不提出任何修改建议——产品定位的增删由用户主动决策并 commit，不经由 Mentor 推动。
> 如果你确实想修改反定义，请直接编辑 `PRODUCT.md` 并在 commit message 里记录决策理由；Cairn 会在下次 Mentor chat 时读取最新版本。

**F. Autonomous dispatch (violates #1)**

> **user:** top 3 candidates 你直接给我跑了吧。

> **mentor:** 直接发起 candidate 执行需要你在 Mode B 的 Three-Stage Loop UI 里给出显式授权——Mentor 是 advisor，不能在 chat 里作为 dispatch 触发点自启 chain。
> 正确下一步：请切到 Three-Stage Loop UI → 选择 "Continuous Iteration" 模式 → 设定授权范围（如"auto-run top 3"）后再启动；Mentor 这里只能帮你确认 top 3 排序的理由。

#### 5.3 Boundary vs Mode B division of labor

Mentor's MUST-NOT list and Mode B's MUST-NOT list are **not the same set** — they're complementary:

- **Mentor is advisor** (per §1.3 #4b: *"Mentor 是 advisor，Continuous 是 executor under explicit authorization"*): only recommends ranked work items + WHY + stakeholder roles; never dispatches, never mutates kernel state; out-of-scope handled by refusal.
- **Mode B is executor under explicit authorization**: can auto-chain (scout → worker → review) within the user-granted scope, but must auto-stop at REVIEWED and mark `needs_human=true` when boundary verify trips; never auto-retry or auto-escalate.
- **Common floor**: accept / reject / push / merge — Mentor never recommends skipping these; Mode B never auto-triggers them. Human-only.

---

## 6. Cardinality + cadence

### 6.1 Max items per response

- **Default 5** (matches Scout's pattern in `scout-prompt.cjs:46`). Closed numeric upper bound; the user MAY pass a query that asks "give me top 3" or "give me top 10" — Mentor will respect overrides up to **10**, never beyond.
- Rationale: > 10 items in a chat panel is no longer "advisor", it's "dump". If Mentor wants to surface > 10, that's a signal to **split the question** ("what should I do about the auth module?" vs "what should I do about tests?"); Mentor's refusal in that case suggests narrower scoping.

### 6.2 Ranking algorithm

The deterministic skeleton (§4.3 Stage B) ranks items across these tiers, **higher tier ranks first**, within-tier sorted by recency (most recent first):

| Tier | Source items | Why this tier |
|---|---|---|
| **T1 — Blocking signals** | blockers in `OPEN` status; tasks in `FAILED`; tasks in `WAITING_REVIEW` | Something is genuinely stuck; the user is the only unblock |
| **T2 — Pending decisions** | candidates in `REVIEWED` status (waiting accept/reject); tasks in `BLOCKED` | A human decision is pending; surfacing fastest reduces queue depth |
| **T3 — Ready to execute** | candidates in `PROPOSED` status (can be picked → Mode B) | Standard advancement |
| **T4 — Inferred from signals** | git log patterns (e.g., "auth module changed but no test commit"); doc gaps; failure patterns from worker reports | Mentor's value-add layer; lowest confidence by default |

Within a tier, items are sorted by `updated_at DESC` (most recent first). Tie-breaks: candidate before task before doc-inference, then alphabetic by id.

**Invariant**: §3.5 #4 still applies — any item with `confidence < 0.5` after LLM polish is demoted to the array tail or to `next_action = "escalate to human review"`, **regardless of tier**.

### 6.3 Cadence

**On-ask only** (per §1.3 trigger semantics):
- No auto-push, no daily-brief, no background polling.
- No "Mentor has new recommendations!" notification — the chat panel doesn't render anything until the user types.
- Cache (§4.5) lets follow-ups within 5 minutes feel instant without re-running the deterministic skeleton; this is an internal efficiency, not a cadence change.

---

## 7. Persistence

### 7.1 Decision: append-only history JSONL

**Recommend: persist to `~/.cairn/mentor-history/<projectId>.jsonl`** (append-only, JSONL, parallel to candidates / iterations / reports files).

Rationale:
- **Self-evaluation**: the only way to ask "did Mentor recommend X last week, did the user pick it, did it succeed?" is to have a log. Mentor's quality lift is precisely this kind of feedback loop.
- **Replay / debug**: when a user says "Mentor told me Y yesterday, but it was wrong", a log makes the conversation reviewable.
- **Continuity across sessions**: if the user restarts the desktop-shell, recent Mentor turns survive — feels like talking to the same advisor.
- **Pattern parity**: candidates / iterations / worker-reports are all JSONL files in `~/.cairn/`. One more in the same shape adds no new IO style.

Ephemeral (no persistence) was the alternative considered; rejected because Mentor's value depends on the user trusting Mentor's recommendations, and trust requires the ability to verify past advice against outcomes.

### 7.2 Record shape

Each line of `mentor-history/<projectId>.jsonl` is one chat turn:

```json
{
  "event_version": 1,
  "turn_id": "h_<12hex>",
  "ts": 1715420000000,
  "project_id": "<project_id>",
  "session_id": "<chat session id, groups multi-turn>",
  "user_question": "<verbatim user input>",
  "signals_hash": "<§4.5 hash>",
  "signals_summary": {
    "candidates_count": 12, "tasks_count": 7,
    "open_blockers": 2, "failed_outcomes": 1,
    "git_head": "<7-hex>"
  },
  "ranked_items": [/* full MentorWorkItem[] from §3 */],
  "llm_meta": {
    "host": "claude-api|codex-cli|gemini",
    "model": "<id>",
    "tokens_in": 4521, "tokens_out": 1203,
    "latency_ms": 1840, "fallback_used": false
  },
  "user_followup_actions": [] // optional, filled later if user picks/rejects an item — see §7.3
}
```

### 7.3 Followup linkage (optional, post-MVP)

After the user acts on a Mentor recommendation (picks → Mode B; answers blocker; rejects), the panel MAY append a follow-up record linking the turn_id to the resulting candidate / iteration / outcome. This enables the self-eval feedback loop. v0 of Mentor does NOT require this linkage; it's a v0.x addition.

### 7.4 Privacy: history stays local

- The history file is **local-only**. It MUST NOT be published via Mode C Multi-Cairn outbox (which only carries `description / candidate_kind / status / kind_chip` snapshots of published candidates — Mentor history is not a candidate snapshot).
- Mode C explicit non-shares (per PRODUCT.md §6.5.3): "不共享 prompt 内容、不共享 worker diff、不共享 secret". Mentor history contains the user's full question text — this falls under "prompt content" by spirit, so it stays local.
- The user MAY rotate / delete `~/.cairn/mentor-history/<projectId>.jsonl` at any time; Mentor degrades gracefully (loses multi-turn continuity, gains nothing else).

### 7.5 Size cap (v0)

Per-project file capped at ~5 MB or 1,000 records (whichever first); on cap exceed, the oldest 25% are truncated. Cap and rotation policy are tunable post-launch; the v0 number is just defense against unbounded growth.

---

### 8. Failure Modes

> **Design principles (4 lines)**
>
> 1. Any failure MUST NOT be silently swallowed — Mentor must let the user see Cairn knows what failed and where. Silent = lying about success, which violates §2.2 "可见性先于可解决性" — Mentor's foundational stance.
> 2. Degraded paths MUST preserve **partial usability**: when LLM polish is unavailable, fall back to the deterministic skeleton (§4 heuristic ranking) — never return empty.
> 3. **Refusal patterns (out-of-scope) do NOT live in this section**. If a user asks Mentor something Mentor shouldn't answer (§5 cases), that's "won't do" — belongs to §5. This section is "couldn't do" — system / data / performance degradations.
> 4. Every degraded response MUST include: **reason (specific error class) + what's available now (even if just the skeleton) + user-actionable next step**. Missing any of the three = not an acceptable failure response.

**Scenario 1 — LLM call fails**

- **Trigger**: HTTP 429 rate limit / 500 / 503 / network `ECONNRESET` / `ETIMEDOUT` / API key invalidated (401 / 403).
- **Detection**: `fetch()` rejected, or HTTP status ≠ 2xx, or response body lacks a valid `work_items` block (JSON parse fails / schema validation fails). Any one trips this mode.
- **Degraded behavior**: skip the LLM polish stage; emit the deterministic skeleton (§4 heuristic ranking) directly with top-N items; leave `why` empty or `null`, set `confidence: null` to mark "no LLM polish". `evidence_refs` still populated (from kernel SQLite, doesn't depend on LLM).
- **User-visible feedback**:
  > mentor: LLM 调用失败（429 rate limit，host: claude-api）。以下是基于项目 state 直接排出的 top-3，没有 WHY 解释段落——每条后面的 `[evidence]` 链接可以帮你核实排序依据。稍后重试可以拿到带解释的完整版本。

**Scenario 2 — Sparse-state new project (no candidates / tasks / commits)**

- **Trigger**: project just initialized — `~/.cairn/project-candidates/` empty, kernel `tasks` table 0 rows, `git log` empty or initial-commit-only, `PRODUCT.md` / `README` missing or < 100 chars.
- **Detection**: after signal aggregation, check `signals.candidates.length === 0 && signals.tasks.length === 0 && signals.commits.length <= 1 && signals.doc_chars < 100`. All four true → sparse state path.
- **Degraded behavior**: do NOT call LLM (no signals to reason over, calling = hallucination). Return a fixed skeleton + suggestion to run a Scout pass for first candidates. No ranked list (empty is better than fabricated).
- **User-visible feedback**:
  > mentor: 项目信号太稀疏，暂时无法给出排序建议——candidates=0，tasks=0，有效 commits=0。建议先跑一次 Scout 生成候选项，或者在 README / PRODUCT.md 里补充项目目标，然后再来问我。

**Scenario 3 — Context budget overflow**

- **Trigger**: project large enough that `PRODUCT.md` + last 20 commits + candidates JSONL + tasks/blockers/outcomes summary, when assembled into the prompt, exceeds the LLM's context window (Claude Sonnet = 200 K tokens; smaller for some Codex CLI configs).
- **Detection**: prompt-assembly stage estimates tokens (`Math.ceil(charCount / 3.5)` conservative); if estimate > `contextBudget * 0.9` (10% reserved for output), trigger overflow path. Also tripped by an LLM `context_length_exceeded` error.
- **Degraded behavior**: priority-based truncation — drop in order: ①git log detail (keep last 5 subject lines only) → ②candidate bodies (keep `description` only, drop `why`/`evidence` detail) → ③static docs (keep README first 300 chars only) → ④if still over budget, fall back to deterministic skeleton without LLM. Record each truncation step into the response's `meta.truncated_signals` field.
- **User-visible feedback**:
  > mentor: 项目信号总量超出 LLM context 预算（估算 ~220K tokens，上限 200K）。已自动裁剪 git 历史和 candidates 详情后重试。当前推荐基于截断后的信号，可靠性略低——建议在问题里聚焦到具体子模块（例如"只看 daemon 包"），可以获得更准确的推荐。

**Scenario 4 — Stale cache hit (snapshot expired)**

- **Trigger**: Mentor has a per-project response cache (TTL 5 min, key = `(project_root, user_query_hash)`). User repeats a similar question within TTL → cache hit. But meanwhile a new commit has landed, or a task / outcome transitioned — snapshot is now inconsistent with current state.
- **Detection**: before returning the cached response, compare `cache_snapshot.git_head` with current `git rev-parse HEAD`; or compare `kernel_state.tasks_updated_at > cache_snapshot.timestamp`. Either inequality → stale.
- **Degraded behavior**: do NOT return the stale cache directly. Show a stale warning + the previous ranking (tagged `[stale]`), and trigger a background refresh (re-fetch signals + re-call LLM); when refresh completes, stream the update into the chat. If the user doesn't wait, at least they see the `[stale]`-tagged previous result rather than an empty response.
- **User-visible feedback**:
  > mentor: 检测到新 commit（a3f2c1d，2 分钟前），缓存快照已过期。以下是上一次的推荐结果（5 分钟前），标 [stale]——正在后台刷新，完成后自动更新。如果需要立即获取最新推荐，点击"强制刷新"或稍等 10 秒。

**Scenario 5 — Out-of-scope team-PM ask (UX cross-ref to §5)**

> This is **not** a system failure; it's a §5 refusal pattern. Listed here only because users often experience refusals as "Mentor broke" — distinguishing this explicitly prevents that misread. Behavioral path lives in §5.2 case A.

- **Trigger**: user query implies **cross-person / cross-project / team aggregation** — e.g. "team velocity 怎样", "A 和 B 谁的吞吐量更高", "上周整个团队做了多少 story points". Mentor's input range is single-project host-level state (§6.5.1 边界), so the answer is unavailable by design, not by error.
- **Detection**: query classification stage (LLM intent classifier or keyword rules) flags `intent.scope === 'cross_person' || intent.scope === 'cross_project' || intent.metric_type === 'velocity'`.
- **Degraded behavior** (here = refusal behavior): do NOT call LLM for futile inference; return a scope explanation + the closest available substitute (an equivalent single-project question).
- **User-visible feedback**:
  > mentor: 这个问题需要跨人员聚合，超出我的信号范围——我只能看到本项目的 tasks / outcomes / commits，没有团队成员的独立数据。我能回答的最近问题是："这个项目最近 7 天哪些 task 推进最慢？"——要换成这个问？

**Scenario 6 — Partial signal read failure (git timeout / fs permission)**

- **Trigger**: during input aggregation, `git log` / `git rev-parse` times out (> 5 s, large monorepo or high IO load); or `PRODUCT.md` / candidates JSONL read fails on permission (EPERM / EACCES). Local failure — kernel SQLite read may still work, LLM may still be reachable; only one input source is missing.
- **Detection**: aggregation wraps each signal source in `Promise.race([fetch, timeout(5000)])` or try/catch; any source rejecting / timing out is recorded into `meta.failed_signals[]` rather than killing the whole Mentor call. If `failed_signals.length > 0 && available_signals.length > 0`, enter "degraded but usable" path.
- **Degraded behavior**: call LLM with the available signal subset, **explicitly tell the LLM in the prompt** which sources are missing (avoids hallucinated inference about absent signals); annotate the response with `meta.missing_signals[]` so the user knows the recommendation is on partial info.
- **User-visible feedback**:
  > mentor: git 信号读取超时（5s），推荐基于 tasks + candidates，不含 commit 历史。以下结果可能遗漏近期 commit 相关的优先级变化——如果磁盘 IO 恢复后重问，可以拿到更完整的推荐。

---

## 9. Alignment check

Verbatim verification against the source-of-truth documents and adjacent
modes. Each row claims a contract; the rationale column names the file
+ line that the contract is grounded in.

### 9.1 PRODUCT.md alignment

| Contract | Source | This spec respects it by |
|---|---|---|
| Mentor is chat panel, not push / report / email | §6.5.1 form | §1.1 surface = new chat sub-section; §6.3 on-ask only |
| Input = static docs + git + candidates + tasks + outcomes + reports | §6.5.1 input list | §2.1 whitelist explicitly enumerates these |
| Output = description + why + stakeholders + next_action + evidence_refs | §6.5.1 output bullets | §3 schema expands these into a strict TS interface + closed enums |
| Mentor recommends, not decides | §6.5.1 边界 #1 | §3.5 invariant #5 (terminal-decision → escalate) + §5.1 #2 (no auto-merge) |
| Mode A proposes, Mode B executes (with explicit auth) | §6.5.2 跟 Mode A 关系 | §3.2 next_action `"pick to start Continuous Iteration"`; §10 hand-off |
| Mentor does not auto-run | §6.5.1 边界 #4 | §6.3 cadence = on-ask only, no daily-brief |
| No new host-level state / no new MCP tool / no new daemon | §6.5.1 实现指向 | §2.1 reuses existing JSONL + read handles; §7.1 history is local JSONL only (new file, but not a kernel state object) |

### 9.2 §1.3 anti-definition alignment

| v4 clause | This spec respects it by |
|---|---|
| **#4a**: explicit-authorization auto-chain → REVIEWED stop; accept/reject/push/merge human-only | §3.5 invariant #5; §5.1 #1, #2; §5.2 cases C, F |
| **#4b**: Mentor as advisor, not orchestrator | §1.1 surface; §5.3 division of labor; §6.5.1 边界 #1 echoed in §5.1 #8 |
| **#5a**: mentor for AI workforce ≠ Linear-style team PM (4 reasons) | §5.1 #9; §5.2 case A refuses sprint velocity; §3 schema uses role/agent kind, no human assignees |
| **#5b**: work items reference candidates/tasks/blockers/outcomes; not new "team issue" entity | §3.1 `evidence_refs` kind closed set is precisely these |
| **#6 generic agent framework** | (untouched — Mentor is product-internal, not exposed as framework) |
| **#8a/b/c multi-Cairn read-only outbox** | §7.4 history stays local, never enters Mode C outbox |

### 9.3 §2.2 belief alignment

| Belief | This spec respects it by |
|---|---|
| #1 "Cairn 不抢方向盘" + v4 "授权范围内推进，终态决策永远人持" | §3.5 invariant #5; §6.3 on-ask only; §5.3 common floor |
| #2 "可见 + 可推荐 + 可执行（按授权）" | Mentor IS the "可推荐" rung; doesn't claim "可执行" (that's Mode B). §8 design principle #1 cites §2.2 verbatim |

### 9.4 Contract dependencies (what Mentor reads)

Mentor depends on, READ-ONLY:

- `project-candidates.cjs::listCandidates(projectId, limit)`
- `project-iterations.cjs::listIterations(projectId, limit)`
- `worker-reports.cjs::listWorkerReports(projectId, limit)` (structured sections only)
- `claude-code-session-scan.cjs::scanClaudeSessions()` (already metadata-only)
- `codex-session-log-scan.cjs::scanCodexSessions()` (already first-line-only)
- Desktop-shell SQLite read handle (existing pattern from Inspector / project-queries.cjs)
- File system reads of `<project_root>/{PRODUCT.md, README.md, TODO.md, CLAUDE.md, ARCHITECTURE.md}`, capped at 6 KB each
- `git log --oneline -20` / `git rev-parse HEAD` / `git status --short` via `execFileSync` with 1 s timeout
- `~/.cairn/mentor-history/<projectId>.jsonl` (Mentor's own log)

Mentor mutates:

- `~/.cairn/mentor-history/<projectId>.jsonl` (append-only)
- **Nothing else.** Specifically: zero writes to kernel SQLite, zero writes to candidates / iterations / reports JSONL, zero writes to registry, zero writes to `~/.claude` / `~/.codex`.

### 9.5 Mode B Continuous Iteration handoff (commit `1ce4c3a`)

The handoff between Mode A and Mode B is **the user clicks "Pick"** in the Three-Stage Loop UI on a candidate referenced by Mentor's output. Schema mapping:

- Mentor item with `next_action = "pick to start Continuous Iteration"` + `evidence_refs[].kind = "candidate"` with a `candidate_id` → user clicks Pick on that candidate ID in the UI → Mode B `pickCandidateAndLaunchWorker` handler runs.
- Mentor item with `next_action = "propose candidate then pick"` → user clicks "Propose from Mentor" (UI sugar) → `proposeCandidate` runs with Mentor's `description` as the candidate description; then user picks normally.

Either way, **Mentor does not call `pickCandidateAndLaunchWorker` or `proposeCandidate` directly**. The button click is the human authorization gate.

---

## 10. Delegation hints for A1 (Mentor scaffold impl)

Two concrete hints to seed the A1 implementation phase:

1. **Reuse `scout-prompt.cjs`'s HARD RULES block pattern** for Mentor's LLM prompt. Specifically: a numbered `STRICT RULES — violating any means ...` list at the top of the prompt, followed by an `OUTPUT FORMAT — end your response with EXACTLY this block (and nothing after it)` fence-enforced output. The Scout pattern is the canonical model for "agent that emits structured output for deterministic parsing"; Mentor's `work_items` block should follow the same shape (JSON inside a fenced code block, parser scans for the LAST occurrence of the header to tolerate any LLM preamble).

2. **Mentor's data layer is a pure read on existing handlers, plus one new JSONL writer**. Scaffold files:
   - `packages/desktop-shell/mentor-prompt.cjs` (parallel to `scout-prompt.cjs`) — composes HARD RULES + signals into the LLM prompt; pure composition, no I/O.
   - `packages/desktop-shell/mentor-collect.cjs` — gathers signals per §2.1, with per-source timeout and `meta.failed_signals` tracking per §8 scenario 6.
   - `packages/desktop-shell/mentor-history.cjs` — append-only JSONL writer for §7 (mirror of `project-candidates.cjs` IO pattern: dirname `mentor-history`, file `<projectId>.jsonl`, `appendLine` helper, fold not needed for v0).
   - `packages/desktop-shell/mentor-handler.cjs` — top-level handler called by the panel IPC; orchestrates collect → skeleton rank (§6.2) → LLM polish (§4.3 Stage C) → schema validate (§4.3 Stage D) → history append → return. No new schema, no new MCP tool, no new daemon.
   - No new dependency.

---

## 11. Status

This is a **design draft**. Not yet implemented; not yet committed as
a contract. To advance:
1. user review + approve this spec
2. file lands in `docs/mentor-layer-spec.md` (this commit)
3. A1 scaffold implements per §10 hints
4. follow-up spec sub-revisions land here when reality diverges from draft

Until step 3 produces a working scaffold, the schema and ranking
algorithm are subject to revision based on dogfood findings.
