# Cairn Test Suite

> Version: v0.0.1 Preview  
> Date: 2026-04-22  
> Scope: Unit + Fault Injection tests for the five-piece Compensator Engine, Classifier, Approval Gate, and GitHub Adapter.  
> Runner: `bun test`  
> Test files live under `tests/unit/`, `tests/fault/`, `tests/e2e/`.

---

## Test Coverage Map

| Property / Mechanism | Test IDs |
|---|---|
| `transitionStep` — all (state, event) pairs | SM-001 – SM-014 |
| `transitionLane` — all (state, event) pairs | SM-015 – SM-027 |
| Terminal state reachability | SM-028 – SM-030 |
| Illegal / no-op transitions | SM-031 – SM-033 |
| GitHub manifest — 8 endpoint class assignment | CL-001 – CL-008 |
| `NOT_IN_MANIFEST` fallback | CL-009 |
| `strict` mode + class ④ → approval gate | CL-010 |
| `acceptIrreversible` mode + class ④ | CL-011 |
| `bypass` mode + class ④ | CL-012 |
| LaneResolver merge combinations | CL-013 – CL-018 |
| F-invariant: missing `covers` field | FI-001 |
| F-optlock: HTTP 412 during compensation | FI-002 |
| F-midstep: step 2 of 3 returns HTTP 500 | FI-003 |
| Receipt required fields (incl. denormalized agent context) | RS-001 |
| `exitCode` enum constraint; no string `status` field | RS-002 |
| `reverted[]` / `irreversibleSideEffects[]` disjointness | RS-003 |
| `exitCode 0` ↔ `failed.length === 0` | RS-004 |
| Halt location via `failed[0].stepIdx`; no `haltedAt` on Receipt | RS-005 |
| Property test: disjointness always holds | RS-006 |
| `buildReceipt()` denormalizes agent context from Lane | RS-007 |
| Exit code 0 (Tier 1: lane state `REVERTED`) | EC-001 |
| Exit code 2 (Tier 1: lane state `PARTIAL_REVERT`) | EC-002 |
| Exit code 3 (Tier 2 only: `failed[0].code ∈ {CONFLICT, INCOMPLETE_BEFORE_IMAGE}`) | EC-003 |
| Exit code 4 (Tier 1 or Tier 2: `FAILED_RETRYABLE` / `INFRA_ERR`) | EC-004 |
| Exit code 5 (Tier 1 or Tier 2: `HELD_FOR_HUMAN` / `MANUAL_GATE`) | EC-005 |
| `laneStateToExitCode` range is `{0,2,4,5}` — never 3 | EC-006 |
| Opt-lock `etag` variant | OL-001 – OL-003 |
| Opt-lock `version-check` variant | OL-004 – OL-005 |
| Opt-lock `field-match` sub-variants | OL-006 – OL-010 |
| Missing before-image (timeout) | OL-011 |
| Idempotent retry after CONFLICT | OL-012 |
| Idempotency key derivation — same inputs | IK-001 |
| Idempotency key derivation — different laneId | IK-002 |
| `wasAlreadySuccessful` skips step | IK-003 |
| Key format (32-char hex prefix of sha256) | IK-004 |
| Class ④ in strict mode → 202 + X-Cairn-Hold | AG-001 |
| `cairn approve` — release held call | AG-002 |
| `cairn deny` — agent receives 499 | AG-003 |
| Approval timeout → 503 Retry-After: 0 | AG-004 |
| `acceptIrreversible` mode — no hold | AG-005 |
| `bypass` mode — no hold, recorded | AG-006 |
| Two concurrent lanes — revert isolation | LI-001 |
| `tryAcquireLaneLock` CAS — second attempt LANE_BUSY | LI-002 |
| Reverting lane A freezes other lanes during compensation | LI-003 |
| Revert receipt for lane A contains no ops from lane B | LI-004 |
| GH: Create PR → close PR | GH-001 |
| GH: Create issue comment → delete comment | GH-002 |
| GH: Create branch → delete branch | GH-003 |
| GH: Add label → remove label | GH-004 |
| GH: Create issue → irreversibleSideEffects | GH-005 |
| GH: Merge PR → approval gate in strict mode | GH-006 |

---

## Group 1: State Machine (SM-*)

All tests are pure-function unit tests of `transitionStep` and `transitionLane` from `src/reverter/state-machine.ts`.

### SM-001: transitionStep — PENDING + START → RUNNING
**Property:** Step state machine — PENDING transitions  
**Precondition:** `state = 'PENDING'`  
**Input:** `event = { kind: 'START' }`  
**Expected:** returns `'RUNNING'`  
**Exit code:** n/a (pure function)  
**Notes:** (spec: L1431–L1435)

### SM-002: transitionStep — PENDING + any other event → PENDING (no-op)
**Property:** Step state machine — PENDING idempotency  
**Precondition:** `state = 'PENDING'`  
**Input:** `event = { kind: 'EXIT_0' }` (any non-START event)  
**Expected:** returns `'PENDING'` unchanged  
**Exit code:** n/a  
**Notes:** `default: return state` branch. (spec: L1434)

### SM-003: transitionStep — RUNNING + EXIT_0 → SUCCESS
**Property:** Step state machine — happy path  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'EXIT_0' }`  
**Expected:** returns `'SUCCESS'`  
**Exit code:** n/a  
**Notes:** (spec: L1438)

### SM-004: transitionStep — RUNNING + EXIT_2 → PARTIAL
**Property:** Step state machine — partial failure  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'EXIT_2' }`  
**Expected:** returns `'PARTIAL'`  
**Exit code:** n/a  
**Notes:** (spec: L1439)

### SM-005: transitionStep — RUNNING + EXIT_3 → VERIFY_MISMATCH
**Property:** Step state machine — optimistic lock conflict  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'EXIT_3' }`  
**Expected:** returns `'VERIFY_MISMATCH'`  
**Exit code:** n/a  
**Notes:** (spec: L1440)

### SM-006: transitionStep — RUNNING + EXIT_4 → INFRA_ERR
**Property:** Step state machine — infrastructure error  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'EXIT_4' }`  
**Expected:** returns `'INFRA_ERR'`  
**Exit code:** n/a  
**Notes:** (spec: L1441)

### SM-007: transitionStep — RUNNING + EXIT_5 → MANUAL_GATE
**Property:** Step state machine — manual gate  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'EXIT_5' }`  
**Expected:** returns `'MANUAL_GATE'`  
**Exit code:** n/a  
**Notes:** (spec: L1442)

### SM-008: transitionStep — RUNNING + unrecognized event → RUNNING (no-op)
**Property:** Step state machine — unknown event guard  
**Precondition:** `state = 'RUNNING'`  
**Input:** `event = { kind: 'START' }` (not a valid RUNNING event)  
**Expected:** returns `'RUNNING'` unchanged  
**Exit code:** n/a  
**Notes:** `default: return state` branch. (spec: L1443)

### SM-009: transitionStep — INFRA_ERR + RETRY → RUNNING
**Property:** Step state machine — retry loop  
**Precondition:** `state = 'INFRA_ERR'`  
**Input:** `event = { kind: 'RETRY' }`  
**Expected:** returns `'RUNNING'`  
**Exit code:** n/a  
**Notes:** (spec: L1446)

### SM-010: transitionStep — INFRA_ERR + ABANDON → PARTIAL
**Property:** Step state machine — abandon after exhausted retries  
**Precondition:** `state = 'INFRA_ERR'`  
**Input:** `event = { kind: 'ABANDON' }`  
**Expected:** returns `'PARTIAL'`  
**Exit code:** n/a  
**Notes:** (spec: L1447)

### SM-011: transitionStep — SUCCESS is terminal
**Property:** Step state machine — terminal state  
**Precondition:** `state = 'SUCCESS'`  
**Input:** `event = { kind: 'START' }` (any event)  
**Expected:** returns `'SUCCESS'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1451–L1455)

