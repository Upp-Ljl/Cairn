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
const { execFileSync } = require('child_process');

/**
 * Resolve `dir` to its git toplevel if `dir` is inside a git work tree.
 * Mirrors mcp-server's workspace canonicalization (sha1(host:topLevel))
 * so a project_root saved by desktop-shell yields the same SESSION_AGENT_ID
 * mcp-server will compute when run from the same directory. Returns the
 * input unchanged on any error or timeout (1s).
 */
function canonicalizeToGitToplevel(dir) {
  if (!dir || typeof dir !== 'string') return dir;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      encoding: 'utf8',
    });
    const top = (out || '').trim();
    if (top) return path.normalize(top);
  } catch (_e) { /* not a git repo, git missing, or timeout — fall through */ }
  return dir;
}

const queries = require('./queries.cjs');
const registry = require('./registry.cjs');
const projectQueries = require('./project-queries.cjs');
const claudeSessionScan = require('./agent-adapters/claude-code-session-scan.cjs');
const codexSessionScan  = require('./agent-adapters/codex-session-log-scan.cjs');
const agentActivity     = require('./agent-activity.cjs');
const goalSignals       = require('./goal-signals.cjs');
const goalInterpretation = require('./goal-interpretation.cjs');
const llmClient         = require('./llm-client.cjs');
const workerReports     = require('./worker-reports.cjs');
const prePrGate         = require('./pre-pr-gate.cjs');
const goalLoopPromptPack = require('./goal-loop-prompt-pack.cjs');
const recoverySummary    = require('./recovery-summary.cjs');
const coordinationSignals = require('./coordination-signals.cjs');
const managedLoopHandlers = require('./managed-loop-handlers.cjs');
const mentorHandler = require('./mentor-handler.cjs');

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

// ---------------------------------------------------------------------------
// Frameless side-panel geometry + slide animation (Day 4)
// ---------------------------------------------------------------------------
//
// Goal: the panel reads as a real desktop side-panel — frameless,
// right-edge attached, full work-area height, slides in/out from the
// right. The custom titlebar lives in panel.html (-webkit-app-region:
// drag); main owns geometry + animation + show/hide lifecycle.
//
// Animation: 12 steps × 20ms = 240ms total. easeOutCubic.
// On Windows setBounds in a tight setInterval is occasionally janky on
// composited displays; if we ever observe it we can fall back to
// instant show/hide by setting PANEL_ANIM_STEPS = 1 — same code path.

const PANEL_WIDTH      = 500;
const PANEL_ANIM_STEPS = 12;
const PANEL_ANIM_MS    = 240;

/** @type {NodeJS.Timeout|null} */
let panelAnimTimer = null;

function rightEdgeBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - PANEL_WIDTH,
    y: wa.y,
    width: PANEL_WIDTH,
    height: wa.height,
  };
}

function offscreenBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width, // entirely off the right edge
    y: wa.y,
    width: PANEL_WIDTH,
    height: wa.height,
  };
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function cancelPanelAnim() {
  if (panelAnimTimer) {
    clearInterval(panelAnimTimer);
    panelAnimTimer = null;
  }
}

function animatePanelTo(targetX, doneFn) {
  if (!panelWindow) return;
  cancelPanelAnim();
  const start = panelWindow.getBounds();
  const dx = targetX - start.x;
  if (PANEL_ANIM_STEPS <= 1 || dx === 0) {
    panelWindow.setBounds({ x: targetX, y: start.y, width: start.width, height: start.height });
    if (doneFn) doneFn();
    return;
  }
  let step = 0;
  panelAnimTimer = setInterval(() => {
    step++;
    const t = step / PANEL_ANIM_STEPS;
    const x = Math.round(start.x + dx * easeOutCubic(t));
    try {
      panelWindow.setBounds({ x, y: start.y, width: start.width, height: start.height });
    } catch (_e) { /* window may have been destroyed mid-animation */ }
    if (step >= PANEL_ANIM_STEPS) {
      cancelPanelAnim();
      try {
        if (panelWindow) {
          panelWindow.setBounds({ x: targetX, y: start.y, width: start.width, height: start.height });
        }
      } catch (_e) {}
      if (doneFn) doneFn();
    }
  }, PANEL_ANIM_MS / PANEL_ANIM_STEPS);
}

function showPanelSlide() {
  if (!panelWindow) {
    createPanelWindow(); // ready-to-show will trigger this same path
    return;
  }
  cancelPanelAnim();
  const onR = rightEdgeBounds();
  const off = offscreenBounds();
  // Make sure we start fully off-screen before show, otherwise the OS
  // briefly paints the panel at its last position.
  panelWindow.setBounds(off);
  if (!panelWindow.isVisible()) panelWindow.show();
  panelWindow.focus();
  animatePanelTo(onR.x);
}

function hidePanelSlide() {
  if (!panelWindow || !panelWindow.isVisible()) return;
  cancelPanelAnim();
  const off = offscreenBounds();
  animatePanelTo(off.x, () => {
    if (panelWindow) {
      try { panelWindow.hide(); } catch (_e) {}
    }
  });
}

