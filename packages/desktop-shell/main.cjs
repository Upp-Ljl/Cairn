'use strict';

/**
 * Cairn desktop-shell — Electron main process.
 *
 * Responsibilities:
 *   - app lifecycle (whenReady / window-all-closed / activate)
 *   - SQLite read-only handle management + DB path switching
 *   - window creation: pet (preview.html), panel (panel.html), legacy (inspector-legacy.html)
 *   - IPC routing: panel + legacy + pet drag handlers
 *   - mutation gating via CAIRN_DESKTOP_ENABLE_MUTATIONS env flag
 *
 * SQL lives in queries.cjs. Keep this file Electron-only.
 *
 * Per PRODUCT.md v3 §12 D9: default state is strictly read-only. The one
 * mutation path (resolveConflict, kept for dogfood-live-pet-demo.mjs
 * compatibility) is gated on CAIRN_DESKTOP_ENABLE_MUTATIONS=1.
 */

const { app, BrowserWindow, ipcMain, screen, dialog, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const queries = require('./queries.cjs');

// ---------------------------------------------------------------------------
// Config + flags
// ---------------------------------------------------------------------------

const PREFS_PATH = path.join(os.homedir(), '.cairn', 'desktop-shell.json');
const DEFAULT_DB_PATH = path.join(os.homedir(), '.cairn', 'cairn.db');

const MUTATIONS_ENABLED = process.env.CAIRN_DESKTOP_ENABLE_MUTATIONS === '1';
if (MUTATIONS_ENABLED) {
  // eslint-disable-next-line no-console
  console.warn('⚠ desktop mutations enabled (CAIRN_DESKTOP_ENABLE_MUTATIONS=1) — dev only');
}

const argv = process.argv.slice(1); // [0] is the executable / .
const LEGACY_MODE = argv.includes('--legacy');

// ---------------------------------------------------------------------------
// Prefs (workspace / DB path persistence)
// ---------------------------------------------------------------------------

function readPrefs() {
  try {
    if (!fs.existsSync(PREFS_PATH)) return {};
    return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) || {};
  } catch (_e) {
    return {};
  }
}

function writePrefs(prefs) {
  try {
    fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8');
  } catch (_e) {
    // Non-fatal — prefs are convenience, not correctness.
  }
}

// ---------------------------------------------------------------------------
// SQLite connection state
// ---------------------------------------------------------------------------

let dbPath = null;       // currently open db file (absolute)
let db = null;           // read-only better-sqlite3 handle
let writeDb = null;      // lazy write handle (mutation flag only)
let tables = new Set();  // cached table-presence for current connection

function openReadDb(p) {
  const Database = require('better-sqlite3');
  return new Database(p, { readonly: true, fileMustExist: true });
}

function openWriteDb(p) {
  if (writeDb && dbPath === p) return writeDb;
  const Database = require('better-sqlite3');
  writeDb = new Database(p, { fileMustExist: true });
  return writeDb;
}

/**
 * Open (or re-open) the read-only handle for the given DB path. Closes any
 * previous handles to avoid file-descriptor leaks across project switches.
 */
