# PR-PLAN — Fix Planning After Review

> Adapted from TeamBrain `docs/PR-PLAN.md`.
> When reviewer Agent returns `VERDICT: NEEDS_FIX (n=K)`, write a PR-PLAN
> with the same DUCKPLAN structure scoped to the fix.

## When You Need a PR-PLAN

You wrote a DUCKPLAN. You implemented. You pushed. Reviewer Agent returned P1/P2 findings.

Now you need a **PR-PLAN**: a focused plan for fixing the findings, with its own acceptance criteria. Do NOT just start editing — write the PR-PLAN first.

---

## PR-PLAN File Location

`docs/superpowers/plans/YYYY-MM-DD-pr-<n>-fix-plan.md`

(If the PR has no number yet, use a slug: `docs/superpowers/plans/YYYY-MM-DD-pr-<slug>-fix-plan.md`.)

---

## Format

Three sections (lighter than full DUCKPLAN because the original plan still applies):

### 1. Tasks
Each P1 / P2 finding becomes a task. Group by file where possible.

```
- T1 [P1] packages/desktop-shell/main.cjs:1825 — IPC `start-managed-iteration` not gated on MUTATIONS_ENABLED
- T2 [P2] packages/desktop-shell/scripts/smoke-managed-loop-panel.mjs — missing assertion for the new IPC handler
- T3 [P3 deferred] panel.html:2025 — button label "register" could be "register as managed"; reason: cosmetic, can ship later
```

### 2. Expected Outputs
For each task, what changes:

```
- T1: main.cjs line 1825 wrapped in `if (MUTATIONS_ENABLED) { ... }`; smoke asserts handler is skipped when env not set
- T2: smoke-managed-loop-panel.mjs has new section "Part X: IPC gating", 3 new assertions
```

### 3. Judge Harness
The verifier that proves the fix landed:

```bash
# T1 + T2
node packages/desktop-shell/scripts/smoke-managed-loop-panel.mjs
# expect: 63/63 (was 60/60; +3 from T2)

# CAIRN_DESKTOP_ENABLE_MUTATIONS not set → handler returns gated error
CAIRN_DESKTOP_ENABLE_MUTATIONS= node packages/desktop-shell/scripts/dogfood-managed-project-loop.mjs
# expect: registers as expected; mutation calls return {ok: false, reason: 'mutations_disabled'}
```

---

## Dispatch Rules for PR-PLAN

- Each P1 / P2 task goes to its own subagent via `TEAMWORK.md` if there are ≥ 2 non-overlapping files
- Single-file fixes: lead agent does it (no overhead worth spawning a subagent for one file)
- After all fixes pushed: re-dispatch reviewer Agent (per `POSTPR.md`); loop until `VERDICT: READY_TO_MERGE`

---

## Anti-Patterns Specific to PR-PLAN

- ❌ "Fix everything in one big commit" — atomize per task so reviewer can diff per concern
- ❌ "P3 found by reviewer slipped in here" — keep PR-PLAN scoped to P1/P2; P3 deferral is decided BEFORE PR-PLAN, not during
- ❌ Modify the original plan to make reviewer findings "no longer apply" — that's gaslighting the reviewer; if scope was wrong, reject the PR and re-plan from DUCKPLAN

---

## Closing the Loop

A PR-PLAN is closed when:
1. All P1 / P2 tasks are implemented and committed
2. Re-dispatched reviewer Agent returns `VERDICT: READY_TO_MERGE`
3. CI green; no conflict (per `POSTPR.md`)

Only then merge.
