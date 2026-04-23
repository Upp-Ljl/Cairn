// Mock Vercel Deployments API.
// POST /v13/deployments {name, target:'production', gitSource:{...}} -> {id, url, readyState:'QUEUED'}
//   transitions: QUEUED -> BUILDING -> READY. On READY: if target=production, production alias re-points.
// GET /v13/deployments/:id -> current state
// GET /v1/projects/:name -> {productionAlias: {deploymentId, sha}}
// POST /v13/deployments/:id/promote -> promote existing previous deployment to production (rollback path)
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS_LOG = path.join(__dirname, 'events.log');
try { fs.unlinkSync(EVENTS_LOG); } catch {}

const deployments = {}; // id -> deployment
const projects = {
  myapp: {
    name: 'myapp',
    productionAlias: null, // {deploymentId, url, sha}
    productionHistory: [], // list of past production deployments
  },
};

function logEvent(ev) { fs.appendFileSync(EVENTS_LOG, JSON.stringify(ev) + '\n'); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

function advanceState(depId) {
  const d = deployments[depId];
  if (!d) return;
  setTimeout(() => {
    d.readyState = 'BUILDING';
    logEvent({ type: 'deployment.building', id: depId });
    setTimeout(() => {
      d.readyState = 'READY';
      logEvent({ type: 'deployment.ready', id: depId });
      if (d.target === 'production') {
        const proj = projects[d.projectName];
        if (proj.productionAlias) proj.productionHistory.push({ ...proj.productionAlias, replacedAt: new Date().toISOString() });
        proj.productionAlias = { deploymentId: depId, url: d.url, sha: d.sha };
        logEvent({ type: 'alias.changed', project: d.projectName, newDeployment: depId });
      }
    }, 40);
  }, 20);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (u.pathname === '/v13/deployments' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { name, target, gitSource } = JSON.parse(body);
      const id = 'dpl_' + crypto.randomBytes(4).toString('hex');
      const sha = gitSource?.sha || crypto.randomBytes(6).toString('hex');
      deployments[id] = { id, projectName: name, target, sha, url: `${name}-${id.slice(-6)}.vercel.app`, readyState: 'QUEUED', created_at: new Date().toISOString() };
      logEvent({ type: 'deployment.queued', id, target });
      advanceState(id);
      json(res, 200, deployments[id]);
    });
    return;
  }
  const gd = u.pathname.match(/^\/v13\/deployments\/([^/]+)$/);
  if (gd && req.method === 'GET') {
    const d = deployments[gd[1]];
    if (!d) return json(res, 404, {});
    return json(res, 200, d);
  }
  const promote = u.pathname.match(/^\/v13\/deployments\/([^/]+)\/promote$/);
  if (promote && req.method === 'POST') {
    const d = deployments[promote[1]];
    if (!d) return json(res, 404, {});
    const proj = projects[d.projectName];
    if (proj.productionAlias) proj.productionHistory.push({ ...proj.productionAlias, replacedAt: new Date().toISOString() });
    proj.productionAlias = { deploymentId: d.id, url: d.url, sha: d.sha };
    logEvent({ type: 'alias.promoted', project: d.projectName, newDeployment: d.id });
    return json(res, 200, proj);
  }
  const gp = u.pathname.match(/^\/v1\/projects\/([^/]+)$/);
  if (gp && req.method === 'GET') {
    const p = projects[gp[1]];
    if (!p) return json(res, 404, {});
    return json(res, 200, p);
  }
  json(res, 404, { message: 'not found' });
});
const PORT = process.env.PORT || 4108;
server.listen(PORT, () => console.log(`[mock-vercel] listening on ${PORT}`));
