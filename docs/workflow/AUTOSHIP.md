# AUTOSHIP — Commit → Push → PR

> After DUCKPLAN work is implemented and FEATURE-VALIDATION passes, ship the PR.
> No human approval needed for commit / push / open-PR. Approval IS needed for: merge, tag, npm publish, force-push, LICENSE changes (per CLAUDE.md).

## Flow

```
DUCKPLAN signed off
   │
   ▼  implement (TEAMWORK if N tasks; lead agent if 1)
artifact in worktree
   │
   ▼  FEATURE-VALIDATION 1+2+3 passes
local green
   │
   ▼  AUTOSHIP — this doc
push + open PR
   │
   ▼  POSTPR review loop
```

---

## Commit Message Format

```
<type>(<scope>): <short description>

<body if needed — what changed and why, not how>
```

Types: `feat` / `fix` / `chore` / `docs` / `test`.
No `Co-Authored-By` trailer (user preference, 2026-04-27).

---

## Branch Strategy

For any change touching code files (`.ts` / `.js` / `.cjs` / `.mjs` / `.json` / `.sql`): feature branch + PR. POSTPR reviewer Agent must pass before merge.
- Branch name: `<type>/<slug>`. Examples: `packaging/win-nsis-mvp`, `feat/live-run-log-events-table`.
- Always branch from latest `main`.

For doc-only / config-only changes with **zero code-file deltas**, direct push to `main` is allowed — but a POSTPR Agent dispatch is still recommended for any doc that defines methodology (`docs/workflow/`, `CLAUDE.md`, `PRODUCT.md`, `ARCHITECTURE.md`).

---

## Push Command

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')

# Default: openssl backend
git -c http.sslBackend=openssl push \
  "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" <branch>

# If TLS fails: switch backend
git -c http.sslBackend=schannel push \
  "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" <branch>
```

Always redact TOKEN in user-visible logs: `sed "s/${TOKEN}/<REDACTED>/g"`.

---

## Open PR (Feature Branch Only)

`gh` is not installed on this machine — use GitHub REST API:

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')

curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/Upp-Ljl/Cairn/pulls" \
  --data-binary @- <<EOF | sed "s/${TOKEN}/<REDACTED>/g"
{
  "title": "<commit title>",
  "body": "## Summary\n...\n## Plan reference\ndocs/superpowers/plans/YYYY-MM-DD-<slug>.md\n## Test plan\n...",
  "head": "<feature-branch>",
  "base": "main"
}
EOF
```

After PR is open, hand off to `POSTPR.md` reviewer Agent dispatch.

---

## Files to Never Stage

- Any untracked file whose name looks like a typo or stray shell redirect: single-char names, leading `{`, leading `&`, trailing garbage.
- `.cairn-push-token/*.txt` — PAT tokens (gitignored)
- `.env*` — credentials
- `.cairn-worktrees/` — agent worktrees (gitignored)
- `node_modules/`, `dist/` (per existing gitignore)

Before staging, eyeball `git status` for anything not on the plan's expected outputs list.

---

## Forbidden During Push (Red Lines)

These are red lines. Violating them rolls the change back.

- ❌ `git push --force` / `--force-with-lease` to `main` or any shared branch
- ❌ `git reset --hard` to "make the diff smaller" after staging
- ❌ `--no-verify` to skip pre-commit hooks
- ❌ `--no-gpg-sign` to skip signing
- ❌ Amending an already-pushed commit (rewrites history teammates have fetched)
- ❌ `git checkout .` / `git restore .` over uncommitted teammate work
- ❌ Adding `// @ts-ignore` / `eslint-disable` / `.skip` to make a check pass without root-cause

If you find yourself reaching for one of these: stop. Investigate. The push is not ready.

See `POSTPR.md` §"Forbidden Patterns" for the same red lines applied to post-push fixes.

---

## TLS Failure Recovery

If push fails with `unexpected eof while reading`:
1. Switch backend (`openssl` ↔ `schannel`) and retry
2. If both fail, sleep 5s, retry from step 1
3. Resolves within 2 retries typically

See `CLAUDE.md` push section for full TLS notes.

---

## What Requires Explicit User Approval

Per CLAUDE.md, autoship does NOT cover:

- Merging a PR (terminal decision)
- `git tag` (release)
- `npm publish`
- Force push
- Editing `LICENSE` / `PRODUCT.md` / governance docs
- Adding new npm deps

For those: state the proposed action, wait for user confirmation, then execute.