### SM-012: transitionStep — PARTIAL is terminal
**Property:** Step state machine — terminal state  
**Precondition:** `state = 'PARTIAL'`  
**Input:** `event = { kind: 'RETRY' }`  
**Expected:** returns `'PARTIAL'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1451–L1455)

### SM-013: transitionStep — VERIFY_MISMATCH is terminal
**Property:** Step state machine — terminal state  
**Precondition:** `state = 'VERIFY_MISMATCH'`  
**Input:** `event = { kind: 'RETRY' }`  
**Expected:** returns `'VERIFY_MISMATCH'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1451–L1455)

### SM-014: transitionStep — MANUAL_GATE is terminal
**Property:** Step state machine — terminal state  
**Precondition:** `state = 'MANUAL_GATE'`  
**Input:** `event = { kind: 'APPROVE' }`  
**Expected:** returns `'MANUAL_GATE'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1454)

### SM-015: transitionLane — RECORDED + REVERT_START → REVERTING
**Property:** Lane state machine — initiate revert  
**Precondition:** `state = 'RECORDED'`  
**Input:** `event = { kind: 'REVERT_START' }`  
**Expected:** returns `'REVERTING'`  
**Exit code:** n/a  
**Notes:** (spec: L1465–L1467)

### SM-016: transitionLane — RECORDED + other event → RECORDED (no-op)
**Property:** Lane state machine — no-op guard  
**Precondition:** `state = 'RECORDED'`  
**Input:** `event = { kind: 'ALL_SUCCESS' }`  
**Expected:** returns `'RECORDED'` unchanged  
**Exit code:** n/a  
**Notes:** `default: return state`. (spec: L1468)

### SM-017: transitionLane — REVERTING + ALL_SUCCESS → REVERTED
**Property:** Lane state machine — happy path terminal  
**Precondition:** `state = 'REVERTING'`  
**Input:** `event = { kind: 'ALL_SUCCESS' }`  
**Expected:** returns `'REVERTED'`  
**Exit code:** n/a  
**Notes:** (spec: L1471)

### SM-018: transitionLane — REVERTING + ANY_FAIL → PARTIAL_REVERT
**Property:** Lane state machine — partial failure terminal  
**Precondition:** `state = 'REVERTING'`  
**Input:** `event = { kind: 'ANY_FAIL' }`  
**Expected:** returns `'PARTIAL_REVERT'`  
**Exit code:** n/a  
**Notes:** (spec: L1472)

### SM-019: transitionLane — REVERTING + INFRA_EXHAUSTED → FAILED_RETRYABLE
**Property:** Lane state machine — retryable infrastructure failure  
**Precondition:** `state = 'REVERTING'`  
**Input:** `event = { kind: 'INFRA_EXHAUSTED' }`  
**Expected:** returns `'FAILED_RETRYABLE'`  
**Exit code:** n/a  
**Notes:** (spec: L1473)

### SM-020: transitionLane — REVERTING + MANUAL_GATE → HELD_FOR_HUMAN
**Property:** Lane state machine — manual gate required  
**Precondition:** `state = 'REVERTING'`  
**Input:** `event = { kind: 'MANUAL_GATE' }`  
**Expected:** returns `'HELD_FOR_HUMAN'`  
**Exit code:** n/a  
**Notes:** (spec: L1474)

### SM-021: transitionLane — REVERTING + unrecognized event → REVERTING (no-op)
**Property:** Lane state machine — unknown event guard  
**Precondition:** `state = 'REVERTING'`  
**Input:** `event = { kind: 'APPROVE' }`  
**Expected:** returns `'REVERTING'` unchanged  
**Exit code:** n/a  
**Notes:** `default: return state`. (spec: L1475)

### SM-022: transitionLane — FAILED_RETRYABLE + REVERT_START → REVERTING
**Property:** Lane state machine — re-entry from retryable state  
**Precondition:** `state = 'FAILED_RETRYABLE'`  
**Input:** `event = { kind: 'REVERT_START' }`  
**Expected:** returns `'REVERTING'`  
**Exit code:** n/a  
**Notes:** (spec: L1477–L1479)

### SM-023: transitionLane — FAILED_RETRYABLE + other event → FAILED_RETRYABLE (no-op)
**Property:** Lane state machine — retryable guard  
**Precondition:** `state = 'FAILED_RETRYABLE'`  
**Input:** `event = { kind: 'ALL_SUCCESS' }`  
**Expected:** returns `'FAILED_RETRYABLE'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1480)

### SM-024: transitionLane — HELD_FOR_HUMAN + APPROVE → REVERTING
**Property:** Lane state machine — approval releases hold  
**Precondition:** `state = 'HELD_FOR_HUMAN'`  
**Input:** `event = { kind: 'APPROVE' }`  
**Expected:** returns `'REVERTING'`  
**Exit code:** n/a  
**Notes:** (spec: L1483)

### SM-025: transitionLane — HELD_FOR_HUMAN + DENY → PARTIAL_REVERT
**Property:** Lane state machine — denial terminates  
**Precondition:** `state = 'HELD_FOR_HUMAN'`  
**Input:** `event = { kind: 'DENY' }`  
**Expected:** returns `'PARTIAL_REVERT'`  
**Exit code:** n/a  
**Notes:** (spec: L1484)

### SM-026: transitionLane — REVERTED is terminal
**Property:** Lane state machine — terminal state  
**Precondition:** `state = 'REVERTED'`  
**Input:** `event = { kind: 'REVERT_START' }` (any event)  
**Expected:** returns `'REVERTED'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1488–L1490)

### SM-027: transitionLane — PARTIAL_REVERT is terminal
**Property:** Lane state machine — terminal state  
**Precondition:** `state = 'PARTIAL_REVERT'`  
**Input:** `event = { kind: 'REVERT_START' }`  
**Expected:** returns `'PARTIAL_REVERT'` unchanged  
**Exit code:** n/a  
**Notes:** (spec: L1489–L1490)

### SM-028: Terminal state reachability — REVERTED
**Property:** State machine — terminal state reachability  
**Precondition:** `state = 'RECORDED'`  
**Input:** sequence `REVERT_START` → `ALL_SUCCESS`  
**Expected:** final state is `'REVERTED'`; `laneStateToExitCode('REVERTED', false) === 0`  
**Exit code:** 0  
**Notes:** Full path: RECORDED → REVERTING → REVERTED. (spec: L1502–L1504)

### SM-029: Terminal state reachability — PARTIAL_REVERT
**Property:** State machine — terminal state reachability  
**Precondition:** `state = 'RECORDED'`  
**Input:** sequence `REVERT_START` → `ANY_FAIL`  
**Expected:** final state is `'PARTIAL_REVERT'`; `laneStateToExitCode('PARTIAL_REVERT', false) === 2`  
**Exit code:** 2  
**Notes:** (spec: L1505)

### SM-030: Terminal state reachability — HELD_FOR_HUMAN
**Property:** State machine — terminal state reachability  
**Precondition:** `state = 'RECORDED'`  
**Input:** sequence `REVERT_START` → `MANUAL_GATE`  
**Expected:** final state is `'HELD_FOR_HUMAN'`; `laneStateToExitCode('HELD_FOR_HUMAN', false) === 5`  
**Exit code:** 5  
**Notes:** (spec: L1507)

### SM-031: Illegal step transition — PENDING + EXIT_0 returns PENDING (no-op, not an error throw)
**Property:** Step state machine — guard clause behavior  
**Precondition:** `state = 'PENDING'`  
**Input:** `event = { kind: 'EXIT_0' }`  
**Expected:** returns `'PENDING'` (no exception thrown); callers must not interpret this as success  
**Exit code:** n/a  
**Notes:** The spec uses `default: return state` rather than throwing. Any caller that attempts a non-START event on a PENDING step has a logic error; this test documents the defensive behavior. (spec: L1434)

### SM-032: Illegal lane transition — REVERTED ignores REVERT_START
**Property:** Lane state machine — already-terminal idempotency  
**Precondition:** `state = 'REVERTED'`  
**Input:** `event = { kind: 'REVERT_START' }`  
**Expected:** returns `'REVERTED'`; does not re-enter REVERTING  
**Exit code:** n/a  
**Notes:** (spec: L1488–L1490)

### SM-033: `laneStateToExitCode` — exhaustive mapping (return type `0|2|4|5` only)
**Property:** Exit code mapping — all lane terminal states  
**Precondition:** n/a  
**Input:** all six `LaneState` values  
**Expected:**  
- `REVERTED` → `0`  
- `PARTIAL_REVERT` → `2`  
- `FAILED_RETRYABLE` → `4`  
- `HELD_FOR_HUMAN` → `5`  
- `REVERTING` (non-terminal, default branch) → `2`  
- `RECORDED` (non-terminal, default branch) → `2`  
- The function NEVER returns `3` — exit code 3 is not reachable via lane state alone  
**Exit code:** n/a  
**Notes:** Return type is `0|2|4|5`. Exit code 3 is only produced by `deriveProcessExitCode()` when `receipt.failed[0].code ∈ {CONFLICT, INCOMPLETE_BEFORE_IMAGE}`. (spec: L1502–L1510, L1516–L1517)

---

## Group 2: Classifier (CL-*)

All tests use `Classifier` from `src/classifier/classify.ts` with `ManifestRegistry` loaded from `manifests/github.yaml`.

### CL-001: POST /repos/{o}/{r}/git/refs → class ③
**Property:** Classifier — GitHub manifest endpoint 1 (create branch)  
**Precondition:** `ManifestRegistry` loaded with `manifests/github.yaml`; `mode = 'strict'`  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/git/refs', body: { ref: 'refs/heads/demo', object: { sha: 'abc123' } } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`; `result.reason` matches `class_reason` from manifest  
**Exit code:** n/a  
**Notes:** Entry 1 in Appendix B. (spec: L3758–L3773)

