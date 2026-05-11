# SELF-REPORT-STOP — 12-Field Self-Check At End Of Each Turn

> Adapted from TeamBrain's Self-Report Stop hook.
> Original: a hook fired after every assistant message; blocked message
> delivery if any of 12 fields was true, returned a correction template.
> This machine has no such hook configured. Pending hook setup, this
> document is the **manual** equivalent — the assistant self-checks
> before sending the message.

## When To Self-Check

Before ending a turn that includes any of:
- Code edits / writes
- Commits / pushes
- Test runs claimed to pass
- Acceptance checklist items marked done
- "I've completed X" statements

Skip for purely conversational turns (answering a question, planning discussion).

---

## The 12 Fields

For each field, the assistant asks: "Was this true of my last turn?" If yes, the turn is not complete; correct before sending.

| # | Field | True means |
|---|---|---|
| 1 | `premature_stopping` | Claimed done but acceptance checklist has unverified items |
| 2 | `permission_seeking` | Asked the user a question that was already pre-authorized (e.g., "Should I push?" after user said autoship is enabled) |
| 3 | `silent_fallback` | Caught an error and swallowed it without surfacing (e.g., try/catch returning a default) |
| 4 | `unverified_claim` | Said "X passes" / "X works" without running the verify command in this turn |
| 5 | `paraphrased_output` | Quoted tool output via paraphrase instead of verbatim — disallows the user from spotting a divergence |
| 6 | `scope_creep` | Made changes beyond what the plan authorized |
| 7 | `destructive_shortcut` | Used `git reset --hard`, `--no-verify`, `--force`, `.skip`, `@ts-ignore`, or similar to make a check pass |
| 8 | `followup_punt` | Said "I'll open an issue for this" for a P1 or P2 finding (must be fixed in same PR) |
| 9 | `mock_in_integration` | Mocked something that the test was meant to integrate with (mocking the DB in an integration test, etc.) |
| 10 | `single_engine_attest` | Validated only with one AI engine when `FEATURE-VALIDATION.md` requires cross-validation |
| 11 | `untracked_state_change` | Modified files outside what was reported (`git status` shows changes the message didn't acknowledge) |
| 12 | `tool_use_without_intent_statement` | Called multiple tools without first stating what / why in user-visible text |

---

## Correction Template

When a field is true, the assistant rewrites the turn:

```
Self-check before reply (one or more fields true):
- field_<n>: <evidence of why it's true>

Action taken before sending:
- <what was fixed; e.g., "ran the verify command", "removed --no-verify flag", "amended the wording to verbatim output"

Now the turn is complete.
```

The user does not need to see the self-check on every turn. It is internal. But the corrections must be applied before sending.

---

## What Self-Report-Stop Does NOT Replace

It does NOT replace:
- `FEATURE-VALIDATION.md` cross-engine validation
- `POSTPR.md` reviewer Agent
- The user's own review

Self-Report-Stop catches the assistant's individual lapses BEFORE they propagate. The other gates catch what self-check misses.

---

## How To Integrate As An Actual Hook (Future Work)

Per CLAUDE.md, hook configuration goes in `settings.json`. A Stop hook can be added to fire a script that scans the last assistant message for the 12 fields and returns a structured block to the assistant. This is **Later-scope** (not time-bound) per PRODUCT.md v3 §12 D10 — a polish item, not blocking MVP.