function createPanelWindow() {
  if (panelWindow) {
    showPanelSlide();
    return;
  }
  // Start off-screen; ready-to-show triggers slide-in to right-edge.
  const off = offscreenBounds();
  panelWindow = new BrowserWindow({
    x: off.x, y: off.y, width: off.width, height: off.height,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,         // tray + marker are the entry points
    show: false,
    title: 'Cairn',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWindow.loadFile('panel.html');

  panelWindow.once('ready-to-show', () => {
    showPanelSlide();
  });

  // Alt-F4 / programmatic .close() must hide instead of destroy, so the
  // tray + marker remain meaningful entry points and quit only runs via
  // the tray Quit item (which flips isQuitting).
  panelWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      hidePanelSlide();
    }
  });
  panelWindow.on('closed', () => {
    cancelPanelAnim();
    panelWindow = null;
  });
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
  if (!panelWindow) {
    createPanelWindow();
    return;
  }
  if (panelWindow.isVisible() && panelWindow.isFocused()) {
    hidePanelSlide();
  } else if (panelWindow.isVisible()) {
    panelWindow.focus();
  } else {
    showPanelSlide();
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
  let totalBlockers = 0, totalFail = 0, totalConflicts = 0;
  let aggAvailable = false;

  // Single scan per source per tray refresh.
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const codexAll  = codexSessionScan.scanCodexSessions();

  // Aggregate AgentActivity across all projects + (when relevant) the
  // primary Unassigned bucket so the tooltip can speak in product
  // language ("3 live agents · 2 recent") instead of per-source counts.
  /** @type {Array<object>} */
  const allActivities = [];

  for (const p of reg.projects) {
    const entry = ensureDbHandle(p.db_path);
    if (!entry) continue;
    aggAvailable = true;
    const agentIds = projectQueries.resolveProjectAgentIds(
      entry.db, entry.tables, p,
    );
    const s = projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, p.db_path, agentIds,
    );
    if (s.health === 'alert') worst = 'alert';
    else if (s.health === 'warn' && worst !== 'alert') worst = 'warn';
    totalBlockers  += s.blockers_open;
    totalFail      += s.outcomes_failed + s.tasks_failed;
    totalConflicts += s.conflicts_open;

    const mcpForActivity = buildMcpActivityRows(entry.db, entry.tables, p, agentIds);
    const built = agentActivity.buildProjectActivities(
      p, mcpForActivity, claudeAll, codexAll,
      { claude: claudeSessionScan, codex: codexSessionScan },
    );
    for (const a of built.activities) allActivities.push(a);
  }

  // Fallback: no registry projects — show legacy queryProjectSummary
  // against the default DB so the tray is still meaningful for users
  // who haven't configured anything yet, plus surface global Claude /
  // Codex activities so the tooltip lights up even before the user
  // registers their first project.
  if (!aggAvailable) {
    const fallbackEntry = activeDbEntry();
    if (fallbackEntry) {
      const s = queries.queryProjectSummary(
        fallbackEntry.db, fallbackEntry.tables, activeDbPath(),
      );
      worst = deriveTrayState(s);
      totalBlockers  = s.blockers_open;
      totalFail      = s.outcomes_failed;
      totalConflicts = s.conflicts_open;
      aggAvailable   = s.available;

      // Treat every Claude/Codex row as Unassigned in this branch
      // (there are no projects to attribute to). MCP rows: skip — we
      // don't have a project context to compute attribution against.
      const builtU = agentActivity.buildUnassignedActivities([], claudeAll, codexAll);
      for (const a of builtU.activities) allActivities.push(a);
      if (builtU.summary.total > 0) aggAvailable = true;
    }
  }

  if (worst !== lastTrayState) {
    tray.setImage(TRAY_IMAGES[worst]);
    lastTrayState = worst;
  }

  if (!aggAvailable) {
    tray.setToolTip('Cairn — DB unavailable');
  } else {
    const sum = agentActivity.summarizeActivities(allActivities);
    const live   = sum.by_family.live;
    const recent = sum.by_family.recent;
    // Tooltip language (PRODUCT MVP §0): product control surface, not a
    // "list of source counts". Lead with live + recent agent activity,
    // then the project-impact counts (blockers, FAIL, conflicts) the
    // tray icon color also encodes.
    const parts = [`Cairn — ${live} live agent${live === 1 ? '' : 's'}`];
    if (recent > 0) parts.push(`${recent} recent`);
    parts.push(`${totalBlockers} blocker${totalBlockers === 1 ? '' : 's'}`);
    parts.push(`${totalFail} FAIL`);
    parts.push(`${totalConflicts} conflict${totalConflicts === 1 ? '' : 's'}`);
    tray.setToolTip(parts.join(' · '));
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
 *
 * Real Agent Presence step 2: Claude Code session-file rows are folded
 * into each project's summary (and the unassigned bucket) so the L1 card
 * can show "agents MCP X · Claude Y" without the panel needing to make
 * a second IPC round-trip. Claude rows do not impersonate MCP rows: the
 * counts go into separate `claude_*` fields, never into `agents_active`.
 *
 * `last_activity_at` for a project incorporates Claude updated_at too,
 * so the L1 "last activity 8m ago" line stays accurate when only Claude
 * was active.
 */
function getProjectsList() {
  // One scan per IPC call. Each row is a small JSON read; cost is
  // dominated by directory enumeration, which is bounded by the number
  // of live Claude sessions (typically < 10). No caching needed yet.
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  // Codex sessions accumulate in dated subdirs — bounded by the
  // adapter's default 7-day window. Scan once per IPC call.
  const codexAll = codexSessionScan.scanCodexSessions();

  const projects = reg.projects.map(p => {
    const entry = ensureDbHandle(p.db_path);
    if (!entry) {
      return {
        id: p.id, label: p.label, project_root: p.project_root,
        db_path: p.db_path, agent_id_hints: p.agent_id_hints,
        last_opened_at: p.last_opened_at, summary: null,
      };
    }
    const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
    const summary = projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, p.db_path, agentIds,
    );

    const { matched: claudeForP } = claudeSessionScan.partitionByProject(claudeAll, p);
    foldClaudeIntoSummary(summary, claudeForP);

    const { matched: codexForP } = codexSessionScan.partitionByProject(codexAll, p);
    foldCodexIntoSummary(summary, codexForP);

    // Activity layer: build the unified row list for this project so the
    // L1 card and the tray can render headline counts in product
    // language ("3 live agents · 2 recent") instead of per-source
    // numbers. The legacy claude_*/codex_*/agents_active fields above
    // remain populated for the per-source breakdown line.
    const mcpForActivity = buildMcpActivityRows(entry.db, entry.tables, p, agentIds);
    const built = agentActivity.buildProjectActivities(
      p, mcpForActivity, claudeAll, codexAll,
      { claude: claudeSessionScan, codex: codexSessionScan },
    );
    summary.agent_activity = built.summary;

    return {
      id: p.id, label: p.label, project_root: p.project_root,
      db_path: p.db_path, agent_id_hints: p.agent_id_hints,
      last_opened_at: p.last_opened_at, summary,
    };
  });

  // One Unassigned bucket per unique db_path. Claude rows whose cwd
  // matches no registered project attach to the *primary* (first) bucket
  // only — same single-attach rule as get-unassigned-detail, so a
  // multi-DB user doesn't see the same Claude row counted twice. Codex
  // follows the identical rule for the same reason.
  const claudeUnassigned = claudeSessionScan.unassignedClaudeSessions(claudeAll, reg.projects);
  const codexUnassigned  = codexSessionScan.unassignedCodexSessions(codexAll, reg.projects);
  const dbPaths = registry.uniqueDbPaths(reg);
  const unassigned = [];
  for (const dbPath of dbPaths) {
    const entry = ensureDbHandle(dbPath);
    if (!entry) continue;
    const attributed = projectQueries.resolveAttributedAgentIdsForDb(
      entry.db, entry.tables, reg.projects, dbPath,
    );
    const u = projectQueries.queryUnassignedSummary(entry.db, entry.tables, dbPath, attributed);
    const isPrimaryBucket = dbPaths[0] === dbPath;
    foldClaudeIntoSummary(u, isPrimaryBucket ? claudeUnassigned : []);
    foldCodexIntoSummary(u,  isPrimaryBucket ? codexUnassigned  : []);

    // Activity summary for the Unassigned bucket: same shape as
    // projects so the panel's L1 renderer can iterate uniformly.
    const mcpForActivity = isPrimaryBucket
      ? buildMcpActivityRowsForUnassigned(entry.db, entry.tables, dbPath, attributed)
      : [];
    const builtU = agentActivity.buildUnassignedActivities(
      mcpForActivity,
      isPrimaryBucket ? claudeUnassigned : [],
      isPrimaryBucket ? codexUnassigned  : [],
    );
    u.agent_activity = builtU.summary;

    unassigned.push(u);
  }

  return { projects, unassigned };
}

/**
 * Pull MCP process rows attributable to a project AND mark each one
 * with the attribution route (capability vs hint). Returned shape
 * matches what queryProjectScopedSessions emits (agent_id, agent_type,
 * status, computed_state, last_heartbeat, heartbeat_ttl, capabilities,
 * registered_at, owns_tasks) plus an extra `_attribution` field that
 * agent-activity.cjs reads to fill the activity row.
 *
 * Cheap re-use: queryProjectScopedSessions already does the SQL +
 * computed_state derivation; here we only have to layer the
 * attribution decision on top.
 */
function buildMcpActivityRows(db, tables, project, agentIds) {
  const sess = projectQueries.queryProjectScopedSessions(db, tables, agentIds);
  const hints = (project && project.agent_id_hints) || [];
  for (const row of sess.sessions) {
    row._attribution = agentActivity.decideMcpAttribution(
      row.capabilities, project && project.project_root, hints, row.agent_id,
    );
  }
  return sess.sessions;
}

/**
 * Pull unassigned MCP rows for one db_path. Mirror of
 * buildMcpActivityRows but for the Unassigned bucket: anything in
 * processes whose agent_id is NOT in `attributedSet`. Each row is
 * marked with `_attribution: null` so the activity row carries the
 * "no attribution" signal cleanly.
 */
function buildMcpActivityRowsForUnassigned(db, tables, dbPath, attributedSet) {
  const detail = projectQueries.queryUnassignedDetail(db, tables, dbPath, attributedSet);
  for (const row of detail.agents) row._attribution = null;
  return detail.agents;
}

/**
 * Mutate `summary` in place to add Claude-Code presence counts.
 * Adds: `claude_busy`, `claude_idle`, `claude_dead`, `claude_unknown`,
 * `claude_total` (always; zero when none). Also bumps `last_activity_at`
 * if any Claude row is more recent than the existing value.
 *
 * Kept here (orchestration layer) rather than in project-queries.cjs
 * because Claude is a non-DB source and we want project-queries.cjs to
 * stay strictly about the Cairn SQLite schema.
 */
function foldClaudeIntoSummary(summary, claudeRows) {
  if (!summary) return;
  const c = claudeSessionScan.summarizeClaudeRows(claudeRows);
  summary.claude_busy    = c.busy;
  summary.claude_idle    = c.idle;
  summary.claude_dead    = c.dead;
  summary.claude_unknown = c.unknown;
  summary.claude_total   = c.total;
  if (c.last_activity_at && c.last_activity_at > (summary.last_activity_at || 0)) {
    summary.last_activity_at = c.last_activity_at;
  }
}

/**
 * Mutate `summary` in place to add Codex session-log presence counts.
 * Adds: `codex_recent`, `codex_inactive`, `codex_unknown`,
 * `codex_total` (always; zero when none). Also bumps `last_activity_at`
 * if any Codex row's mtime is more recent than the existing value.
 *
 * Kept here (orchestration layer) for the same reason as foldClaude:
 * Codex is a non-DB source and project-queries.cjs stays strictly about
 * the Cairn SQLite schema.
 */
