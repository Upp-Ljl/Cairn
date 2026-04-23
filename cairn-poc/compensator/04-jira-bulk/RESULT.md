# POC 04 — Jira bulk fields edit (P5 async partial success)

## Result: PASS

- 300 keys submitted; server-side split 200 success / 100 fail.
- Revert correctly only touched the 200 successful keys, leaving the 100 untouched keys untouched.
- `recordMs` = 75 ms (300 sequential-chunked GETs at 20 parallel). Real Jira would require similar — no bulk-GET for arbitrary keys.

## Partial-revert state machine (mermaid)

```
                 +---------------+
                 |  ENQUEUED     |
                 +-------+-------+
                         |
                         v
                 +-------+-------+
                 |   RUNNING     |<---+
                 +-------+-------+    | (poll)
                         |            |
                         v            |
                 +-------+-------+----+
                 |   COMPLETE    |
                 +-------+-------+
                         |
         +---------------+---------------+
         |                               |
         v                               v
+--------+--------+             +--------+--------+
| ALL_SUCCESS     |             | PARTIAL_SUCCESS |
| revert plan =   |             | revert plan =   |
|   all keys      |             |   only          |
|                 |             |   .successful   |
+-----------------+             +-----------------+
```

## Findings

1. **Before-image must be captured BEFORE submission** — because once the task starts running, GETs return a mix of "already updated" and "not yet updated" rows. We snapshot all keys up front.
2. **Only `task.result.successful` should be reverted** — the server is authoritative about what actually changed. Our before-image covers ALL submitted keys, but we filter to what the server confirmed it touched.
3. **Task abandonment** — if poll times out (task never reaches COMPLETE), we can't safely revert because we don't know the final split. Strategy must be: wait with ~infinite patience, or treat unknown-state as "manual intervention required" and surface to operator.
4. **Bulk-revert efficiency**: successes are grouped by their original priority, so the revert fires ~k bulk calls (k = distinct original priority values) rather than 200 single-issue calls.

## Gaps

- If the same bulk edit touches multiple fields simultaneously (priority + assignee + labels), our before-image must capture all those fields — currently only priority is implemented.
- Webhooks / notifications fired by the forward update cannot be un-fired. Slack "Priority changed" notifications would be sent twice (forward + revert).
