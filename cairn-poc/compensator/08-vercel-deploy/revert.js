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
  if (!lane.compensator.method) {
    console.log(JSON.stringify({ revertOk: false, reason: lane.compensator.note }));
    process.exit(3);
  }
  const r = await httpReq(lane.compensator.method, lane.compensator.url);
  console.log(`[revert] promote previous -> status=${r.status}`);
  const now = await httpReq('GET', `${new URL(lane.compensator.url).origin}/v1/projects/${lane.forwardRequest.project}`);
  const ok = now.body.productionAlias.deploymentId === lane.previousProductionAlias.deploymentId;
  console.log(JSON.stringify({
    revertOk: ok,
    wantAliasId: lane.previousProductionAlias.deploymentId,
    gotAliasId: now.body.productionAlias.deploymentId,
    irreversibleSideEffects: lane.cascadeSideEffects.irreversible,
  }, null, 2));
  process.exit(ok ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
