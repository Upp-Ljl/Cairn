# Architecture B Phase 1 — `writeNextTurn` turn_index bump

> Closes the JSDoc TODO at `claude-stream-launcher.cjs:683`.
> Scope: ONLY the turn-index bumping inside `writeNextTurn`. Full
> Pool/Module 8 wiring (per-plan long-running CC) is a separate plan.

## 1. Plan

`claude-stream-launcher.cjs::writeNextTurn(prompt)` currently writes a
follow-up user NDJSON envelope to the running CC stdin without touching
`_hookState`. Result: after the first turn, every subsequent Stop hook
event is suppressed by the dedupe gate as `fired_for_turn === turn_index`
(both still 0), so callers like Mode A's `onTurnDone` callback never
re-fire for turns ≥ 1.

This blocks Architecture B's whole reason for existing: dispatching plan
steps as new turns into a long-running CC and getting one Stop signal
per step. Today the launcher CAN host multi-turn (the budget controller
already calls `writeNextTurn`), but its `onTurnDone` is essentially
single-shot.

Fix: bump `_hookState.turn_index` and reset
`_hookState.fired_for_turn = _hookState.turn_index - 1` inside
`writeNextTurn` BEFORE writing the envelope, so the Stop hook+result
dedupe gate fires exactly once per new turn.

Out of scope (separate plans):
- Pool registry (`mode-a-spawner` reuses a long-running child by plan_id)
- Mode A loop integration (decideNextDispatch consulting the pool)
- Crash recovery / fallback to fresh spawn when a pooled CC dies
- `mode-a-spawner.onEvent`'s result-event session_id capture for
  subsequent turns (Phase 2 already persists per-spawn; per-turn does
  not change session_id, so no change needed)

## 2. Expected Outputs

- `packages/desktop-shell/claude-stream-launcher.cjs::writeNextTurn`
  bumps `_hookState.turn_index` and resets `fired_for_turn` to
  `turn_index - 1` before writing. JSDoc TODO removed (replaced with a
  short explanatory comment). The function still returns boolean.
- `packages/desktop-shell/scripts/smoke-hooks-turn-protocol.mjs` gains
  a new scenario (Section F or named after `multi_turn`) that:
  - Spawns the launcher against a fake `claude` shim
  - Captures `onTurnDone` fires
  - Calls `writeNextTurn(...)` between turns
  - Asserts: `onTurnDone` fires once per turn, with `turn_index` going
    0 → 1 → 2 → ...
  - Asserts: each turn's Stop hook event is NOT suppressed by the
    dedupe gate
- Smoke total assertion count goes up by ~8.
- Branch `feat/arch-b-write-next-turn` with one commit (or two: fix +
  smoke). PR to `main`.

## 3. How To Verify

```bash
# Smoke (covers the multi-turn scenario):
cd D:/lll/cairn/.cairn-worktrees/arch-b-write-next-turn
node packages/desktop-shell/scripts/smoke-hooks-turn-protocol.mjs
# expect: all assertions pass, including the new multi_turn section

# Regression: existing single-turn flow still works
node packages/desktop-shell/scripts/smoke-stream-launcher.mjs
# expect: 62/62 pass

# Existing settings-config smoke (we don't touch it but verify)
node packages/desktop-shell/scripts/smoke-claude-settings-config.mjs
# expect: 16/16 pass

# Existing mode-a-loop smoke (we don't touch the loop but verify)
node packages/desktop-shell/scripts/smoke-mode-a-loop.mjs
# expect: 64/64 pass
```

## 4. Probes

Probe 1 — Claude haiku reads the patched function and emits canonical JSON
describing the dedupe-state mutations:

```bash
PROMPT='Read packages/desktop-shell/claude-stream-launcher.cjs writeNextTurn function. Output JSON only: {"bumps_turn_index": <bool>, "resets_fired_for_turn": <bool>, "writes_envelope": <bool>}. JSON only, no prose.'
claude --model haiku -p "$PROMPT" > /tmp/probe-haiku.json
jq -S . /tmp/probe-haiku.json > /tmp/probe-haiku.canonical.json
```

Probe 2 — General-purpose Agent in fresh context, same prompt shape,
expected hard-match:

```
Agent(subagent_type: "general-purpose", prompt: "...same prompt...")
```

Hard-match expectation:
```json
{"bumps_turn_index": true, "resets_fired_for_turn": true, "writes_envelope": true}
```

Real-run (Gate 3): the new smoke scenario IS the real run. Its output
shows `onTurnDone` firing per turn with increasing `turn_index`.
