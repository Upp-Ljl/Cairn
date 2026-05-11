# Xproduct.md - Agent Work Governance

> Status: product direction note, not a replacement for `PRODUCT.md`.
> Source reference: Meituan engineering article, "用 Agent 评测思路管理 AI Coding - 31 万行代码 AI 重构的实践"  
> Link: https://mp.weixin.qq.com/s/CTY5mdgKh6TmPrO6xsKhWQ

This note captures what Cairn should borrow from the article. The point is not the "310k-line refactor" story itself. The useful lesson is the operating model behind it:

> Do not build a stronger coding agent. Build the engineering environment that constrains, coordinates, reviews, and improves how agents and people work together.

Cairn's current product direction already fits this: a local project control surface for agentic software work. The next upgrade should move from "seeing the worksite" to "making the worksite governable."

---

## 1. Core Takeaway

AI Coding at scale does not mainly fail because agents write too slowly. It fails because agent work becomes hard to govern:

- standards are implicit;
- progress reports are inconsistent;
- tasks drift from the original goal;
- testing and review are skipped or uneven;
- handoff context is verbose and unreliable;
- repeated failures do not become reusable rules.

For Cairn, the upgrade path is:

> Cairn should become the local governance layer for agent work: project rules, worker reports, Pre-PR gates, task-chain evidence, repeated failure patterns, and recovery anchors all visible in one project control surface.

This keeps the existing boundary intact:

- Codex / Claude Code / Cursor / Kiro still execute code.
- Cairn does not write code.
- Cairn does not auto-split tasks.
- Cairn does not dispatch agents as an orchestrator.
- Cairn records, relates, validates, and surfaces the work.

---

## 2. What To Borrow

### 2.1 人人对齐 -> 人机对齐

The article's strongest method is:

1. First align humans on standards.
2. Then turn those standards into AI Rules / Skills / SOP / checklists.

Cairn should mirror this at project level. Before agent collaboration can be reliable, the project needs explicit answers to:

- What is a task?
- What counts as done?
- What counts as blocked?
- When is testing required?
- When is a checkpoint required?
- What must a worker agent report before stopping?
- What must happen before a PR is considered ready?
- What should be escalated to the human?

Cairn should not invent these standards automatically. It should make them durable, visible, reusable, and tied to tasks/outcomes.

### 2.2 Pre-PR As The First Governance Gate

The article's Pre-PR mechanism is highly applicable. Before a formal PR or final handoff, an agent should self-check:

- goal completion;
- changed files;
- tests run;
- typecheck/lint status;
- risky files touched;
- open blockers;
- failed outcomes;
- missing docs or migrations;
- PR summary and review notes.

In Cairn, this maps naturally to existing primitives:

- `tasks` = work item;
- `outcomes` = deterministic gate result;
- `checkpoints` = recovery evidence;
- `blockers` = unresolved attention requests;
- `Run Log` = visible execution record;
- `Project-Aware Panel` = the user's control surface.

Pre-PR should initially be read-only / advisory:

- `READY`
- `NEEDS_TESTS`
- `NEEDS_REVIEW`
- `BLOCKED`
- `FAILED_GATE`
- `DRIFT_RISK`

It should not block git, open PRs, or mutate code in the first version.

### 2.3 Worker Report Protocol

A multi-agent system becomes expensive if the supervisor must read every full conversation. The cheaper pattern is: every worker session emits a short structured report.

Suggested report shape:

```text
GOAL:
DONE:
NOT_DONE:
CHANGED:
TESTS:
BLOCKERS:
RISKS:
NEXT:
HUMAN_NEEDED:
```

Cairn can store and show these reports under the relevant task chain. This gives the human a project-level view without forcing every agent to share full chat history.

This is also the basis for efficient long-horizon work:

- Claude Code / Codex writes a short report.
- Cairn attaches it to the task/session.
- The panel shows state and deltas.
- A supervisor agent or human decides the next instruction.