### CL-002: POST /repos/{o}/{r}/pulls → class ③
**Property:** Classifier — GitHub manifest endpoint 2 (create PR)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/pulls', body: { title: 't', head: 'demo', base: 'main' } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`  
**Exit code:** n/a  
**Notes:** (spec: L3775–L3799)

### CL-003: PATCH /repos/{o}/{r}/pulls/{number} → class ③
**Property:** Classifier — GitHub manifest endpoint 3 (close/update PR)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'PATCH', urlPath: '/repos/x/y/pulls/42', body: { state: 'closed' } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`  
**Exit code:** n/a  
**Notes:** (spec: L3801–L3824)

### CL-004: POST /repos/{o}/{r}/issues → class ③
**Property:** Classifier — GitHub manifest endpoint 4 (create issue)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/issues', body: { title: 'bug' } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`  
**Exit code:** n/a  
**Notes:** Entry has `unreversible_tail`. (spec: L3826–L3844)

### CL-005: POST /repos/{o}/{r}/issues/{n}/comments → class ③
**Property:** Classifier — GitHub manifest endpoint 5 (create comment)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/issues/5/comments', body: { body: 'LGTM' } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`  
**Exit code:** n/a  
**Notes:** (spec: L3846–L3863)

### CL-006: POST /repos/{o}/{r}/issues/{n}/labels → class ③
**Property:** Classifier — GitHub manifest endpoint 6 (add label)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/issues/5/labels', body: { labels: ['bug'] } }`  
**Expected:** `result.class === '③'`; `result.approvalRequired === false`  
**Exit code:** n/a  
**Notes:** Uses `field-match` optimistic lock in compensator. (spec: L3865–L3886)

