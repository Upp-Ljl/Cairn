# Auto-Ship: Commit → Push → PR

> After docs/code work is done, ship immediately — no human approval needed for commit and push.

## What "auto-ship" means

When work is complete and verified:
1. Stage relevant files (never `0`, `{const`, or other accidental files)
2. Commit with conventional commit message
3. Push to `origin main` via PAT (openssl backend first, schannel fallback)
4. If on a feature branch: open PR via GitHub API

No "should I commit?" question. No "ready to push?" confirmation.
The user has pre-authorized this for all verified, complete work.

---

## Commit Message Format

```
<type>(<scope>): <short description>

<body if needed — what changed and why, not how>
```

Types: `feat` / `fix` / `chore` / `docs` / `test`
No `Co-Authored-By` trailer (user preference, 2026-04-27).

---

## Push Command

```bash
TOKEN=$(cat .cairn-push-token/ljl-token.txt | tr -d '[:space:]')

# Try openssl first
git -c http.sslBackend=openssl push \
  "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" main

# If that fails, try schannel
git -c http.sslBackend=schannel push \
  "https://x-access-token:${TOKEN}@github.com/Upp-Ljl/Cairn.git" main
```

Always redact TOKEN in logs: `sed "s/${TOKEN}/<REDACTED>/g"`

---

## PR Creation (feature branch only)

PRs are only possible when `head != base`. If working on `main` directly, push is the delivery — no PR.

For feature branch work:
```bash
curl -s -X POST \
  -H "Authorization: token ${TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/Upp-Ljl/Cairn/pulls" \
  --data-binary @- <<EOF
{
  "title": "<commit title>",
  "body": "## Summary\n...\n## Test plan\n...",
  "head": "<feature-branch>",
  "base": "main"
}
EOF
```

---

## Files to Never Stage

- `0`, `{const` — accidental empty files from typos
- `.cairn-push-token/*.txt` — PAT tokens, gitignored
- `.env*` — credentials

---

## TLS Failure Recovery

If push fails with `unexpected eof while reading`:
1. Switch backend (openssl ↔ schannel) and retry
2. If both fail, sleep 5s and retry from step 1
3. Typically resolves within 2 retries

See `CLAUDE.md §push` for full TLS notes.
