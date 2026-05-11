# Plan Format

> Every non-trivial task starts with a plan. This is the standard format.

## Structure (4 sections, required)

### 1. Goal
One sentence. What changes in the world when this is done.

### 2. Acceptance Checklist
≤5 items. Each item is either true or false — no "should be" or "probably".

```
[ ] `bun test` passes with no new failures
[ ] Panel shows Managed Loop card with all 5 actions
[ ] User can start an iteration without opening a terminal
[ ] No new npm dependencies added
[ ] No new MCP tools or migrations
```

### 3. Verify Commands
The exact commands that prove the checklist above.
Not "run tests" — the actual command string.

```bash
cd packages/desktop-shell && node scripts/dogfood-managed-project-loop.mjs
# expect: 21/21 assertions PASS
```

### 4. Out of Scope
What this plan explicitly does not do. Prevents scope creep mid-execution.

---

## Plan File Convention

Plans live in `docs/superpowers/plans/` named `YYYY-MM-DD-<slug>.md`.
Workflow docs (this kind) live in `docs/workflow/`.

---

## Self-Evaluation Before Delivery

Before reporting done, Claude checks each checklist item and reports:
- ✅ verified by: `<command + output>`
- ❌ not done: `<what's missing>`

"Should be fine" is not a verification. A command with output is.
