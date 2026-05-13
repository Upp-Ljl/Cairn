# GRILL — Force Clarity Before Execution

> Claude does not execute until grilling is complete.

## Rule

"Complete" means Claude can restate without ambiguity:
1. **What the output looks like** — file paths, schema, observable behavior
2. **Who uses it and how** — runner, environment, invocation
3. **What "done" means** — verifiable command + expected output (per `FEATURE-VALIDATION.md`)
4. **What is explicitly out of scope** — prevents mid-execution drift

If any of these four is unclear, keep asking.

---

## Question Format

- Maximum 3 questions per round
- Each question offers concrete options (A/B/C) — not open-ended unless necessary
- After ≤ 3 rounds, Claude either has clarity OR states exactly what is still unknown and why it blocks execution

---

## When To Stop Grilling

Stop when Claude can write a DUCKPLAN (per `HOWTO-PLAN-PR.md`) without guessing in any of the four sections.

Good signal: Claude can describe the verify command and expected output before writing any code.

---

## What Grilling Prevents

Before this protocol, Claude would:
- Interpret an ambiguous instruction
- Execute
- Deliver the wrong thing
- Cost: a full implementation that has to be redone

Grilling is cheaper than redoing. Always grill before non-trivial implementation.

---

## What Grilling Does NOT Replace

It does NOT replace:
- `HOWTO-PLAN-PR.md` — the structured plan after grilling
- `FEATURE-VALIDATION.md` — the verification gates
- `POSTPR.md` — the reviewer loop after push

Grilling is the front door; the rest of the workflow happens after the door is open.

---

## Anti-Grilling Patterns

Avoid asking:
- "Do you want me to proceed?" — if the user already said yes, don't re-ask (`SELF-REPORT-STOP.md` field 2: `permission_seeking`)
- "Should I do A or B?" when A and B have the same outcome — pick one, mention it in the final report
- "Is my plan correct?" — Plan is a document; ask the user to look at it, don't summarize it back
- **Surfacing a subagent's grilling memo (§5 of a grill draft) verbatim to the user.** When a subagent returns "questions worth grilling before code," that section is a TODO for **you**, not for the user. Resolve every reversible / local / implementation-detail item yourself (litmus per CLAUDE.md "Decision Rules": reversible → you decide, irreversible → user). Only items that hit hard lines — git history / external systems / product positioning / safety / license / release / push — go up to the user, and only after you've given your recommendation. **Asking the user to pick between "implementation path a vs b", "naming option X vs Y", or "which existing primitive to compose" is a permission-seeking failure mode** even when phrased as "I recommend X, OK?" — if you recommend it, just do it. The autonomy scope from `[[autonomous-ship-authorization]]` covers design-side decisions, not just push authorization.
- **Mid-run "progress update" / "status table" / "what's done so far" messages.** When the user has authorized a multi-step run (e.g. "开干", "干完一气推", "autoship", a named Phase to complete), surfacing a CEO-styled status summary mid-run is the same failure mode as asking permission — it pulls the user back into the loop on a moment they didn't choose. See `SELF-REPORT-STOP.md` field 13 `mid_work_status_report` for the canonical examples and the only three valid stop conditions: (a) every deliverable on `origin/main`, (b) hard block that can't be self-resolved, (c) user typed something. "Finished task N of N+M" is not a valid stop. Tool-result narration is fine (the user sees those happen anyway); the failure mode is the user-facing summary message that requires no response.
