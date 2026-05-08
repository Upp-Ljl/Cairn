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

const { app, BrowserWindow, ipcMain, screen, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const queries = require('./queries.cjs');

// ---------------------------------------------------------------------------
// Tray icon assets (base64 PNG, 16x16, 1px border + solid fill)
// ---------------------------------------------------------------------------
//
// Pre-generated at source-time with a one-shot Node helper (zlib + Buffer
// builtins, no third-party dep). Embedded as base64 string constants so:
//   - no binary files in the repo
//   - no runtime canvas / spritesheet / webp dependency
//   - no native ICO toolchain required for a 3-state Quick Slice tray
// Three distinct colors carry the state signal:
//   idle  = gray   #505050 / dark-gray border
//   warn  = amber  #DCB432 / dark-amber border
//   alert = red    #C83232 / dark-red border
// macOS users may need a hi-dpi/ICO upgrade later; that's Hardening (R13).
const TRAY_ICON_IDLE  = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVR4nGPQ0ND4TwlmABEBAQFk4VEDRg0YNYDaBlCCAX390vApagYAAAAAAElFTkSuQmCC';
const TRAY_ICON_WARN  = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGPIi5L8TwlmABF3thiRhUcNGDVg1ABqG0AJBgAaCYxjVG9cowAAAABJRU5ErkJggg==';
const TRAY_ICON_ALERT = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGOoEBH5TwlmABEnjIzIwqMGjBowagC1DaAEAwCFDApPXv1bjAAAAABJRU5ErkJggg==';

const TRAY_IMAGES = {
  idle:  nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_IDLE),
  warn:  nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_WARN),
  alert: nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_ALERT),
};

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
let tray = null;
let trayPollTimer = null;
let lastTrayState = null;        // 'idle' | 'warn' | 'alert'
let isQuitting = false;          // set by Quit menu so close handlers cooperate

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
    if (!panelWindow.isVisible()) panelWindow.show();
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

  // Tray-aware close: pressing the OS close button hides the window but
  // keeps the app alive. Quit must go through the tray menu (or `app.quit()`
  // wired via isQuitting). Without this, closing the panel would orphan
  // the tray in a confusing "icon stays but nothing happens on click"
  // state — see plan §10 R14.
  panelWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      panelWindow.hide();
    }
  });
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
// Tray (system tray / menu bar entry)
// ---------------------------------------------------------------------------

function togglePanel() {
  if (panelWindow && panelWindow.isVisible() && panelWindow.isFocused()) {
    panelWindow.hide();
    return;
  }
  if (!panelWindow) {
    createPanelWindow();
  } else {
    if (!panelWindow.isVisible()) panelWindow.show();
    panelWindow.focus();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Cairn',            click: () => togglePanel() },
    { label: 'Open Legacy Inspector', click: () => createLegacyWindow() },
    { type: 'separator' },
    { label: 'Quit',                  click: () => {
      isQuitting = true;
      app.quit();
    }},
  ]);
}

/**
 * Compute tray state from the project summary. Priority:
 *   alert  — open conflicts > 0 OR failed outcomes > 0
 *   warn   — open blockers > 0 OR waiting_review tasks > 0
 *   idle   — otherwise
 */
function deriveTrayState(summary) {
  if (!summary || !summary.available) return 'idle';
  if ((summary.conflicts_open  || 0) > 0) return 'alert';
  if ((summary.outcomes_failed || 0) > 0) return 'alert';
  if ((summary.blockers_open   || 0) > 0) return 'warn';
  if ((summary.tasks_waiting_review || 0) > 0) return 'warn';
  return 'idle';
}

function buildTrayTooltip(summary) {
  if (!summary || !summary.available) return 'Cairn — DB unavailable';
  return (
    `Cairn — ${summary.agents_active} agents · ` +
    `${summary.blockers_open} blockers · ` +
    `${summary.outcomes_failed} FAIL · ` +
    `${summary.conflicts_open} conflicts`
  );
}

function refreshTray() {
  if (!tray) return;
  const summary = queries.queryProjectSummary(db, tables, dbPath);
  const state = deriveTrayState(summary);
  if (state !== lastTrayState) {
    tray.setImage(TRAY_IMAGES[state]);
    lastTrayState = state;
  }
  tray.setToolTip(buildTrayTooltip(summary));
}

function createTray() {
  if (tray) return;
  // Start with idle; refreshTray will update immediately.
  tray = new Tray(TRAY_IMAGES.idle);
  tray.setToolTip('Cairn — starting…');
  tray.setContextMenu(buildTrayMenu());

  // Single-click toggles panel on Windows. macOS shows the context menu
  // on click by default; Quick Slice main target is Windows (R11), so
  // this is fine for now.
  tray.on('click', () => togglePanel());

  // Update icon + tooltip every 1s alongside panel polling.
  refreshTray();
  trayPollTimer = setInterval(refreshTray, 1000);
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

  // Tray comes up first so the app has a persistent entry point even if
  // the user immediately closes the panel.
  createTray();

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
    `mutations=${MUTATIONS_ENABLED ? 'on(dev)' : 'off'} ` +
    `tray=on db=${dbPath}`
  );
});

// Tray-aware lifecycle: closing all windows does NOT quit the app.
// Users who want to actually exit must use the tray's Quit menu (which
// flips isQuitting and calls app.quit()). On macOS this matches the
// platform convention; on Windows it gives the tray a meaningful role
// instead of being an orphan icon (plan §10 R14).
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
  // otherwise: keep app + tray alive
});

app.on('before-quit', () => {
  isQuitting = true;
  if (trayPollTimer) {
    clearInterval(trayPollTimer);
    trayPollTimer = null;
  }
  if (tray) {
    try { tray.destroy(); } catch (_e) {}
    tray = null;
  }
});
