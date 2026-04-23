// Mock GitHub Issues API. Implements GET and PATCH /repos/:owner/:repo/issues/:n
// Uses schema close to real GitHub: title, state (open|closed), state_reason, labels[], body, assignees[]
const http = require('http');
const url = require('url');

const store = {
  // key = owner/repo/n
  'octo/demo/1': {
    number: 1,
    title: 'Original title',
    state: 'open',
    state_reason: null,
    labels: [{ name: 'bug' }, { name: 'p1' }],
    body: 'Original body text',
    assignees: [{ login: 'alice' }],
    updated_at: '2026-04-20T10:00:00Z',
  },
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  // /repos/:owner/:repo/issues/:n
  const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  if (!m) return json(res, 404, { message: 'Not Found' });
  const key = `${m[1]}/${m[2]}/${m[3]}`;
  const issue = store[key];
  if (!issue) return json(res, 404, { message: 'Issue not found' });

  if (req.method === 'GET') {
    // inject small random latency to simulate network
    setTimeout(() => json(res, 200, issue), 8 + Math.random() * 12);
    return;
  }
  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        // Real GitHub accepts: title, state, state_reason, body, labels, assignees
        for (const k of ['title', 'state', 'state_reason', 'body']) {
          if (k in patch) issue[k] = patch[k];
        }
        if ('labels' in patch) issue.labels = patch.labels.map((n) => (typeof n === 'string' ? { name: n } : n));
        if ('assignees' in patch) issue.assignees = patch.assignees.map((n) => (typeof n === 'string' ? { login: n } : n));
        issue.updated_at = new Date().toISOString();
        json(res, 200, issue);
      } catch (e) {
        json(res, 400, { message: 'bad json' });
      }
    });
    return;
  }
  json(res, 405, { message: 'method not allowed' });
});

const PORT = process.env.PORT || 4101;
server.listen(PORT, () => console.log(`[mock-github-issue] listening on ${PORT}`));
