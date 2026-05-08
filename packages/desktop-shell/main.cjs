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
const registry = require('./registry.cjs');
const projectQueries = require('./project-queries.cjs');

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
//
// Project-Aware Live Panel: persistent state lives in the project
// registry (`~/.cairn/projects.json`, owned by registry.cjs).
// The Quick-Slice-era `~/.cairn/desktop-shell.json` is read once at
// boot for migration (registry.bootstrapInitialRegistry) and never
// written by this build — keeping it in place lets users downgrade.

const MUTATIONS_ENABLED = process.env.CAIRN_DESKTOP_ENABLE_MUTATIONS === '1';
if (MUTATIONS_ENABLED) {
  // eslint-disable-next-line no-console
  console.warn('⚠ desktop mutations enabled (CAIRN_DESKTOP_ENABLE_MUTATIONS=1) — dev only');
}

const argv = process.argv.slice(1); // [0] is the executable / .
const LEGACY_MODE = argv.includes('--legacy');

// ---------------------------------------------------------------------------
// SQLite connection state — multi-DB (one read handle per unique db_path)
// ---------------------------------------------------------------------------
//
// Project-Aware Live Panel rule (plan §3.1):
//   - identity is project_root, NOT db_path
//   - multiple projects may share the same db_path
//   - desktop-shell is the only writer to ~/.cairn/projects.json;
//     it never writes to the SQLite DB
//
// State:
//   reg            : current registry (loaded at boot, mutated via IPC)
//   dbHandles      : Map<dbPath, { db, tables }> — one read handle per
//                    unique db_path, shared by every project pointing at it
//   selectedProjectId : the project currently shown in L2 (null = L1
//                       projects-list view; also the default boot state)
//
// Legacy + Quick-Slice IPC handlers (getState, getProjectSummary,
// queryRunLogEvents, etc.) read from the *active* db handle, which
// follows selectedProjectId. When no project is selected, they fall
// back to the default DB path so the pet sprite + legacy Inspector
// keep working.

/** @type {{ version: number, projects: registry.ProjectRegistryEntry[] }} */
let reg = { version: registry.REGISTRY_VERSION, projects: [] };

/** @type {Map<string, { db: any, tables: Set<string> }>} */
const dbHandles = new Map();

/** @type {Map<string, any>} writeDb handles (mutation flag only) */
const writeHandles = new Map();

/** @type {string|null} */
let selectedProjectId = null;

function openReadDb(p) {
  const Database = require('better-sqlite3');
  return new Database(p, { readonly: true, fileMustExist: true });
}

function openWriteDb(p) {
  if (writeHandles.has(p)) return writeHandles.get(p);
  const Database = require('better-sqlite3');
  const handle = new Database(p, { fileMustExist: true });
  writeHandles.set(p, handle);
  return handle;
}

/** Ensure WAL mode for a db file (idempotent). */
function ensureWalMode(p) {
  try {
    const Database = require('better-sqlite3');
    const init = new Database(p);
    init.pragma('journal_mode = WAL');
    init.close();
  } catch (_e) { /* mcp-server will WAL-init on its own write */ }
}

/**
 * Make sure a read handle exists for `p`. Returns the handle entry, or
 * null if the file is missing / unreadable.
 */
function ensureDbHandle(p) {
  if (!p) return null;
  if (dbHandles.has(p)) return dbHandles.get(p);
  if (!fs.existsSync(p)) {
    // eslint-disable-next-line no-console
    console.log(`cairn: db not found at ${p}`);
    return null;
  }
  ensureWalMode(p);
  try {
    const handle = openReadDb(p);
    const entry = { db: handle, tables: queries.getTables(handle) };
    dbHandles.set(p, entry);
    // eslint-disable-next-line no-console
    console.log(`cairn: db connected ${p} (${entry.tables.size} tables)`);
    return entry;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`cairn: db open failed: ${e.message}`);
    return null;
  }
}

