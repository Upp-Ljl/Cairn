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

For non-trivial changes: feature branch + PR.
- Branch name: `<type>/<slug>`. Examples: `packaging/win-nsis-mvp`, `feat/live-run-log-events-table`.
- Always branch from latest `main`.

For doc-only / trivial changes: direct push to `main` is fine (no PR review value).

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

- `0`, `{const`, and any single-char-or-pattern accidental files
- `.cairn-push-token/*.txt` — PAT tokens (gitignored)
- `.env*` — credentials
- `.cairn-worktrees/` — agent worktrees (gitignored)
- `node_modules/`, `dist/` (per existing gitignore)

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