### 2.4 Rules Should Be Project Artifacts

Rules should not be scattered across prompts, chats, and memory. Cairn can treat them as project artifacts:

- coding rules;
- review rules;
- test rules;
- checkpoint rules;
- migration rules;
- worker report rules;
- Pre-PR checklist rules.

The panel can show which rules applied to a task, which checks passed, and which failed repeatedly.

### 2.5 Repeated Failures Should Become Pending Learnings

The article's deeper lesson is continuous improvement. When failures repeat, they should become candidate rules.

Examples:

- Agent often forgets to run `npm test`.
- Agent touches `package.json` without explaining release impact.
- Agent starts a refactor without checkpointing.
- Agent leaves a blocker unresolved but reports "done".
- Agent changes UI but does not run a desktop smoke.

Cairn can record these as pending learnings:

```text
Pattern:
Evidence:
Suggested rule:
Scope:
Status: pending_review / accepted / rejected
```

Important boundary: Cairn should not silently train or rewrite agent behavior. Human approval should turn a repeated failure into a project rule.

---

## 3. Product Upgrade: Agent Work Governance

This direction can be named:

> Agent Work Governance

It is not a new product identity. It is the next capability layer on top of the current project control surface.

Current layer:

> See project, agents, task chains, blockers, outcomes, checkpoints, and run log.

Governance layer:

> See whether agent work follows project rules, whether it is ready for review, where it drifted, and which repeated failures should become rules.

---

## 4. Proposed Capabilities

### 4.1 Project Rules Registry

Project-level rules stored locally and displayed in the panel.

Possible fields:

```text
rule_id
title
description
scope
severity
source
created_at
status
```

Examples:

- "Before any rewind, create an auto checkpoint."
- "Desktop-shell UI changes require Electron boot smoke."
- "MCP tool surface changes require stdio smoke."
- "Package/license changes require owner decision."
- "Worker reports must include tests and risks."

Panel surface:

- Project Rules tab or section.
- Task detail shows "applied rules".
- Pre-PR Gate references relevant rules.

### 4.2 Agent Report Protocol

Structured short reports attached to task/session.

Possible fields:

```text
report_id
task_id
agent_id
session_id
goal
done
not_done
changed_files
tests
blockers
risks
next
human_needed
created_at
```

Panel surface:

- Under each task chain: latest worker report.
- In Run Log: `agent.reported`.
- In Project Summary: "N reports need review" or "latest report stale".

### 4.3 Pre-PR Gate

A readiness check before PR/handoff/final delivery.

Inputs:

- current task intent;
- changed files from git;
- latest worker report;
- outcomes status;
- open blockers;
- checkpoint existence;
- tests evidence;
- project rules.

Outputs:

```text
status: READY | NEEDS_TESTS | NEEDS_REVIEW | BLOCKED | FAILED_GATE | DRIFT_RISK
summary
missing_evidence[]
recommended_next[]
```

First version should be advisory, not mutating:

- no automatic PR creation;
- no git hook enforcement;
- no blocking commits;
- no AI code review mandate.

### 4.4 Rule Adherence Record

Record which project rules were checked and what happened.

Possible events:

- `rule.checked`
- `rule.passed`
- `rule.failed`
- `rule.waived`
- `pre_pr.ready`
- `pre_pr.failed`

This eventually belongs in `cairn_events`, but the first version can be represented through existing outcomes/report artifacts.

### 4.5 Repeated Failure Pattern Log

A lightweight retrospective queue.

Possible fields:

```text
pattern_id
title
evidence_task_ids
evidence_report_ids
suggested_rule
hit_count
status
created_at
last_seen_at
```

Panel surface:

- "Repeated failures" section in project detail.
- Human can accept one as a project rule.

### 4.6 Governance Debt

This is the project-management analogue of technical debt.

Examples:

