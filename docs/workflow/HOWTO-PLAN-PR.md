# HOWTO-PLAN-PR — DUCKPLAN Format

> Every PR plan must have four sections. Missing any section = plan rejected.
> Adapted from TeamBrain `docs/HOWTO-PLAN-PR.md`.

## The Four Sections

### 1. Plan
What the code change is. Specific, not vague.

Examples:
- ❌ "Improve packaging" — vague
- ✅ "Add electron-builder config to `packages/desktop-shell/package.json` targeting NSIS installer on Windows x64. Produce `dist/Cairn Setup x.x.x.exe`. No code-signing in this PR."

### 2. Expected Outputs
What artifacts exist after the work is done. Files, binaries, schema rows, commits.

Examples:
- `packages/desktop-shell/package.json` has `"build"` field with `appId`, `productName`, `nsis` config
- `packages/desktop-shell/dist/Cairn Setup 0.1.0.exe` exists, ≤ 120 MB
- `packages/desktop-shell/scripts/smoke-electron-package.mjs` exists, asserts NSIS produces a valid exe
- Commit on branch `packaging/win-nsis-mvp`

### 3. How To Verify
Exact commands a reviewer can run. Each command must end with a deterministic check.

Examples:
```bash
# build
cd packages/desktop-shell && npm run build:win
# expect: exit 0; dist/Cairn Setup 0.1.0.exe exists

# smoke
node packages/desktop-shell/scripts/smoke-electron-package.mjs
# expect: 12/12 assertions pass

# install + launch
"dist/Cairn Setup 0.1.0.exe" /S
cairn --version
# expect: prints v0.1.0
```

### 4. Probes
Fast `claude -p` / `claude --model haiku -p` invocations that probe the artifact in JSON form, suitable for hard-match cross-validation per `FEATURE-VALIDATION.md`.

Examples:
```bash
claude --model haiku -p \
  "Given this electron-builder config: $(cat packages/desktop-shell/package.json | jq .build), output JSON {appId, productName, targets} only" \
  > /tmp/probe-claude.json

# second engine: claude sonnet, expected hard-match
claude --model sonnet -p \
  "Same prompt..." > /tmp/probe-sonnet.json

diff /tmp/probe-claude.json /tmp/probe-sonnet.json
# expect: zero diff (JSON hard-match)
```

---

## Plan File Location

`docs/superpowers/plans/YYYY-MM-DD-<slug>.md`

Workflow methodology docs (this kind) live in `docs/workflow/`.
DUCKPLAN files are for **executing** plans, not for methodology.

---

## What Makes a Plan Fail Review

- Section 1 says what to do but section 3 has no verify command → reject
- Section 3 has commands but section 2 has no expected output to check against → reject
- Section 4 has no probes (or has one only, not enough for cross-validation) → reject
- Plan has multiple unrelated changes ("packaging + UI polish + bug fix") → split into separate plans
- Plan has scope creep mid-execution → stop, re-plan; don't keep going

---

## When NOT to Write a DUCKPLAN

For trivial changes (typo fix, doc update under 50 lines, single-line config change), skip the four-section plan and just commit. The rule of thumb: if you can describe the change in one sentence AND verify it in one command, no plan needed.

For anything multi-file, multi-package, or involving new dependencies / migrations / IPC / new MCP tools — plan required.