function foldCodexIntoSummary(summary, codexRows) {
  if (!summary) return;
  const c = codexSessionScan.summarizeCodexRows(codexRows);
  summary.codex_recent   = c.recent;
  summary.codex_inactive = c.inactive;
  summary.codex_unknown  = c.unknown;
  summary.codex_total    = c.total;
  if (c.last_activity_at && c.last_activity_at > (summary.last_activity_at || 0)) {
    summary.last_activity_at = c.last_activity_at;
  }
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
  // Canonicalize: if the chosen folder lives inside a git work tree,
  // promote it to the toplevel so the auto-derived agent_id_hint matches
  // the SESSION_AGENT_ID mcp-server boots with from anywhere in the tree.
  // No-op (and silent) if git is missing, the dir isn't a repo, or the
  // probe times out at 1s.
  project_root = canonicalizeToGitToplevel(project_root);
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

// Register a project entry from a Claude/Codex Unassigned row's cwd.
//
// Why a dedicated channel and not just add-project({ project_root, db_path }):
//   - The starting point is a presence-row cwd we already know; the
//     caller doesn't want a folder-picker dialog and shouldn't have to
//     compute the canonical git-toplevel itself.
//   - We owe the user a clear "already registered" answer when the
//     canonical cwd matches an existing entry — silently no-op'ing
//     would confuse, and silently duplicating would create two project
//     cards pointing at the same tree.
//   - Real Agent Presence attribution rule: Claude / Codex rows match
//     by `cwd ⊆ project_root`, not by agent_id_hints. So this handler
//     deliberately does NOT add a hint — adding one would conflate
//     pre-v2 deterministic-id semantics with v2 capability/cwd-driven
//     attribution. The new entry comes up with hints=[] and the next
//     poll re-attributes Claude/Codex purely via cwd.
ipcMain.handle('register-project-from-cwd', (_e, cwd, dbPath) => {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { ok: false, error: 'cwd_required' };
  }
  const canonical = canonicalizeToGitToplevel(cwd);
  if (!canonical || canonical === '(unknown)') {
    return { ok: false, error: 'canonicalize_failed' };
  }
  const existing = registry.findProjectByRoot(reg, canonical);
  if (existing) {
    return {
      ok: false,
      error: 'already_registered',
      entry: { id: existing.id, label: existing.label, project_root: existing.project_root },
    };
  }
  const targetDb = (typeof dbPath === 'string' && dbPath.trim())
    ? dbPath
    : registry.DEFAULT_DB_PATH;
  const baseLabel = registry.defaultLabelFor(canonical);
  const label = registry.pickAvailableLabel(reg, baseLabel);

  // hints intentionally empty — see comment above. Claude / Codex
  // attribute via cwd, MCP via capability tags. Pre-v2 historical rows
  // can still be attached later via "Add to project…" on a session.
  const result = registry.addProject(reg, {
    project_root: canonical,
    db_path: targetDb,
    label,
    agent_id_hints: [],
  });
  reg = result.reg;
  ensureDbHandle(targetDb); // open the read handle eagerly so L1 can render
  return { ok: true, entry: result.entry };
});

// Project Goal (Goal Mode v1) — registry-only, no DB writes.
//
// Cairn does NOT decide goals. These IPC handlers persist user-authored
// goals into ~/.cairn/projects.json. The goal becomes input to the
// LLM Interpretation layer, but the goal itself is never inferred from
// agent activity (PRODUCT.md §1.3 #4 / §7 principle 2).
ipcMain.handle('get-project-goal', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  return registry.getProjectGoal(reg, projectId);
});

ipcMain.handle('set-project-goal', (_e, projectId, input) => {
  if (!projectId || typeof projectId !== 'string') {
    return { ok: false, error: 'projectId_required' };
  }
  const result = registry.setProjectGoal(reg, projectId, input || {});
  if (result.error) return { ok: false, error: result.error };
  reg = result.reg;
  return { ok: true, goal: result.goal };
});

// Project Rules — registry-only governance layer.
//
// Cairn does not enforce rules; they're advisory inputs to Pre-PR
// Gate / Interpretation / Goal Loop Prompt Pack. setProjectRules
// rejects an all-empty payload (use clear-project-rules instead) so
// "" never silently overwrites a real ruleset.
ipcMain.handle('get-project-rules', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  return registry.getProjectRules(reg, projectId);
});

ipcMain.handle('get-effective-project-rules', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  return registry.getEffectiveProjectRules(reg, projectId);
});

ipcMain.handle('set-project-rules', (_e, projectId, input) => {
  if (!projectId || typeof projectId !== 'string') {
    return { ok: false, error: 'projectId_required' };
  }
  const result = registry.setProjectRules(reg, projectId, input || {});
  if (result.error) return { ok: false, error: result.error };
  reg = result.reg;
  return { ok: true, rules: result.rules };
});

ipcMain.handle('clear-project-rules', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') {
    return { ok: false, error: 'projectId_required' };
  }
  const result = registry.clearProjectRules(reg, projectId);
  reg = result.reg;
  return { ok: true, cleared: result.cleared };
});

ipcMain.handle('clear-project-goal', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') {
    return { ok: false, error: 'projectId_required' };
  }
  const result = registry.clearProjectGoal(reg, projectId);
  reg = result.reg;
  return { ok: true, cleared: result.cleared };
});

ipcMain.handle('add-hint', (_e, id, agentId) => {
  if (!agentId || typeof agentId !== 'string') return { ok: false, error: 'invalid agent_id' };
  const proj = reg.projects.find(p => p.id === id);
  if (!proj) return { ok: false, error: `project not found: ${id}` };
  const already = proj.agent_id_hints.includes(agentId);
  reg = registry.addHint(reg, id, agentId);
  return { ok: true, already };
});

// L2 Sessions tab — presence rows attributed to the active project.
//
// Composition (Real Agent Presence step 2, 2026-05-08):
//   1. MCP rows from Cairn's `processes` table, filtered by hints ∪
//      capability matches (project-queries.cjs).
//   2. Claude Code session-file rows from ~/.claude/sessions/<pid>.json,
//      filtered by `cwd ⊆ project_root` (claude-code-session-scan.cjs).
// Both flows are read-only. MCP rows keep their existing schema; Claude
// rows carry a `source: "claude-code/session-file"` tag so the renderer
// can pick the right row template. We do NOT write Claude rows into the
// processes table — that would be a fake heartbeat the daemon never
// asked for, and it would survive past the Claude session's lifetime.
ipcMain.handle('get-project-sessions', () => {
  const proj = activeProject();
  if (!proj) return {
    available: false, sessions: [],
    activities: [], activity_summary: agentActivity.summarizeActivities([]),
    ts: Math.floor(Date.now() / 1000),
  };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return {
    available: false, sessions: [],
    activities: [], activity_summary: agentActivity.summarizeActivities([]),
    ts: Math.floor(Date.now() / 1000),
  };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const mcp = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);

  // Claude Code: scan host-level session files, attribute by cwd.
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const { matched: claudeForProject } = claudeSessionScan.partitionByProject(claudeAll, proj);

  // Codex CLI / Codex Desktop: same model — host-level rollout files,
  // attribute by cwd. Status semantics differ (recent / inactive /
  // unknown) so the renderer keeps the two sources visually distinct.
  const codexAll = codexSessionScan.scanCodexSessions();
  const { matched: codexForProject } = codexSessionScan.partitionByProject(codexAll, proj);

  // Activity layer: build the unified row list. mcp.sessions rows get
  // tagged with `_attribution` first so each AgentActivity carries
  // attribution = "capability" | "hint".
  const hints = (proj && proj.agent_id_hints) || [];
  for (const row of mcp.sessions) {
    row._attribution = agentActivity.decideMcpAttribution(
      row.capabilities, proj.project_root, hints, row.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    proj, mcp.sessions, claudeAll, codexAll,
    { claude: claudeSessionScan, codex: codexSessionScan },
  );

  return {
    available: mcp.available || claudeAll.length > 0 || codexAll.length > 0,
    ts: mcp.ts,
    // Legacy per-source fields kept populated for any reader that hasn't
    // migrated to `activities`. The renderer now consumes `activities`
    // as the canonical view; per-source rows remain reachable via
    // detail.expanded breakdown.
    sessions: mcp.sessions,
    claude_sessions: claudeForProject,
    codex_sessions:  codexForProject,
    // Unified activity view — the canonical Sessions tab feed.
    activities: built.activities,
    activity_summary: built.summary,
  };
});

