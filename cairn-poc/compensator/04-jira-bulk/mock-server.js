// Mock Jira bulk field edit.
// POST /rest/api/3/bulk/issues/fields  body: {selectedIssueIdsOrKeys:[...], editedFieldsInput: {priority:{priority:{name:"High"}}}}
//   -> 201 {taskId}
// GET /rest/api/3/bulk/queue/:taskId
//   -> {status: ENQUEUED|RUNNING|COMPLETE, progress, result:{successful:[...],failed:[...]}}
// Per issue store keeps priority field. Deterministic "200 succeed, 100 fail" split.
const http = require('http');
const url = require('url');

const issues = {};
for (let i = 1; i <= 300; i++) issues[`PROJ-${i}`] = { key: `PROJ-${i}`, fields: { priority: { name: 'Medium' } } };
const tasks = {}; // taskId -> {...}

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

function runTaskAsync(taskId) {
  const t = tasks[taskId];
  t.status = 'RUNNING';
  let i = 0;
  const tick = () => {
    if (i >= t.selectedKeys.length) {
      t.status = 'COMPLETE';
      t.progress = 100;
      return;
    }
    // process a chunk
    const chunk = t.selectedKeys.slice(i, i + 50);
    for (const k of chunk) {
      // fail keys whose numeric suffix > 200 to simulate 200-success / 100-fail
      const n = parseInt(k.split('-')[1], 10);
      if (n > 200) {
        t.result.failed.push({ key: k, error: 'permission_denied' });
      } else {
        const prev = issues[k].fields.priority.name;
        t.result.successful.push({ key: k, prevPriority: prev });
        issues[k].fields.priority = { ...t.edit.priority.priority };
      }
    }
    i += 50;
    t.progress = Math.min(100, Math.round((i / t.selectedKeys.length) * 100));
    setTimeout(tick, 40);
  };
  setTimeout(tick, 30);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'POST' && u.pathname === '/rest/api/3/bulk/issues/fields') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { selectedIssueIdsOrKeys, editedFieldsInput } = JSON.parse(body);
        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        tasks[taskId] = { taskId, status: 'ENQUEUED', progress: 0, selectedKeys: selectedIssueIdsOrKeys, edit: editedFieldsInput, result: { successful: [], failed: [] } };
        runTaskAsync(taskId);
        json(res, 201, { taskId });
      } catch { json(res, 400, { message: 'bad json' }); }
    });
    return;
  }
  const m = u.pathname.match(/^\/rest\/api\/3\/bulk\/queue\/(.+)$/);
  if (m && req.method === 'GET') {
    const t = tasks[m[1]];
    if (!t) return json(res, 404, { message: 'task not found' });
    return json(res, 200, t);
  }
  const gi = u.pathname.match(/^\/rest\/api\/3\/issue\/(.+)$/);
  if (gi && req.method === 'GET') {
    const i = issues[gi[1]];
    if (!i) return json(res, 404, {});
    return json(res, 200, i);
  }
  json(res, 404, { message: 'not found' });
});
const PORT = process.env.PORT || 4104;
server.listen(PORT, () => console.log(`[mock-jira] listening on ${PORT}`));
