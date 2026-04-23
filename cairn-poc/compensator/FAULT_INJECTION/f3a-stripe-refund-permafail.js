// F3a — Stripe multi-step compensator: refund -> cancelSubscription.
// We inject a scenario where refund permanently fails (charge_already_refunded).
// Expected SAFE behavior:
//   - step 1 (refund) fails -> lane moves to partial_undo { completedSteps:[], failedStep:'refund' }
//   - step 2 (cancelSub) still runs (because cancel is independent of refund)
//   - OR: user-decided policy: halt on first failure
//   - final state visible to user: subscription=canceled, charge NOT refunded, balance still includes the charge
// The POC revert.js doesn't have a state machine — it just loops steps and exits on verify mismatch.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '05-stripe-subscription');

function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': b.length } : {}) },
    }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks).toString(); let p = null; try { p = buf ? JSON.parse(buf) : null; } catch { p = buf; } resolve({ status: res.statusCode, body: p }); }); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const r = http.request({ hostname: '127.0.0.1', port, path: '/v1/customers/cus_A', method: 'GET' }, (x) => { x.resume(); x.on('end', res); }); r.on('error', rej); r.end(); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('no mock');
}

async function main() {
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4105);

    // 1. forward create subscription
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'cus_A', 'price_1'], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('forward: subId=', out.subId, 'chargeId=', out.chargeId);

    // 2. PRE-refund the charge out-of-band so that the compensator's refund step will 400.
    const preRefund = await httpReq('POST', 'http://127.0.0.1:4105/v1/refunds', { charge: out.chargeId });
    console.log('pre-refund (to cause compensator fail): status=', preRefund.status, 'body=', preRefund.body);

    // customer balance after pre-refund -> 0 (mock decrements)
    const custMid = await httpReq('GET', 'http://127.0.0.1:4105/v1/customers/cus_A');
    console.log('customer balance after pre-refund (should be 0):', custMid.body.balance);

    // 3. run the POC revert — it will try refund again -> 400 already refunded, then cancelSub.
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('\n=== revert stdout ===\n' + rev.stdout);
    console.log('revert exit:', rev.status);

    // 4. audit
    const sub = await httpReq('GET', `http://127.0.0.1:4105/v1/subscriptions/${out.subId}`);
    const cust = await httpReq('GET', 'http://127.0.0.1:4105/v1/customers/cus_A');
    const events = fs.readFileSync(path.join(POC, 'events.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    console.log('final sub.status=', sub.body.status);
    console.log('final cust.balance=', cust.body.balance);
    console.log('events delivered during whole session:');
    events.forEach(e => console.log('  ', e));

    // Read lane file; does it reflect partial_undo or is it unchanged?
    const lane = JSON.parse(fs.readFileSync(out.lanePath, 'utf8'));
    console.log('\nlane.state ?', lane.state, '(undefined = POC doesn\'t track compensator state)');
    console.log('lane has partial_undo/failedStep?', !!lane.failedStep || !!lane.partialUndo);

    const subCanceled = sub.body.status === 'canceled';
    const balanceRestored = cust.body.balance === 0;

    console.log(JSON.stringify({
      revertExit: rev.status,
      finalSubCanceled: subCanceled,
      finalBalanceAtZero: balanceRestored,
      lane_hasPartialUndoState: false,
      verdict: [
        rev.status === 0 ? 'revert.js reported success (exit=0)' : `revert.js exit=${rev.status}`,
        'step 1 (refund) returned 400 — revert.js console.logged it but proceeded with step 2 — no halt, no retry, no lane state update',
        'step 2 (cancelSub) succeeded — sub is canceled',
        'final balance IS zero BUT only because out-of-band pre-refund happened; had we NOT pre-refunded and refund just 500\'d, balance would be left at 2000 (charged but not refunded) AND revert would still exit 0 as long as verify happened to match',
      ],
      bugs: [
        'no compensator state machine — steps are a JS for-loop; failure != lane state',
        'no partial_undo terminal state — lane is still "active" from Cairn\'s view',
        'no retry / no idempotency guard on the refund step — if refund was retriable, we can\'t tell',
        'no manual_gate escalation — in a real multi-step revert the human must intervene',
      ],
    }, null, 2));
  } finally { mock.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