### CL-007: PUT /repos/{o}/{r}/pulls/{n}/merge → class ④
**Property:** Classifier — GitHub manifest endpoint 7 (merge PR)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'PUT', urlPath: '/repos/x/y/pulls/42/merge', body: {} }`  
**Expected:** `result.class === '④'`; `result.approvalRequired === true` (strict mode); `result.entry.requiresApprovalWhen[0].always === true`  
**Exit code:** n/a  
**Notes:** `requires_approval_when: [{ always: true }]`. (spec: L3888–L3904)

### CL-008: DELETE /repos/{o}/{r}/git/refs/heads/{branch} → class ④
**Property:** Classifier — GitHub manifest endpoint 8 (delete branch)  
**Precondition:** Same as CL-001  
**Input:** `{ method: 'DELETE', urlPath: '/repos/x/y/git/refs/heads/demo', body: {} }`  
**Expected:** `result.class === '④'`; `result.approvalRequired === true`; `result.entry.undoStrategy.unreversibleTail` is non-empty  
**Exit code:** n/a  
**Notes:** `requires_approval_when: [{ always: true }]`. (spec: L3906–L3929)

### CL-009: NOT_IN_MANIFEST fallback → class ④
**Property:** Classifier — conservative fallback  
**Precondition:** `mode = 'strict'`  
**Input:** `{ method: 'POST', urlPath: '/repos/x/y/weird/thing', body: {} }`  
**Expected:** `result.class === '④'`; `result.reason === 'NOT_IN_MANIFEST'`; `result.approvalRequired === true`  
**Exit code:** n/a  
**Notes:** Preview conservative strategy: any unmatched path is escalated to ④. (spec: L717–L724, L3284–L3288)

### CL-010: CAIRN_MODE=strict + class ④ → approval gate opens
**Property:** Classifier — strict mode gate  
**Precondition:** `mode = 'strict'`; endpoint is `PUT .../merge`  
**Input:** same as CL-007  
**Expected:** `result.approvalRequired === true`  
**Exit code:** n/a  
**Notes:** (spec: L698–L702)

### CL-011: CAIRN_MODE=acceptIrreversible + class ④ → logged as accepted-irreversible, call passes
**Property:** Classifier — acceptIrreversible mode  
**Precondition:** `mode = 'acceptIrreversible'`; endpoint is `PUT .../merge`  
**Input:** same as CL-007  
**Expected:** `result.approvalRequired === false`; `result.acceptedIrreversible === true`  
**Exit code:** n/a  
**Notes:** (spec: L700–L701)

### CL-012: CAIRN_MODE=bypass + class ④ → no hold, call passes silently
**Property:** Classifier — bypass mode  
**Precondition:** `mode = 'bypass'`; endpoint is `PUT .../merge`  
**Input:** same as CL-007  
**Expected:** `result.approvalRequired === false`; `result.acceptedIrreversible === false`  
**Exit code:** n/a  
**Notes:** `bypass` suppresses approval gate entirely. (spec: L3290–L3294)

### CL-013: LaneResolver — header-only (L1) resolution, high confidence
**Property:** LaneResolver — Layer 1 merge  
**Precondition:** Request carries `x-cairn-lane-id: lane_ABC` header  
**Input:** `{ headers: { 'x-cairn-lane-id': 'lane_ABC' }, remotePort: 9000, body: {} }`  
**Expected:** `result.laneId === 'lane_ABC'`; `result.confidence === 'high'`; `result.source === 'layer1'`  
**Exit code:** n/a  
**Notes:** Layer 1 is the inline header path. (spec: L186)

### CL-014: LaneResolver — no header, PID lookup (L3) match, medium confidence
**Property:** LaneResolver — Layer 3 fallback  
**Precondition:** No `x-cairn-lane-id` header; PID netstat matches a known lane  
**Input:** `{ headers: {}, remotePort: 9001 }`; mock pid-lookup returns `lane_DEF`  
**Expected:** `result.laneId === 'lane_DEF'`; `result.confidence` is `'medium'` or `'low'`; `result.source === 'layer3'`  
**Exit code:** n/a  
**Notes:** (spec: L113)

### CL-015: LaneResolver — header + body agree → high confidence
**Property:** LaneResolver — consistent multi-layer merge  
**Precondition:** Header has `x-cairn-lane-id: lane_X`; body contains `laneId: 'lane_X'`  
**Input:** both layers return same `lane_X`  
**Expected:** `result.laneId === 'lane_X'`; `result.confidence === 'high'`  
**Exit code:** n/a  
**Notes:** Agreement across sources upgrades confidence.

### CL-016: LaneResolver — header vs body conflict → conflict source
**Property:** LaneResolver — conflict detection  
**Precondition:** Header returns `lane_A`; body returns `lane_B`  
**Input:** two layers disagree  
**Expected:** `result.source === 'conflict'` OR whichever layer wins by priority; `result.confidence` is `'low'` or `'none'`  
**Exit code:** n/a  
**Notes:** Conflict is an explicit source value. (spec: L3612–L3615)

### CL-017: LaneResolver — no header, no body, no PID match → none
**Property:** LaneResolver — no attribution  
**Precondition:** All three layers return null  
**Input:** bare request with no lane signal  
**Expected:** `result.laneId === null`; `result.confidence === 'none'`; `result.source === 'none'`  
**Exit code:** n/a  
**Notes:** (spec: L3611–L3615)

### CL-018: LaneResolver — path-only match, low confidence
**Property:** LaneResolver — Layer 2 hook path  
**Precondition:** No header; hook socket provides lane signal with `laneId: 'lane_GHI'`  
**Input:** request from PID registered via hook-socket (Layer 2)  
**Expected:** `result.laneId === 'lane_GHI'`; `result.source === 'layer2'`  
**Exit code:** n/a  
**Notes:** Layer 2 is hook-socket. (spec: L112)

---

## Group 3: Fault Injection (FI-*)

These three tests are the explicit CI gate — any failure blocks merge.  
Test files: `tests/fault/F-invariant.test.ts`, `tests/fault/F-optlock.test.ts`, `tests/fault/F-midstep.test.ts`.

### FI-001: F-invariant — compensator chain misses a mutated field
**Property:** Invariant check — `INCOMPLETE_BEFORE_IMAGE`  
**Precondition:**  
1. Mock GitHub server running on port 18110.  
2. Agent sends `PATCH /repos/x/y/pulls/1` with `{ title: 'new', body: 'new body' }`.  
3. Manifest is patched so `compensatorChain[0].covers = ['title']` (drops `'body'`).  
**Input:** `cairn.revert(op.laneId)`  
**Expected:**  
- `receipt.exitCode === 3`  
- `receipt.failed.length === 1`  
- `receipt.failed[0].code === 'INCOMPLETE_BEFORE_IMAGE'`  
- `receipt.failed[0].gaps` contains `'body'`  
**Exit code:** 3  
**Notes:** Exact scenario named in success criteria. (spec: L1688–L1708, L1241–L1284)

### FI-002: F-optlock — HTTP 412 during compensation
**Property:** Optimistic lock — conflict detection  
**Precondition:**  
1. Mock GitHub server on port 18110.  
2. Agent sends `PATCH /repos/x/y/pulls/1 { state: 'closed' }`.  
3. Before compensation fires, mock server is configured to return HTTP 412 on `PATCH /repos/x/y/pulls/1` when `If-Match` header does not match expected stale ETag.  
**Input:** `cairn.revert(op.laneId)`  
**Expected:**  
- `receipt.exitCode === 3`  
- `receipt.failed.length === 1`  
- `receipt.failed[0].code === 'CONFLICT'`  
- Lane final state is `'PARTIAL_REVERT'`  
**Exit code:** 3  
**Notes:** Exact scenario named in success criteria. (spec: L1713–L1729, L1174–L1177)

### FI-003: F-midstep — step 2 of 3 returns HTTP 500
**Property:** Mid-sequence failure — partial revert enumeration  
**Precondition:**  
1. Mock GitHub server on port 18110.  
2. Agent sends `POST /repos/x/y/pulls { title: 't', head: 'demo', base: 'main' }`, which produces a 3-step compensation: `[close-PR, delete-ref-demo, ...]`.  
3. Mock server is configured: step 0 (close PR / PATCH) → 200; step 1 (DELETE /repos/x/y/git/refs/heads/demo) → 500.  
**Input:** `cairn.revert(op.laneId)`  
**Expected:**  
- `receipt.exitCode === 2`  
- `receipt.reverted.length === 1` (step 0 succeeded)  
- `receipt.failed.length === 1` (step 1 failed)  
- `receipt.failed[0].code === 'INFRA_ERR'`  
- Step 2 (third step) is NOT attempted  
- Lane final state is `'PARTIAL_REVERT'`  
**Exit code:** 2  
**Notes:** Exact scenario named in success criteria. (spec: L1734–L1749, L1215–L1218)

---

## Group 4: Receipt Schema (RS-*)

Tests in `tests/unit/receipt/`.

### RS-001: Required fields present on successful receipt
**Property:** Receipt schema — field completeness  
**Precondition:** Successful 1-step revert  
**Input:** `buildReceipt(lane, ctx, plan)` with one completed step and no failures (note: takes full `Lane` object, not just `laneId`)  
**Expected:** Receipt object contains all of:  
- `laneId` (string)  
- `agentId` (string, denormalized from Lane)  
- `agentName` (string, denormalized from Lane)  
- `pipelineId` (string or undefined, denormalized from Lane)  
- `exitCode` (number, one of `0|2|3|4|5`)  
- `reverted` (array)  
- `failed` (array)  
- `irreversibleSideEffects` (array)  
- `timings.startedAt` (ISO string)  
- `timings.endedAt` (ISO string)  
- `timings.wallMs` (number)  
- `attribution.confidence` (one of `'high'|'medium'|'low'|'none'`)  
- `engineVersion` (string, e.g. `"cairn/0.0.1-r2"`)  
- `generatedAt` (number, epoch ms)  
**Exit code:** 0  
**Notes:** Exact fields from the `Receipt` TypeScript interface (r2). `agentId`, `agentName`, `pipelineId`, `engineVersion`, `generatedAt` are denormalized from the `Lane` argument so receipts are self-contained. (spec: L3569–L3603)

### RS-002: `exitCode` is the sole status field — no string `status` field on Receipt
**Property:** Receipt schema — exitCode enum; absence of string status field  
**Precondition:** Build receipts for each failure scenario  
**Input:** receipts with `failed[0].code` = each of `'INCOMPLETE_BEFORE_IMAGE'`, `'CONFLICT'`, `'INFRA_ERR'`, `'MANUAL_GATE'`; and one with no failures  
**Expected:**  
- No failures → `exitCode === 0`  
- `'INCOMPLETE_BEFORE_IMAGE'` → `exitCode === 3`  
- `'CONFLICT'` → `exitCode === 3`  
- `'INFRA_ERR'` → `exitCode === 4`  
- `'MANUAL_GATE'` → `exitCode === 5`  
- All values are in the set `{0, 2, 3, 4, 5}`  
- Receipt does NOT have a `status` string field; `'status' in receipt === false`  
- `exitCodeToString()` is a separate helper for display purposes only; it is not a Receipt field  
**Exit code:** n/a  
**Notes:** `exitCode: 0|2|3|4|5` is the single source of truth on the Receipt. Human-readable strings are produced by the `exitCodeToString()` helper at the display layer. (spec: L3575–L3576, L3586–L3595, L1527–L1535)

### RS-003: `reverted[]` and `irreversibleSideEffects[]` are disjoint by opId / kind
**Property:** Receipt schema — disjointness invariant  
**Precondition:** Receipt with 2 reverted steps and 1 irreversible side effect  
**Input:** Construct a `RevertContext` where `completed` contains opIds `[op1, op2]` and `irreversibleTail` contains `{ kind: 'ci-run', ... }`  
**Expected:** No `opId` in `reverted[]` appears in `irreversibleSideEffects[]`; specifically the invariant is that one side effect cannot be both "reverted" and "irreversible"  
**Exit code:** n/a  
**Notes:** (spec: L1586)

### RS-004: `exitCode 0` ↔ `failed.length === 0`
**Property:** Receipt schema — exit code 0 invariant  
**Precondition:** `buildReceipt` called with `ctx.failed = null` and all steps completed  
**Input:** `ctx = { completed: [step1, step2], failed: null, irreversibleTail: [] }`  
**Expected:** `receipt.exitCode === 0` AND `receipt.failed.length === 0`  
**Exit code:** 0  
**Notes:** (spec: L1563–L1565)

### RS-005: Halt location is `failed[0].stepIdx` — no top-level `haltedAt` field on Receipt
**Property:** Receipt schema — halt location via failed entry; absence of `haltedAt`  
**Precondition:** `buildReceipt` called with `ctx.failed` pointing to step at index 1  
**Input:** `ctx.failed = { opId: 'op2', stepIdx: 1, code: 'INFRA_ERR', msg: '500' }`  
**Expected:**  
- `receipt.failed[0].stepIdx === 1` (this is the halt location)  
- `receipt.exitCode === 4`  
- Receipt does NOT have a top-level `haltedAt` field; `'haltedAt' in receipt === false`  
**Exit code:** 4  
**Notes:** The `Receipt` interface explicitly forbids a top-level `haltedAt` field. The halt location is conveyed by `failed[0].stepIdx`. (spec: L3577, L3523–L3529)

### RS-006: Property test — disjointness invariant holds for random input
**Property:** Receipt schema — disjointness fuzz  
**Precondition:** n/a  
**Input:** Generate 100 random `(reverted[], failed[], irreversibleSideEffects[])` combinations using random opIds and kind strings  
**Expected:** For every generated receipt, `reverted[].map(r => r.opId)` has no overlap with `irreversibleSideEffects[].map(e => e.kind)` (different fields by design); assert that `buildReceipt` never places the same opId in both `reverted` and `failed`  
**Exit code:** n/a  
**Notes:** This is a property-based test. Use a simple loop with `Math.random` rather than a property-testing library dependency. (spec: L1586)

### RS-007: `buildReceipt()` denormalizes agent context from Lane
**Property:** Receipt schema — denormalized agent context fields  
**Precondition:** A `Lane` object with `agentId = 'agent-42'`, `agentName = 'my-agent'`, `pipelineId = 'pipe-99'`  
**Input:** `buildReceipt(lane, ctx, plan)` where `lane` carries the above values; `ctx` has one completed step and no failures  
**Expected:**  
- `receipt.agentId === 'agent-42'`  
- `receipt.agentName === 'my-agent'`  
- `receipt.pipelineId === 'pipe-99'`  
- `receipt.generatedAt` is a number (epoch ms) within 5 seconds of `Date.now()` at test time  
- `receipt.engineVersion` matches `/^cairn\//` (non-empty string starting with `"cairn/"`)  
**Exit code:** 0  
**Notes:** These fields are denormalized from the `Lane` argument so a receipt remains self-contained even if the lane record is later deleted. `buildReceipt` now accepts a full `Lane` as its first argument rather than a bare `laneId`. (spec: L3569–L3584, L1601–L1623)