/**
 * Close a read handle if no remaining registry project still points
 * at it. Call after registry mutations.
 */
function gcDbHandles() {
  const stillReferenced = new Set(registry.uniqueDbPaths(reg));
  for (const [p, entry] of dbHandles.entries()) {
    if (!stillReferenced.has(p)) {
      try { entry.db.close(); } catch (_e) {}
      dbHandles.delete(p);
    }
  }
  for (const [p, w] of writeHandles.entries()) {
    if (!stillReferenced.has(p)) {
      try { w.close(); } catch (_e) {}
      writeHandles.delete(p);
    }
  }
}

function openAllRegistryDbs() {
  for (const p of registry.uniqueDbPaths(reg)) ensureDbHandle(p);
}

/**
 * Resolve the "active" db handle for legacy / non-project IPC calls.
 * Routes through selectedProjectId if set; otherwise falls back to the
 * default DB path (so pet sprite + legacy Inspector continue working
 * even when the user is on the L1 view).
 */
function activeDbEntry() {
  if (selectedProjectId) {
    const proj = reg.projects.find(p => p.id === selectedProjectId);
    if (proj) return ensureDbHandle(proj.db_path);
  }
  // Fallback: first registry entry, or the default DB.
  if (reg.projects.length > 0) return ensureDbHandle(reg.projects[0].db_path);
  return ensureDbHandle(registry.DEFAULT_DB_PATH);
}

function activeDbPath() {
  if (selectedProjectId) {
    const proj = reg.projects.find(p => p.id === selectedProjectId);
    if (proj) return proj.db_path;
  }
  if (reg.projects.length > 0) return reg.projects[0].db_path;
  return registry.DEFAULT_DB_PATH;
}

function activeProject() {
  if (!selectedProjectId) return null;
  return reg.projects.find(p => p.id === selectedProjectId) || null;
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
  // Aggregate across all registered projects: tray reflects the worst
  // health across them. Unassigned buckets are not counted (they
  // shouldn't drive the tray to alert just because random untagged
  // rows exist in the DB).
  let worst = 'idle';
  let totalAgents = 0, totalBlockers = 0, totalFail = 0, totalConflicts = 0;
  let aggAvailable = false;

  for (const p of reg.projects) {
    const entry = ensureDbHandle(p.db_path);
    if (!entry) continue;
    aggAvailable = true;
    const s = projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, p.db_path, p.agent_id_hints,
    );
    if (s.health === 'alert') worst = 'alert';
    else if (s.health === 'warn' && worst !== 'alert') worst = 'warn';
    totalAgents    += s.agents_active;
    totalBlockers  += s.blockers_open;
    totalFail      += s.outcomes_failed + s.tasks_failed;
    totalConflicts += s.conflicts_open;
  }

  // Fallback: no registry projects — show legacy queryProjectSummary
  // against the default DB so the tray is still meaningful for users
  // who haven't configured anything yet.
  if (!aggAvailable) {
    const fallbackEntry = activeDbEntry();
    if (fallbackEntry) {
      const s = queries.queryProjectSummary(
        fallbackEntry.db, fallbackEntry.tables, activeDbPath(),
      );
      worst = deriveTrayState(s);
      totalAgents    = s.agents_active;
      totalBlockers  = s.blockers_open;
      totalFail      = s.outcomes_failed;
      totalConflicts = s.conflicts_open;
      aggAvailable   = s.available;
    }
  }

  if (worst !== lastTrayState) {
    tray.setImage(TRAY_IMAGES[worst]);
    lastTrayState = worst;
  }

  if (!aggAvailable) {
    tray.setToolTip('Cairn — DB unavailable');
  } else {
    tray.setToolTip(
      `Cairn — ${totalAgents} agents · ${totalBlockers} blockers · ` +
      `${totalFail} FAIL · ${totalConflicts} conflicts`,
    );
  }
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
// IPC — Project-Aware (L1 + project-scoped views)
// ---------------------------------------------------------------------------