// Unassigned drill-down — keyed by db_path so a user inspecting one DB's
// Unassigned bucket gets a stable view regardless of which project is
// currently selected for L2.
ipcMain.handle('get-unassigned-detail', (_e, dbPath) => {
  if (!dbPath || typeof dbPath !== 'string') return null;
  const entry = ensureDbHandle(dbPath);
  if (!entry) return null;
  const attributed = projectQueries.resolveAttributedAgentIdsForDb(
    entry.db, entry.tables, reg.projects, dbPath,
  );
  const detail = projectQueries.queryUnassignedDetail(entry.db, entry.tables, dbPath, attributed);

  // Claude Code: surface sessions whose cwd is in NO registered project.
  // This is global (not per-db) so we only attach when the user is on
  // the *first* Unassigned card — otherwise duplicate cards on multi-DB
  // setups would each show the same Claude rows. Heuristic: attach to
  // the bucket whose db_path equals the first registry db_path, or the
  // single bucket when there is only one. Day-1 simplification; the
  // panel doesn't yet model "Claude sessions are not really a per-DB
  // thing" but this avoids duplication today.
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const claudeUnassigned = claudeSessionScan.unassignedClaudeSessions(claudeAll, reg.projects);
  const codexAll = codexSessionScan.scanCodexSessions();
  const codexUnassigned = codexSessionScan.unassignedCodexSessions(codexAll, reg.projects);
  const dbPaths = registry.uniqueDbPaths(reg);
  const isPrimaryBucket = dbPaths.length === 0
    || dbPaths[0] === dbPath;
  detail.claude_sessions = isPrimaryBucket ? claudeUnassigned : [];
  detail.codex_sessions  = isPrimaryBucket ? codexUnassigned  : [];

  // Activity layer for the Unassigned bucket. MCP rows are
  // detail.agents (queryUnassignedDetail already filtered to unassigned
  // agent_ids); we tag them with attribution=null and feed them
  // through buildUnassignedActivities together with the claude/codex
  // rows for THIS bucket only (multi-DB de-dup is already enforced
  // above by the isPrimaryBucket gate).
  for (const row of detail.agents) row._attribution = null;
  const built = agentActivity.buildUnassignedActivities(
    detail.agents,
    isPrimaryBucket ? claudeUnassigned : [],
    isPrimaryBucket ? codexUnassigned  : [],
  );
  detail.activities = built.activities;
  detail.activity_summary = built.summary;
  return detail;
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

// ---------------------------------------------------------------------------
// Goal Interpretation — advisory LLM layer (Goal Mode v1)
// ---------------------------------------------------------------------------
//
// In-memory cache so the panel's 1s poll doesn't hammer the provider.
// `get-goal-interpretation` returns the cached value (or null);
// `refresh-goal-interpretation` is the only path that actually calls
// the LLM. Cache lives only in this process — never persisted.

/** @type {Map<string, { result: object, generated_at: number }>} */
const interpretationCache = new Map();
const INTERPRETATION_CACHE_TTL_MS = 5 * 60 * 1000; // best-effort, not load-bearing

function buildInterpretationInput(proj, entry, agentIds) {
  const summary = projectQueries.queryProjectScopedSummary(
    entry.db, entry.tables, proj.db_path, agentIds,
  );
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const codexAll  = codexSessionScan.scanCodexSessions();
  const { matched: claudeForP } = claudeSessionScan.partitionByProject(claudeAll, proj);
  const { matched: codexForP }  = codexSessionScan.partitionByProject(codexAll, proj);
  foldClaudeIntoSummary(summary, claudeForP);
  foldCodexIntoSummary(summary, codexForP);
  const mcpForActivity = buildMcpActivityRows(entry.db, entry.tables, proj, agentIds);
  const built = agentActivity.buildProjectActivities(
    proj, mcpForActivity, claudeAll, codexAll,
    { claude: claudeSessionScan, codex: codexSessionScan },
  );
  summary.agent_activity = built.summary;

  const pulse = goalSignals.deriveProjectPulse(summary, built.activities, {});
  const goal = registry.getProjectGoal(reg, proj.id);
  // Worker Reports — only counts/titles flow through; LLM never
  // sees the report body via the interpretation path (the privacy
  // boundary is in goal-interpretation.cjs::buildCompactState).
  const recentReports = workerReports.listWorkerReports(proj.id, 5);
  // Project rules (governance v1) — effective ruleset (user-set or
  // default). buildCompactState produces a `rules_summary` envelope
  // that's safe to send to the LLM (counts + top items + non_goals,
  // capped widths).
  const effRules = registry.getEffectiveProjectRules(reg, proj.id);

  return {
    goal,
    pulse,
    activity_summary: built.summary,
    top_activities: built.activities.slice(0, 6),
    tasks_summary: {
      running:        summary.tasks_running,
      blocked:        summary.tasks_blocked,
      waiting_review: summary.tasks_waiting_review,
      failed:         summary.tasks_failed,
      done:           0, // not currently tracked in summary
    },
    blockers_summary: { open: summary.blockers_open },
    outcomes_summary: {
      failed:  summary.outcomes_failed,
      pending: summary.outcomes_pending,
    },
    checkpoints_summary: null, // not in summary; left null for v1
    recent_reports: recentReports,
    project_rules: effRules.rules,
    project_rules_is_default: effRules.is_default,
  };
}

ipcMain.handle('get-goal-interpretation', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  const cached = interpretationCache.get(projectId);
  if (cached && (Date.now() - cached.generated_at) < INTERPRETATION_CACHE_TTL_MS) {
    return cached.result;
  }
  return cached ? cached.result : null; // stale cache is OK; refresh is explicit
});

ipcMain.handle('refresh-goal-interpretation', async (_e, projectId, opts) => {
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const input = buildInterpretationInput(proj, entry, agentIds);
  const force = !!(opts && opts.forceDeterministic);
  const result = await goalInterpretation.interpretGoal(input, {
    forceDeterministic: force,
  });
  interpretationCache.set(projectId, {
    result,
    generated_at: Date.now(),
  });
  return { ok: true, result };
});

// Provider describe-self (NEVER includes the api key).
ipcMain.handle('get-llm-provider-info', () => {
  return llmClient.describeProvider(llmClient.loadProvider());
});

// ---------------------------------------------------------------------------
// Worker Reports (Phase 3)
// ---------------------------------------------------------------------------
//
// Local, append-only, project-scoped. Storage lives at
// ~/.cairn/project-reports/<projectId>.jsonl. Cairn does NOT auto-
// extract reports from running agent transcripts; the user (or a
// friendly agent that already produced a structured summary) drops
// reports in via this IPC. The Goal Interpretation layer only ever
// sees title + counts (see goal-interpretation.cjs::buildCompactState).

ipcMain.handle('add-worker-report', (_e, projectId, input) => {
  const o = (input && typeof input === 'object') ? input : {};
  // Optional pre-parse: caller may pass `text` instead of structured
  // fields. parseReportText handles common markdown layouts.
  let parsed = null;
  if (typeof o.text === 'string' && o.text.trim()) {
    parsed = workerReports.parseReportText(o.text);
  }
  const merged = Object.assign({}, parsed || {}, {
    title:            o.title            || (parsed && parsed.title)            || '',
    source_app:       o.source_app       || (parsed && parsed.source_app)       || '',
    session_id:       o.session_id       || (parsed && parsed.session_id)       || null,
    agent_id:         o.agent_id         || (parsed && parsed.agent_id)         || null,
    completed:        o.completed        || (parsed && parsed.completed)        || [],
    remaining:        o.remaining        || (parsed && parsed.remaining)        || [],
    blockers:         o.blockers         || (parsed && parsed.blockers)         || [],
    next_steps:       o.next_steps       || (parsed && parsed.next_steps)       || [],
    needs_human:      typeof o.needs_human === 'boolean' ? o.needs_human
                      : (parsed ? parsed.needs_human : false),
    related_task_ids: o.related_task_ids || (parsed && parsed.related_task_ids) || [],
  });
  return workerReports.addWorkerReport(projectId, merged);
});

ipcMain.handle('list-worker-reports', (_e, projectId, limit) => {
  return workerReports.listWorkerReports(projectId, limit);
});

ipcMain.handle('clear-worker-reports', (_e, projectId) => {
  return workerReports.clearWorkerReports(projectId);
});

// ---------------------------------------------------------------------------
// Pre-PR Gate (advisory only)
// ---------------------------------------------------------------------------
//
// Reuses the buildInterpretationInput pipeline + adds a `summary`
// field for the gate's deterministic rules. Cached the same way as
// goal interpretation: get-* returns the cached value (or null);
// refresh-* is the only path that actually evaluates / calls LLM.

/** @type {Map<string, { result: object, generated_at: number }>} */
const prePrGateCache = new Map();

function buildPrePrGateInput(proj, entry, agentIds) {
  // Same shape as buildInterpretationInput — the gate consumes
  // goal + pulse + activity_summary + recent_reports + a flat
  // summary field (counts) + project_rules (governance v1).
  const interpInput = buildInterpretationInput(proj, entry, agentIds);
  const summary = projectQueries.queryProjectScopedSummary(
    entry.db, entry.tables, proj.db_path, agentIds,
  );
  // Effective rules: user-set if present, else the default ruleset.
  // The is_default flag tells the gate to tag default-derived
  // checklist items with " [default]" so the user can see what's
  // theirs vs the floor.
  const effRules = registry.getEffectiveProjectRules(reg, proj.id);
  return Object.assign({}, interpInput, {
    summary,
    project_rules: effRules.rules,
    project_rules_is_default: effRules.is_default,
  });
}

ipcMain.handle('get-pre-pr-gate', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  const cached = prePrGateCache.get(projectId);
  return cached ? cached.result : null;
});

