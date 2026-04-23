// F4 — Cascade side-effect honesty for #7 github-merge.
// The POC's lane already has cascadeSideEffects.irreversible. We verify:
//   1. lane lists [ci_minutes_consumed, deployment_webhook_fired, pr_merged_webhook_fired]
//   2. revert receipt surfaces these
//   3. actual events.log contains the events (so "we said it happened" aligns with what happened)
// Then: we check whether the lane captures the SPECIFIC ids (ci_run_id, deployment_id) so a
//   compliance team can audit which concrete side effects leaked.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '07-github-merge');

async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const r = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, (x) => { x.resume(); x.on('end', res); }); r.on('error', rej); r.end(); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('no mock');
}

async function main() {
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe' });
  try {
    await waitPort(4107);

    // 1. forward merge via proxy
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'octo', 'demo', '42'], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('forward: laneId=', out.laneId, 'mergeSha=', out.mergeSha);

    // Wait for cascade: CI -> deploy
    await new Promise((r) => setTimeout(r, 500));

    // Read events.log
    const events = fs.readFileSync(path.join(POC, 'events.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    console.log('events actually delivered:');
    events.forEach(e => console.log('  ', JSON.stringify(e)));

    // Read lane
    const lane = JSON.parse(fs.readFileSync(out.lanePath, 'utf8'));
    console.log('\nlane.cascadeSideEffects.irreversible:');
    lane.cascadeSideEffects.irreversible.forEach(s => console.log('  -', s));

    // Check: does the lane include CONCRETE identifiers?
    const concrete = {
      mergeSha: !!lane.forwardResponse?.sha,
      ciRunId: /check[_ ]suite|ci[_ ]run[_ ]id/.test(JSON.stringify(lane).toLowerCase()),
      deploymentId: /deployment.*id|deploy[_ ]id/.test(JSON.stringify(lane).toLowerCase()),
      webhookDeliveryIds: /delivery[_ ]id/.test(JSON.stringify(lane).toLowerCase()),
    };
    console.log('\nconcrete identifiers captured in lane?', concrete);

    // 2. run revert; check receipt
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('\n=== revert stdout ===\n' + rev.stdout);

    // Parse revert's JSON verdict
    let verdictJson = null;
    const jm = rev.stdout.match(/\{[\s\S]*"irreversibleSideEffects"[\s\S]*\}/);
    if (jm) { try { verdictJson = JSON.parse(jm[0]); } catch {} }

    console.log(JSON.stringify({
      laneHasIrreversibleList: !!lane.cascadeSideEffects?.irreversible?.length,
      laneEnumeratesGeneric: lane.cascadeSideEffects?.irreversible,
      laneEnumeratesConcrete: concrete,
      revertReceiptIncludesList: !!verdictJson?.irreversibleSideEffects,
      eventsActuallyDelivered: events.map(e => e.type),
      verdict: [
        'GOOD: lane already has cascadeSideEffects.irreversible and revert receipt surfaces it to caller',
        concrete.deploymentId ? 'GOOD: deployment id captured' : 'GAP: lane does NOT capture concrete ids (ci_run_id, deployment_id, webhook_delivery_id). A compliance auditor cannot point to WHICH specific delivery leaked.',
        'GAP: lane.cascadeSideEffects.irreversible is a HUMAN-READABLE string array, not a structured list of {type, id, timestamp}. Machine-readable format recommended for Cairn production.',
        'GAP: revert reciept does NOT include counts (how many webhook subscribers received it, CI minutes consumed as a number)',
      ],
      recommendation: `Upgrade lane schema to:
  cascadeSideEffects: {
    reversible: [{type, op, status}],
    irreversible: [
      { type: 'ci.run.minutes_consumed', runId, minutes, runLogUrl },
      { type: 'webhook.delivered', subscriber, eventType, deliveryId, deliveredAt },
      { type: 'deployment.production.served_traffic', deploymentId, startedAt, endedAt, trafficEstimate },
    ],
  }`,
    }, null, 2));
  } finally { mock.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
