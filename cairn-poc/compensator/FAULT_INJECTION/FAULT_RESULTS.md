# Compensator Fault Injection — Results

Date: 2026-04-21
Scope: `D:\lll\cairn\cairn-poc\compensator\` POCs 01–08 (all 8 written by subagent A, all verified end-to-end by A).
Methodology: wrote real code that starts the mocks, runs the proxies, injects specific faults, then runs revert.js and audits the actual mock state.

## Executive summary

| # | Scenario | Expected safe behavior | Actual behavior | Verdict |
|---|---|---|---|---|
| F1a | GitHub labels: before-image missing the labels key | detect gap, refuse/flag | silently succeeded, left labels in forward state | **BUG** (silent wrong state, exit 0) |
| F1b | Notion stale before-image + read-only rollup | narrow revert, flag gaps | narrow revert works; rollup flagged as coverageGap | OK (not a short board) |
| F1c | SQL UPDATE with concurrent 3rd-party write | detect conflict, skip | revert stomped 3rd-party email (lost-update) | **BUG** |
| F2a | Jira bulk revert: 2nd group's POST fails 500 | halt or partial_undo state | revert crashed with TypeError on undefined taskId; 100 keys left in forward state; no partial_undo marker | **BUG** |
| F2b | S3 multipart: complete fails (or crash mid-parts) | sweeper aborts orphan | sweeper works correctly against existing lane format | OK (design works, just needs a scheduled runner) |
| F3a | Stripe: refund step permanently 400 | halt or partial_undo | revert exited 0 as "success"; step failure hidden | **BUG** (most severe — reports success despite step failure) |
| F3b | GitHub: transient 500 on revert PATCH | retry w/ backoff | 1 attempt only; exit 3; manual re-run fixes it | **BUG** (no retry, no idempotency key) |
| F4 | GitHub merge: cascade honesty | enumerate irreversible side effects w/ concrete IDs | generic string list in lane + receipt; no concrete run_id/deployment_id/delivery_id | GAP (not a silent bug, but insufficient for audit) |

## Per-scenario details

### F1a — GitHub before-image missing `labels`
Script: `f1a-github-before-image-missing-labels.js`

1. Forward: PATCH issue with `{labels:['urgent'], title:'F1a title'}`
2. Corrupt lane: delete `beforeImage.labels` AND `compensator.body.labels`
3. Run revert

Observed: `revert.js` exited 0 and reported `revertOk: true`. It only verified `title` (because compensator.body only had `title`). The mock still serves `labels = ['urgent']` (the forward-applied value). **User-observable wrong state, no warning.**

Why it failed:
- `cairn-proxy.js` treats compensator.body as the ground truth of what to revert. If anything is missing there (due to corruption, upgrade, partial write), revert is a silent no-op for that field.
- There is no cross-check: "forward patch touched N keys; compensator.body covers M keys; if M<N, escalate."

Required protection:
- Invariant: for every key in `forwardRequest.body`, the lane MUST have either `compensator.body[k]` or an explicit `coverageGap` for that key. Revert must refuse to run if invariant is violated (exit non-zero, `state=manual_gate`).

### F1b — Notion stale / read-only fields
Script: `f1b-notion-stale-before-image.js`

- Third-party edit to Tags between forward (touched Status) and revert was correctly preserved. Revert is narrow (only restores fields it modified). **This is the right design.**
- PATCH on rollup property: mock rejects with 400, but the proxy *before* forward declares `coverageGaps:[{prop:'ComputedCount', reason:'read-only type rollup'}]`. Revert skips it. **Correctly handled.**
- NB: neither forward failure (fwd status 400) nor coverageGap is an error in the proxy — lane is written anyway. That is appropriate for diagnostics, but Cairn should surface "forwardStatus=400 + gaps" to the user.

Not a short board — A's POC covers this well.

### F1c — SQL concurrent write (lost-update)
Script: `f1c-sql-concurrent-write.js`

Seed row `id=1, email=alice@example.com, name=Alice`.
1. Proxy: `UPDATE users SET email='new@x.com' WHERE id=1` — lane captures before-image.
2. Third-party: `UPDATE users SET email='concurrent@x.com', name='ConcurrentName' WHERE id=1`.
3. Revert: `UPDATE users SET email='alice@example.com' WHERE id=1` — **no optimistic lock predicate**.

Final row: `email='alice@example.com', name='ConcurrentName'`. The third-party's `email='concurrent@x.com'` was silently destroyed. Classic lost-update.

The POC *does* verify and exits 3 (because `name` still differs from before-image — but only by coincidence, since `name` wasn't touched by forward. Had the concurrent writer also changed `name`, verify would still pass.). So exit code 3 is a weak signal; the data loss already happened.

Part 2 demonstrates the fix: `UPDATE users SET email=? WHERE id=? AND email=?forwardValue` — `changes=0` on conflict, concurrent writer preserved. Lane should then move to `state=conflict` and surface to user.

Required protection:
- SQL compensator MUST include optimistic-lock predicate `AND <col>=?forwardAppliedValue`
- Check `changes` after revert; `changes==0` on an expected-match row ⇒ conflict detected, do NOT retry blindly

### F2a — Jira bulk revert with mid-revert 500
Script: `f2a-jira-bulk-revert-step-fail.js`

Set up 200 successful forward changes split into 2 revert groups (Low: 100, Medium: 100). Faulty mock returns 500 on the 2nd POST (Medium group).

Observed:
- Group 1 (Low): 100/100 restored correctly.
- Group 2 (Medium): POST 500 → `submit.body.taskId` undefined → poll for 50×80ms → `t.status` undefined → **revert.js crashes with `TypeError: Cannot read properties of undefined (reading 'successful')`** at `revert.js:34`.
- Exit code 1.
- 100 keys remain in forward state `High`; should be `Medium`.
- Lane file has no `partial_undo` or `failedGroup` marker.
- Verify step samples only 5 keys — if sampling had landed in the Low group, it would have reported success.

Required protection:
- Per-group bulk revert must be a first-class state transition (`group_N=success|partial|failed`).
- On submit 500: retry with backoff (at least 3x); then mark lane `partial_undo` with `completedGroups:[Low]`, `failedGroups:[Medium]`, `resumableAfter: now+N`.
- Verify must audit ALL keys, not sample 5.
- Exit code must distinguish: 0=full revert, 2=partial_undo (user action needed), 3=verify-disagrees, 4=infra error.

### F2b — S3 orphan sweeper
Script: `f2b-s3-orphan-sweeper.js`

Two scenarios:
1. Proxy crashes after uploading 2/3 parts (`CRASH_AFTER_PART=2`) — lane persists `state=UPLOADING_PARTS` with `uploadId`.
2. Manual Complete with bad ETag → 400 — manually persisted a lane in `state=UPLOADING_PARTS`.

Sweeper: scans `lanes/*.json`, finds 2 orphans, issues AbortMultipartUpload. Remaining in-progress uploads after sweep = 0.

Works correctly. POC #6 proxy already persists lane *before every state transition*, so this is robust against mid-upload process death.

Remaining gap: if the proxy dies before `lane.uploadId` is written (`state=INIT_PENDING`), the orphan is untrackable from lane alone. Production Cairn should additionally run `ListMultipartUploads` per bucket and cross-reference to lane files, aborting anything older than a threshold.

Not a short board.

### F3a — Stripe multi-step with refund step permanent 400
Script: `f3a-stripe-refund-permafail.js`

Compensator plan: `[refund, cancelSubscription]`. We pre-refund out-of-band so the compensator's refund step returns 400 "already refunded".

Observed:
- Step 1 (refund) → 400, console.logged but revert.js *continues*.
- Step 2 (cancelSubscription) → 200, sub canceled.
- Final customer balance happens to be 0 (because of the out-of-band refund) → verify reports `balanceOk:true, subStatusOk:true` → **exit 0, "revertOk"**.
- **If the out-of-band refund had NOT happened** and the first refund just returned 500, the balance would be 2000 (customer charged, never refunded), but revert.js would still say "revertOk:false but no structured recovery path."

This is the worst bug of all scenarios: **revert reports success while one compensator step silently failed**.

Lane file has no `compensator.state`, no `completedSteps`, no `failedStep`, no `partial_undo`.

Required protection:
- Compensator MUST be a state machine with per-step tracking:
  - `steps:[{op, status:pending|success|failed, attempts, lastError, idempotencyKey}]`
- Terminal states: `success` (all steps done), `partial_undo` (some failed, recoverable), `failed` (unrecoverable), `manual_gate` (policy says halt).
- Exit code MUST reflect state: 0=success, 2=partial_undo, 3=verify-mismatch, 4=infra-error.
- Verify must check per-step postconditions, not just "final snapshot equals before-image" (which can match by coincidence).

### F3b — GitHub transient 500 + retry
Script: `f3b-github-revert-retry.js`

Custom mock fails the Nth PATCH. Forward = PATCH #1 (success). Revert = PATCH #2 (500, fails once).

Observed:
- `revert.js` makes ONE attempt. No retry.
- Verify reads state, sees `title` still forward value, exits 3.
- Title remains `'F3b forward title'`.
- Manually re-running `revert.js` succeeds (PATCH #3 passes) — so the flow IS idempotent by re-reading lane.

Missing:
- No automatic retry with exponential backoff on 5xx/429.
- No `Idempotency-Key` header. For PATCH this matters less (GitHub PATCH is naturally idempotent on same inputs); for POST compensators (Stripe refund, Jira bulk submit, GitHub revert-PR creation) this is **critical** — a retry after server-side partial apply can double-apply.

Required protection:
- Revert runner: exponential backoff (e.g. 3 tries: 0s, 1s, 5s) on 408/429/5xx, distinguishable from 4xx (which should fail fast).
- All compensator requests get `Idempotency-Key: <laneId>/<stepIndex>/<attemptN>` header (where supported).
- If exhausted: lane moves to `partial_undo` or `retry_later`.

### F4 — GitHub merge cascade honesty
Script: `f4-cascade-honesty.js`

The POC lane DOES include `cascadeSideEffects.irreversible` as a human-readable string list, and revert.js surfaces it in the receipt. **This is good; A deserves credit.**

What is missing:
- Concrete identifiers: actual `ci_run_id`, `deployment_id`, `webhook_delivery_id` of the side-effects that fired. Lane only has `mergeSha`. An auditor cannot answer "which specific webhook delivery did Slack receive?"
- Structured format: the list is free-form strings, not machine-parseable `{type, id, timestamp, subscriber, url}` objects.
- Counts / quantities: "CI minutes consumed" is not a number; "production served traffic" has no timestamps or request count.

Events that actually fired during our run (from `events.log`):
- `pull_request.merged`
- `check_suite.requested` → `in_progress` → `completed`
- `deployment.created` → `deployment.success`

None of these IDs are captured by the proxy's `GET /deployments` call (since they happen after merge). The proxy should (a) poll the resource for N seconds to capture post-merge cascade IDs, or (b) subscribe to the webhook stream itself.

Required protection (lane schema upgrade):
```
cascadeSideEffects: {
  reversible: [
    { type:'git.commit.revert', targetSha, plan:'forward-only commit on main' },
    { type:'deploy.redeploy', targetDeploymentId, plan:'trigger CI on revert commit' },
  ],
  irreversible: [
    { type:'ci.run.minutes_consumed', runId, minutes, logUrl },
    { type:'webhook.delivered', subscriber, eventType, deliveryId, deliveredAt },
    { type:'deployment.production.served_traffic', deploymentId, startedAt, endedAt, requestEstimate },
  ],
}
```

## Key metrics (asked)

1. **F1 before-image gap detection**: 1 of 8 POCs silently restores to the wrong state when before-image is incomplete (POC #1 GitHub). POC #2 Notion declares gaps correctly (architecturally protected by its coverageGaps pass). POC #3 SQL has a worse class of bug: not missing-field, but missing optimistic-lock predicate → lost-update. **Score: 2/8 vulnerable, 6/8 fine or out-of-scope for this class.**

2. **F2 partial bulk revert precision**: forward succeeded on 200 keys; we split the revert into 2 groups of 100. After one group fails, actual revert precision = **100/200 (50%)**, not the 200/200 implied by exit code / lane. Revert.js crashes with unhandled TypeError, leaves lane uncurable without manual inspection.

3. **F2/F3 revert self-failure stability**: **Major gap.** None of the POCs have:
   - per-step state machine
   - `partial_undo` terminal state in lane schema
   - exponential-backoff retry
   - Idempotency-Key headers
   - distinct exit codes per failure class
   
   Worst case (F3a Stripe): revert reports **exit 0** while one step hard-failed and another succeeded, because verify happened to match the expected final snapshot by coincidence.

4. **F4 cascade honesty**: POC #7 and #8 (we sampled #7) lane **DOES** declare irreversible side effects in human text, and revert receipt surfaces the list. The lane format **does NOT** capture concrete IDs (ci_run_id, deployment_id, webhook_delivery_id). Declaring "I can't undo X" is there; pointing to which specific X is not. Half credit.

## Compensator state machine (proposed)

See `STATE_MACHINE.txt` next to this file.

## Production-grade protections Cairn must add

1. **Invariant enforcement in proxy**: for every forward-touched key, lane must have a compensator entry OR an explicit coverageGap. Emit a structured manifest.
2. **Optimistic-lock compensators**: SQL and REST compensators should include `If-Match:<forwardAppliedValue>` (or WHERE predicate) — revert is a no-op on conflict, not a stomp.
3. **Per-step state machine in revert runner**: `steps:[{op, status, attempts, lastError, idempotencyKey}]` + `state:running|success|partial_undo|failed|manual_gate`. Persist after each transition.
4. **Retry policy**: exp. backoff on 408/429/5xx; hard-fail on 4xx (except 409 which maps to conflict/state=manual_gate).
5. **Idempotency-Key on every compensator POST**: derived from laneId+stepIndex+attemptIndex.
6. **Structured verify**: per-step postcondition check, not final-snapshot match.
7. **Scheduled sweeper**: runs every N minutes, scans lanes for state ∈ {INIT_PENDING, UPLOADING_PARTS, partial_undo} older than T; issues appropriate aborts or retries.
8. **Structured cascade manifest**: concrete IDs + timestamps + subscribers for every irreversible side effect, not free-form prose.
9. **Exit codes**: 0=success, 2=partial_undo, 3=verify-mismatch, 4=infra-error, 5=manual_gate. Operators can script on these.
10. **Sample audit on bulk revert**: verify must touch all keys (or a statistically representative sample sized to the failure-group granularity), not a fixed 5-key sample.

## Honest assessment of A's POCs

A's POCs are solid as proof-of-concept artifacts: all 8 endpoints reverse correctly on the happy path. The issues found here are *design-level* gaps that A explicitly flagged or partially flagged in RESULT.md:

- A already documented that completeness varies by endpoint (3/8 full reverse, 3/8 state-reverse-with-leftover, 2/8 forward-only cascade).
- A's lane format is missing a compensator state machine and retry policy. Every one of the 8 has this problem.
- A's verify functions are often under-powered (sampling 5 keys, final-snapshot comparison) and would not catch the F2a/F3a class of bug in production.
- A made the right call recording `coverageGaps` in the Notion POC; that pattern should generalize to all compensators.

These are not failures of A's work — A was building happy-path POCs. These findings are the shopping list for productionization.
