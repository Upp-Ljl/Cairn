<!-- cairn-skill: mentor-recommendation v1 -->

# Mentor Recommendation — output shape for the single-turn advisor

This skill is loaded by Cairn Mentor
(`mentor-prompt.cjs::generateMentorPrompt`) and injected as the
output-format block of the Mentor LLM prompt. The 9 STRICT RULES that
sit above this block in the prompt are a **security boundary** and stay
in code (see `mentor-prompt.cjs::buildHardRules`) — they are NOT part of
this skill and MUST NOT be edited via this file.

Edit this file to tune the **output shape / schema invariants /
closed-set values** the advisor is asked to honour. Schema validation
still runs deterministically in code regardless of what this file says —
this file teaches the LLM the contract; the validator enforces it.

# OUTPUT FORMAT (MANDATORY)

Emit, as the LAST thing in your response, the header
`## Mentor Work Items` followed immediately by a fenced
JSON code block. Nothing must appear after the closing fence.

Maximum {{max_items}} work item(s).

## Mentor Work Items
```json
{
  "work_items": [
    {
      "id": "m_<12 lowercase hex>",
      "description": "<≤200 chars — MUST NOT repeat IDs already in evidence_refs>",
      "why": {
        "impact": "<≤100 chars — one sentence on value or cost-of-not-doing>",
        "cost": "L|M|H",
        "risk": "L|M|H",
        "urgency": "L|M|H"
      },
      "stakeholders": {
        "owner": "agent|human|either",
        "reviewer": "agent|human|either",
        "notify": ["<role/agent-kind ≤64 chars — NO real names>"]
      },
      "next_action": "<one of the 7 allowed values below>",
      "evidence_refs": [
        { "kind": "<task|candidate|blocker|outcome|iteration|commit|doc>", "ref": "<id or path>" }
      ],
      "confidence": 0.00
    }
  ]
}
```

Allowed next_action values (closed set — use verbatim):
  - "pick to start Continuous Iteration"
  - "propose candidate then pick"
  - "answer blocker question"
  - "manual run via <Codex CLI|Claude Code>"
  - "create checkpoint then investigate"
  - "defer / mark not-now"
  - "escalate to human review"

Allowed evidence_refs.kind values (closed set):
  "task", "candidate", "blocker", "outcome", "iteration", "commit", "doc"

SCHEMA INVARIANTS (spec §3.5) — enforce all five:

  #1  description MUST NOT repeat IDs already present in evidence_refs.
      IDs belong in refs; description is for prose.

  #2  stakeholders.notify[] MUST contain only agent role / kind strings
      (e.g. "worker", "reviewer", "codex-session-α"). Real human names
      or account handles are FORBIDDEN.

  #3  evidence_refs[].kind MUST be one of the closed set above.
      Do NOT invent new kind values.

  #4  Items with confidence < 0.5 MUST be placed at the TAIL of the
      work_items array, OR their next_action MUST be
      "escalate to human review". Never front-load low-confidence picks.

  #5  INVARIANT #5 ENFORCEMENT: if your intended next_action would
      semantically include merge / push / accept / reject / rollback,
      rewrite it as "escalate to human review". This is unconditional.

ORDER: output items ranked highest priority first. Low-confidence
(confidence < 0.5) items must appear LAST in the array (invariant #4).

NOTHING AFTER THE CLOSING FENCE. No commentary, no follow-up prose.
