'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.cairn', 'cairn.db');

let db = null;
let writeDb = null;
let petWindow = null;
let inspectorWindow = null;

// Read handle: readonly, used for all list/query paths (high-frequency reads).
// Write handle: opened lazily on first write operation (WAL allows concurrent
// read+write in-process; keeping separate handles avoids accidentally promoting
// read paths to RW).
function openDb() {
  const Database = require('better-sqlite3');
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function openWriteDb() {
  if (writeDb) return writeDb;
  const Database = require('better-sqlite3');
  writeDb = new Database(DB_PATH, { fileMustExist: true });
  return writeDb;
}

function getTables() {
  if (!db) return new Set();
  return new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );
}

// Same queries as state-server.js, verbatim
function queryState() {
  if (!db) return {
    available: false, agents_active: 0, conflicts_open: 0,
    lanes_held_for_human: 0, lanes_reverting: 0, dispatch_pending: 0,
    last_dispatch_status: null, last_dispatch_age_sec: null,
    newest_agent_age_sec: null, ts: Math.floor(Date.now() / 1000),
  };

  try {
    const tables = getTables();

    let agents_active = 0, newest_agent_age_sec = null;
    if (tables.has('processes')) {
      agents_active = db.prepare(`SELECT COUNT(*) AS c FROM processes WHERE status='ACTIVE'`).get().c;
      const newest = db.prepare(`SELECT MAX(registered_at) AS t FROM processes`).get();
      if (newest && newest.t != null)
        newest_agent_age_sec = Math.round((Date.now() - newest.t) / 100) / 10;
    }

    let conflicts_open = 0;
    if (tables.has('conflicts'))
      conflicts_open = db.prepare(`SELECT COUNT(*) AS c FROM conflicts WHERE status='OPEN'`).get().c;

    let lanes_held_for_human = 0, lanes_reverting = 0;
    if (tables.has('lanes')) {
      lanes_held_for_human = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='HELD_FOR_HUMAN'`).get().c;
      lanes_reverting = db.prepare(`SELECT COUNT(*) AS c FROM lanes WHERE state='REVERTING'`).get().c;
    }

    let last_dispatch_status = null, last_dispatch_age_sec = null, dispatch_pending = 0;
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
      available: true, agents_active, conflicts_open,
      lanes_held_for_human, lanes_reverting, dispatch_pending,
      last_dispatch_status, last_dispatch_age_sec,
      newest_agent_age_sec, ts: Math.floor(Date.now() / 1000),
    };
  } catch {
    return {
      available: false, agents_active: 0, conflicts_open: 0,
      lanes_held_for_human: 0, lanes_reverting: 0, dispatch_pending: 0,
      last_dispatch_status: null, last_dispatch_age_sec: null,
      newest_agent_age_sec: null, ts: Math.floor(Date.now() / 1000),
    };
  }
}

function queryActiveAgents() {
  if (!db || !getTables().has('processes')) return [];
  return db.prepare(`SELECT * FROM processes WHERE status='ACTIVE'`).all();
}

function queryOpenConflicts() {
  if (!db || !getTables().has('conflicts')) return [];
  return db.prepare(`SELECT * FROM conflicts WHERE status='OPEN'`).all();
}

function queryRecentDispatches() {
  if (!db || !getTables().has('dispatch_requests')) return [];
  return db.prepare(`SELECT * FROM dispatch_requests ORDER BY created_at DESC LIMIT 20`).all();
}

function queryActiveLanes() {
  if (!db || !getTables().has('lanes')) return [];
  return db.prepare(
    `SELECT * FROM lanes WHERE state IN ('RECORDED','REVERTING','HELD_FOR_HUMAN','FAILED_RETRYABLE')`
  ).all();
}

function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const W = 96, H = 104, MARGIN = 24;

  petWindow = new BrowserWindow({
    width: W, height: H,
    x: width - W - MARGIN,
    y: height - H - MARGIN,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  petWindow.loadFile('preview.html');
  petWindow.on('blur', () => {
    if (petWindow) petWindow.setAlwaysOnTop(true, 'screen-saver');
  });
  petWindow.on('closed', () => { petWindow = null; });
}

function createInspectorWindow() {
  inspectorWindow = new BrowserWindow({
    width: 480, height: 600,
    title: 'Cairn Inspector',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  inspectorWindow.loadFile('inspector.html');
  inspectorWindow.on('closed', () => { inspectorWindow = null; });
}

ipcMain.handle('get-state', () => queryState());
ipcMain.handle('get-active-agents', () => queryActiveAgents());
ipcMain.handle('get-open-conflicts', () => queryOpenConflicts());
ipcMain.handle('get-recent-dispatches', () => queryRecentDispatches());
ipcMain.handle('get-active-lanes', () => queryActiveLanes());

ipcMain.handle('resolve-conflict', (_e, conflictId, resolution) => {
  try {
    const wdb = openWriteDb();
    const resolutionText = resolution || 'resolved via Inspector';
    const now = Date.now();
    const result = wdb.prepare(`
      UPDATE conflicts
         SET status = 'RESOLVED',
             resolved_at = ?,
             resolution = ?
       WHERE id = ? AND status IN ('OPEN', 'PENDING_REVIEW')
    `).run(now, resolutionText, conflictId);
    if (result.changes === 0) {
      // Either not found or already in a terminal state
      const row = wdb.prepare('SELECT status FROM conflicts WHERE id = ?').get(conflictId);
      const reason = row ? `conflict status is already ${row.status}` : 'conflict not found';
      return { ok: false, error: reason };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('open-inspector', () => {
  if (inspectorWindow) {
    inspectorWindow.focus();
  } else {
    createInspectorWindow();
  }
});

let dragOffsetX = 0, dragOffsetY = 0;

ipcMain.on('start-drag', (_e, { mouseX, mouseY }) => {
  if (!petWindow) return;
  const [winX, winY] = petWindow.getPosition();
  dragOffsetX = mouseX - winX;
  dragOffsetY = mouseY - winY;
});

ipcMain.on('do-drag', (_e, { mouseX, mouseY }) => {
  if (!petWindow) return;
  petWindow.setPosition(
    Math.round(mouseX - dragOffsetX),
    Math.round(mouseY - dragOffsetY)
  );
});

app.whenReady().then(() => {
  const dbAvailable = fs.existsSync(DB_PATH);
  if (dbAvailable) {
    // ensure WAL mode so pet's read handle never blocks writers
    try {
      const Database = require('better-sqlite3');
      const rwInit = new Database(DB_PATH);
      rwInit.pragma('journal_mode = WAL');
      rwInit.close();
    } catch (_e) { /* DB not ready yet — mcp-server will WAL-init on first write */ }
    try { db = openDb(); } catch (e) { db = null; }
  }
  console.log(`cairn pet ready — db=${DB_PATH} available=${db !== null}`);
  createPetWindow();
});

app.on('window-all-closed', () => app.quit());
