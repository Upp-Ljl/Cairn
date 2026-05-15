# 2026-05-15 — Hooks-Based Turn-Completion Protocol for Mode A

> DUCKPLAN, four sections (Plan / Expected Outputs / How To Verify / Probes)
> + Open Questions + Risk Register + Effort estimate.
> Spike `D:\lll\cairn\scripts\spike-claude-hooks.mjs` already passed on
> Windows 11 (9.9s, both `SessionStart` + `Stop` hooks fired, NDJSON
> `hook_response` events emitted, `transcript_path` payload captured).
> This plan operationalises that result.

---

## 0. Context (one paragraph, then stop)

Mode A's stream launcher today decides "turn done" by listening for an NDJSON
`result` event (Phase 1) and extracting `session_id` from it (Phase 2). It
works, but it has two real weaknesses: (a) `result` is the **last** thing CC
emits before exit — we can't distinguish "still streaming the final
assistant chunk" from "actually done" until the process is already on its
way down; (b) we have no clean signal for **multi-stop** (CC's
`stop_hook_active=true` reentry) or for cases where CC dies unexpectedly
mid-turn without writing `result`. Migrating to `--settings <hooks.json> +
--include-hook-events` (the smithersai/claude-p technique) gives us a first-class
turn-completion signal with a richer payload (`transcript_path`,
`last_assistant_message`, `session_id`, `cwd`, `permission_mode`, `effort`,
`stop_hook_active`) and naturally extends to Architecture B (long-running
CC, many stdin turns). Spike is green; this is now an integration plan, not
a research plan.

---

## 1. Plan (= what the code change IS)

### 1.1 Goal (3-5 bullets)

- Replace `result`-event polling as the **primary** "turn done" signal in
  `claude-stream-launcher.cjs` with a **`Stop` hook payload** delivered via
  `--include-hook-events` NDJSON.
- Surface that payload as a single `onTurnDone({ session_id,
  last_assistant_text, transcript_path, stop_hook_active, raw })` callback
  fired from the launcher — same shape Mode A spawner can subscribe to,
  same shape future Architecture B (long-running CC, multi-turn) can reuse
  without refactor.
- Ship a new `claude-settings-config.cjs` (parallels `claude-mcp-config.cjs`)
  that writes a per-spawn temp `settings.json` containing the `Stop` +
  `SessionStart` hook commands, and threads `--settings <tempPath>` into the
  spawn argv. Cleanup on child exit, mirroring the MCP temp file lifecycle.
- Keep the existing `result`-event capture as a **fallback** so the launcher
  still works if `--include-hook-events` is missing/broken on a given CC
  version (defence-in-depth, ~10 lines).
- All existing smokes (62 + 28) keep passing; one new smoke
  (`smoke-hooks-turn-protocol.mjs`, ~35 assertions) asserts the new
  callback semantics with a fake claude binary that emits hook NDJSON
  events.

### 1.2 Non-goals (explicit defers)

- **Transcript-jsonl parsing** for richer agent-thought observability
  (`transcript_path` is captured; reading the file is a follow-up). Cairn
  panel does not need transcript content today — `tail.log` already
  delivers what we render.
- **Architecture B end-to-end** (long-running CC, many turns per spawn).
  This plan only delivers the *protocol surface* (`onTurnDone`) Architecture
  B will consume. Wiring the Agent Pool to send `writeNextTurn` after every
  `onTurnDone` is a separate plan.
- **PreToolUse / PostToolUse hooks** for tool-call observability — out of
  scope. Stop is enough for "turn done".
- **Merging with the user's global `~/.claude/settings.json`** — out of
  scope (CC merges settings itself when both global + `--settings` are
  present; we don't need to read theirs). See Risk R3.
- **Mode B / `worker-launcher.cjs --print` migration**. Mode B is one-shot;
  the exit code already tells us "done". No hook benefit, no change.

---

## 2. Architecture (file-by-file)

### 2.1 New file: `packages/desktop-shell/claude-settings-config.cjs`

**Currently**: does not exist.

**What it does**:
- `buildSettingsConfigFile({ runId, home, tmpDir? })` →
  `{ ok, tempPath, cleanup, hookPayloadDir }`
- Writes a settings.json with `hooks.Stop` + `hooks.SessionStart` entries.
  Each hook's `command` is a `node -e "<inline>"` invocation (Windows-safe,
  no bash) that reads the JSON payload from stdin and **appends** one
  NDJSON line to a per-run file `~/.cairn/worker-runs/<runId>/hook-events.jsonl`.