ipcMain.handle('refresh-pre-pr-gate', async (_e, projectId, opts) => {
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const input = buildPrePrGateInput(proj, entry, agentIds);
  const force = !!(opts && opts.forceDeterministic);
  const result = await prePrGate.evaluatePrePrGate(input, {
    forceDeterministic: force,
  });
  prePrGateCache.set(projectId, {
    result,
    generated_at: Date.now(),
  });
  return { ok: true, result };
});

// ---------------------------------------------------------------------------
// Goal Loop Prompt Pack — copy-pasteable next-round prompt
// ---------------------------------------------------------------------------
//
// User clicks "Generate next worker prompt" in the panel; we build a
// pack from current state and (optionally) ask the LLM to rephrase
// non-binding sections. Cairn never sends the prompt to an agent —
// the user copies it themselves.

/** @type {Map<string, { result: object, generated_at: number }>} */
const promptPackCache = new Map();

ipcMain.handle('get-prompt-pack', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  const cached = promptPackCache.get(projectId);
  return cached ? cached.result : null;
});

// ---------------------------------------------------------------------------
// Recovery surface (UI hardening — checkpoint visibility)
// ---------------------------------------------------------------------------
//
// Read-only — uses queryProjectScopedCheckpoints against the existing
// `checkpoints` table; no writes. The card is the first time the
// panel exposes Cairn's checkpoint primitive to the user. Per
// PRODUCT.md §1.3 #4 the panel does not execute rewind; users get
// "copy recovery prompt" only.

// ---------------------------------------------------------------------------
// Handoff (scratchpad) + Conflict surface (Coordination Surface Pass)
// ---------------------------------------------------------------------------

ipcMain.handle('get-project-scratchpad', (_e, projectId, limit) => {
  if (!projectId || typeof projectId !== 'string') return [];
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return [];
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return [];
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  return projectQueries.queryProjectScopedScratchpad(
    entry.db, entry.tables, agentIds, limit || 30,
  );
});

ipcMain.handle('get-project-conflicts', (_e, projectId, limit) => {
  if (!projectId || typeof projectId !== 'string') return [];
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return [];
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return [];
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  return projectQueries.queryProjectScopedConflicts(
    entry.db, entry.tables, agentIds, limit || 30,
  );
});

// ---------------------------------------------------------------------------
// Coordination signals — derived view for the panel + prompt pack
// ---------------------------------------------------------------------------

function buildCoordinationInput(proj, entry, agentIds) {
  const summary = projectQueries.queryProjectScopedSummary(
    entry.db, entry.tables, proj.db_path, agentIds,
  );
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const codexAll  = codexSessionScan.scanCodexSessions();
  const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
  for (const r of sess.sessions) {
    r._attribution = agentActivity.decideMcpAttribution(
      r.capabilities, proj.project_root, proj.agent_id_hints || [], r.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    proj, sess.sessions, claudeAll, codexAll,
    { claude: claudeSessionScan, codex: codexSessionScan },
  );
  summary.agent_activity = built.summary;
  const tasksPayload   = projectQueries.queryProjectScopedTasks(entry.db, entry.tables, agentIds);
  const blockers       = projectQueries.queryProjectScopedBlockers(entry.db, entry.tables, agentIds, 50);
  const outcomes       = projectQueries.queryProjectScopedOutcomes(entry.db, entry.tables, agentIds, 50);
  const checkpoints    = projectQueries.queryProjectScopedCheckpoints(entry.db, entry.tables, agentIds, 50);
  const scratchpad     = projectQueries.queryProjectScopedScratchpad(entry.db, entry.tables, agentIds, 30);
  const conflicts      = projectQueries.queryProjectScopedConflicts(entry.db, entry.tables, agentIds, 30);
  const recentReports  = workerReports.listWorkerReports(proj.id, 5);
  const goal           = registry.getProjectGoal(reg, proj.id);
  const effRules       = registry.getEffectiveProjectRules(reg, proj.id);

  return {
    activities: built.activities,
    summary,
    tasks: tasksPayload.tasks,
    blockers,
    outcomes,
    checkpoints,
    scratchpad,
    conflicts,
    recent_reports: recentReports,
    goal,
    project_rules: effRules.rules,
    project_rules_is_default: effRules.is_default,
  };
}

ipcMain.handle('get-coordination-signals', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return null;
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return null;
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const input = buildCoordinationInput(proj, entry, agentIds);
  return coordinationSignals.deriveCoordinationSignals(input, {});
});

ipcMain.handle('get-handoff-prompt', (_e, projectId, opts) => {
  if (!projectId || typeof projectId !== 'string') return { ok: false, error: 'projectId_required' };
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const o = opts || {};
  const taskId = typeof o.task_id === 'string' ? o.task_id : null;
  const includeContext = !!o.include_context;
  const ckpts = projectQueries.queryProjectScopedCheckpoints(entry.db, entry.tables, agentIds, 50);
  const scratchpad = projectQueries.queryProjectScopedScratchpad(entry.db, entry.tables, agentIds, 20);
  const reports = workerReports.listWorkerReports(proj.id, 3);
  const tasks = projectQueries.queryProjectScopedTasks(entry.db, entry.tables, agentIds).tasks;
  const targetTask = taskId ? tasks.find(t => t.task_id === taskId) : null;
  const prompt = coordinationSignals.handoffPromptText
    ? coordinationSignals.handoffPromptText(/* unused */)
    : null; // legacy guard; the actual builder lives below
  // We compose the handoff prompt inline (rather than in
  // coordination-signals.cjs) because it pulls from project state and
  // is intentionally the panel's job, not a pure-derivation module's.
  return {
    ok: true,
    prompt: composeHandoffPrompt({
      project_label: proj.label,
      goal: registry.getProjectGoal(reg, proj.id),
      target_task: targetTask,
      latest_checkpoints: ckpts.slice(0, 3),
      latest_scratchpad: includeContext ? scratchpad.slice(0, 5) : [],
      recent_reports: reports.slice(0, 2),
      include_full_context: includeContext,
    }),
  };
});

ipcMain.handle('get-conflict-prompt', (_e, projectId, conflictId) => {
  if (!projectId || typeof projectId !== 'string') return { ok: false, error: 'projectId_required' };
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const conflicts = projectQueries.queryProjectScopedConflicts(entry.db, entry.tables, agentIds, 50);
  const target = conflictId ? conflicts.find(c => c.id === conflictId) : conflicts.find(c => c.status === 'OPEN' || c.status === 'PENDING_REVIEW');
  if (!target) return { ok: false, error: 'no_conflict_found' };
  return {
    ok: true,
    prompt: composeConflictPrompt({ project_label: proj.label, conflict: target }),
  };
});

// ---------------------------------------------------------------------------
// Handoff + Conflict prompt composers (panel-side; advisory)
// ---------------------------------------------------------------------------
//
// Kept inline in main.cjs because they pull from registry / queries
// (not pure-derivation friendly) and they MUST stay out of any LLM
// payload — the templates explicitly forbid auto-execute / push.

