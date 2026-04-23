# POC 08 — Vercel production deploy (Cascade)

## Result: ALIAS-FLIP REVERT PASS; SIDE-EFFECTS IRREVERSIBLE

- Forward flips production alias to v2. Revert promotes the previously-saved v1 deployment id, alias returns to v1.
- `recordMs` = 8 ms.

## What CAN be reverted

- **Production alias pointer** — swinging back is cheap and fast (~100-300ms at real Vercel).

## What CANNOT be reverted

- **The window of traffic** served by v2. Any POST / PATCH / side-effecting request handled by v2 is a fact.
- **Edge cache warming** — v2 artifact is in CDN edge caches worldwide; TTLs must expire (Vercel does issue invalidation but it is eventual).
- **`deployment.ready` and `alias.changed` webhooks** — delivered to subscribers (Slack, monitoring, on-call).
- **DNS propagation** — if the deploy involved custom domain config (not modeled here but real), DNS TTL > alias change.

## Cold-project caveat

If there is no previous production alias (brand-new project's first prod deploy), the compensator has **no rollback target**. The plan becomes "delete the deployment", which takes the site offline — usually worse than leaving the bad deploy.

The code explicitly detects this case and sets `compensator.method: null` with a human-readable note.

## Classifier implication

Same as POC 07: production deploys should be `② guarded`, not `③ reversible`, unless the caller accepts the finite blast-radius window.

## Events

9 events total (4 v1 seed + 4 v2 forward + 1 promote). All 8 forward/seed events are durable in downstream consumers.
