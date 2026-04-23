# POC 07 — GitHub PR merge (Cascade)

## Result: FORWARD-ONLY REVERT (partial)

- Revert PR created; history now contains `[merge, revert]`. A second CI cascade runs, a new deploy ships the pre-merge tree.
- `recordMs` = 13 ms.

## What the compensator CAN do

- **Append a revert commit to `main`** (forward-only — does not rewrite history).
- **Trigger a redeploy** of the pre-merge artifact via the natural "merge to main -> deploy" automation.

## What the compensator CANNOT do

1. **Un-run CI** — GitHub Actions / GHA minutes already consumed. If CI failed and left partial artifacts (Docker images in GHCR, test reports in S3), those remain.
2. **Un-deploy served traffic** — during the window between `deployment.success` and our revert deploy's `deployment.success`, real user requests hit the merged code. Any side effects those requests caused (DB writes, emails, analytics events) are outside our revert scope.
3. **Un-send webhooks** — Slack, PagerDuty, Datadog, Linear, custom subscribers have all received `pull_request.merged`, `check_suite.completed`, `deployment.success` for the bad SHA. Our revert sends new webhooks (for the revert PR + its own CI + its own deploy) but the originals are durable.
4. **Un-tag releases** — if the merge triggered `git tag v1.2.3` via CI, that tag exists and is visible to anyone polling the releases API.
5. **Re-attract fetches** — downstream repos/CI systems that polled between merge and revert have cached the bad SHA.

## Verdict

**Classifier implication**: PR-merge-to-production should be gated to `② guarded` at best, not `③ reversible`. The window between merge and revert is the blast radius, and it cannot be shrunk to zero.

## Events log confirms

12 events generated across forward+revert:
- Forward: 6 (merged + 3 CI + 2 deploy)
- Revert: 6 (same shape, new SHA)

Downstream webhook consumers see all 12. Only idempotent / diff-based consumers are safe.