function connectDb(targetPath) {
  // Close previous handles cleanly
  try { if (db) db.close(); } catch (_e) {}
  try { if (writeDb) writeDb.close(); } catch (_e) {}
  db = null;
  writeDb = null;
  tables = new Set();
  dbPath = targetPath;

  if (!targetPath || !fs.existsSync(targetPath)) {
    // eslint-disable-next-line no-console
    console.log(`cairn pet: db not found at ${targetPath}`);
    return false;
  }

  // Ensure WAL mode once with a transient RW handle. mcp-server already does
  // this on first write; we do it defensively in case the desktop opens an
  // existing file before any writer has touched it.
  try {
    const Database = require('better-sqlite3');
    const init = new Database(targetPath);
    init.pragma('journal_mode = WAL');
    init.close();
  } catch (_e) { /* fall through; mcp-server will WAL-init eventually */ }

  try {
    db = openReadDb(targetPath);
    tables = queries.getTables(db);
    // eslint-disable-next-line no-console
    console.log(`cairn pet: db connected ${targetPath} (${tables.size} tables)`);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`cairn pet: db open failed: ${e.message}`);
    db = null;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

let petWindow = null;
let panelWindow = null;
let legacyWindow = null;

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

function createPanelWindow() {
  if (panelWindow) {
    panelWindow.focus();
    return;
  }
  panelWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: 'Cairn — Project Control Surface',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWindow.loadFile('panel.html');
  panelWindow.on('closed', () => { panelWindow = null; });
}

function createLegacyWindow() {
  if (legacyWindow) {
    legacyWindow.focus();
    return;
  }
  legacyWindow = new BrowserWindow({
    width: 480,
    height: 600,
    title: 'Cairn Inspector (legacy)',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  legacyWindow.loadFile('inspector-legacy.html');
  legacyWindow.on('closed', () => { legacyWindow = null; });
}

// ---------------------------------------------------------------------------
// IPC — panel / Day 1 channels
// ---------------------------------------------------------------------------

ipcMain.handle('get-project-summary', () =>
  queries.queryProjectSummary(db, tables, dbPath)
);

ipcMain.handle('get-tasks-list', () =>
  queries.queryTasksList(db, tables)
);

ipcMain.handle('get-task-detail', (_e, taskId) =>
  queries.queryTaskDetail(db, tables, taskId)
);

ipcMain.handle('get-run-log-events', () =>
  queries.queryRunLogEvents(db, tables)
);

ipcMain.handle('get-db-path', () => dbPath);

ipcMain.handle('set-db-path', async (_e, requestedPath) => {
  let target = requestedPath;
  if (!target) {
    // No explicit path — open a file picker rooted on the current DB's dir
    const startDir = dbPath ? path.dirname(dbPath) : path.dirname(DEFAULT_DB_PATH);
    const result = await dialog.showOpenDialog({
      title: 'Select Cairn workspace DB',
      defaultPath: startDir,
      properties: ['openFile'],
      filters: [{ name: 'Cairn DB', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, error: 'cancelled' };
    }
    target = result.filePaths[0];
  }

  const ok = connectDb(target);
  if (!ok) {
    return { ok: false, error: `failed to open ${target}` };
  }
  const prefs = readPrefs();
  prefs.dbPath = target;
  writePrefs(prefs);
  return { ok: true, dbPath: target };
});

ipcMain.on('open-legacy-inspector', () => createLegacyWindow());

// ---------------------------------------------------------------------------
// IPC — legacy / pet channels (unchanged shape)
// ---------------------------------------------------------------------------

ipcMain.handle('get-state',             () => queries.queryLegacyState(db, tables));
ipcMain.handle('get-active-agents',     () => queries.queryActiveAgents(db, tables));
ipcMain.handle('get-open-conflicts',    () => queries.queryOpenConflicts(db, tables));
ipcMain.handle('get-recent-dispatches', () => queries.queryRecentDispatches(db, tables));
ipcMain.handle('get-active-lanes',      () => queries.queryActiveLanes(db, tables));

ipcMain.on('open-inspector', () => {
  // Legacy "open-inspector" channel from preview.html now opens the
  // legacy Inspector (renamed). Existing callers (pet click handler) keep
  // working without changes.
  createLegacyWindow();
});

// ---------------------------------------------------------------------------
// IPC — mutation channel (gated on env flag)
// ---------------------------------------------------------------------------

// Synchronous probe used by preload.cjs to decide whether to expose
// resolveConflict on window.cairn.
ipcMain.on('cairn:mutations-enabled?', (event) => {
  event.returnValue = MUTATIONS_ENABLED;
});

if (MUTATIONS_ENABLED) {
  ipcMain.handle('resolve-conflict', (_e, conflictId, resolution) => {
    if (!dbPath) return { ok: false, error: 'no DB connected' };
    try {
      const wdb = openWriteDb(dbPath);
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
        const row = wdb.prepare('SELECT status FROM conflicts WHERE id = ?').get(conflictId);
        const reason = row ? `conflict status is already ${row.status}` : 'conflict not found';
        return { ok: false, error: reason };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ---------------------------------------------------------------------------
// IPC — pet drag (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // Resolve initial DB path: prefs > default
  const prefs = readPrefs();
  const initialPath = prefs.dbPath || DEFAULT_DB_PATH;
  connectDb(initialPath);

  // Always create the pet (ambient presence). Then open either the panel
  // or the legacy Inspector depending on launch mode.
  createPetWindow();
  if (LEGACY_MODE) {
    createLegacyWindow();
  } else {
    createPanelWindow();
  }

  // eslint-disable-next-line no-console
  console.log(
    `cairn desktop-shell ready — mode=${LEGACY_MODE ? 'legacy' : 'panel'} ` +
    `mutations=${MUTATIONS_ENABLED ? 'on(dev)' : 'off'} db=${dbPath}`
  );
});

// Day 3 will install the tray icon and make this conditional. For Day 1
// we keep the existing behavior so smoke-testing without a tray still
// works (closing the panel window quits the app on Windows/Linux, which
// is the current expectation). Day 3 will replace this guard.
app.on('window-all-closed', () => app.quit());
