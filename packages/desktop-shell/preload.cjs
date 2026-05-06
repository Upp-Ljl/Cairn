'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cairn', {
  getState: () => ipcRenderer.invoke('get-state'),
  getActiveAgents: () => ipcRenderer.invoke('get-active-agents'),
  getOpenConflicts: () => ipcRenderer.invoke('get-open-conflicts'),
  getRecentDispatches: () => ipcRenderer.invoke('get-recent-dispatches'),
  getActiveLanes: () => ipcRenderer.invoke('get-active-lanes'),
  resolveConflict: (id, reason) => ipcRenderer.invoke('resolve-conflict', id, reason),
  openInspector: () => ipcRenderer.send('open-inspector'),
  startDrag: (mouseX, mouseY) => ipcRenderer.send('start-drag', { mouseX, mouseY }),
  doDrag: (mouseX, mouseY) => ipcRenderer.send('do-drag', { mouseX, mouseY }),
});
