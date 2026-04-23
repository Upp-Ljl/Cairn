// Vercel production deploy proxy.
// record: GET current production alias (previous deployment id). This is the rollback target.
// forward: POST deployment (target=production). Wait until READY + alias flipped.
// compensator: POST promote on the PREVIOUS deployment — this swings the alias back.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4108';
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
  const [project, sha] = process.argv.slice(2);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // record: current production alias
  const t0 = Date.now();
  const proj = await httpReq('GET', `${UPSTREAM}/v1/projects/${project}`);
  const recordMs = Date.now() - t0;
  const prevAlias = proj.body.productionAlias;

  // forward: create new prod deployment
  const created = await httpReq('POST', `${UPSTREAM}/v13/deployments`, { name: project, target: 'production', gitSource: { sha } });
  const depId = created.body.id;

  // poll until READY
  let dep;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 30));
    const g = await httpReq('GET', `${UPSTREAM}/v13/deployments/${depId}`);
    dep = g.body;
    if (dep.readyState === 'READY') break;
  }
  // confirm alias changed
  const post = await httpReq('GET', `${UPSTREAM}/v1/projects/${project}`);

  const lane = {
    laneId,
    endpoint: 'vercel.deployments.create.production',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    previousProductionAlias: prevAlias,
    forwardRequest: { project, sha },
    forwardResponse: { deploymentId: depId, currentProductionAlias: post.body.productionAlias },
    cascadeSideEffects: {
      reversible: ['alias flip (swing back by promoting previous deploymentId)'],
      irreversible: [
        'production traffic served by new deployment during the window',
        'edge cache populated with new artifact (TTL-bounded, not instantly invalidated)',
        'deployment.ready and alias.changed webhooks delivered',
        'any runtime side-effects from requests (DB writes, emails, analytics)',
      ],
    },
    compensator: prevAlias
      ? { method: 'POST', url: `${UPSTREAM}/v13/deployments/${prevAlias.deploymentId}/promote`, note: 'promote previous production deployment — swings alias back' }
      : { method: null, note: 'no previous production alias (cold project) — cannot rollback to prior state; only option is delete this deployment' },
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, newDeployment: depId, newAlias: post.body.productionAlias?.deploymentId, prevAliasId: prevAlias?.deploymentId }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