---

## Group 5: Exit Codes (EC-*)

Tests in `tests/unit/exit-codes/`. Tests call `laneStateToExitCode`, `deriveExitCode`, and `deriveProcessExitCode` (from `src/reverter/exit-code.ts`).

Exit code derivation is a two-tier process unified by `deriveProcessExitCode(receipt, lane)`:
- **Tier 1 — from lane state** (`laneStateToExitCode`, return type `0|2|4|5`): exit 0 (`REVERTED`), exit 2 (`PARTIAL_REVERT`), exit 4 (`FAILED_RETRYABLE`), exit 5 (`HELD_FOR_HUMAN`). This tier never produces exit code 3.
- **Tier 2 — from `failed[0].code`** (only when `receipt.failed.length > 0`): exit 3 (`CONFLICT` or `INCOMPLETE_BEFORE_IMAGE`). This path takes priority over lane state.

### EC-001: Exit 0 — full success, `failed = []`
**Property:** Exit code mapping — success  
**Precondition:** `laneState = 'REVERTED'`  
**Input:** `laneStateToExitCode('REVERTED', false)`  
**Expected:** returns `0`  
**Exit code:** 0  
**Notes:** Tier 1 path. `cairn revert` process exits 0. (spec: L1503–L1504, L1516–L1517)

### EC-002: Exit 2 — `PARTIAL_REVERT` — at least one step failed
**Property:** Exit code mapping — partial failure  
**Precondition:** `laneState = 'PARTIAL_REVERT'`  
**Input:** `laneStateToExitCode('PARTIAL_REVERT', false)`  
**Expected:** returns `2`  
**Exit code:** 2  
**Notes:** Tier 1 path. (spec: L1505, L1518)

