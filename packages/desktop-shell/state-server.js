// legacy: HTTP variant for browser preview, not used by Electron app
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DB_PATH = join(homedir(), '.cairn', 'cairn.db');
const PORT = 7842;

function openDb() {
  const Database = require('better-sqlite3');
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

const EMPTY = {
  available: false,
  agents_active: 0,
  conflicts_open: 0,
  lanes_held_for_human: 0,
  lanes_reverting: 0,
  dispatch_pending: 0,
  last_dispatch_status: null,
  last_dispatch_age_sec: null,
  newest_agent_age_sec: null,
  ts: 0,
};

function queryState() {
  if (!existsSync(DB_PATH)) {
    return { ...EMPTY, ts: Math.floor(Date.now() / 1000) };
  }

  let db;
  try {
    db = openDb();
  } catch {
    return { ...EMPTY, ts: Math.floor(Date.now() / 1000) };
  }

  try {
    const tables = new Set(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
    );

    let agents_active = 0;
    let newest_agent_age_sec = null;
    if (tables.has('processes')) {
      agents_active = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`).get().c;
      const newest = db.prepare(`SELECT MAX(registered_at) AS t FROM processes`).get();
      if (newest && newest.t != null) {
        newest_agent_age_sec = Math.round((Date.now() - newest.t) / 100) / 10;
      }
    }

    let conflicts_open = 0;
    if (tables.has('conflicts')) {
      conflicts_open = db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status='OPEN'`).get().c;
    }

    let lanes_held_for_human = 0;
    let lanes_reverting = 0;
    if (tables.has('lanes')) {
      lanes_held_for_human = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='HELD_FOR_HUMAN'`).get().c;
      lanes_reverting = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='REVERTING'`).get().c;
    }

    let last_dispatch_status = null;
    let last_dispatch_age_sec = null;
    let dispatch_pending = 0;
    if (tables.has('dispatch_requests')) {
      const row = db.prepare(
        `SELECT status, created_at FROM dispatch_requests ORDER BY created_at DESC LIMIT 1`
      ).get();
      if (row) {
        last_dispatch_status = row.status.toLowerCase();
        last_dispatch_age_sec = Math.round((Date.now() - row.created_at) / 100) / 10;
      }
      dispatch_pending = db.prepare(`SELECT COUNT(*) AS c FROM dispatch_requests WHERE status='PENDING'`).get().c;
    }

    return {
      available: true,
      agents_active,
      conflicts_open,
      lanes_held_for_human,
      lanes_reverting,
      dispatch_pending,
      last_dispatch_status,
      last_dispatch_age_sec,
      newest_agent_age_sec,
      ts: Math.floor(Date.now() / 1000),
    };
  } finally {
    db.close();
  }
}

const STATUS_HTML = `<!DOCTYPE html><html><body style="font-family:monospace;background:#1a1a1a;color:#eee;padding:24px">
<h2>Cairn State Server</h2><p>Running on port ${PORT}.</p>
<p><a href="/state" style="color:#7af">/state</a> — JSON snapshot</p>
</body></html>`;

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/state') {
    const payload = JSON.stringify(queryState());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(STATUS_HTML);
  }
});

server.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