- Returns `hookPayloadDir` so the launcher knows where the disk-side audit
  trail lives.

**Rationale (constraint 4, strategy choice)**: we adopt **strategy (c) —
both**. Primary signal = NDJSON `hook_response` event in stdout (zero-disk,
realtime); durable audit trail = `hook-events.jsonl` written by the hook
itself (survives process crash, lets panel re-render history). NDJSON is
the trigger; disk is the receipt. Strategy (a) alone loses realtime;
strategy (b) alone loses durability if CC crashes before flushing stdout.
Cost of doing both: ~6 lines extra in the hook command.

**Function signatures**:
```js
// claude-settings-config.cjs
function buildSettingsConfigFile({ runId, home, tmpDir }) {
  // → { ok: true, tempPath, cleanup, hookPayloadFile }
  //   | { ok: false, error: 'runId_required' | 'write_failed' }
}
function _hookCommand(hookPayloadFile) {
  // returns the cross-platform `node -e "..."` string the hook will exec.
  // Uses JSON.stringify(hookPayloadFile) for path escaping.
}
// Exposed for tests: _hookCommand, _buildSettingsObject
```

The `_hookCommand` body (escape-safe, Windows-portable):
```js
node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{require('fs').appendFileSync(${JSON.stringify(hookPayloadFile)},s+'\n')}catch(_e){}})"
```
Single line, single quote pair for `-e`, all interior strings single-quoted.
Spike-verified on Windows.

### 2.2 `packages/desktop-shell/claude-stream-launcher.cjs`

**Currently**: spawns CC with `--output-format stream-json --input-format
stream-json --verbose --permission-mode bypassPermissions --mcp-config
<tmp> --strict-mcp-config [--resume <id>]`. Watches NDJSON. On `type:'result'`
captures `session_id` and continues until child exit.

**Changes**:

1. **Spawn argv** — append `--include-hook-events` and `--settings <tempPath>`
   after `--strict-mcp-config`. Build the settings file via
   `claude-settings-config.buildSettingsConfigFile`. Failure to build is
   fatal (mirrors mcp-config failure handling).

2. **New event tap inside `parser.on('event', ev => …)`** — match
   `ev.type === 'hook_response'` (or whatever the spike-confirmed
   shape is; see §6 Q1) and:
   - Extract `payload.hook_name` (or `payload.hook_event_name`,
     field-defensive — see Risk R5).
   - If `hook_name === 'Stop'`:
     - Read `payload.session_id`, `payload.last_assistant_message`,
       `payload.transcript_path`, `payload.stop_hook_active`.
     - **Dedupe**: if `stop_hook_active === true`, log + skip (CC will Stop
       again). Only the FIRST `Stop` with `stop_hook_active === false`
       fires the public callback. We track this in a `_turnDoneFiredOnce`
       flag scoped to the run.
     - Update `meta.session_id` (prefer hook over result-event).
     - Append the payload to in-memory `meta.last_turn_payload` for
       observability.
     - Invoke `opts.onTurnDone({ session_id, last_assistant_text,
       transcript_path, stop_hook_active: false, raw: payload })`.
   - If `hook_name === 'SessionStart'`: log + persist
     `meta.session_started_at = Date.now()`. No callback (not turn-done).
   - Unknown hook name → log at info-level + continue. **Field-defensive**:
     never destructure non-existing keys; treat the payload as opaque
     except for explicit known fields.

3. **Fallback retention**: keep the existing `if (ev.type === 'result')`
   block but make it a **fallback only** — fire `onTurnDone` from there
   ONLY IF `_turnDoneFiredOnce === false` (hook never came through).
   Log at warn-level when the fallback fires so we notice CC versions
   that don't emit hook_response events.

4. **Watchdog**: no change — `bumpWatchdog()` still keys off any NDJSON
   event, including `hook_started` / `hook_response`. Existing 10-min
   idle timeout still applies.

