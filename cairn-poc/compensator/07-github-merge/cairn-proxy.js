// GitHub PR merge proxy. Acknowledges this is a CASCADE trigger — we can only record intent and
// plan a forward-only "revert commit" + redeploy. We cannot un-run CI, cannot un-deploy bytes.
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4107';
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
  const [owner, repo, num] = process.argv.slice(2);
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // record: current main branch tip + list of recent deployments
  const t0 = Date.now();
  const branch = await httpReq('GET', `${UPSTREAM}/repos/${owner}/${repo}/branches/main`);
  const deps = await httpReq('GET', `${UPSTREAM}/repos/${owner}/${repo}/deployments`);
  const recordMs = Date.now() - t0;

  // forward: merge
  const merge = await httpReq('PUT', `${UPSTREAM}/repos/${owner}/${repo}/pulls/${num}/merge`, {});

  const lane = {
    laneId,
    endpoint: 'github.pull.merge',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    beforeImage: {
      mainTip: branch.body.commit,
      deployments: deps.body,
    },
    forwardRequest: { owner, repo, num },
    forwardResponse: merge.body,
    cascadeSideEffects: {
      reversible: [
        'revert commit on main (adds to history, does not rewrite)',
        'trigger new CI + redeploy previous artifact',
      ],
      irreversible: [
        'CI minutes already consumed',
        'production served responses from the merged artifact during the window',
        'webhook pull_request.merged already delivered to Slack/PagerDuty/external subscribers',
        'check_suite.completed webhook already delivered',
      ],
    },
    compensator: {
      method: 'POST',
      url: `${UPSTREAM}/repos/${owner}/${repo}/pulls`,
      body: { title: `Revert merge of PR #${num}`, revert_of_sha: merge.body.sha, auto_merge: true },
      note: 'forward-only revert — appends a revert commit, does NOT rewrite history or undo deploy bytes',
    },
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, mergeSha: merge.body.sha }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