### EC-003: Exit 3 — invariant or conflict error requires `failed[0].code` — not reachable via lane state
**Property:** Exit code mapping — verify mismatch via Tier 2 only  
**Precondition:** Receipt has `failed.length > 0`; `failed[0].code` is `'CONFLICT'` or `'INCOMPLETE_BEFORE_IMAGE'`  
**Input:** `deriveProcessExitCode(receipt, lane)` where `receipt.failed[0].code` is `'CONFLICT'`; repeat with `'INCOMPLETE_BEFORE_IMAGE'`  
**Expected:**  
- Both calls return `3`  
- `laneStateToExitCode` called with any valid `LaneState` value NEVER returns `3` (the function's return type is `0|2|4|5`)  
- Exit code 3 is unreachable from the lane state mapping alone; it requires `failed[0].code ∈ {CONFLICT, INCOMPLETE_BEFORE_IMAGE}`  
**Exit code:** 3  
**Notes:** Tier 2 path only. `deriveProcessExitCode()` is the unified entry point. (spec: L1541–L1544, L1568–L1573, L1626–L1629)

### EC-004: Exit 4 — retryable infrastructure error
**Property:** Exit code mapping — infra error  
**Precondition:** `receipt.failed[0].code = 'INFRA_ERR'` (Tier 2); also `laneState = 'FAILED_RETRYABLE'` (Tier 1)  
**Input:** `deriveProcessExitCode(receipt, lane)` where `receipt.failed[0].code = 'INFRA_ERR'`; also `laneStateToExitCode('FAILED_RETRYABLE', false)`  
**Expected:** both return `4`  
**Exit code:** 4  
**Notes:** Exit 4 is reachable via both tiers. (spec: L1531, L1506, L1580)

### EC-005: Exit 5 — manual gate / held for human
**Property:** Exit code mapping — manual gate  
**Precondition:** `receipt.failed[0].code = 'MANUAL_GATE'` (Tier 2); also `laneState = 'HELD_FOR_HUMAN'` (Tier 1)  
**Input:** `deriveProcessExitCode(receipt, lane)` where `receipt.failed[0].code = 'MANUAL_GATE'`; also `laneStateToExitCode('HELD_FOR_HUMAN', false)`  
**Expected:** both return `5`  
**Exit code:** 5  
**Notes:** Exit 5 is reachable via both tiers. (spec: L1532, L1507, L1521)

### EC-006: `laneStateToExitCode` maps to exactly `{0, 2, 4, 5}` — no 3
**Property:** Exit code mapping — bijectivity and range constraint  
**Precondition:** n/a  
**Input:** all valid `LaneState` values passed to `laneStateToExitCode`  
**Expected:**  
- Exit 0 ↔ `REVERTED`  
- Exit 2 ↔ `PARTIAL_REVERT` (and non-terminal default branch: `REVERTING`, `RECORDED`)  
- Exit 4 ↔ `FAILED_RETRYABLE`  
- Exit 5 ↔ `HELD_FOR_HUMAN`  
- The value `3` is NEVER in the output set of `laneStateToExitCode`  
**Exit code:** n/a  
**Notes:** Exit 3 belongs exclusively to Tier 2 (`failed[0].code` path). Exit 2 is also returned for `REVERTING` and `RECORDED` via the default branch, which are non-terminal states that should not appear in a final receipt. (spec: L1502–L1510, L1516–L1517)

---

## Group 6: Optimistic Lock (OL-*)

Tests in `tests/unit/optlock/`. Tests call `buildOptLockHeaders`, `executeOptLock`, `verifyOptLockResponse` from `src/reverter/optlock.ts`.

### OL-001: `etag` variant — `If-Match` header set from before-image
**Property:** Opt-lock etag — header injection  
**Precondition:** Step has `plan.optimisticLock = { type: 'etag', value: '${before_image.etag}' }`; resolver context has `before_image.etag = 'W/"abc"'`  
**Input:** `buildOptLockHeaders(step, resolver)`  
**Expected:** returns `{ 'If-Match': 'W/"abc"' }`  
**Exit code:** n/a  
**Notes:** (spec: L1304)

### OL-002: `etag` variant — upstream returns 412 → CONFLICT
**Property:** Opt-lock etag — 412 rejection  
**Precondition:** Mock HTTP returns 412 for the compensation request  
**Input:** `executeStep` sends request; response status is 412  
**Expected:** `stepResult.status === 'FAIL'`; `stepResult.errorCode === 'CONFLICT'`; compensation state updated to `'VERIFY_MISMATCH'`  
**Exit code:** 3  
**Notes:** (spec: L1174–L1177)

### OL-003: `etag` variant — `verifyOptLockResponse` with 204 → true
**Property:** Opt-lock etag — successful delete (204)  
**Precondition:** `step.plan.optimisticLock = { type: 'etag', value: '...' }`  
**Input:** `verifyOptLockResponse({ status: 204, headers: {} }, step)`  
**Expected:** returns `true`  
**Exit code:** n/a  
**Notes:** (spec: L1378–L1380)

### OL-004: `version-check` variant — `buildOptLockHeaders` returns empty object (no header)
**Property:** Opt-lock version-check — no header emitted  
**Precondition:** `step.plan.optimisticLock = { type: 'version-check', field: 'updated_at', expected: '2026-01-01' }`  
**Input:** `buildOptLockHeaders(step, resolver)`  
**Expected:** returns `{}` (no `If-Match` or similar header)  
**Exit code:** n/a  
**Notes:** `version-check` uses response-time comparison, not header. (spec: L1305)

### OL-005: `version-check` variant — `verifyOptLockResponse` accepts 2xx
**Property:** Opt-lock version-check — HTTP health check only  
**Precondition:** `step.plan.optimisticLock = { type: 'version-check', ... }`  
**Input:** `verifyOptLockResponse({ status: 200, headers: {} }, step)`  
**Expected:** returns `true`  
**Exit code:** n/a  
**Notes:** Spec note: specific field comparison is a TODO (L1382). Only HTTP health is checked here. (spec: L1381–L1384)

### OL-006: `field-match` variant — `must_contain` — label present → ok
**Property:** Opt-lock field-match — must_contain success  
**Precondition:** Probe URL mock returns `[{ name: 'bug' }, { name: 'help wanted' }]`; `compare_value = 'bug'`; `compare_strategy = 'must_contain'`  
**Input:** `executeOptLock({ type: 'field-match', probe_url: 'GET /...', compare_strategy: 'must_contain', compare_value: 'bug' }, resolver, mockForwarder)`  
**Expected:** `result.status === 'ok'`  
**Exit code:** n/a  
**Notes:** (spec: L1347–L1353)

### OL-007: `field-match` variant — `must_contain` — label absent → conflict
**Property:** Opt-lock field-match — must_contain failure  
**Precondition:** Probe returns `[{ name: 'help wanted' }]` (no 'bug'); `compare_value = 'bug'`  
**Input:** same as OL-006 but label missing  
**Expected:** `result.status === 'conflict'`; `result.detail` contains `'bug'`  
**Exit code:** 3  
**Notes:** (spec: L1343–L1344)

### OL-008: `field-match` variant — `must_not_contain` — label absent → ok
**Property:** Opt-lock field-match — must_not_contain success  
**Precondition:** Probe returns `[]`; `compare_strategy = 'must_not_contain'`; `compare_value = 'bug'`  
**Input:** `executeOptLock({ type: 'field-match', ..., compare_strategy: 'must_not_contain', compare_value: 'bug' }, resolver, mockForwarder)`  
**Expected:** `result.status === 'ok'`  
**Exit code:** n/a  
**Notes:** (spec: L1354–L1356)

### OL-009: `field-match` variant — `exact_match` — body matches → ok
**Property:** Opt-lock field-match — exact_match success  
**Precondition:** Probe returns `"open"`; `compare_value = '"open"'` (JSON-serialized)  
**Input:** `executeOptLock({ type: 'field-match', ..., compare_strategy: 'exact_match', compare_value: 'open' }, resolver, mockForwarder)`  
**Expected:** `result.status === 'ok'`  
**Exit code:** n/a  
**Notes:** `exact_match` uses `JSON.stringify(body) === JSON.stringify(value)`. (spec: L1357–L1359)

### OL-010: `field-match` variant — probe returns non-2xx → probe_failed
**Property:** Opt-lock field-match — probe HTTP error  
**Precondition:** Mock forwarder returns 404 for probe URL  
**Input:** `executeOptLock({ type: 'field-match', probe_url: 'GET /not-found', ... }, resolver, mockForwarder404)`  
**Expected:** `result.status === 'probe_failed'`; `result.httpStatus === 404`  
**Exit code:** n/a  
**Notes:** (spec: L1337–L1339)

### OL-011: Missing before-image (timeout) → `BEFORE_IMAGE_UNAVAILABLE`
**Property:** Before-image capture — timeout error  
**Precondition:** `captureBeforeImage` called with `budgetMs = 100`; upstream fetch times out (AbortController fires)  
**Input:** `captureBeforeImage(entry, req, slowFetch, 100)`  
**Expected:** throws `CairnError` with `code === 'BEFORE_IMAGE_TIMEOUT'`; or returns `null` with caller mapping to `BEFORE_IMAGE_UNAVAILABLE`  
**Exit code:** n/a  
**Notes:** The abort path in `captureBeforeImage` throws `CairnError('BEFORE_IMAGE_TIMEOUT', ...)`. Non-timeout fetch errors throw `CairnError('BEFORE_IMAGE_UNAVAILABLE', ...)`. (spec: L1626–L1629)

### OL-012: Idempotent retry after CONFLICT preserves same idempotency key
**Property:** Opt-lock + idempotency — key stability  
**Precondition:** First revert attempt receives 412 → CONFLICT; second retry attempt uses same `(laneId, stepIdx, opId)`  
**Input:** `deriveIdempotencyKey(laneId, stepIdx, opId)` called twice with identical inputs  
**Expected:** Both calls return identical 32-char hex strings; no new key is generated for a retry  
**Exit code:** n/a  
**Notes:** (spec: L1405–L1407)

---

## Group 7: Idempotency (IK-*)

Tests in `tests/unit/idempotency/`. Tests call `deriveIdempotencyKey` and `wasAlreadySuccessful` from `src/reverter/idempotency.ts`.

### IK-001: Same (laneId, stepIdx, opId) → deterministically same key
**Property:** Idempotency key — deterministic derivation  
**Precondition:** n/a  
**Input:** `deriveIdempotencyKey('lane_AAA', 0, 'op_BBB')` called twice  
**Expected:** Both calls return the same string; the result is stable across process restarts (pure hash)  
**Exit code:** n/a  
**Notes:** (spec: L1404–L1407)

### IK-002: Different laneId → different key
**Property:** Idempotency key — lane isolation  
**Precondition:** n/a  
**Input:** `deriveIdempotencyKey('lane_AAA', 0, 'op_BBB')` vs `deriveIdempotencyKey('lane_ZZZ', 0, 'op_BBB')`  
**Expected:** Two different keys  
**Exit code:** n/a  
**Notes:** laneId is part of the hash input `${laneId}:${stepIdx}:${opId}`. (spec: L1406)

### IK-003: `wasAlreadySuccessful(key) = true` → compensation step skipped
**Property:** Idempotency — skip already-successful step  
**Precondition:** Storage mock returns a compensation with `state = 'SUCCESS'` for `(opId, stepIdx, action)`  
**Input:** `wasAlreadySuccessful(mockSaver, opId, stepIdx, action)`  
**Expected:** returns `true`; caller (`executeRevert`) skips the step and adds it to `ctx.completed` via `resurrectResult`  
**Exit code:** n/a  
**Notes:** The `--resume` flag triggers this path. (spec: L1026, L1411–L1417)

### IK-004: Key format is 32-char hex prefix of sha256
**Property:** Idempotency key — format  
**Precondition:** n/a  
**Input:** `deriveIdempotencyKey('lane_TEST', 1, 'op_XYZ')`  
**Expected:** result is a string of exactly 32 characters matching `/^[0-9a-f]{32}$/`  
**Exit code:** n/a  
**Notes:** `h.slice(0, 32)` of `sha256(...).digest('hex')`. (spec: L1405–L1407)

---

## Group 8: Approval Gate (AG-*)

Integration tests in `tests/unit/approval-gate/`. Use a mock Cairn proxy and mock upstream.

### AG-001: Class ④ call in `strict` mode → proxy returns 202 + `X-Cairn-Hold: pending`
**Property:** Approval gate — hold response  
**Precondition:** Cairn running in `strict` mode; request matches `PUT .../merge` (class ④, `requiresApprovalWhen: [{ always: true }]`)  
**Input:** Agent sends `PUT /repos/x/y/pulls/1/merge` through proxy  
**Expected:** Proxy immediately responds with HTTP `202` and header `X-Cairn-Hold: pending`; request is queued internally; op state is `'PENDING_APPROVAL'`; a `RequestSnapshot` is persisted in SQLite  
**Exit code:** n/a  
**Notes:** (spec: L42–L43, L2584–L2604)

### AG-002: `cairn approve lane-X op-Y` → held call released, original response forwarded to agent
**Property:** Approval gate — approve path  
**Precondition:** Op is in `PENDING_APPROVAL` state; agent socket is still connected  
**Input:** `handleApprove(opId)` called  
**Expected:** `upstreamResp` is forwarded to the agent socket; op state updated to `'PASSED'`; response contains `clientAlive: true`  
**Exit code:** 0  
**Notes:** (spec: L2587–L2601)

### AG-003: `cairn deny lane-X op-Y` → held call dropped, agent receives 499
**Property:** Approval gate — deny path  
**Precondition:** Op is in `PENDING_APPROVAL` state; agent socket is connected  
**Input:** `handleDeny(opId, 'too risky')` called  
**Expected:** Socket receives `HTTP/1.1 499 Client Closed Request` with body containing denial message; op state updated to `'BLOCKED'`  
**Exit code:** n/a  
**Notes:** (spec: L2606–L2617)

### AG-004: Approval timeout (no response within TTL) → agent receives `503 Retry-After: 0`
**Property:** Approval gate — timeout  
**Precondition:** Op is in `PENDING_APPROVAL` state; `config.approvalTimeoutSec` has elapsed without `cairn approve`; timed-scan fires  
**Input:** `findPendingApprovalsOlderThan(ttlMs)` returns the stale op  
**Expected:** Socket receives `HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0`; op state updated to `'BLOCKED'`  
**Exit code:** n/a  
**Notes:** (spec: L2619–L2631)

### AG-005: `acceptIrreversible` mode → no hold, call tagged `accepted-irreversible`
**Property:** Approval gate — acceptIrreversible bypass  
**Precondition:** Cairn running in `acceptIrreversible` mode; class ④ endpoint hit  
**Input:** `classify()` returns `{ approvalRequired: false, acceptedIrreversible: true }`  
**Expected:** Request is forwarded to upstream immediately (no 202 hold); op is recorded in lane log with `acceptedIrreversible = true`; no entry in pending approvals queue  
**Exit code:** n/a  
**Notes:** (spec: L700–L701)

### AG-006: `bypass` mode → no hold, no tag, call passes silently but is recorded
**Property:** Approval gate — bypass mode  
**Precondition:** Cairn running in `bypass` mode; class ④ endpoint hit  
**Input:** `classify()` returns `{ approvalRequired: false, acceptedIrreversible: false }`  
**Expected:** Request forwarded immediately; op is recorded to SQLite (for audit); `approvalRequired = false`; `acceptedIrreversible = false`; no hold  
**Exit code:** n/a  
**Notes:** (spec: L3290–L3294)

---

## Group 9: Lane Isolation (LI-*)

Integration tests in `tests/unit/lane-isolation/`. Use in-memory `CheckpointSaver` or SQLite test database.

### LI-001: Two concurrent lanes A and B — `cairn revert lane-A` → lane B ops untouched
**Property:** Lane isolation — revert scope  
**Precondition:** Two lanes recorded with distinct ops each; lane A has ops `[opA1, opA2]`; lane B has op `[opB1]`  
**Input:** `executeRevert(laneIdA, { dryRun: false })`  
**Expected:** `receipt.reverted` contains only opIds from lane A; `opB1` remains in `PASSED` state (unchanged); `saver.getOp(opB1.id).state` is still `'PASSED'`  
**Exit code:** 0  
**Notes:** planCompensations filters by laneId. (spec: L1096–L1106)

### LI-002: `tryAcquireLaneLock` CAS — second concurrent attempt receives `LANE_BUSY`
**Property:** Lane isolation — lock contention  
**Precondition:** `tryAcquireLaneLock(laneId, 'holder1', 60000)` returns `true` (lock acquired)  
**Input:** Immediately after, `tryAcquireLaneLock(laneId, 'holder2', 60000)` is called  
**Expected:** Second call returns `false` (or throws `CairnError('LANE_BUSY', { laneId, holder })`); first holder retains lock  
**Exit code:** n/a  
**Notes:** r1 uses atomic `UPDATE` CAS on `lanes` table. (spec: L41, L1073–L1078)

### LI-003: Reverting lane A freezes lanes B and C during compensation, then resumes them
**Property:** Lane isolation — cross-lane freeze  
**Precondition:** Three lanes: A, B, C all in `RECORDED` state; lane A revert begins  
**Input:** `executeRevert(laneIdA, ...)` — during compensation, check `isLaneFrozen(laneIdB)` and `isLaneFrozen(laneIdC)`  
**Expected:**  
- During revert: `isLaneFrozen(laneIdB) === true`; `isLaneFrozen(laneIdC) === true`  
- After revert completes and `releaseLaneLock` fires: lanes B and C are unfrozen  
**Exit code:** n/a  
**Notes:** `freezeLanes(except: [laneIdA])` is called at the top of `executeRevert`. In Preview, freeze is in-memory via `frozenLanes Set`. (spec: L1085–L1093)

### LI-004: Revert receipt for lane A contains no ops from lane B
**Property:** Lane isolation — receipt scope  
**Precondition:** Same as LI-001  
**Input:** Full receipt from `executeRevert(laneIdA, ...)`  
**Expected:** Every `opId` in `receipt.reverted` and `receipt.failed` belongs to lane A; `receipt.laneId === laneIdA`  
**Exit code:** n/a  
**Notes:** (spec: L1563)

---

## Group 10: Compensation Chains — GitHub (GH-*)

Integration tests in `tests/unit/github-adapter/`. Each test uses a mock HTTP forwarder. The "happy path" tests assert that the correct HTTP calls are issued in the correct order.

### GH-001: Create PR → close PR (PATCH state=closed)
**Property:** GitHub adapter — create PR compensation  
**Precondition:** Manifest entry for `POST /repos/{o}/{r}/pulls`; mock forwarder records all outbound requests  
**Input:**  
1. Forward op: `POST /repos/acme/web/pulls` with body `{ title: 't', head: 'feat', base: 'main' }`; upstream response includes `{ number: 42 }`  
2. Execute `cairn revert`  
**Expected:**  
- Step 0 issues `PATCH /repos/acme/web/pulls/42` with body `{ state: 'closed' }` → mock returns 200  
- Step 1 issues `DELETE /repos/acme/web/git/refs/heads/feat` (`best_effort: true`)  
- `receipt.exitCode === 0`; `receipt.reverted.length >= 1`  
**Exit code:** 0  
**Notes:** Two-step compensation chain (L0-pure + best_effort delete ref). (spec: L3775–L3799)

### GH-002: Create issue comment → delete comment
**Property:** GitHub adapter — create comment compensation  
**Precondition:** Manifest entry for `POST /repos/{o}/{r}/issues/{n}/comments`  
**Input:**  
1. Forward op: `POST /repos/acme/web/issues/5/comments` body `{ body: 'LGTM' }`; upstream response `{ id: 101 }`  
2. Execute `cairn revert`  
**Expected:** Step 0 issues `DELETE /repos/acme/web/issues/comments/101` → mock returns 204; `receipt.exitCode === 0`; `receipt.reverted[0].covers` contains `'body'` and `'id'`  
**Exit code:** 0  
**Notes:** `${response.id}` template is resolved to `101`. (spec: L3846–L3863)

### GH-003: Create branch → delete branch
**Property:** GitHub adapter — create branch compensation  
**Precondition:** Manifest entry for `POST /repos/{o}/{r}/git/refs`  
**Input:**  
1. Forward op: `POST /repos/acme/web/git/refs` body `{ ref: 'refs/heads/demo', object: { sha: 'abc123' } }`  
2. Execute `cairn revert`  
**Expected:** Step 0 issues `DELETE /repos/acme/web/git/refs/heads/demo` → mock returns 204; `receipt.exitCode === 0`  
**Exit code:** 0  
**Notes:** `coverage_gaps` includes `object.sha` (server-confirmed). Template: `${path.ref_short}` resolved from path vars. (spec: L3758–L3773)

### GH-004: Add label → remove label
**Property:** GitHub adapter — add label compensation  
**Precondition:** Manifest entry for `POST /repos/{o}/{r}/issues/{n}/labels`; field-match opt-lock  
**Input:**  
1. Forward op: `POST /repos/acme/web/issues/5/labels` body `{ labels: ['bug'] }`  
2. Probe GET returns `[{ name: 'bug' }]` (label still present)  
3. Execute `cairn revert`  
**Expected:** Step 0 first probes label list (GET `/repos/acme/web/issues/5/labels`), confirms `must_contain: 'bug'` → ok; then issues `DELETE /repos/acme/web/issues/5/labels/bug` → 204; `receipt.exitCode === 0`  
**Exit code:** 0  
**Notes:** `field-match` with `must_contain`. Template `${request.labels.0}` resolves to `'bug'`. (spec: L3865–L3886)

### GH-005: Create issue → irreversibleSideEffects (email notification)
**Property:** GitHub adapter — create issue irreversible tail  
**Precondition:** Manifest entry for `POST /repos/{o}/{r}/issues`; `unreversible_tail: [{ kind: 'issue-notification-email', detectable: false }]`  
**Input:**  
1. Forward op: `POST /repos/acme/web/issues` body `{ title: 'bug' }`; upstream response `{ number: 7 }`  
2. Execute `cairn revert`  
**Expected:**  
- Compensation closes the issue: `PATCH /repos/acme/web/issues/7` body `{ state: 'closed' }` → 200  
- `receipt.irreversibleSideEffects.length >= 1`  
- `receipt.irreversibleSideEffects[0].kind === 'issue-notification-email'`  
- `receipt.irreversibleSideEffects[0].detectable === false`  
- `receipt.exitCode === 0` (closing succeeds; irreversible tail is informational)  
**Exit code:** 0  
**Notes:** (spec: L3826–L3844)

### GH-006: Merge PR → approval gate opens in strict mode
**Property:** GitHub adapter — merge PR approval gate  
**Precondition:** Cairn in `strict` mode; manifest entry for `PUT .../merge` with `requires_approval_when: [{ always: true }]` and `class: ④`  
**Input:** Agent attempts `PUT /repos/acme/web/pulls/42/merge` through proxy  
**Expected:**  
- Proxy returns HTTP 202 with `X-Cairn-Hold: pending` (gate opens)  
- Op state is `'PENDING_APPROVAL'`  
- `receipt.irreversibleSideEffects` would include `ci-run`, `webhook-delivery`, `downstream-deploy` once receipt is built  
**Exit code:** n/a (gate is open; no revert attempted yet)  
**Notes:** This is an approval gate + irreversible tail combination test. (spec: L3888–L3904)

---

## Skipped / Deferred Tests

The following scenarios cannot be written yet because the spec is incomplete or the feature is explicitly unimplemented.

### DEFER-001: `covers` semantics — JSON-path vs top-level key
**Reason:** The spec does not decide whether `covers: ['object.sha']` means the dotted JSON-path `object.sha` or the top-level key `object`. `extractMutatedPaths` is documented as "top-level field level, Preview does not do nested diff" (spec: L1251–L1252). A precise test for nested-path `covers` matching cannot be written until the semantic is locked.

### DEFER-002: `extractMutatedPaths` — nested mutations produce false negatives
**Reason:** `extractMutatedPaths` only diffs top-level keys (spec: L1251). A request body mutating `{ labels: { primary: 'bug' } }` where only `labels.primary` changed would not be detected if `labels` itself is present in the before-image. The test behavior is therefore undefined until nested diff is specified.

### DEFER-003: `version-check` opt-lock — field comparison not implemented
**Reason:** `verifyOptLockResponse` for `version-check` only does HTTP status health check; the specific field comparison (`resp.body[field] === expected`) is marked as a TODO at spec L1382. A test asserting field-level version comparison would test unimplemented behavior.

### DEFER-004: Cross-lane dependency graph
**Reason:** The algorithm for determining which lanes a revert should freeze based on dependency relationships is not defined. Only "freeze all lanes except the one being reverted" is implemented (spec: L1085–L1093). Dependency-aware partial freeze is deferred to v0.1+.

### DEFER-005: `handleStepFailure` RETRY / SKIP_BEST_EFFORT branches
**Reason:** `handleStepFailure` always returns `'ABORT'` in Preview (spec: L1215–L1219). The `RETRY` and `SKIP_BEST_EFFORT` values of `PlanAction` (spec: L3685) are defined but unreachable. `best_effort: true` on manifest entries is silently ignored. Tests for these branches would test dead code.

### DEFER-006: `receipt.irreversibleSideEffects[].evidence` field
**Reason:** `evidence` is always `null` in `gatherIrreversibleTail` (spec: L1230: `evidence: null`). The mechanism to populate it is undefined. A test asserting a non-null `evidence` value cannot be written until the population logic is specified.