function _clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function composeHandoffPrompt(input) {
  const o = input || {};
  const lines = [];
  const projectLabel = _clip(o.project_label, 200) || '(this project)';
  lines.push(`You are a coding agent picking up where a previous agent left off in ${projectLabel}.`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT dispatch you. The user is asking you to take over.`);
  lines.push('');

  if (o.goal && o.goal.title) {
    lines.push('# Project goal');
    lines.push(`Goal: ${_clip(o.goal.title, 200)}`);
    if (o.goal.desired_outcome) lines.push(`Desired outcome: ${_clip(o.goal.desired_outcome, 400)}`);
    lines.push('');
  }

  if (o.target_task) {
    const t = o.target_task;
    lines.push('# Task to continue');
    lines.push(`- task id:     ${t.task_id}`);
    lines.push(`- intent:      ${_clip(t.intent, 200) || '(no intent recorded)'}`);
    lines.push(`- state:       ${t.state}`);
    if (t.created_by_agent_id) lines.push(`- previous agent: ${t.created_by_agent_id}`);
    lines.push(`- blockers (open/total): ${t.blockers_open || 0} / ${t.blockers_total || 0}`);
    if (t.outcome_status) lines.push(`- outcome:     ${t.outcome_status}`);
    if (t.checkpoints_total) lines.push(`- checkpoints: ${t.checkpoints_total}`);
    lines.push('');
  } else {
    lines.push('# Task to continue');
    lines.push('(No specific task selected — pick the next attention candidate from Cairn\'s coordination signals.)');
    lines.push('');
  }

  if (Array.isArray(o.latest_checkpoints) && o.latest_checkpoints.length) {
    lines.push('# Recovery anchors');
    for (const c of o.latest_checkpoints) {
      const idShort = (c.id || '').slice(0, 12);
      const labelPart = c.label ? ` "${_clip(c.label, 80)}"` : '';
      const headPart  = c.git_head ? ` @${String(c.git_head).slice(0, 7)}` : '';
      lines.push(`- ${idShort}${labelPart} (${c.snapshot_status || '?'})${headPart}`);
    }
    lines.push('');
  }

  if (Array.isArray(o.latest_scratchpad) && o.latest_scratchpad.length) {
    lines.push('# Shared context (scratchpad keys)');
    for (const sp of o.latest_scratchpad) {
      const keyPart = _clip(sp.key, 80);
      const taskPart = sp.task_id ? ` (task ${sp.task_id})` : '';
      const sizePart = sp.value_size ? ` — ${sp.value_size}B` : '';
      lines.push(`- ${keyPart}${taskPart}${sizePart}`);
      if (o.include_full_context && sp.value_preview) {
        // Indent the preview lines so they're visually grouped under
        // the key. Preview is already capped to 240 chars by the query.
        for (const l of sp.value_preview.split(/\r?\n/).slice(0, 3)) {
          lines.push(`    > ${_clip(l, 200)}`);
        }
      }
    }
    if (!o.include_full_context) {
      lines.push('(Use Cairn cairn.scratchpad.read tool to fetch full content.)');
    }
    lines.push('');
  }

  if (Array.isArray(o.recent_reports) && o.recent_reports.length) {
    lines.push('# Recent worker reports (counts only)');
    for (const r of o.recent_reports) {
      lines.push(`- "${_clip(r.title, 120)}": ${(r.completed || []).length} done · ${(r.remaining || []).length} remaining · ${(r.blockers || []).length} blockers${r.needs_human ? ' · needs_human' : ''}`);
    }
    lines.push('');
  }

  lines.push('# What to do');
  lines.push('1. Read the recovery anchors and shared scratchpad keys to understand what the previous agent left.');
  lines.push('2. Confirm the next concrete step with the user before executing — do not infer scope from transcripts.');
  lines.push('3. Produce a worker report at the end (completed / remaining / blockers / next_steps).');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not expand scope beyond the original goal\'s success criteria.');
  lines.push('- Do not execute rewind without first showing the preview to the user (if a rewind is being considered).');
  lines.push('- Cairn does not dispatch agents. You were not auto-assigned; the user pasted this prompt to you.');

  return lines.join('\n');
}

function composeConflictPrompt(input) {
  const o = input || {};
  const c = o.conflict || null;
  const projectLabel = _clip(o.project_label, 200) || '(this project)';
  const lines = [];
  lines.push(`You are a coding agent reviewing a multi-agent conflict in ${projectLabel}.`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT resolve conflicts. The user is asking you to inspect and recommend.`);
  lines.push('');
  if (!c) {
    lines.push('# Conflict');
    lines.push('No conflict provided. Refuse to inspect without one.');
  } else {
    lines.push('# Conflict');
    lines.push(`- id:     ${c.id}`);
    lines.push(`- type:   ${c.conflict_type}`);
    lines.push(`- status: ${c.status}`);
    lines.push(`- detected: ${c.detected_at ? new Date(c.detected_at).toISOString() : '?'}`);
    lines.push(`- agent_a: ${c.agent_a}`);
    if (c.agent_b) lines.push(`- agent_b: ${c.agent_b}`);
    if (c.summary) lines.push(`- summary: ${_clip(c.summary, 400)}`);
    if (Array.isArray(c.paths) && c.paths.length) {
      lines.push('- paths:');
      for (const p of c.paths.slice(0, 12)) lines.push(`    - ${_clip(p, 200)}`);
    }
    lines.push('');
  }
  lines.push('# What to do');
  lines.push('1. Inspect each affected path. Diff the two agents\' versions if both present.');
  lines.push('2. Identify the root cause (concurrent write / overlapping intent / state mismatch).');
  lines.push('3. Recommend a resolution to the USER. Do NOT resolve, merge, or force-push the conflict yourself.');
  lines.push('4. If the resolution requires choosing one agent\'s output over the other, ask the user which to keep.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not modify Cairn\'s conflict state from your end (Cairn marks RESOLVED via its own tools, not via you).');
  lines.push('- Do not silently pick a side; surface the trade-off to the user.');
  return lines.join('\n');
}

function composeReviewPrompt(input) {
  const o = input || {};
  const projectLabel = _clip(o.project_label, 200) || '(this project)';
  const t = o.target_task || null;
  const oc = o.outcome || null;
  const lines = [];
  lines.push(`You are a coding agent reviewing a Cairn task for ${projectLabel}.`);
  lines.push('Cairn is a project control surface (read-only); it does NOT decide PASS / FAIL / RETRY. Your role is to report what you see and recommend a verdict to the user.');
  lines.push('');
  if (t) {
    lines.push('# Task');
    lines.push(`- task id:     ${t.task_id}`);
    lines.push(`- intent:      ${_clip(t.intent, 200) || '(no intent)'}`);
    lines.push(`- state:       ${t.state}`);
  }
  if (oc) {
    lines.push('');
    lines.push('# Outcome');
    lines.push(`- status: ${oc.status}`);
    if (oc.evaluation_summary) lines.push(`- last evaluation: ${_clip(oc.evaluation_summary, 400)}`);
  }
  lines.push('');
  lines.push('# What to do');
  lines.push('1. Inspect the task\'s diff / files / acceptance criteria.');
  lines.push('2. Verify against the project\'s testing policy.');
  lines.push('3. Report PASS / FAIL with evidence to the user. Do NOT mark the outcome yourself.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not change the outcome record in Cairn from your end.');
  return lines.join('\n');
}

ipcMain.handle('get-review-prompt', (_e, projectId, taskId) => {
  if (!projectId || typeof projectId !== 'string') return { ok: false, error: 'projectId_required' };
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const tasks = projectQueries.queryProjectScopedTasks(entry.db, entry.tables, agentIds).tasks;
  const target = taskId ? tasks.find(t => t.task_id === taskId) : null;
  let outcome = null;
  if (target) {
    const detail = queries.queryTaskDetail(entry.db, entry.tables, target.task_id);
    outcome = detail && detail.outcome ? detail.outcome : null;
  }
  return {
    ok: true,
    prompt: composeReviewPrompt({
      project_label: proj.label, target_task: target, outcome,
    }),
  };
});

ipcMain.handle('get-project-recovery', (_e, projectId) => {
  if (!projectId || typeof projectId !== 'string') return null;
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return null;
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return null;
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const ckpts = projectQueries.queryProjectScopedCheckpoints(
    entry.db, entry.tables, agentIds, 50,
  );
  return recoverySummary.deriveProjectRecovery(ckpts, {});
});

ipcMain.handle('get-recovery-prompt', (_e, projectId, opts) => {
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);

  const o = opts || {};
  if (o.task_id) {
    // Per-task recovery prompt: fetch this task's checkpoints + state.
    const ckpts = queries.queryTaskCheckpoints(entry.db, entry.tables, o.task_id);
    const detail = queries.queryTaskDetail(entry.db, entry.tables, o.task_id);
    const taskRow = detail && detail.task;
    const summary = recoverySummary.deriveProjectRecovery(
      // Wrap the task's checkpoints as if they were project-scoped so
      // the helper picks the latest READY one if any.
      ckpts.map(c => Object.assign({}, c, {
        task_id: o.task_id,
        task_intent: taskRow ? taskRow.intent : null,
        task_state:  taskRow ? taskRow.state  : null,
      })),
      {},
    );
    const prompt = recoverySummary.recoveryPromptForTask({
      project_label: proj.label,
      task_id:       o.task_id,
      task_intent:   taskRow ? taskRow.intent : null,
      task_state:    taskRow ? taskRow.state  : null,
      checkpoint:    summary.last_ready || (summary.safe_anchors[0] || null),
    });
    return { ok: true, prompt, summary };
  }

  // Project-level prompt.
  const ckpts = projectQueries.queryProjectScopedCheckpoints(
    entry.db, entry.tables, agentIds, 50,
  );
  const summary = recoverySummary.deriveProjectRecovery(ckpts, {});
  const prompt = recoverySummary.recoveryPromptForProject({
    project_label: proj.label,
    summary,
  });
  return { ok: true, prompt, summary };
});

