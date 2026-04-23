// Mock GitHub PR merge + downstream CI + deploy.
// PUT /repos/:owner/:repo/pulls/:n/merge -> merges PR, triggers CI check_suite (running->success ~80ms), which triggers deploy.
// POST /repos/:owner/:repo/deployments from CI -> creates deployment (production).
// GET endpoints for status.
// Endpoints available for revert:
//   - POST /repos/:owner/:repo/pulls -> open new PR (revert PR)
//   - POST /repos/:owner/:repo/git/commits -> write revert commit
// Side effects that CANNOT be undone:
//   - CI run (already consumed CI minutes)
//   - deploy (production traffic hit that artifact; rollback != undo)
//   - webhooks delivered to Slack, PagerDuty, etc.
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTS_LOG = path.join(__dirname, 'events.log');
try { fs.unlinkSync(EVENTS_LOG); } catch {}

const prs = { 'octo/demo/42': { number: 42, state: 'open', head: { sha: 'sha-feature' }, base: { ref: 'main' }, merged: false } };
const commits = { main: [{ sha: 'sha-base-0', message: 'initial' }] };
const checkSuites = {}; // sha -> {id, status, conclusion}
const deployments = {}; // id -> {id, sha, environment, state}
const revertPRs = {};

function logEvent(ev) { fs.appendFileSync(EVENTS_LOG, JSON.stringify(ev) + '\n'); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

function triggerCI(sha) {
  const csId = crypto.randomBytes(4).toString('hex');
  checkSuites[sha] = { id: csId, head_sha: sha, status: 'queued', conclusion: null };
  logEvent({ type: 'check_suite.requested', sha, id: csId });
  setTimeout(() => {
    checkSuites[sha].status = 'in_progress';
    logEvent({ type: 'check_suite.in_progress', sha, id: csId });
    setTimeout(() => {
      checkSuites[sha].status = 'completed';
      checkSuites[sha].conclusion = 'success';
      logEvent({ type: 'check_suite.completed', sha, id: csId, conclusion: 'success' });
      // trigger deploy because on-success policy
      const depId = crypto.randomBytes(4).toString('hex');
      deployments[depId] = { id: depId, sha, environment: 'production', state: 'in_progress', created_at: new Date().toISOString() };
      logEvent({ type: 'deployment.created', id: depId, sha });
      setTimeout(() => {
        deployments[depId].state = 'success';
        logEvent({ type: 'deployment.success', id: depId, sha });
      }, 60);
    }, 40);
  }, 20);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const merge = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
  if (merge && req.method === 'PUT') {
    const key = `${merge[1]}/${merge[2]}/${merge[3]}`;
    const pr = prs[key];
    if (!pr) return json(res, 404, { message: 'no pr' });
    // new merge commit
    const sha = 'sha-merge-' + crypto.randomBytes(3).toString('hex');
    commits.main.push({ sha, message: `Merge PR #${pr.number}`, prevHead: commits.main[commits.main.length - 1].sha });
    pr.merged = true;
    pr.state = 'closed';
    pr.merge_commit_sha = sha;
    logEvent({ type: 'pull_request.merged', number: pr.number, sha });
    triggerCI(sha);
    return json(res, 200, { sha, merged: true });
  }
  const csGet = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-suites$/);
  if (csGet && req.method === 'GET') {
    const sha = csGet[3];
    return json(res, 200, { check_suites: checkSuites[sha] ? [checkSuites[sha]] : [] });
  }
  if (u.pathname.match(/\/deployments$/) && req.method === 'GET') {
    return json(res, 200, Object.values(deployments));
  }
  const depGet = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/deployments\/([^/]+)$/);
  if (depGet && req.method === 'GET') {
    const d = deployments[depGet[1]];
    if (!d) return json(res, 404, {});
    return json(res, 200, d);
  }
  const branchGet = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/branches\/main$/);
  if (branchGet && req.method === 'GET') {
    return json(res, 200, { name: 'main', commit: commits.main[commits.main.length - 1] });
  }
  // Create a revert PR (compensator uses this path)
  const prCreate = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (prCreate && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const bodyObj = JSON.parse(body);
      const n = 100 + Object.keys(revertPRs).length;
      // revert PR adds a new commit on top that restores the tree
      const sha = 'sha-revert-' + crypto.randomBytes(3).toString('hex');
      commits.main.push({ sha, message: `Revert of ${bodyObj.revert_of_sha}`, prevHead: commits.main[commits.main.length - 1].sha });
      revertPRs[n] = { number: n, state: 'closed', merged: true, merge_commit_sha: sha, reverts: bodyObj.revert_of_sha };
      logEvent({ type: 'revert_pr.merged', number: n, sha, reverts: bodyObj.revert_of_sha });
      triggerCI(sha);
      json(res, 201, { number: n, merge_commit_sha: sha });
    });
    return;
  }
  json(res, 404, { message: 'not found' });
});
const PORT = process.env.PORT || 4107;
server.listen(PORT, () => console.log(`[mock-gh-merge] listening on ${PORT}`));
