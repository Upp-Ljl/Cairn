# Feature Validation — Cross-Engine 1+2+3

> Adapted from TeamBrain's "Feature 验证 1+2+3" gate.
> Original: `claudefast -p` → `codex exec` → `tmux interactive`, JSON hard-match.
> Cairn adaptation: `claude --model haiku -p` → `claude --model sonnet -p` (different context) → real-run via Bash, JSON hard-match.

## Why Three Gates

A single AI engine can be self-deceiving — it asserts X works when X does not. Cross-validation by **two different engines** plus a **real run** catches this.

For Cairn (no codex / no claudefast / no tmux), the three gates are:

| Gate | Tool | Output |
|---|---|---|
| **Gate 1 — Fast probe** | `claude --model haiku -p` | Canonical JSON describing the artifact |
| **Gate 2 — Second engine** | `claude --model sonnet -p` in fresh context (via Agent subagent for true isolation) | Canonical JSON describing the same artifact |
| **Gate 3 — Real run** | Direct `Bash` execution; capture stdout/stderr verbatim | Real output of the artifact in production-like conditions |

---

## The Hard-Match Rule

Gate 1 JSON and Gate 2 JSON must be **byte-identical** after canonicalization (sort keys, normalize whitespace).

```bash
# Gate 1
claude --model haiku -p "$PROMPT" > /tmp/gate1.json
jq -S . /tmp/gate1.json > /tmp/gate1.canonical.json

# Gate 2 (Agent subagent — use `general-purpose` for full context isolation
# AND ability to run verification commands; `Explore` is read-only and
# cannot execute Bash, so it is not suitable for Gate 2.)
# spawn Agent(subagent_type: "general-purpose", prompt: $PROMPT) → expect JSON output
# save to /tmp/gate2.json
jq -S . /tmp/gate2.json > /tmp/gate2.canonical.json

# Hard match
diff -u /tmp/gate1.canonical.json /tmp/gate2.canonical.json
# expect: zero output (identical)
```

If diff is non-empty:
- One engine is hallucinating
- Or the prompt is ambiguous (different reasonable answers)
- Either way: do not ship until resolved.

---

## Gate 3 — Real Run

The real run produces ground truth. If gate 3 contradicts gate 1+2 even when 1+2 agreed, the AI engines were jointly wrong (rare but possible).

```bash
# Run the actual feature
node packages/desktop-shell/scripts/smoke-<feature>.mjs > /tmp/gate3.txt 2>&1
# OR
cd packages/<pkg> && npm test > /tmp/gate3.txt 2>&1

# Extract canonical JSON from real output (the feature must emit structured output for this to work)
grep -oE '\{.*\}' /tmp/gate3.txt | jq -S . > /tmp/gate3.canonical.json

diff -u /tmp/gate1.canonical.json /tmp/gate3.canonical.json
# expect: zero output (matches AI claims AND reality)
```

---

## Concrete Example — `cairn install` Verification

**Plan**: harden `cairn install` so a teammate can run it on a fresh clone and get a working setup.

**Gate 1 — claude haiku probe**:
```bash
PROMPT='Read packages/mcp-server/src/cli/install.ts. Output JSON only: {"flags":[...],"files_written":[...],"idempotent_keys":[...]}'
claude --model haiku -p "$PROMPT" > /tmp/install-probe-haiku.json
```

**Gate 2 — Agent subagent (fresh context, `general-purpose`)**:
```
Agent(subagent_type: "general-purpose", prompt: "Read packages/mcp-server/src/cli/install.ts and output the same JSON shape: {flags, files_written, idempotent_keys}. JSON only, no prose.")
```

**Gate 3 — Real run**:
```bash
# fresh dir
cd $(mktemp -d) && git clone D:/lll/cairn .
cd packages/mcp-server && npm install && npm run build
node dist/cli/install.js --help > /tmp/install-real.txt
# canonicalize the real --help output into the same JSON shape
node -e '
  const help = require("fs").readFileSync(process.argv[1], "utf8");
  const flags = [...help.matchAll(/--[\w-]+/g)].map(m => m[0]);
  console.log(JSON.stringify({ flags, files_written: [], idempotent_keys: [] }, null, 2));
' /tmp/install-real.txt > /tmp/install-real.json
```

Compare all three. If they agree, the install CLI's behavior is what the docs claim.

---

## When To Skip Validation

- Trivial doc-only changes (a single typo fix, < 5 lines)
- Pure formatting / lint auto-fix
- Reverts (the prior state was already validated)

Everything else: validate.

---

## Gate Failure Recovery

When Gate 1 ≠ Gate 2:
1. Read both outputs side-by-side
2. Identify which is correct (or both are wrong)
3. Fix the artifact OR rephrase the prompt — pick whichever maps to reality
4. Re-run all three gates

When Gate 1+2 agree but Gate 3 disagrees:
1. The AI engines are jointly wrong — common cause: stale cache, missing dep, env mismatch
2. Trust Gate 3 (reality). Fix the artifact until Gate 3 produces what Gate 1+2 predicted
3. OR fix the prompts until Gate 1+2 produce what Gate 3 actually shows

Never resolve by "the test was flaky, try again." Resolve by reading the diff.