/**
 * Build the L1 Projects-list payload: per-project scoped summary +
 * one Unassigned bucket per unique db_path.
 */
function getProjectsList() {
  const hintsByDb = registry.hintsByDbPath(reg);
  const projects = reg.projects.map(p => {
    const entry = ensureDbHandle(p.db_path);
    if (!entry) {
      return {
        id: p.id, label: p.label, project_root: p.project_root,
        db_path: p.db_path, agent_id_hints: p.agent_id_hints,
        last_opened_at: p.last_opened_at, summary: null,
      };
    }
    const summary = projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, p.db_path, p.agent_id_hints,
    );
    return {
      id: p.id, label: p.label, project_root: p.project_root,
      db_path: p.db_path, agent_id_hints: p.agent_id_hints,
      last_opened_at: p.last_opened_at, summary,
    };
  });

  // One Unassigned bucket per unique db_path that registry references.
  // (DB paths with no registered project are not surfaced here — user
  // must register at least one project against that DB to see it.)
  const unassigned = [];
  for (const p of registry.uniqueDbPaths(reg)) {
    const entry = ensureDbHandle(p);
    if (!entry) continue;
    const allHints = hintsByDb.get(p) || new Set();
    const u = projectQueries.queryUnassignedSummary(entry.db, entry.tables, p, allHints);
    unassigned.push(u);
  }

  return { projects, unassigned };
}

ipcMain.handle('get-projects-list', () => getProjectsList());

ipcMain.handle('select-project', (_e, projectId) => {
  if (projectId === null) {
    selectedProjectId = null;
    return { ok: true, selected: null };
  }
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: `project not found: ${projectId}` };
  selectedProjectId = projectId;
  // Touch last_opened_at so L1 sort can prefer recently-used.
  reg = registry.touchProject(reg, projectId);
  return { ok: true, selected: { id: proj.id, label: proj.label } };
});

ipcMain.handle('get-selected-project', () => {
  const proj = activeProject();
  return proj
    ? { id: proj.id, label: proj.label, project_root: proj.project_root, db_path: proj.db_path, agent_id_hints: proj.agent_id_hints }
    : null;
});