5. **Cleanup**: on child exit, call `settingsRes.cleanup()` alongside
   `mcpRes.cleanup()`. Same `try/catch` envelope.

**New public API surface**: `opts.onTurnDone(payload)` — the primary
contract for the rest of the codebase. `opts.onEvent` stays (other
callers still want raw NDJSON).

**Removed**: nothing. Both `onEvent` and the `result`-event capture
remain, the latter demoted to fallback.

**Contract change**: `meta.session_id` may now come from the Stop hook
*before* the result event arrives. Callers that read `meta.session_id`
during a run will see it populated ~one event earlier. Side-effect-free
for current callers (they read on done, not during).

### 2.3 `packages/desktop-shell/mode-a-spawner.cjs`

**Currently**: subscribes to `onEvent`, scans for `ev.type === 'result'`,
extracts `ev.session_id`, persists via `sessionStore.setSessionId`.

**Changes**:

1. **Switch to `onTurnDone`** as the primary path for session_id
   persistence and "step done" detection. The current `onEvent` filter
   for `result` events stays as a defence-in-depth fallback (mirrors
   launcher pattern).

2. **No new bookkeeping** — `dispatch_requests`, `tasks`, plan-step
   advancement all already happen elsewhere (advanceOnComplete in
   mode-a-loop). This commit only moves the turn-done signal source.

3. **Pass `transcript_path` to logger** for diagnostics:
   `cairnLog.info('mode-a-spawner', 'turn_done', { transcript_path,
   session_id, … })`. We don't read the file; we just record where it is
   for later investigation.

**Rationale**: the public surface of `mode-a-spawner` does not change.
Internally, the signal is more reliable + arrives slightly earlier.

### 2.4 `packages/desktop-shell/claude-mcp-config.cjs`

**No changes**. Listed only to make explicit: the new settings file lives
in a sibling module, not bolted onto MCP config. They have different
lifecycles conceptually (MCP = which servers to attach; hooks = lifecycle
notifications) and bundling them would couple unrelated change vectors.

### 2.5 `packages/desktop-shell/mode-a-session-store.cjs`

**No changes**. The session_id it persists is identical whether captured
from `result` or `Stop hook` — both come from CC's session machinery.

### 2.6 Test helpers / smoke harness

Existing `fake-claude.js` smoke fixtures emit a fixed NDJSON sequence.
The new smoke needs a fake that **also emits** hook_started + hook_response
events. We add a third fake harness (does NOT modify the existing two):
`packages/desktop-shell/scripts/smoke-hooks-turn-protocol.mjs` writes its
own `fake-claude.js` with the extended sequence.

---

## 3. Migration / Sequencing (commits, small + revertable)

| # | Commit title (conventional) | Files | Risk if reverted |
|---|---|---|---|
| 1 | `feat(desktop-shell): add claude-settings-config builder` | new `claude-settings-config.cjs` + 12-assertion unit smoke `scripts/smoke-claude-settings-config.mjs` | none — module unused yet |
| 2 | `feat(desktop-shell): thread --settings + --include-hook-events into stream launcher argv` | `claude-stream-launcher.cjs` argv only, no callback wiring | CC sees hooks but launcher ignores hook_response — harmless |
| 3 | `feat(desktop-shell): emit onTurnDone callback from Stop hook payload` | `claude-stream-launcher.cjs` event tap + dedupe + fallback | callers without onTurnDone unaffected (callback is optional) |
| 4 | `feat(desktop-shell): mode-a-spawner consumes onTurnDone` | `mode-a-spawner.cjs` | revert leaves Mode A still working via `result`-event fallback |
| 5 | `test(desktop-shell): smoke-hooks-turn-protocol E2E with fake claude` | new smoke + tweaks to assertion counts in existing smokes (if any drift) | none |
| 6 | `docs(claude-md): hooks turn protocol + smoke command` | `CLAUDE.md`, `docs/cairn-subagent-protocol.md` if relevant | none |

