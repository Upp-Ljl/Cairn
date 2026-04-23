// Cairn proxy for Stripe subscriptions — this is an asymmetric compensator (CREATE is not reversible by "re-PATCH").
// record: nothing from before-image (resource did not exist). Snapshot the request + cust balance.
// forward: POST the subscription.
// compensator plan: DELETE subscription + (after invoice finalizes) POST refund for the charge.
//   Because the invoice/charge are CREATED async, we must poll the sub until it has a latest_invoice
//   captured before we can write a complete compensator.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4105';
const LANES_DIR = path.join(__dirname, 'lanes');
fs.mkdirSync(LANES_DIR, { recursive: true });

function httpReq(method, u, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } },
      (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  const [customer, price] = process.argv.slice(2);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // STEP 1: record — snapshot customer balance (side-effect surface we can verify)
  const t0 = Date.now();
  const custBefore = await httpReq('GET', `${UPSTREAM}/v1/customers/${customer}`);
  const recordMs = Date.now() - t0;

  // STEP 2: forward
  const created = await httpReq('POST', `${UPSTREAM}/v1/subscriptions`, { customer, items: [{ price }] });
  const subId = created.body.id;

  // Poll until sub has latest_invoice (= invoice.paid has fired)
  let sub = created.body;
  let pollTries = 0;
  while (!sub.latest_invoice && pollTries < 30) {
    await new Promise((r) => setTimeout(r, 30));
    const g = await httpReq('GET', `${UPSTREAM}/v1/subscriptions/${subId}`);
    sub = g.body;
    pollTries++;
  }
  // fetch invoice -> get charge id
  const inv = sub.latest_invoice ? await httpReq('GET', `${UPSTREAM}/v1/invoices/${sub.latest_invoice}`) : null;
  const chargeId = inv?.body?.charge;

  // STEP 3: write lane
  const lane = {
    laneId,
    endpoint: 'stripe.subscriptions.create',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    forwardRequest: { customer, price },
    forwardResponse: created.body,
    asyncArtifacts: { subscriptionId: subId, invoiceId: sub.latest_invoice, chargeId },
    customerBalanceBefore: custBefore.body.balance,
    compensator: {
      upstream: UPSTREAM,
      steps: [
        chargeId ? { op: 'refund', url: `${UPSTREAM}/v1/refunds`, body: { charge: chargeId } } : null,
        { op: 'cancelSubscription', url: `${UPSTREAM}/v1/subscriptions/${subId}` },
      ].filter(Boolean),
      warnings: [
        'invoice.paid webhook was ALREADY delivered to downstream consumers — cannot be un-sent',
        'customer.subscription.created webhook ALREADY delivered',
        'charge.refunded + customer.subscription.deleted will be delivered on revert — downstream must be idempotent',
      ],
    },
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, subId, chargeId, pollTries }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
