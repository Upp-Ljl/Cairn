# Review Loop: Auto-Verify After Every Ship

> After every push, verify the work is actually correct — not just committed.

## The Loop

```
ship (commit + push)
  │
  ▼
run verify commands
  │
  ├── all pass → done, report
  │
  └── any fail → fix in same session, re-run verify, ship again
       (never open a "follow-up issue" and merge anyway)
```

## Non-negotiable Rules

1. **Fix in this session, not a follow-up.** If verification fails after push, fix it now. Do not merge and open an issue. The issue will never be fixed.

2. **Verify commands run automatically.** After every commit, Claude runs the verify commands from the plan without being asked.

3. **Dogfood beats unit tests.** Unit tests passing is necessary but not sufficient. The real dogfood script must pass. For Cairn: `node scripts/w5-phase3-dogfood.mjs` (32/32). For each new feature: the feature's own smoke.

4. **Two engines > one.** When possible, verify with two independent tools (e.g., Claude runs the command, then Codex also runs it). Divergence means something is wrong.

---

## Stop Conditions

Work is done when ALL of the following are true:
- [ ] All unit tests pass (`npm test`)
- [ ] TypeScript compiles clean (`npx tsc --noEmit`)
- [ ] Live dogfood or smoke passes
- [ ] No uncommitted leftover changes relevant to the task
- [ ] Acceptance checklist from the plan is fully checked

If any item is false, do not report done. Fix first.

---

## Verify Commands for Cairn

```bash
# daemon
cd packages/daemon && npm test && npx tsc --noEmit

# mcp-server
cd packages/mcp-server && npm test && npx tsc --noEmit

# live dogfood (kernel)
cd packages/mcp-server && npm run build && node scripts/w5-phase3-dogfood.mjs

# managed project loop (desktop-shell)
node packages/desktop-shell/scripts/dogfood-managed-project-loop.mjs
```

Expected baselines:
- daemon: 411 tests / 29 files
- mcp-server: 329 tests / 17 files / 1 pre-existing skip
- dogfood: 32/32 assertions PASS
- managed loop: 21/21 assertions PASS

---

## When to Skip Review Loop

Never. Even for "trivial" doc-only changes, at minimum run `git diff --stat` and confirm the staged files match intent. The accidental `0` and `{const` files in the 2026-05-11 commit happened because this step was skipped.
