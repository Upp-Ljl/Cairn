// Mock of an HTTP-fronted SQL service (like a thin Postgres-over-HTTP). Real engine is sqlite.
// POST /query {sql, params} -> {rows, changes}  (emulates pg-like interface)
// Schema: users(id INTEGER PK, email TEXT UNIQUE, name TEXT, updated_at TEXT)
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'test.db');
try { fs.unlinkSync(DB_PATH); } catch {}
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, updated_at TEXT);
  INSERT INTO users(id,email,name,updated_at) VALUES
    (1,'alice@example.com','Alice','2026-04-20T10:00:00Z'),
    (2,'bob@example.com','Bob','2026-04-20T10:00:00Z'),
    (3,'carol@example.com','Carol','2026-04-20T10:00:00Z');
`);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.url === '/query' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { sql, params = [] } = JSON.parse(body);
        const stmt = db.prepare(sql);
        if (/^\s*select/i.test(sql)) {
          const rows = stmt.all(...params);
          json(res, 200, { rows, changes: 0 });
        } else {
          const info = stmt.run(...params);
          json(res, 200, { rows: [], changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        }
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }
  json(res, 404, { message: 'not found' });
});

const PORT = process.env.PORT || 4103;
server.listen(PORT, () => console.log(`[mock-sql] listening on ${PORT}`));
