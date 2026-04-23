// F3b — Test revert retry by running a CUSTOM mock-github that returns 500 on the first PATCH
// after a marker query param, then a simpler approach: just spawn a version of mock-server that
// returns 500 on the first PATCH overall. Rebuild the mock on 4101.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const POC = path.join(__dirname, '..', '01-github-issue');

function httpReq(method, u, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search,
      method, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': b.length } : {}) },
    }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks).toString(); let p = null; try { p = buf ? JSON.parse(buf) : null; } catch { p = buf; } resolve({ status: res.statusCode, body: p }); }); });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const r = http.request({ hostname: '127.0.0.1', port, path: '/repos/octo/demo/issues/1', method: 'GET' }, (x) => { x.resume(); x.on('end', res); }); r.on('error', rej); r.end(); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('no mock ' + port);
}

async function main() {
  // Build a custom mock that tracks PATCH count and fails the Nth one.
  // Env: FAIL_PATCH_INDEX=2 means fail the 2nd PATCH (forward=1 succeeds, revert=2 fails once).
  const customMockCode = `
const http = require('http');
const url = require('url');
const store = { 'octo/demo/1': { number:1, title:'Original title', state:'open', state_reason:null, labels:[{name:'bug'},{name:'p1'}], body:'Original body', assignees:[{login:'alice'}], updated_at:'2026-04-20T10:00:00Z' } };
let patchCount = 0;
const FAIL_AT = parseInt(process.env.FAIL_PATCH_INDEX || '2', 10);
function json(res, code, obj) { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const m = u.pathname.match(/^\\/repos\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)$/);
  if (!m) return json(res, 404, {});
  const issue = store[\`\${m[1]}/\${m[2]}/\${m[3]}\`];
  if (!issue) return json(res, 404, {});
  if (req.method === 'GET') return json(res, 200, issue);
  if (req.method === 'PATCH') {
    let body=''; req.on('data',(c)=>body+=c); req.on('end',()=>{
      patchCount++;
      console.error('[mock] PATCH #' + patchCount);
      if (patchCount === FAIL_AT) {
        return json(res, 500, { error: 'transient fail on PATCH #' + patchCount });
      }
      const patch = JSON.parse(body);
      for (const k of ['title','state','state_reason','body']) if (k in patch) issue[k]=patch[k];
      if ('labels' in patch) issue.labels = patch.labels.map((n)=>typeof n==='string'?{name:n}:n);
      if ('assignees' in patch) issue.assignees = patch.assignees.map((n)=>typeof n==='string'?{login:n}:n);
      issue.updated_at = new Date().toISOString();
      json(res, 200, issue);
    });
    return;
  }
  json(res, 405, {});
}).listen(4101, () => console.log('[custom-mock] up'));
`;
  const customPath = path.join(__dirname, '.custom-github-mock.js');
  fs.writeFileSync(customPath, customMockCode);
  const mock = spawn('node', [customPath], { stdio: 'pipe', env: { ...process.env, FAIL_PATCH_INDEX: '2' } });
  mock.stderr.on('data', (c) => process.stderr.write('[mock-err] ' + c));
  await waitPort(4101);

  try {
    // forward (will be PATCH #1 -> success)
    const patch = JSON.stringify({ title: 'F3b forward title' });
    const r = spawnSync('node', [path.join(POC, 'cairn-proxy.js'), 'octo', 'demo', '1', patch], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim());
    console.log('forward ok, lane=', out.laneId);

    // revert — PATCH #2 will 500
    const rev = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('=== revert stdout ===\n' + rev.stdout);
    console.log('=== revert stderr ===\n' + rev.stderr);
    console.log('revert exit:', rev.status);

    // check final title (should be 'Original title' if revert actually happened; else 'F3b forward title')
    const final = await httpReq('GET', 'http://127.0.0.1:4101/repos/octo/demo/issues/1');
    console.log('FINAL title=', final.body.title);

    // attempt a MANUAL retry: run revert a second time. If idempotent + retries, this succeeds.
    console.log('\n--- manual retry: re-run revert.js ---');
    const rev2 = spawnSync('node', [path.join(POC, 'revert.js'), out.lanePath], { encoding: 'utf8' });
    console.log('rev2 stdout:\n' + rev2.stdout);
    const final2 = await httpReq('GET', 'http://127.0.0.1:4101/repos/octo/demo/issues/1');

    console.log(JSON.stringify({
      firstRevertExit: rev.status,
      firstRevertLeftState_ForwardTitle: final.body.title === 'F3b forward title',
      secondRevertManualRetry_ok: final2.body.title === 'Original title',
      verdict: [
        rev.status === 0
          ? 'BUG: revert.js exited 0 despite mock returning 500 on the PATCH — verify then saw still-forward state. Actually verify would fail here.'
          : 'revert.js exited non-zero (expected on 500)',
        final.body.title === 'F3b forward title'
          ? 'BUG CONFIRMED: no retry in revert.js — 1 attempt, state left wrong'
          : 'revert somehow succeeded',
        'BUT: re-running revert.js manually DOES eventually succeed (idempotent), because we re-read lane and re-PATCH',
        'MISSING: Idempotency-Key header on outgoing PATCH. If mock had half-applied the PATCH server-side before 500, a naive retry could double-apply (non-issue for PATCH idempotency, but critical for POST compensators like refund).',
      ],
    }, null, 2));
  } finally { mock.kill(); try { fs.unlinkSync(customPath); } catch {} }
}
main().catch((e) => { console.error(e); process.exit(1); });
