# POSTPR — Auto-Review Loop After Push

> Adapted from TeamBrain `docs/POSTPR.md`.
> Original: Codex bot reviews every push, leaves inline P1/P2/P3 comments;
> main agent fixes P1/P2 in same PR; loop until Codex silent or 👍.
> Cairn adaptation: no Codex bot — dispatch Agent (general-purpose, opus or sonnet) to review the diff and produce same-shape output.

## The Loop

```
push to feature branch
   │
   ▼  open PR (or push to existing PR)
PR open
   │
   ▼  dispatch reviewer Agent — input: PR diff + plan ref + acceptance checklist
reviewer Agent outputs structured findings: P1 / P2 / P3
   │
   ├── P1 / P2 present → write PR-PLAN, dispatch fixers, push fix commit → loop back
   │
   └── only P3 (or none) → check stop conditions
         │
         ├── CI green AND no conflict AND reviewer silent/👍 → merge
         │
         └── any of above false → fix → loop back
```

**Hard rule**: P1 / P2 are fixed in **this PR**. They are NEVER deferred to a follow-up issue. Punting via follow-up issue means the issue will never be fixed.

P3 may be deferred with explicit reason ("UX polish, low blast radius, captured as issue #N").

---

## Reviewer Agent Prompt

Dispatch the reviewer with this shape:

```
# Reviewer role
You are an independent code reviewer. You have not seen prior conversation. Audit only the PR diff against the linked plan.

# Inputs
- PR diff: <output of `git diff main..HEAD` on the PR branch>
- Plan: <contents of docs/superpowers/plans/YYYY-MM-DD-<slug>.md>
- Acceptance checklist: <copy from plan section 1>

# Your job
For each finding, output a row:
- Severity: P1 (must fix to merge) | P2 (must fix to merge) | P3 (defer ok)
- File: path:line_range
- Issue: one sentence
- Why it matters: one sentence (cite blast radius)
- Suggested fix: one sentence or code snippet

# Stop conditions
After audit:
- If you found zero P1/P2: end your message with "VERDICT: READY_TO_MERGE"
- If you found ≥ 1 P1 or P2: end your message with "VERDICT: NEEDS_FIX (n=<P1+P2 count>)"
- Do NOT output anything after the VERDICT line.

# Anti-patterns to flag as P1
- silent fallback (try/catch that swallows errors)
- destructive git operations (reset --hard, force push, branch -D)
- missing verify command for new behavior
- broken acceptance checklist item
- new dependency without CLAUDE.md approval
- mutation gated on env flag not yet set up
```

---

## P-Severity Rules

| Severity | Definition | Example | Action |
|---|---|---|---|
| **P1** | Blocks merge; breaks an acceptance criterion or introduces production hazard | "New IPC handler doesn't gate on MUTATIONS_ENABLED; will mutate state in default install" | Fix in same PR |
| **P2** | Blocks merge; missing required artifact or quality bar | "Plan section 3 said `npm test` must pass; new test file added but not actually run" | Fix in same PR |
| **P3** | Does not block; polish / future work | "Variable named `mgr` could be `manager` for clarity" | Defer with explicit reason |

---

## Stop Conditions (All Three Must Hold)

1. **CI green**: all configured test suites pass at the latest commit
   - Check without `gh`: `curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/Upp-Ljl/Cairn/commits/<sha>/check-runs" | jq '.check_runs[] | {name, conclusion}'`
   - PAT from `AUTOSHIP.md §"Push Command"`. Expect every `conclusion` to be `"success"`.
2. **No merge conflict** with target branch
3. **Reviewer silent or 👍**: latest reviewer Agent output is `VERDICT: READY_TO_MERGE`

If any one is false, the PR is NOT ready. Do not merge. Do not click the button.

---

## Forbidden Patterns

These are red lines. Violation means the PR is rolled back.

- ❌ `git reset --hard` on the PR branch to "make CI green" — destroys reviewer's prior comments
- ❌ Force push to main / master — overwrites teammates' work
- ❌ Open a "follow-up" issue containing a P1 / P2 and merge anyway
- ❌ Add `// @ts-ignore` or `eslint-disable` to make a check pass without root-cause investigation
- ❌ Skip a hook with `--no-verify` to push faster
- ❌ Mark a test `.skip` to make CI green

If you find yourself reaching for one of these: stop. Investigate root cause. The PR is not ready.

---

## Cadence

Reviewer Agent is dispatched:
- Immediately after the initial push to the PR branch
- After every fix-commit push that addresses prior P1/P2

Cadence interval: as fast as the Agent can run (no fixed polling). The next dispatch is gated on `git push` completing, not on a timer.

---

## Cross-Reference

- `HOWTO-PLAN-PR.md` — the plan reviewer reads
- `PR-PLAN.md` — what to write when reviewer returns P1/P2
- `FEATURE-VALIDATION.md` — pre-push gate, prevents many P1s from reaching reviewer
- `AUTOSHIP.md` — the push mechanics POSTPR loops on
