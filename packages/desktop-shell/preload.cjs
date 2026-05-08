'use strict';

/**
 * Preload bridge between the renderer (panel.html / inspector-legacy.html /
 * preview.html) and the Electron main process.
 *
 * Read-only by default. The mutation channel (resolveConflict) is exposed
 * here ONLY when the main process advertises it via process.env-derived
 * flag CAIRN_DESKTOP_ENABLE_MUTATIONS=1. Renderers detect mutation
 * availability by checking `typeof window.cairn.resolveConflict ===
 * 'function'` (see inspector-legacy.js).
 */

const { contextBridge, ipcRenderer } = require('electron');

// Mutation flag is forwarded into the preload via a synchronous IPC call
// at startup. Main is the source of truth; preload just mirrors.
const MUTATIONS_ENABLED = (() => {
  try {
    return ipcRenderer.sendSync('cairn:mutations-enabled?') === true;
  } catch (_e) {
    return false;
  }
})();

const api = {
  // ---- Project-Aware Live Panel: L1 + project registry ----
  getProjectsList:    () => ipcRenderer.invoke('get-projects-list'),
  selectProject:      (id) => ipcRenderer.invoke('select-project', id),
  getSelectedProject: () => ipcRenderer.invoke('get-selected-project'),
  addProject:         (input) => ipcRenderer.invoke('add-project', input || {}),
  removeProject:      (id) => ipcRenderer.invoke('remove-project', id),
  renameProject:      (id, label) => ipcRenderer.invoke('rename-project', id, label),
  addHint:            (id, agentId) => ipcRenderer.invoke('add-hint', id, agentId),
  getProjectSessions: () => ipcRenderer.invoke('get-project-sessions'),
  getUnassignedDetail:(dbPath) => ipcRenderer.invoke('get-unassigned-detail', dbPath),

  // ---- panel views (active-project routed; deprecated set-db-path) ----
  getProjectSummary: () => ipcRenderer.invoke('get-project-summary'),
  getTasksList:      () => ipcRenderer.invoke('get-tasks-list'),
  getTaskDetail:     (taskId) => ipcRenderer.invoke('get-task-detail', taskId),
  getRunLogEvents:   () => ipcRenderer.invoke('get-run-log-events'),
  getDbPath:         () => ipcRenderer.invoke('get-db-path'),
  setDbPath:         (path) => ipcRenderer.invoke('set-db-path', path),
  openLegacyInspector: () => ipcRenderer.send('open-legacy-inspector'),
  hidePanel:           () => ipcRenderer.send('cairn:hide-panel'),

  // ---- Legacy (inspector-legacy.html + preview.html pet) ----
  getState:           () => ipcRenderer.invoke('get-state'),
  getActiveAgents:    () => ipcRenderer.invoke('get-active-agents'),
  getOpenConflicts:   () => ipcRenderer.invoke('get-open-conflicts'),
  getRecentDispatches:() => ipcRenderer.invoke('get-recent-dispatches'),
  getActiveLanes:     () => ipcRenderer.invoke('get-active-lanes'),
  openInspector:      () => ipcRenderer.send('open-inspector'),
  startDrag:          (mouseX, mouseY) => ipcRenderer.send('start-drag', { mouseX, mouseY }),
  doDrag:             (mouseX, mouseY) => ipcRenderer.send('do-drag', { mouseX, mouseY }),
};

// Mutation channel — present only in dev-flag mode. Renderers detect via
// typeof check; legacy inspector hides its Resolve button when absent.
if (MUTATIONS_ENABLED) {
  api.resolveConflict = (id, reason) =>
    ipcRenderer.invoke('resolve-conflict', id, reason);
}

contextBridge.exposeInMainWorld('cairn', api);