ipcMain.handle('generate-prompt-pack', async (_e, projectId, opts) => {
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const entry = ensureDbHandle(proj.db_path);
  if (!entry) return { ok: false, error: 'db_unavailable' };
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  // Reuse the gate input — same shape (goal + rules + state + reports);
  // also pass the cached gate result if available so the pack
  // checklist can dedupe against it. Plus a coordination summary so
  // the prompt pack carries today's coordination context (not the
  // raw signals — only the LLM-safe summary form).
  const coordInput = buildCoordinationInput(proj, entry, agentIds);
  const coord = coordinationSignals.deriveCoordinationSignals(coordInput, {});
  const coordSummary = coordinationSignals.summarizeCoordination(coord);
  const input = Object.assign({}, buildPrePrGateInput(proj, entry, agentIds), {
    pre_pr_gate: prePrGateCache.get(projectId)
      ? prePrGateCache.get(projectId).result
      : null,
    coordination_summary: coordSummary,
  });
  const force = !!(opts && opts.forceDeterministic);
  const result = await goalLoopPromptPack.generatePromptPack(input, {
    forceDeterministic: force,
  });
  promptPackCache.set(projectId, { result, generated_at: Date.now() });
  return { ok: true, result };
});

// ---------------------------------------------------------------------------
// Managed Loop — Cairn-managed external repo workflow
// ---------------------------------------------------------------------------
//
// Per PRODUCT.md §1.3 + §6.4: Cairn manages the loop, never the work.
// Every channel here is user-triggered (panel button click). We never
// auto-launch a worker; we never push, fetch, checkout, reset, or
// otherwise mutate the managed repo's working tree. The IPC layer is
// a thin wrapper over managed-loop-handlers.cjs.

ipcMain.handle('list-managed-projects', () => {
  return managedLoopHandlers.listManagedProjects(reg);
});

ipcMain.handle('register-managed-project', (_e, projectId, input) => {
  return managedLoopHandlers.registerManagedProject(reg, projectId, input || {});
});

ipcMain.handle('get-managed-project-profile', (_e, projectId) => {
  return managedLoopHandlers.getManagedProjectProfile(projectId);
});

ipcMain.handle('start-managed-iteration', (_e, projectId, input) => {
  return managedLoopHandlers.startManagedIteration(projectId, input || {});
});

ipcMain.handle('generate-managed-worker-prompt', (_e, projectId, opts) => {
  // Build the heavy context (goal/rules/gate/coord) from main process
  // state so the panel doesn't have to re-fetch each.
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const o = opts || {};
  const goal = registry.getProjectGoal(reg, projectId);
  const effective = registry.getEffectiveProjectRules(reg, projectId);
  const rules = effective ? effective.rules : null;
  const isDefault = effective ? effective.is_default : true;
  const cachedGate = prePrGateCache.get(projectId);
  const ctx = {
    iteration_id: o.iteration_id || null,
    goal,
    project_rules: rules,
    project_rules_is_default: isDefault,
    pre_pr_gate: cachedGate ? cachedGate.result : null,
  };
  return managedLoopHandlers.generateManagedWorkerPrompt(projectId, ctx);
});

ipcMain.handle('attach-managed-worker-report', (_e, projectId, input) => {
  return managedLoopHandlers.attachManagedWorkerReport(projectId, input || {});
});

ipcMain.handle('collect-managed-evidence', (_e, projectId, input) => {
  return managedLoopHandlers.collectManagedEvidence(projectId, input || {});
});

ipcMain.handle('review-managed-iteration', async (_e, projectId, opts) => {
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const o = opts || {};
  const cachedGate = prePrGateCache.get(projectId);
  const goal = registry.getProjectGoal(reg, projectId);
  const effective = registry.getEffectiveProjectRules(reg, projectId);
  const ctx = {
    iteration_id: o.iteration_id || null,
    pre_pr_gate: cachedGate ? cachedGate.result : null,
    goal,
    rules: effective ? effective.rules : null,
  };
  return managedLoopHandlers.reviewManagedIteration(projectId, ctx, {
    forceDeterministic: !!o.forceDeterministic,
  });
});

ipcMain.handle('list-managed-iterations', (_e, projectId, limit) => {
  return managedLoopHandlers.listManagedIterations(projectId, limit || 0);
});

// Worker Launch — user-authorized, single-shot agent runs. Each
// channel is one panel button; never invoked on a timer.

ipcMain.handle('detect-worker-providers', () => {
  return managedLoopHandlers.detectWorkerProviders();
});

ipcMain.handle('launch-managed-worker', (_e, projectId, input) => {
  return managedLoopHandlers.launchManagedWorker(projectId, input || {});
});

ipcMain.handle('get-worker-run', (_e, runId) => {
  return managedLoopHandlers.getWorkerRun(runId);
});

ipcMain.handle('list-worker-runs', (_e, projectId) => {
  return managedLoopHandlers.listWorkerRuns(projectId);
});

ipcMain.handle('stop-worker-run', (_e, runId) => {
  return managedLoopHandlers.stopWorkerRun(runId);
});

ipcMain.handle('tail-worker-run', (_e, runId, limit) => {
  return managedLoopHandlers.tailWorkerRun(runId, limit || 16 * 1024);
});

ipcMain.handle('extract-worker-report', (_e, projectId, input) => {
  return managedLoopHandlers.extractManagedWorkerReport(projectId, input || {});
});

ipcMain.handle('extract-scout-candidates', (_e, projectId, input) => {
  return managedLoopHandlers.extractScoutCandidates(projectId, input || {});
});

ipcMain.handle('pick-candidate-and-launch-worker', (_e, projectId, input) => {
  return managedLoopHandlers.pickCandidateAndLaunchWorker(projectId, input || {});
});

ipcMain.handle('run-review-for-candidate', (_e, projectId, input) => {
  return managedLoopHandlers.runReviewForCandidate(projectId, input || {});
});

ipcMain.handle('extract-review-verdict', (_e, projectId, input) => {
  return managedLoopHandlers.extractReviewVerdict(projectId, input || {});
});

// Day 5 — read-only candidate accessors (always available; Inspector
// + smokes use these to render and inspect rows).
ipcMain.handle('list-candidates', (_e, projectId, limit) => {
  return managedLoopHandlers.listCandidates(projectId, limit || 100);
});
ipcMain.handle('list-candidates-by-status', (_e, projectId, status) => {
  return managedLoopHandlers.listCandidatesByStatus(projectId, status);
});
ipcMain.handle('get-candidate', (_e, projectId, candidateId) => {
  return managedLoopHandlers.getCandidate(projectId, candidateId);
});

// Day 6 — boundary verify. Read-only against the managed repo (uses
// the existing evidence whitelist — `git status --short` only). Side
// effects are confined to ~/.cairn/ JSONLs (candidate.boundary_violations
// + iteration.evidence_summary), matching the same write surface
// every other Three-Stage handler already touches. Not gated by
// MUTATIONS_ENABLED — verify is the reviewer's lens, not a state
// transition.
ipcMain.handle('verify-worker-boundary', (_e, projectId, input) => {
  return managedLoopHandlers.verifyWorkerBoundary(projectId, input || {});
});

// Multi-Cairn v0 — read-only sharing of published candidates. Status
// + list are unconditional reads; publish / unpublish are user
// mutations on the shared outbox and gated on MUTATIONS_ENABLED to
// stay consistent with Day 5's Accept / Reject / Roll back pattern.
ipcMain.handle('get-multi-cairn-status', () => {
  return managedLoopHandlers.getMultiCairnStatus();
});
ipcMain.handle('list-team-candidates', (_e, projectId) => {
  return managedLoopHandlers.listTeamCandidates(projectId);
});
ipcMain.handle('list-my-published-candidate-ids', (_e, projectId) => {
  return managedLoopHandlers.listMyPublishedCandidateIds(projectId);
});
if (MUTATIONS_ENABLED) {
  ipcMain.handle('publish-candidate-to-team', (_e, projectId, candidateId) => {
    return managedLoopHandlers.publishCandidateToTeam(projectId, candidateId);
  });
  ipcMain.handle('unpublish-candidate-from-team', (_e, projectId, candidateId) => {
    return managedLoopHandlers.unpublishCandidateFromTeam(projectId, candidateId);
  });
}

