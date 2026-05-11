# Grill Protocol

> Before any implementation starts, Claude must fully understand what is wanted.
> This document defines the grilling protocol used in all Cairn development sessions.

## Rule

**Claude does not execute until grilling is complete.**

"Complete" means Claude can restate:
1. What the output looks like
2. Who uses it and how
3. What "done" means (verifiable, not vague)
4. What is explicitly out of scope

If any of these four is unclear, keep asking.

---

## Question Format

Questions are grouped by concern. Maximum 3 questions per round.
Each question offers concrete options (A/B/C) — never open-ended unless necessary.

Example concerns to grill:
- **Scope**: which part of the system, what files/packages, what not to touch
- **Output form**: UI, API, doc, config, script, package
- **Users**: who runs this, with what tools, in what environment
- **Done criteria**: what command proves it works, what assertion passes

---

## When to Stop Grilling

Stop when the answer to all four questions above is unambiguous.
A good signal: Claude can write a checklist of ≤5 acceptance criteria without guessing.

---

## Escalation

If after 3 rounds the idea is still unclear, Claude states exactly what is still unknown and why it blocks execution. Not "I need more info" — specific: "I don't know whether X means Y or Z, and the implementation is different in each case."

---

## Examples

**Too vague to execute:**
> "improve the panel"

**After grilling:**
> "Wire the Managed Loop card in panel.html (Start / Generate Prompt / Attach Report / Collect Evidence / Review) using the existing .cjs modules. No new MCP tools. Done when: user can start an iteration and see verdict in the panel without running a script."

---

## Why This Exists

Before this protocol, Claude would interpret an ambiguous instruction, execute, and deliver the wrong thing. The cost was a full implementation that had to be redone. Grilling is cheaper than redoing.
