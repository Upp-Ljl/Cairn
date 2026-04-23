// Revert Jira bulk: group the successful keys by their original priority, fire one bulk PATCH per group, poll, verify.
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
  console.log(`[revert] lane=${lane.laneId} successful=${lane.successfulCount}`);
  const groups = new Map();
  for (const { key, revertTo } of lane.compensator.perKey) {
    if (!groups.has(revertTo)) groups.set(revertTo, []);
    groups.get(revertTo).push(key);
  }
  const up = lane.compensator.upstream;
  for (const [prio, keys] of groups) {
    const submit = await httpReq('POST', `${up}/rest/api/3/bulk/issues/fields`, {
      selectedIssueIdsOrKeys: keys,
      editedFieldsInput: { priority: { priority: { name: prio } } },
    });
    const tid = submit.body.taskId;
    let t;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 80)); const q = await httpReq('GET', `${up}/rest/api/3/bulk/queue/${tid}`); t = q.body; if (t.status === 'COMPLETE') break; }
    console.log(`[revert] group ${prio}: ${keys.length} keys -> successful=${t.result.successful.length} failed=${t.result.failed.length}`);
  }
  // verify sample
  const sampleKeys = lane.compensator.perKey.slice(0, 5).map((o) => o.key);
  const samples = await Promise.all(sampleKeys.map((k) => httpReq('GET', `${up}/rest/api/3/issue/${k}`)));
  const checks = sampleKeys.map((k, i) => ({ k, want: lane.beforeImage[k], got: samples[i].body.fields.priority.name, ok: samples[i].body.fields.priority.name === lane.beforeImage[k] }));
  const ok = checks.every((c) => c.ok);
  console.log(JSON.stringify({ revertOk: ok, sampleChecks: checks }, null, 2));
  process.exit(ok ? 0 : 3);
}
run().catch((e) => { console.error(e); process.exit(1); });