Reversibility: each commit on its own line. If commit 3 breaks production,
revert 3 → launcher still passes `--settings` + `--include-hook-events`
(harmless) and falls back to `result`-event capture (today's behaviour).

---

## 4. Validation matrix

### 4.1 Existing smokes — must keep passing unchanged

| Smoke | Current asserts | Change needed |
|---|---|---|
| `smoke-stream-launcher.mjs` | 62 | None to pass count. Internally: fake-claude.js emits 5 events without hooks → launcher's fallback path fires → `meta.session_id` still captured via `result` event. Verify by adding ONE new assertion: "fallback path fires onTurnDone via result event when no hook_response present" (→ **63 assertions**). |
| `smoke-mode-a-spawn-resume.mjs` | 28 | None. Resume flow is identical — only the signal source changed. (→ stays at **28**.) |
| `smoke-mode-a-session-store.mjs` | 39 | None. Pure storage module, untouched. (→ **39**.) |
| `tests/storage/*.test.ts` (daemon) | 439 | None. No schema change. |
| `tests/*` (mcp-server) | 424 | None. No tool added. |

### 4.2 New smokes

| File | Approximate assertions | What it asserts |
|---|---|---|
| `scripts/smoke-claude-settings-config.mjs` | 12 | (a) returns tempPath, (b) cleanup is a function, (c) settings.json parses, (d) has `hooks.Stop`, (e) has `hooks.SessionStart`, (f) Stop hook command is a non-empty string, (g) command embeds the hookPayloadFile path quote-safe, (h) cleanup removes file, (i) cleanup is idempotent, (j) missing runId → error, (k) write failure → ok:false, (l) hookPayloadFile is under run-dir |
| `scripts/smoke-hooks-turn-protocol.mjs` | 35 | (1-5) fake claude emits hook_started+hook_response+result; launcher captures all (2) onTurnDone fires exactly once when stop_hook_active=false (3) onTurnDone NOT fired when stop_hook_active=true on a Stop event (4) onTurnDone fires from `result`-event fallback when fake emits NO hook_response (5) payload contains session_id, transcript_path, last_assistant_text (6) hook-events.jsonl on disk has one line per hook fired (7) settings.json temp file exists during spawn and is removed after exit (8) argv contains `--include-hook-events` and `--settings <path>` (9) cleanup runs on spawn error path (10) field-defensive: payload missing transcript_path still fires onTurnDone with undefined |

### 4.3 End-to-end live verification (no fake)

```bash
# Hooks-real test: run the actual Mode A loop against a real `claude` binary
# in a sandboxed HOME, dispatch ONE step, watch for onTurnDone log line.
cd D:/lll/cairn/packages/desktop-shell
HOME=$(mktemp -d) USERPROFILE="$HOME" \
  node scripts/dogfood-hooks-live.mjs   # NEW — 1-spawn end-to-end, ~20s
# Expect: stdout contains 'turn_done' cairn-log entry with non-null session_id
# AND  ~/.cairn/worker-runs/<runId>/hook-events.jsonl exists with ≥1 line
# AND  process exits 0.
```

If `dogfood-hooks-live.mjs` is too much extra work for this PR, fall back to:
manually run `node packages/desktop-shell/main.cjs` with one project in Mode A,
take one tick, grep `~/.cairn/logs/cairn-<date>.jsonl` for `"turn_done"`.

### 4.4 Regression checks (the "did I break anything" matrix)

```bash
cd D:/lll/cairn/packages/daemon       && npm test     # expect: 439 pass
cd D:/lll/cairn/packages/mcp-server   && npm test     # expect: 424 pass + 1 skip
cd D:/lll/cairn/packages/desktop-shell
node scripts/smoke-stream-launcher.mjs                # expect: 63/63 (was 62, +1)
node scripts/smoke-mode-a-spawn-resume.mjs            # expect: 28/28
node scripts/smoke-mode-a-session-store.mjs           # expect: 39/39
node scripts/smoke-claude-settings-config.mjs         # expect: 12/12 (new)
node scripts/smoke-hooks-turn-protocol.mjs            # expect: 35/35 (new)
npx tsc --noEmit  # (in daemon + mcp-server, separately)
```

Grand total: **439 + 424 + 63 + 28 + 39 + 12 + 35 = 1040 assertions/tests**.

---

## 5. Probes (cross-validation for FEATURE-VALIDATION)

Two probes, hard-matched JSON output. Both ask the same question of two
independent engines: "given this settings.json hook config, what fields
will the Stop hook receive?". Hard-match validates our schema assumption.

```bash
# Probe 1 — haiku
claude --model haiku -p \
  "Given this Claude Code settings JSON: $(node -e 'const c=require(\"./packages/desktop-shell/claude-settings-config.cjs\"); const r=c.buildSettingsConfigFile({runId:\"probe\",tmpDir:require(\"os\").tmpdir()}); console.log(require(\"fs\").readFileSync(r.tempPath,\"utf8\")); r.cleanup();') 
   list (as JSON only, no prose) the fields the Stop hook command will
   receive on stdin. Use this exact format:
   {\"fields\": [\"field_name_1\", \"field_name_2\", ...]}" \
  > /tmp/probe-haiku.json

# Probe 2 — sonnet, same prompt
claude --model sonnet -p "<same prompt>" > /tmp/probe-sonnet.json

# Hard-match
diff <(jq -S . /tmp/probe-haiku.json) <(jq -S . /tmp/probe-sonnet.json)
# expect: zero diff. Both models should list at least:
#   session_id, transcript_path, stop_hook_active, cwd
# (spike empirically captured these — see scripts/spike-claude-hooks.mjs)

# Probe 3 — sanity: actually exec the spike and confirm one more time
node scripts/spike-claude-hooks.mjs > /tmp/spike.txt
grep -c 'fired' /tmp/spike.txt  # expect: 2 (SessionStart + Stop)
grep -c 'transcript_path' /tmp/spike.txt  # expect: ≥ 1
```

---

## 6. Open Questions (lead, please answer before commit 3)

### Q1. Exact NDJSON event type emitted by `--include-hook-events`

The spike log uses regex `/hook/i` to find events but does not pin down
the exact `type` value. Options:
- **(a)** `type: 'hook_started'` / `type: 'hook_response'` (matches the
  smithersai/claude-p code reference);
- **(b)** `type: 'hook'` with `subtype: 'started' | 'response'`;
- **(c)** something else this CC version emits.

**Lean**: (a) — but I want to grep the spike's raw stdout, not its parsed
summary, to lock in the exact field. Easy 2-min check: re-run spike with
the `events` array dumped raw to a file.

### Q2. Strategy for hook payload propagation — confirm "(c) both"

Already chosen above. Lead: confirm or override to (b) only (NDJSON
event, no disk hop) for simpler code. My lean: keep (c) for audit
durability; cost is ~6 lines.

### Q3. Should `--settings` merge with user's global `~/.claude/settings.json`?

CC documents that `--settings <file>` adds to (does not replace) the
global settings file. If user has their own Stop hook in
`~/.claude/settings.json`, both will fire — including theirs.
Options:
- **(a)** Live with it — user's hook fires alongside ours. Most realistic.
- **(b)** Pass `--strict-settings` (if it exists) to replace.
- **(c)** Read their settings, merge into ours, write the union. Brittle.

**Lean**: (a). User's hook is their business; if it crashes, it crashes
under their name in their stdout, and our Stop event still fires
(hooks are independent). Lead: confirm.

### Q4. `--print` mode in Mode B — do we backport hooks?

Mode B (`worker-launcher.cjs`) uses `claude --print` one-shot. Exit code
already gives "done". Backporting hooks would only give us
`transcript_path` cheaply.

**Lean**: defer. Mode B works. Lead: confirm not in this PR.

### Q5. Long-running CC (Architecture B) — should `onTurnDone` callback
receive a *turn index* in addition to payload?

In Architecture B, one spawn handles N turns. Callers will want to know
"this was turn 3 of N". Options:
- **(a)** Add `turn_index` now (counter scoped to the run).
- **(b)** Defer to the Architecture B plan.

**Lean**: (a) — costs one integer field, future-proofs the contract,
zero cost to current callers (they ignore unknown fields). Lead: confirm.

---

## 7. Risk Register (5 items, blast radius + mitigation)

### R1. Hook command escaping breaks on Windows

**What**: `node -e "..."` with embedded JSON paths in `command` field of
`settings.json`. Path separators on Windows are `\`, which JSON.stringify
escapes to `\\`. If we naively use shell-style escaping instead of
`JSON.stringify(path)` we get either ENOENT or arbitrary parse errors.

**Blast radius**: Stop hook never fires → launcher falls back to
`result`-event capture (today's behaviour) → degraded but not broken.
We log a `warn` so we notice in panel "live run log".

**Mitigation**: `_hookCommand` uses `JSON.stringify(hookPayloadFile)`
verbatim. Spike already proved this works (line 38 of
`spike-claude-hooks.mjs`). Smoke `smoke-claude-settings-config.mjs`
asserts (g): "command embeds path quote-safe" by parsing the embedded
JSON literal back out and string-equaling.

### R2. Stop hook can fire MULTIPLE times (`stop_hook_active=true` reentry)

**What**: CC docs state: when an agent's Stop hook is invoked and the
agent continues thinking, Stop fires again — the second time with
`stop_hook_active=true`. If we fire `onTurnDone` on every Stop, downstream
mode-a-spawner persists session_id twice, mode-a-loop might think the
step is done when it isn't, advance pointer prematurely.

**Blast radius**: real — plan advances one step too far → user sees
"step 2 in flight" while CC is still working on step 1.

**Mitigation**: explicit dedupe in launcher: `_turnDoneFiredOnce` flag,
fire only on the FIRST `Stop` event whose `stop_hook_active === false`.
Smoke assertion (2) + (3) directly exercise this.

### R3. User has a global `~/.claude/settings.json` with their own Stop hook

**What**: Two Stop hooks fire. Theirs may crash, take long, or output
garbage to a file. Doesn't affect our NDJSON capture (CC emits
hook_response per-hook), but increases turn-done latency.

**Blast radius**: latency only. Functionally OK.

**Mitigation**: documented in §6 Q3 / non-goal §1.2. We do not read or
modify their settings. If lead chooses Q3(b), revisit; otherwise accept.

### R4. Hook command itself crashes mid-run (e.g. disk full, permission)

**What**: `appendFileSync` to `hook-events.jsonl` throws. Hook script
swallows in `catch(_e){}`. CC still reports `hook_response` over NDJSON
(it doesn't know our script failed silently). Launcher's NDJSON tap
still fires `onTurnDone`. Disk audit trail is incomplete.

**Blast radius**: audit trail loss on the failing run only. No
production breakage; subsequent runs unaffected. We log a `warn` via the
launcher's `cairn-log` (since we're processing the hook_response either
way).

**Mitigation**: hook script wraps in `try/catch` swallow. Launcher does
NOT depend on disk for correctness — disk is audit only (strategy c).
Smoke does not need to assert this path (it's a soft failure).

### R5. Future CC version adds/renames fields in hook payload

**What**: today's payload has `transcript_path`, `last_assistant_message`,
`session_id`, `cwd`, `permission_mode`, `effort`, `stop_hook_active`. A
future version could rename, add, or remove fields.

**Blast radius**: if we destructure required fields and they're missing,
`onTurnDone` callback could fire with `undefined` session_id → resume
breaks.

**Mitigation**: field-defensive parsing — for each field, check `typeof
payload[x] === 'string' && payload[x]` before use. Unknown fields ignored
(passed through in `raw`). `onTurnDone` payload typed with optional
fields. Smoke assertion (10) covers the "missing transcript_path" case.
If `session_id` is missing, log error and **fall through to `result`-event
fallback** rather than fire callback with garbage.

---

## 8. Expected Outputs (artefacts after PR ships)

- New file: `packages/desktop-shell/claude-settings-config.cjs` (~120 LOC)
- Modified: `packages/desktop-shell/claude-stream-launcher.cjs` (+~70 LOC,
  -0 LOC, fallback retained)
- Modified: `packages/desktop-shell/mode-a-spawner.cjs` (+~25 LOC, -0 LOC)
- New: `packages/desktop-shell/scripts/smoke-claude-settings-config.mjs` (12 asserts)
- New: `packages/desktop-shell/scripts/smoke-hooks-turn-protocol.mjs` (35 asserts)
- Modified: `packages/desktop-shell/scripts/smoke-stream-launcher.mjs`
  (+1 assert, 62 → 63 — fallback semantics)
- New: `packages/desktop-shell/scripts/dogfood-hooks-live.mjs` (optional —
  end-to-end live; if shipped, ~80 LOC; if not, defer to a follow-up)
- Modified: `CLAUDE.md` "已落地约定" — one bullet documenting the new
  signal path and `onTurnDone` API surface.
- 6 commits on branch `feat/hooks-turn-protocol` (or similar).
- All 1040 assertions/tests green.

---

## 9. How To Verify (reviewer checklist)

```bash
# 0. Fresh checkout of the branch
git fetch origin && git checkout feat/hooks-turn-protocol

# 1. Daemon + mcp-server regression
cd packages/daemon && npm test            # expect: 439 pass
cd ../mcp-server && npm test              # expect: 424 pass + 1 skip
cd ../daemon && npx tsc --noEmit && cd ../mcp-server && npx tsc --noEmit

# 2. New unit smoke
cd ../desktop-shell
node scripts/smoke-claude-settings-config.mjs   # expect: 12/12

# 3. New integration smoke (fake claude)
node scripts/smoke-hooks-turn-protocol.mjs       # expect: 35/35

# 4. Existing smokes still pass
node scripts/smoke-stream-launcher.mjs           # expect: 63/63
node scripts/smoke-mode-a-spawn-resume.mjs       # expect: 28/28
node scripts/smoke-mode-a-session-store.mjs      # expect: 39/39

# 5. Spike re-run (one-shot — burns ~5 tokens of Anthropic credit)
node scripts/spike-claude-hooks.mjs              # expect: both sentinels fire

# 6. (Optional, if shipped) end-to-end live
node scripts/dogfood-hooks-live.mjs              # expect: turn_done log line
```

**Decision gate**: all 6 sections green → ship. Any red → stop, fix, do not
land.

---

## 10. Estimated Effort

| Commit | Scope | Estimate (h) |
|---|---|---|
| 1. `claude-settings-config.cjs` + unit smoke | mechanical, spike-proven | 1.0 – 1.5 |
| 2. argv wiring | trivial | 0.25 – 0.5 |
| 3. `onTurnDone` callback + dedupe + fallback | most architectural | 2.0 – 3.0 |
| 4. `mode-a-spawner.cjs` switch to onTurnDone | small | 0.5 – 1.0 |
| 5. `smoke-hooks-turn-protocol.mjs` (35 asserts + fake claude variant) | careful | 2.0 – 3.0 |
| 6. Docs sync (CLAUDE.md) + dogfood-hooks-live.mjs (optional) | light | 0.5 – 1.0 |
| Buffer for Open Question resolutions (Q1, Q5) | unknown unknowns | 0.5 – 1.5 |
| **Total** | | **6.75 – 11.5 hours** |

Single-session feasible if Open Questions resolve fast; otherwise two
sessions across one day.

---

## 11. Plan-mode Self-check (per CLAUDE.md Gates)

- ✅ ≤5-line acceptance checklist? Yes — see §9 "Decision gate".
- ✅ Tests-not-enough rule? Yes — live dogfood path in §4.3.
- ✅ No definition drift? Cairn = coordination kernel + side panel.
  Hooks are a CC-side mechanism the launcher consumes; doesn't change
  what Cairn IS.
- ✅ No new npm dep? Confirmed — uses only `node:fs`, `node:os`, `node:path`,
  `node:child_process`, `node:crypto`.
- ✅ Windows-friendly? Hook command is `node -e`, no bash. Spike-verified.
- ✅ Read-only constraint on desktop-shell preserved? Yes — settings.json
  temp file lives in `os.tmpdir()`, not Cairn home. The
  `hook-events.jsonl` audit file under `~/.cairn/worker-runs/<runId>/`
  is write-by-the-launcher (the same place tail.log + stream_events.jsonl
  already live), NOT by the panel UI — D9 read-only rule intact.
- ✅ Subagent verdicts needed? Probably — a sonnet review of commit 3
  before merge to catch dedupe-flag scoping bugs and field-defensive
  parsing gaps.
