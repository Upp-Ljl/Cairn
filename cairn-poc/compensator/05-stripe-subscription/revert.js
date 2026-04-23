const http = require('http');
const fs = require('fs');
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
  const lane = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(`[revert] lane=${lane.laneId}`);
  for (const step of lane.compensator.steps) {
    if (step.op === 'refund') {
      const r = await httpReq('POST', step.url, step.body);
      console.log(`[revert] refund -> ${r.status}`);
    } else if (step.op === 'cancelSubscription') {
      const r = await httpReq('DELETE', step.url);
      console.log(`[revert] cancel sub -> ${r.status} status=${r.body.status}`);
    }
  }
  // verify: customer balance back to before; subscription status = canceled
  const cust = await httpReq('GET', `${lane.compensator.upstream}/v1/customers/${lane.forwardRequest.customer}`);
  const sub = await httpReq('GET', `${lane.compensator.upstream}/v1/subscriptions/${lane.asyncArtifacts.subscriptionId}`);
  const balOk = cust.body.balance === lane.customerBalanceBefore;
  const subOk = sub.body.status === 'canceled';
  console.log(JSON.stringify({ balanceOk: balOk, subStatusOk: subOk, want: lane.customerBalanceBefore, got: cust.body.balance, subStatus: sub.body.status, warnings: lane.compensator.warnings }, null, 2));
  process.exit(balOk && subOk ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
