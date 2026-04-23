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
  const c = lane.compensator;
  const r = await httpReq(c.method, c.url, c.body);
  console.log(`[revert] revert PR -> status=${r.status} number=${r.body.number} sha=${r.body.merge_commit_sha}`);
  console.log(JSON.stringify({
    revertOk: r.status === 201,
    verdict: 'FORWARD-ONLY REVERT: history now contains [merge, revert]. Deploy will redeploy the pre-merge tree. Previous side-effects (CI, webhooks, served traffic) are irreversible.',
    irreversibleSideEffects: lane.cascadeSideEffects.irreversible,
  }, null, 2));
  process.exit(r.status === 201 ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
