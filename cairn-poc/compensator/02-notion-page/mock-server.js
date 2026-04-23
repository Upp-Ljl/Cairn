// Mock Notion API: GET /v1/pages/:id and PATCH /v1/pages/:id
// Notion page shape: object, id, archived, properties{name: {type, ...}}, cover, icon
// Properties are keyed by name; values nested by type (e.g. title: [{type:'text',text:{content:...}}])
const http = require('http');
const url = require('url');

const store = {
  'p-123': {
    object: 'page',
    id: 'p-123',
    archived: false,
    icon: { type: 'emoji', emoji: 'original' },
    cover: null,
    properties: {
      Name: { id: 'title', type: 'title', title: [{ type: 'text', text: { content: 'Original Title' }, plain_text: 'Original Title' }] },
      Status: { id: 'st', type: 'select', select: { id: 's1', name: 'Draft', color: 'gray' } },
      Tags: { id: 'tg', type: 'multi_select', multi_select: [{ id: 't1', name: 'foo', color: 'blue' }] },
      Priority: { id: 'pr', type: 'number', number: 1 },
      // Intentionally include a rollup-like computed field that cannot be patched but is in GET:
      ComputedCount: { id: 'cc', type: 'rollup', rollup: { type: 'number', number: 42, function: 'count' } },
      // And a created_time (read-only):
      CreatedAt: { id: 'ca', type: 'created_time', created_time: '2026-04-01T00:00:00.000Z' },
    },
    last_edited_time: '2026-04-20T10:00:00.000Z',
  },
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const m = u.pathname.match(/^\/v1\/pages\/([^/]+)$/);
  if (!m) return json(res, 404, { message: 'not found' });
  const page = store[m[1]];
  if (!page) return json(res, 404, { message: 'page not found' });

  if (req.method === 'GET') {
    setTimeout(() => json(res, 200, page), 10 + Math.random() * 20);
    return;
  }
  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        if ('archived' in patch) page.archived = patch.archived;
        if ('icon' in patch) page.icon = patch.icon;
        if ('cover' in patch) page.cover = patch.cover;
        if ('properties' in patch) {
          for (const [k, v] of Object.entries(patch.properties)) {
            if (!page.properties[k]) {
              // real Notion returns validation_error for unknown
              return json(res, 400, { message: `unknown property ${k}` });
            }
            // reject patching read-only types
            const t = page.properties[k].type;
            if (['rollup', 'created_time', 'last_edited_time', 'formula'].includes(t)) {
              return json(res, 400, { message: `property ${k} type ${t} is read-only` });
            }
            // merge: real Notion replaces the typed sub-value
            page.properties[k] = { ...page.properties[k], ...v };
          }
        }
        page.last_edited_time = new Date().toISOString();
        json(res, 200, page);
      } catch (e) {
        json(res, 400, { message: 'bad json' });
      }
    });
    return;
  }
  json(res, 405, { message: 'method not allowed' });
});

const PORT = process.env.PORT || 4102;
server.listen(PORT, () => console.log(`[mock-notion] listening on ${PORT}`));
