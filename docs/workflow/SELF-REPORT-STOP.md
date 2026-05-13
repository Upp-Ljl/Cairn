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
| 2 | `permission_seeking` | Asked the user a question that was already pre-authorized. Includes: "Should I push?" after autoship granted; "Implementation path A or B?" when both are reversible (CLAUDE.md Decision Rules: reversible = your call); "Which name should I use?"; "Which existing primitive to compose?"; surfacing a subagent's `§5 grilling memo` verbatim instead of resolving it yourself first. If you've already given a recommendation, just execute it — asking-after-recommending is the same failure mode as asking cold. |
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
| 13 | `mid_work_status_report` | Surfaced a progress update / status table / "what's done so far" message in the middle of a multi-step run the user explicitly authorized to run to completion. Stopping after task N of N+M to say "now starting task N+1" is the same failure mode as asking permission, dressed as "just informing." Per `[[autonomous-ship-authorization]]` + `[[no-unsolicited-status-reports]]`, during an authorized run stop and surface only when: (a) every committed deliverable for the **authorized scope** is on `origin/main` (or the user-named endpoint — see scope-reading below); (b) a hard blocker prevents progress and cannot be self-resolved (see field 14 for what counts); (c) the user typed something. "Natural task boundary" / "good checkpoint moment" / "context-window hygiene" / "this phase just shipped, should I do the next?" are NOT stop conditions. Tool-result narration is fine — the failure mode is the user-facing summary message that requires nothing from the user. **Scope-reading**: when the user authorizes multi-phase work ("继续往后推进", "向最终目标进发", "ship through to <state>"), the authorized scope is the named END STATE, not each intermediate phase. A finished phase mid-multi-phase-scope = checkpoint inside the run, not a stop condition. Phase N+1 starts immediately without surfacing. |
| 14 | `push_block_misread_as_dev_block` | Treated `git push` failure (PAT scope / GCM auth / TLS handshake / network) as a stop condition for downstream dev work. **A push being rejected only means that commit hasn't reached `origin/main` yet — it does not mean the next phase can't start.** Local `main` and worktree branches keep accumulating, subagents keep launching, smokes keep running. Push retries when the user resolves the credential issue. **Stricter rule** (per CEO correction 2026-05-14 第八掌 "为什么又停了"): **"my last planned phase shipped + push is blocked" is NEVER a stop condition for a multi-phase authorized scope.** Authorized scope = the END STATE the user named (e.g. "完整掌控感产品 + 朋友能下载 + 自己用感知到提效"), NOT "the 17-constraint checklist I made." 17/17 ✅ ≠ scope done — there's always: real-agent dogfood of the new convention, packaging UX (onboarding wizard / first-launch), Mode B continuous iteration, refinement of just-shipped features, real-LLM tuning, etc. When push is one of many parallel deliverables AND there are unfinished feature/quality/UX items in the authorized scope, push-block → queue the push for retry, **pick the next biggest unblocked item and start it**. Do NOT surface "everything is done except push" — that statement is almost always false against the user's actual scope. Surfacing "PAT scope blocks me" mid-multi-phase-run is the same anti-pattern as field 13 — it dresses up "asking permission" as "informing about a blocker." Action when push fails: log the failure with the specific error, identify the next biggest item in the authorized scope (refinement / next feature / dogfood / packaging) and start it, retry the push automatically when the next commit lands OR when the user signals the credential is fixed. |

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