- task without outcome;
- active session without report;
- failed outcome without next action;
- blocker older than threshold;
- no checkpoint before risky operation;
- unassigned agent activity;
- task marked done but Pre-PR gate not run;
- repeated rule failure not converted to rule.

Panel surface:

- Project summary: governance debt count.
- Detail view: list of unresolved governance debt.

---

## 5. How This Fits Current Cairn

Cairn already has the right foundation:

| Current object | Governance use |
|---|---|
| `tasks` | durable work items and task chains |
| `processes` | live agent/session presence |
| `blockers` | unresolved attention requests |
| `outcomes` | deterministic checks and gate results |
| `checkpoints` | recovery anchors and evidence |
| `scratchpad` | shared context and raw reports |
| `dispatch_requests` | handoff/assignment evidence |
| Run Log | worksite narrative |

The governance layer should not replace these objects. It should organize them around rules, reports, readiness, and repeated failures.

---

## 6. Suggested First Demo

Do not start with a full PMO system. Start with one focused demo:

> A task reaches "ready for review"; Cairn shows a Pre-PR Gate using the latest worker report, tests evidence, checkpoint presence, blockers, outcomes, and project rules.

Demo flow:

1. A Claude Code / Codex session works on a task.
2. It writes a short worker report.
3. Cairn attaches the report to the task chain.
4. Cairn evaluates a Pre-PR Gate:
   - tests present?
   - open blockers?
   - checkpoint exists?
   - outcome status?
   - changed files summarized?
   - project rules checked?
5. Panel shows:
   - `READY` or `NEEDS_TESTS` / `BLOCKED` / `DRIFT_RISK`;
   - missing evidence;
   - suggested next action.

This is small, demoable, and directly tied to user value.

---

## 7. Implementation Sketch

### Phase A: No Schema, File/Report Based

Use existing artifacts first:

- worker report as markdown or scratchpad key;
- Pre-PR checklist as a project file;
- outcomes as gate result;
- panel reads and displays a simple readiness status.

Good enough to validate UX.

### Phase B: Local SQLite Artifacts

If useful, add dedicated tables later:

- `project_rules`
- `agent_reports`
- `pre_pr_gates`
- `rule_adherence`
- `failure_patterns`

This should come after the panel proves the workflow.

### Phase C: Event Stream

When `cairn_events` exists, emit:

- `agent.reported`
- `rule.checked`
- `rule.failed`
- `pre_pr.ready`
- `pre_pr.failed`
- `failure_pattern.detected`

Then Run Log becomes the governance timeline, not just an activity feed.

---

## 8. Boundaries

Cairn should not become:

- a coding agent;
- a code reviewer that decides correctness alone;
- a CI replacement;
- Jira / Linear / Asana;
- a lead-subagent orchestrator;
- an automatic task dispatcher;
- an enterprise compliance platform.

Cairn can become:

- the local place where project rules live;
- the place where agent reports attach to task chains;
- the place where Pre-PR readiness is visible;
- the place where repeated failures become reviewed rules;
- the place where the human sees what still needs judgment.

The human still decides priority, tradeoffs, and final acceptance.

---

## 9. Product Principle

The article points to a principle Cairn should adopt:

> AI lowers the cost of seeing everything; humans still decide what matters.

Cairn should help the developer see the project state, evidence, missing checks, handoff status, repeated failures, and recovery points. It should not pretend to be the final authority.

---

## 10. Recommendation

After Project-Aware Live Panel stabilizes, the next product upgrade should be:

1. Worker Report Protocol.
2. Pre-PR Gate.
3. Project Rules Registry.
4. Governance Debt indicators.
5. Repeated Failure Pattern Log.

Recommended first slice:

> Add a lightweight Pre-PR Gate view for one task, powered by a short worker report and existing Cairn objects.

This would upgrade Cairn from:

> "I can see what agents are doing."

to:

> "I can see whether agent work is ready, blocked, drifting, or missing evidence."

That is the product step most aligned with Cairn's current direction.
