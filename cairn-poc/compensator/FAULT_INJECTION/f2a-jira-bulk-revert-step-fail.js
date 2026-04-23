// F2a — Jira bulk revert with injected mid-revert 500.
// Approach: copy the mock-server to a patched version on port 4204 that returns 500
// for POST requests whose body contains the priority name "Medium" (the 2nd revert group).
// Then rewrite lane.compensator.upstream to point at 4204 and run revert.js.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '04-jira-bulk');

function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {}) },
    }, (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { const r = await httpReq('GET', `http://127.0.0.1:${port}/rest/api/3/issue/PROJ-1`); if (r.status === 200) return; }
    catch { await new Promise((r) => setTimeout(r, 80)); }
  }
  throw new Error('no mock');
}

async function main() {
  // Launch the original mock on default port 4104 (for the forward call to succeed)
  const mock = spawn('node', [path.join(POC, 'mock-server.js')], { stdio: 'pipe', env: { ...process.env, PORT: '4104' } });
  await waitPort(4104);

  // Also launch a "faulty" mock on 4204 that is seeded with the POST-forward state (all issues = 'High').
  // Easiest: launch a fresh POC mock on 4204 that mirrors current state manually.
  const faultyCode = `
const http = require('http');
const url = require('url');
const issues = {};
for (let i=1; i<=300; i++) issues['PROJ-'+i] = { key: 'PROJ-'+i, fields: { priority: { name: i <= 200 ? 'High' : 'Medium' } } };
const tasks = {};
let taskCounter = 0;
function json(res, code, obj) { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function runTask(tid) {
  const t = tasks[tid]; t.status='RUNNING'; let i=0;
  const tick=()=>{
    if (i>=t.selectedKeys.length){ t.status='COMPLETE'; t.progress=100; return; }
    for (const k of t.selectedKeys.slice(i, i+50)) {
      t.result.successful.push({key:k, prevPriority:issues[k].fields.priority.name});
      issues[k].fields.priority = {...t.edit.priority.priority};
    }
    i+=50; setTimeout(tick, 20);
  };
  setTimeout(tick, 20);
}
http.createServer((req, res)=>{
  const u = url.parse(req.url, true);
  if (req.method==='POST' && u.pathname==='/rest/api/3/bulk/issues/fields') {
    let b=''; req.on('data',(c)=>b+=c); req.on('end',()=>{
      const parsed = JSON.parse(b);
      taskCounter++;
      // INJECT: the SECOND POST during revert — i.e. taskCounter===2 — fails
      if (taskCounter === 2) {
        console.error('[faulty] injected 500 on task submit #2');
        return json(res, 500, { error: 'injected 500 for 2nd revert group' });
      }
      const tid = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
      tasks[tid] = { taskId: tid, status:'ENQUEUED', progress:0, selectedKeys: parsed.selectedIssueIdsOrKeys, edit: parsed.editedFieldsInput, result:{successful:[],failed:[]}};
      runTask(tid);
      json(res, 201, {taskId: tid});
    });
    return;
  }
  const m = u.pathname.match(/^\\/rest\\/api\\/3\\/bulk\\/queue\\/(.+)$/);
  if (m && req.method==='GET'){
    const t = tasks[m[1]]; if (!t) return json(res,404,{message:'no task'});
    return json(res,200,t);
  }
  const gi = u.pathname.match(/^\\/rest\\/api\\/3\\/issue\\/(.+)$/);
  if (gi && req.method==='GET'){ const i = issues[gi[1]]; if (!i) return json(res,404,{}); return json(res,200,i); }
  json(res,404,{});
}).listen(4204, ()=>console.log('[faulty-jira-4204] up'));
`;
  const faultyPath = path.join(__dirname, '.faulty-jira-server.js');
  fs.writeFileSync(faultyPath, faultyCode);
  const faulty = spawn('node', [faultyPath], { stdio: 'pipe' });
  faulty.stderr.on('data', (c) => process.stderr.write('[faulty] ' + c));
  faulty.stdout.on('data', (c) => process.stdout.write('[faulty] ' + c));
  await waitPort(4204);

  try {
    // 1. forward bulk on all 300 keys against original mock 4104
    const keys = Array.from({ length: 300 }, (_, i) => `PROJ-${i + 1}`).join(',');
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), keys, 'High'], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('forward: successful=', out.successful, 'failed=', out.failed);

    // 2. Split the before-image into 2 groups so revert produces 2 POSTs:
    //    100 keys revert to 'Low', 100 keys revert to 'Medium'.
    const lane = JSON.parse(fs.readFileSync(out.lanePath, 'utf8'));
    for (let i = 0; i < 100; i++) {
      const pk = lane.compensator.perKey[i];
      pk.revertTo = 'Low';
      lane.beforeImage[pk.key] = 'Low';
    }
    // Point at faulty 4204 where state is seeded as all=High already
    lane.compensator.upstream = 'http://127.0.0.1:4204';
    fs.writeFileSync(out.lanePath, JSON.stringify(lane, null, 2));

    // 3. Run revert. Expected: group #1 (Low, 100 keys) succeeds. Group #2 (Medium, 100 keys) → 500.
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8', timeout: 30000 });
    console.log('\n=== revert stdout ===\n' + rev.stdout);
    console.log('=== revert stderr ===\n' + rev.stderr);
    console.log('revert exit:', rev.status);

    // 4. Audit faulty-mock state
    const lowKeys = lane.compensator.perKey.slice(0, 100).map(p => p.key);
    const medKeys = lane.compensator.perKey.slice(100).map(p => p.key);
    const lowSample = await Promise.all(lowKeys.slice(0, 10).map(k => httpReq('GET', `http://127.0.0.1:4204/rest/api/3/issue/${k}`)));
    const medSample = await Promise.all(medKeys.slice(0, 10).map(k => httpReq('GET', `http://127.0.0.1:4204/rest/api/3/issue/${k}`)));
    const lowActual = lowSample.map(r => r.body.fields.priority.name);
    const medActual = medSample.map(r => r.body.fields.priority.name);

    const lowRestoredToLow = lowActual.filter(p => p === 'Low').length;
    const medStillHigh = medActual.filter(p => p === 'High').length;
    const medStillWrong = medActual.filter(p => p !== 'Medium').length;

    console.log('\n=== audit ===');
    console.log('Low group sample (first 10):', lowActual);
    console.log('Med group sample (first 10):', medActual);
    console.log(JSON.stringify({
      revertExit: rev.status,
      lowGroupRestored: `${lowRestoredToLow}/10`,
      medGroup_stillInForwardState_High: `${medStillHigh}/10`,
      medGroup_notRestored: `${medStillWrong}/10`,
      verdict: rev.status === 0 && medStillWrong > 0
        ? 'BUG: revert.js exited 0 despite second group failing; sampling missed the failure. Real state partially reverted, user thinks it fully reverted.'
        : rev.status !== 0
          ? 'PARTIAL-OK: exit non-zero, but lane file has no partial_undo state; retry story undefined.'
          : 'OK',
      findings: [
        'revert.js does NOT stop on group failure (continue loop) — or may crash on undefined taskId',
        'no retry w/ backoff on 500',
        'no idempotency key — replaying the failed bulk after partial progress is unsafe',
        'verify step samples only 5 keys — cannot detect 100-key group failure',
        'lane file has no state=partial_undo, cannot resume from failure point',
      ],
    }, null, 2));
  } finally {
    mock.kill();
    faulty.kill();
    try { fs.unlinkSync(faultyPath); } catch {}
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