ipcMain.handle('add-project', async (_e, input) => {
  let project_root = input && typeof input.project_root === 'string' ? input.project_root : '';
  let db_path      = input && typeof input.db_path === 'string'      ? input.db_path      : '';
  const label      = input && typeof input.label === 'string'        ? input.label        : '';

  if (!project_root) {
    const result = await dialog.showOpenDialog({
      title: 'Choose project root folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, error: 'cancelled' };
    }
    project_root = result.filePaths[0];
  }
  if (!db_path) {
    // Default: <project_root>/.cairn/cairn.db if it exists, else ~/.cairn/cairn.db
    const local = path.join(project_root, '.cairn', 'cairn.db');
    db_path = fs.existsSync(local) ? local : registry.DEFAULT_DB_PATH;
  }

  const result = registry.addProject(reg, { project_root, db_path, label });
  reg = result.reg;
  ensureDbHandle(db_path); // open the handle eagerly so L1 can render
  return { ok: true, entry: result.entry };
});

ipcMain.handle('remove-project', (_e, id) => {
  if (selectedProjectId === id) selectedProjectId = null;
  reg = registry.removeProject(reg, id);
  gcDbHandles();
  return { ok: true };
});

ipcMain.handle('rename-project', (_e, id, label) => {
  reg = registry.renameProject(reg, id, label);
  return { ok: true };
});

ipcMain.handle('add-hint', (_e, id, agentId) => {
  reg = registry.addHint(reg, id, agentId);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// IPC — panel views (legacy + Quick-Slice; route through active project)
// ---------------------------------------------------------------------------
//
// These channels don't take a projectId and continue working as in
// Quick Slice. They route to the active project's db_path (or default
// if no project selected). For project-scoped summary they apply the
// active project's hints; for Run Log / Tasks they currently return
// DB-wide data (per-project filtering for those is Day 3+ work).

ipcMain.handle('get-project-summary', () => {
  const entry = activeDbEntry();
  if (!entry) return projectQueries.queryProjectScopedSummary(null, new Set(), activeDbPath(), []);
  const proj = activeProject();
  if (proj) {
    return projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, proj.db_path, proj.agent_id_hints,
    );
  }
  // No project selected — fall back to the legacy unscoped summary
  // (so the panel never shows a misleading per-project zero-state when
  // nothing is selected yet).
  return queries.queryProjectSummary(entry.db, entry.tables, activeDbPath());
});

ipcMain.handle('get-tasks-list', () => {
  const entry = activeDbEntry();
  if (!entry) return [];
  return queries.queryTasksList(entry.db, entry.tables);
});

ipcMain.handle('get-task-detail', (_e, taskId) => {
  const entry = activeDbEntry();
  if (!entry) return null;
  return queries.queryTaskDetail(entry.db, entry.tables, taskId);
});

ipcMain.handle('get-run-log-events', () => {
  const entry = activeDbEntry();
  if (!entry) return [];
  return queries.queryRunLogEvents(entry.db, entry.tables);
});

ipcMain.handle('get-db-path', () => activeDbPath());

ipcMain.handle('set-db-path', async (_e, _requestedPath) => {
  // Project-Aware reframe: there's no "current DB path" any more —
  // a project's db_path is fixed at registry-add time. Tell the
  // renderer to use add-project instead.
  return {
    ok: false,
    error: 'set-db-path is deprecated; use add-project (with project_root) instead',
  };
});

ipcMain.on('open-legacy-inspector', () => createLegacyWindow());

// ---------------------------------------------------------------------------
// IPC — legacy / pet channels (unchanged shape; routed to active DB)
// ---------------------------------------------------------------------------

ipcMain.handle('get-state', () => {
  const e = activeDbEntry();
  return queries.queryLegacyState(e ? e.db : null, e ? e.tables : new Set());
});
ipcMain.handle('get-active-agents', () => {
  const e = activeDbEntry();
  return queries.queryActiveAgents(e ? e.db : null, e ? e.tables : new Set());
});
ipcMain.handle('get-open-conflicts', () => {
  const e = activeDbEntry();
  return queries.queryOpenConflicts(e ? e.db : null, e ? e.tables : new Set());
});
ipcMain.handle('get-recent-dispatches', () => {
  const e = activeDbEntry();
  return queries.queryRecentDispatches(e ? e.db : null, e ? e.tables : new Set());
});
ipcMain.handle('get-active-lanes', () => {
  const e = activeDbEntry();
  return queries.queryActiveLanes(e ? e.db : null, e ? e.tables : new Set());
});

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
    const targetDbPath = activeDbPath();
    if (!targetDbPath) return { ok: false, error: 'no DB connected' };
    try {
      const wdb = openWriteDb(targetDbPath);
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
  // Load (or bootstrap) the registry, then open one read handle per
  // unique db_path. The legacy desktop-shell.json is read by registry
  // bootstrap if projects.json doesn't exist yet, producing a single
  // legacy-default entry pointing at the old dbPath.
  reg = registry.loadRegistry();
  openAllRegistryDbs();
  // No project selected at boot — panel opens to L1 view.
  selectedProjectId = null;

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
    `tray=on projects=${reg.projects.length} dbs=${dbHandles.size}`
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
  // Close every read + write handle to release file locks on Windows.
  for (const entry of dbHandles.values()) {
    try { entry.db.close(); } catch (_e) {}
  }
  dbHandles.clear();
  for (const w of writeHandles.values()) {
    try { w.close(); } catch (_e) {}
  }
  writeHandles.clear();
});
