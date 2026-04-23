# POC 01 — GitHub Issue PATCH (P4)

## Result: PASS

- End-to-end run: `bash test.sh`
- Forward PATCH changed `title`, `state`, `labels`. After revert all 3 fields match before-image.

## Latency

- `recordMs` (extra GET before PATCH): **27 ms** (single run, mock had 8-20ms injected latency)
- p50 over 10 cold runs later measured in SUMMARY

## Field coverage gap

GitHub issues PATCH accepts: `title, state, state_reason, body, labels, assignees, milestone`.
GET returns all of these — **no gap** for issues. Milestone only tested via string id (not verified here).

## Edge cases NOT covered

- Race: if another actor PATCHed between our GET and our PATCH, our revert overwrites their change (lost update). Real fix needs If-Match / updated_at guard.
- Comments, reactions are separate endpoints — out of scope.