// Mode B Continuous Iteration — auto-chains Scout → up-to-N
// (Worker → Review → Verify) and stops every candidate at REVIEWED.
// run / stop are gated on MUTATIONS_ENABLED (they spawn external
// agents); get / list are unconditional reads.
ipcMain.handle('get-continuous-run', (_e, projectId, runId) => {
  return managedLoopHandlers.getContinuousRun(projectId, runId);
});
ipcMain.handle('list-continuous-runs', (_e, projectId, limit) => {
  return managedLoopHandlers.listContinuousRuns(projectId, limit || 50);
});
if (MUTATIONS_ENABLED) {
  ipcMain.handle('run-continuous-iteration', (_e, projectId, input) => {
    return managedLoopHandlers.runContinuousIteration(projectId, input || {});
  });
  ipcMain.handle('stop-continuous-iteration', (_e, runId) => {
    return managedLoopHandlers.stopContinuousIteration(runId);
  });
}

// Mode A — Mentor Layer (advisor chat).
//
// ask-mentor spawns a provider (claude-code / codex / fixture-mentor)
// to polish the deterministic skeleton; that's an "agent run" by the
// same launcher pipeline as Scout/Worker/Review, so it's gated on
// MUTATIONS_ENABLED. list-mentor-history / get-mentor-entry are pure
// reads on ~/.cairn/mentor-history JSONL and always exposed.
ipcMain.handle('list-mentor-history', (_e, projectId, limit) => {
  return mentorHandler.listMentorHistory(projectId, limit || 50);
});
ipcMain.handle('get-mentor-entry', (_e, projectId, turnId) => {
  return mentorHandler.getMentorEntry(projectId, turnId);
});
if (MUTATIONS_ENABLED) {
  ipcMain.handle('ask-mentor', (_e, projectId, input) => {
    return mentorHandler.askMentor(projectId, input || {});
  });
}

// Day 5 — terminal user-action handlers. Gated on
// CAIRN_DESKTOP_ENABLE_MUTATIONS=1 to honor PRODUCT.md §12 D9: panel
// stays read-only, the Inspector (already opt-in for mutations via
// the same env flag) is where users click Accept/Reject/Roll back.
// Smokes call the handler functions directly (not through IPC) so
// they don't depend on the env flag.
if (MUTATIONS_ENABLED) {
  ipcMain.handle('accept-candidate', (_e, projectId, candidateId) => {
    return managedLoopHandlers.acceptCandidate(projectId, candidateId);
  });
  ipcMain.handle('reject-candidate', (_e, projectId, candidateId) => {
    return managedLoopHandlers.rejectCandidate(projectId, candidateId);
  });
  ipcMain.handle('roll-back-candidate', (_e, projectId, candidateId) => {
    return managedLoopHandlers.rollBackCandidate(projectId, candidateId);
  });
}

ipcMain.handle('continue-managed-iteration-review', async (_e, projectId, opts) => {
  // Same context build as review-managed-iteration; collects evidence + reviews.
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) return { ok: false, error: 'project_not_found' };
  const o = opts || {};
  const cachedGate = prePrGateCache.get(projectId);
  const goal = registry.getProjectGoal(reg, projectId);
  const effective = registry.getEffectiveProjectRules(reg, projectId);
  const ctx = {
    iteration_id: o.iteration_id || null,
    pre_pr_gate: cachedGate ? cachedGate.result : null,
    goal,
    rules: effective ? effective.rules : null,
  };
  return managedLoopHandlers.continueManagedIterationReview(projectId, ctx, {
    forceDeterministic: !!o.forceDeterministic,
  });
});

// Project Pulse — derived signals only. No mutation, no recommendation
// of next agent action. Uses the same project summary + activity feed
// the rest of the IPC layer already produces; no new SQL.
ipcMain.handle('get-project-pulse', () => {
  const proj = activeProject();
  const entry = activeDbEntry();
  if (!proj || !entry) {
    return goalSignals.deriveProjectPulse(null, [], {});
  }
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  const summary = projectQueries.queryProjectScopedSummary(
    entry.db, entry.tables, proj.db_path, agentIds,
  );
  const claudeAll = claudeSessionScan.scanClaudeSessions();
  const codexAll  = codexSessionScan.scanCodexSessions();
  const { matched: claudeForP } = claudeSessionScan.partitionByProject(claudeAll, proj);
  const { matched: codexForP }  = codexSessionScan.partitionByProject(codexAll, proj);
  foldClaudeIntoSummary(summary, claudeForP);
  foldCodexIntoSummary(summary, codexForP);
  const mcpForActivity = buildMcpActivityRows(entry.db, entry.tables, proj, agentIds);
  const built = agentActivity.buildProjectActivities(
    proj, mcpForActivity, claudeAll, codexAll,
    { claude: claudeSessionScan, codex: codexSessionScan },
  );
  summary.agent_activity = built.summary;
  return goalSignals.deriveProjectPulse(summary, built.activities, {});
});

ipcMain.handle('get-project-summary', () => {
  const entry = activeDbEntry();
  if (!entry) return projectQueries.queryProjectScopedSummary(null, new Set(), activeDbPath(), []);
  const proj = activeProject();
  if (proj) {
    const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
    const summary = projectQueries.queryProjectScopedSummary(
      entry.db, entry.tables, proj.db_path, agentIds,
    );
    // Fold Claude rows into the L2 summary so the active-project card
    // shows "agents MCP X · Claude Y · Codex Z" identically to L1.
    const claudeAll = claudeSessionScan.scanClaudeSessions();
    const { matched } = claudeSessionScan.partitionByProject(claudeAll, proj);
    foldClaudeIntoSummary(summary, matched);
    const codexAll = codexSessionScan.scanCodexSessions();
    const { matched: codexMatched } = codexSessionScan.partitionByProject(codexAll, proj);
    foldCodexIntoSummary(summary, codexMatched);

    // Activity-layer summary alongside the legacy per-source folds so
    // the L2 summary card can render "X live · Y recent" headline.
    const mcpForActivity = buildMcpActivityRows(entry.db, entry.tables, proj, agentIds);
    const built = agentActivity.buildProjectActivities(
      proj, mcpForActivity, claudeAll, codexAll,
      { claude: claudeSessionScan, codex: codexSessionScan },
    );
    summary.agent_activity = built.summary;
    return summary;
  }
  // No project selected — fall back to the legacy unscoped summary.
  return queries.queryProjectSummary(entry.db, entry.tables, activeDbPath());
});

// Day 5: returns the project-scoped + enriched payload (filtered by
// agent_id_hints, with per-task blocker / outcome / checkpoint counts).
// When no project is selected (or when the active project has no
// hints) the renderer surfaces an empty state — DB-wide tasks no
// longer leak into the L2 view.
ipcMain.handle('get-tasks-list', () => {
  const proj = activeProject();
  const entry = activeDbEntry();
  if (!proj || !entry) {
    return { available: false, hints_empty: true, tasks: [] };
  }
  // Real Agent Presence v2: include capability-matched sessions in
  // the attribution set, not just registry hints.
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, proj);
  return projectQueries.queryProjectScopedTasks(
    entry.db, entry.tables, agentIds,
  );
});

ipcMain.handle('get-task-detail', (_e, taskId) => {
  const entry = activeDbEntry();
  if (!entry) return null;
  return queries.queryTaskDetail(entry.db, entry.tables, taskId);
});

// Checkpoints attached to a task — fetched on detail expand. Read-only;
// no rewind / preview / mutation channel.
ipcMain.handle('get-task-checkpoints', (_e, taskId) => {
  const entry = activeDbEntry();
  if (!entry) return [];
  return queries.queryTaskCheckpoints(entry.db, entry.tables, taskId);
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
  // Day 4: the floating marker (preview.html) now toggles the side
  // panel instead of opening the legacy Inspector — same gesture as
  // tray click. Channel name kept for preview.js compatibility (no
  // preload churn). Legacy Inspector is reachable via tray right-click
  // menu and the panel's overflow menu.
  togglePanel();
});

// Custom titlebar close button → slide out + hide. Never quits.
ipcMain.on('cairn:hide-panel', () => {
  hidePanelSlide();
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

  // Boot smoke: when CAIRN_DESKTOP_BOOT_TEST=1 is set, run a few poll
  // ticks to exercise tray + getProjectsList + IPC handlers, then quit
  // gracefully so the smoke driver can assert exit code.
  if (process.env.CAIRN_DESKTOP_BOOT_TEST === '1') {
    // Drive one explicit tray refresh + one project-list build to
    // catch wiring errors that wouldn't surface from the timer-only
    // path (e.g. a missing require).
    try { refreshTray(); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('BOOT_TEST refreshTray failed:', e && e.message);
      process.exit(2);
    }
    try {
      const list = getProjectsList();
      // eslint-disable-next-line no-console
      console.log(
        `BOOT_TEST projects=${list.projects.length} unassigned=${list.unassigned.length}`
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('BOOT_TEST getProjectsList failed:', e && e.message);
      process.exit(2);
    }
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 3000);
  }
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
  cancelPanelAnim();
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
