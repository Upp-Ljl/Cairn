# POC 05 — Stripe subscriptions.create (P5 async + side effects)

## Result: PASS for financial state; WEBHOOKS NOT REVERSIBLE

- Customer balance: 0 → 2000 (after sub+invoice) → 0 (after refund+cancel). Verified.
- Subscription status: incomplete → active → canceled.
- `recordMs` = 9ms (only customer snapshot, no full subscription state to record because it didn't exist).
- Forward poll took ~90ms to see `latest_invoice` appear (3 poll cycles @ 30ms).

## Compensator asymmetry

The forward action is a CREATE. The compensator is **not** a single reverse call — it's a **plan** of two calls:

1. `POST /v1/refunds {charge}` — refunds the auto-created invoice charge
2. `DELETE /v1/subscriptions/:id` — cancels the subscription

Neither alone is sufficient. If we only cancel, the customer is still charged. If we only refund, the subscription stays active.

## Webhook leakage (KEY FINDING)

events.log confirms **4 webhooks** were delivered during this test:

```
invoice.paid            <-- forward (CANNOT UN-SEND)
customer.subscription.created  <-- forward (CANNOT UN-SEND)
charge.refunded         <-- revert (new event, downstream may see as fresh activity)
customer.subscription.deleted  <-- revert
```

**Implication**: any downstream that reacted to the forward webhooks (sent welcome email, provisioned seat, rang sales' bell in Slack) has already reacted. Revert cannot reach those side effects. Cairn must surface this as an irreversible side-effect marker in the classifier output, not hide it behind a "success" revert.

## Dependencies on poll

If the lane-writer fails or is killed before the post-create poll sees `latest_invoice`, the recorded lane is missing `chargeId`. Revert would then cancel the sub but leave the customer charged. Mitigation: poll must block-until-invoice or be repeatable offline via a `complete-lane.js` catch-up pass.

## Gaps

- Prorations, trial periods, and multiple invoice items not modeled.
- Idempotency: if revert is run twice, second `POST /v1/refunds` returns 400 (`already refunded`). Revert should tolerate this.
