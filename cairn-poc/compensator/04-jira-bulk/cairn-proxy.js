// Jira bulk proxy.
// record = GET each selected issue's current priority (in parallel chunks) BEFORE the bulk call
// forward = POST bulk; poll until COMPLETE; capture result.successful + failed
// compensator = for each key in successful, plan a PUT-equivalent (here: POST /rest/api/3/issue/:key via small-scale
//   single-issue revert; since mock doesn't expose it, we reuse the same bulk endpoint with a per-success priority)
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:4104';
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
  const [keysArg, newPriority] = process.argv.slice(2);
  const keys = keysArg.split(',');
  const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // STEP 1: record — parallel fetch of each issue's priority
  const t0 = Date.now();
  const beforeMap = {};
  const CHUNK = 20;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const res = await Promise.all(chunk.map((k) => httpReq('GET', `${UPSTREAM}/rest/api/3/issue/${k}`)));
    chunk.forEach((k, idx) => { beforeMap[k] = res[idx].body?.fields?.priority?.name; });
  }
  const recordMs = Date.now() - t0;

  // STEP 2: forward — submit bulk + poll
  const submit = await httpReq('POST', `${UPSTREAM}/rest/api/3/bulk/issues/fields`, {
    selectedIssueIdsOrKeys: keys,
    editedFieldsInput: { priority: { priority: { name: newPriority } } },
  });
  const taskId = submit.body.taskId;
  let task;
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((r) => setTimeout(r, 80));
    const q = await httpReq('GET', `${UPSTREAM}/rest/api/3/bulk/queue/${taskId}`);
    task = q.body;
    if (task.status === 'COMPLETE') break;
  }

  // STEP 3: compensator — per-success revert with before-image priority
  // Partial success: only revert keys in task.result.successful; failed keys never changed, so skip.
  const opsPerKey = task.result.successful.map((s) => ({ key: s.key, revertTo: beforeMap[s.key] }));
  const lane = {
    laneId,
    endpoint: 'jira.bulk.fields',
    createdAt: new Date().toISOString(),
    recordLatencyMs: recordMs,
    forwardRequest: { keys, newPriority },
    taskId,
    taskFinalStatus: task.status,
    successfulCount: task.result.successful.length,
    failedCount: task.result.failed.length,
    compensator: {
      upstream: UPSTREAM,
      perKey: opsPerKey,
      strategy: 'group successes by revert-target priority then bulk-revert each group',
    },
    beforeImage: beforeMap,
  };
  const lanePath = path.join(LANES_DIR, `${laneId}.json`);
  fs.writeFileSync(lanePath, JSON.stringify(lane, null, 2));
  console.log(JSON.stringify({ laneId, lanePath, recordMs, taskId, successful: task.result.successful.length, failed: task.result.failed.length }, null, 2));
}
run().catch((e) => { console.error(e); process.exit(1); });
