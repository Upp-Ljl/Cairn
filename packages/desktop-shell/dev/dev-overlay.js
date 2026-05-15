'use strict';

/**
 * Dev overlay — injected into panel-dev.html.
 * Adds settings gear + pet + language selector INSIDE the panel.
 * Runs after DOM is ready but does not touch panel.js internals.
 */

(function () {

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------
const STORE_KEY = 'cairn-dev-settings';
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function save(p) { const s = { ...load(), ...p }; localStorage.setItem(STORE_KEY, JSON.stringify(s)); return s; }

// ---------------------------------------------------------------------------
// Inject CSS
// ---------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = /* css */`
/* --- Dev overlay --- */
#dev-gear {
  position: fixed;
  bottom: 32px;
  right: 12px;
  width: 28px; height: 28px;
  background: #222;
  border: 1px solid #444;
  border-radius: 50%;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  transition: all 0.2s ease;
  opacity: 0.6;
}
#dev-gear:hover { opacity: 1; border-color: #7af; color: #7af; }
#dev-gear.open { opacity: 1; border-color: #7af; color: #7af; background: #1a1a2e; }

#dev-settings {
  position: fixed;
  bottom: 68px;
  right: 12px;
  width: 240px;
  background: #141418;
  border: 1px solid #333;
  border-radius: 10px;
  padding: 14px;
  z-index: 9999;
  display: none;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: #ccc;
}
#dev-settings.open { display: block; }
#dev-settings .ds-title {
  font-size: 10px;
  color: #7af;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #2a2a2a;
}
#dev-settings .ds-group {
  margin-bottom: 10px;
}
#dev-settings .ds-group:last-child { margin-bottom: 0; }
#dev-settings .ds-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}
#dev-settings .ds-label {
  color: #999;
  font-size: 11px;
}

/* Toggle switch */
.ds-toggle {
  position: relative;
  width: 32px; height: 18px;
  cursor: pointer;
  flex-shrink: 0;
}
.ds-toggle input { display: none; }
.ds-toggle .ds-track {
  position: absolute; inset: 0;
  background: #333;
  border-radius: 9px;
  transition: background 0.2s;
}
.ds-toggle input:checked + .ds-track { background: #4a7; }
.ds-toggle .ds-thumb {
  position: absolute;
  top: 2px; left: 2px;
  width: 14px; height: 14px;
  background: #ddd;
  border-radius: 50%;
  transition: transform 0.2s;
  pointer-events: none;
}
.ds-toggle input:checked ~ .ds-thumb { transform: translateX(14px); }

/* Select */
.ds-select {
  width: 100%;
  background: #1e1e24;
  color: #ccc;
  border: 1px solid #3a3a3a;
  border-radius: 4px;
  padding: 4px 6px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  outline: none;
  margin-top: 4px;
}
.ds-select:focus { border-color: #7af; }

/* Pet floating in panel */
#dev-pet {
  position: fixed;
  bottom: 36px;
  left: 12px;
  z-index: 9998;
  cursor: grab;
  transition: opacity 0.3s ease, transform 0.3s ease;
  pointer-events: auto;
}
/* When panel is showing cockpit (mostly), pet is in workspace area
   (not on panel), so make it semi-transparent until hover */
#dev-pet { opacity: 0.6; }
#dev-pet:hover { opacity: 1; }
#dev-pet.hidden {
  opacity: 0;
  transform: scale(0.4);
  pointer-events: none;
}
#dev-pet:active { cursor: grabbing; }
#dev-pet canvas {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
}
#dev-pet-label {
  text-align: center;
  font-size: 9px;
  color: #555;
  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
  margin-top: 2px;
}
`;
document.head.appendChild(style);

// ---------------------------------------------------------------------------
// Inject DOM
// ---------------------------------------------------------------------------
const gear = document.createElement('div');
gear.id = 'dev-gear';
gear.innerHTML = '\u2699';
gear.title = 'Dev Settings (S)';
document.body.appendChild(gear);

const panel = document.createElement('div');
panel.id = 'dev-settings';
panel.innerHTML = `
  <div class="ds-title">Dev Settings</div>

  <div class="ds-group">
    <div class="ds-row">
      <span class="ds-label" data-i18n="pet">Desktop Pet</span>
      <label class="ds-toggle">
        <input type="checkbox" id="ds-pet-toggle" checked>
        <div class="ds-track"></div>
        <div class="ds-thumb"></div>
      </label>
    </div>
    <select class="ds-select" id="ds-pet-state">
      <option value="auto">Auto (cycle)</option>
      <option value="idle">idle</option>
      <option value="running-right">running-right</option>
      <option value="running-left">running-left</option>
      <option value="waving">waving</option>
      <option value="jumping">jumping</option>
      <option value="failed">failed</option>
      <option value="waiting">waiting</option>
      <option value="running">running</option>
      <option value="review">review</option>
    </select>
  </div>

  <div class="ds-group">
    <div class="ds-row">
      <span class="ds-label" data-i18n="lang">Language</span>
    </div>
    <select class="ds-select" id="ds-lang">
      <option value="en">English</option>
      <option value="zh">\u4e2d\u6587 (Chinese)</option>
      <option value="ja">\u65e5\u672c\u8a9e (Japanese)</option>
    </select>
  </div>

  <div class="ds-group">
    <div class="ds-row">
      <span class="ds-label" data-i18n="theme">Theme</span>
    </div>
    <div style="display:flex;gap:0;margin-top:4px">
      <button class="ds-theme-btn" id="ds-theme-dark" data-theme="dark" style="flex:1;padding:4px;border:1px solid var(--border, #2a2a2e);background:var(--accent-bg, rgba(91,154,255,0.08));color:var(--accent, #5b9aff);border-radius:4px 0 0 4px;font-family:inherit;font-size:11px;cursor:pointer;border-right:none">Dark</button>
      <button class="ds-theme-btn" id="ds-theme-light" data-theme="light" style="flex:1;padding:4px;border:1px solid var(--border, #2a2a2e);background:none;color:var(--text-secondary, #8888a0);border-radius:0 4px 4px 0;font-family:inherit;font-size:11px;cursor:pointer">Light</button>
    </div>
  </div>

  <div class="ds-group">
    <div class="ds-row">
      <span class="ds-label" data-i18n="status">Show Pet Status</span>
      <label class="ds-toggle">
        <input type="checkbox" id="ds-pet-status-toggle">
        <div class="ds-track"></div>
        <div class="ds-thumb"></div>
      </label>
    </div>
  </div>
`;
document.body.appendChild(panel);

// Pet container
const petEl = document.createElement('div');
petEl.id = 'dev-pet';
petEl.innerHTML = '<canvas id="dev-pet-canvas" width="96" height="104"></canvas><div id="dev-pet-label"></div>';
document.body.appendChild(petEl);

// ---------------------------------------------------------------------------
// Settings toggle
// ---------------------------------------------------------------------------
gear.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = panel.classList.toggle('open');
  gear.classList.toggle('open', open);
});
document.addEventListener('click', (e) => {
  if (!panel.contains(e.target) && e.target !== gear) {
    panel.classList.remove('open');
    gear.classList.remove('open');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 's' || e.key === 'S') gear.click();
});

// ---------------------------------------------------------------------------
// Pet sprite engine
// ---------------------------------------------------------------------------
const SHEET_W = 1536, SHEET_H = 1872;
const CELL_W = 192, CELL_H = 208;
const COLS = 8, SCALE = 0.5, FPS = 8;
const DW = CELL_W * SCALE, DH = CELL_H * SCALE;
const STATES = [
  { name: 'idle',          row: 0, frames: 6 },
  { name: 'running-right', row: 1, frames: 8 },
  { name: 'running-left',  row: 2, frames: 8 },
  { name: 'waving',        row: 3, frames: 4 },
  { name: 'jumping',       row: 4, frames: 5 },
  { name: 'failed',        row: 5, frames: 8 },
  { name: 'waiting',       row: 6, frames: 6 },
  { name: 'running',       row: 7, frames: 6 },
  { name: 'review',        row: 8, frames: 6 },
];
const AUTO_CYCLE = ['idle','running','running-right','waiting','waving','review','jumping','running-left','failed'];

const cv = document.getElementById('dev-pet-canvas');
cv.width = DW; cv.height = DH;
const cx = cv.getContext('2d');
cx.imageSmoothingEnabled = false;

let sheet = null, chroma = null;
let sIdx = 0, fr = 0, lastTs = 0;
let manualState = 'auto';
let autoIdx = 0;

function byName(n) { const i = STATES.findIndex(s => s.name === n); return i >= 0 ? i : 0; }
function setState(n) {
  const i = byName(n);
  if (i !== sIdx) { sIdx = i; fr = 0; }
  const lbl = document.getElementById('dev-pet-label');
  if (lbl) lbl.textContent = n;
}
function draw() {
  if (!chroma) return;
  const st = STATES[sIdx];
  cx.clearRect(0, 0, DW, DH);
  cx.drawImage(chroma, (fr % COLS) * CELL_W, st.row * CELL_H, CELL_W, CELL_H, 0, 0, DW, DH);
}
function loop(ts) {
  requestAnimationFrame(loop);
  if (!sheet || ts - lastTs < 1000 / FPS) return;
  lastTs = ts;
  fr = (fr + 1) % STATES[sIdx].frames;
  draw();
}
function autoCycle() {
  if (manualState !== 'auto') return;
  setState(AUTO_CYCLE[autoIdx % AUTO_CYCLE.length]);
  autoIdx++;
}
function buildChroma(img) {
  const off = document.createElement('canvas');
  off.width = SHEET_W; off.height = SHEET_H;
  const c = off.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(img, 0, 0);
  try {
    const d = c.getImageData(0, 0, SHEET_W, SHEET_H);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4)
      if (px[i] > 200 && px[i+1] > 200 && px[i+2] < 120) px[i+3] = 0;
    c.putImageData(d, 0, 0);
  } catch {}
  return off;
}
const img = new Image();
img.onload = () => {
  sheet = img; chroma = buildChroma(img);
  draw(); requestAnimationFrame(loop);
  autoCycle(); setInterval(autoCycle, 4000);
};
img.src = 'spritesheet.webp';

// Pet drag
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  const r = petEl.getBoundingClientRect();
  petEl.style.position = 'fixed';
  petEl.style.left = r.left + 'px';
  petEl.style.top = r.top + 'px';
  petEl.style.bottom = 'auto';
  drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
  cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  petEl.style.left = (drag.ox + e.clientX - drag.sx) + 'px';
  petEl.style.top = (drag.oy + e.clientY - drag.sy) + 'px';
});
cv.addEventListener('pointerup', () => { drag = null; });

// ---------------------------------------------------------------------------
// Wire controls
// ---------------------------------------------------------------------------
const petToggle = document.getElementById('ds-pet-toggle');
const petStateSelect = document.getElementById('ds-pet-state');
const petStatusToggle = document.getElementById('ds-pet-status-toggle');
const langSelect = document.getElementById('ds-lang');
const petLabel = document.getElementById('dev-pet-label');

petToggle.addEventListener('change', () => {
  petEl.classList.toggle('hidden', !petToggle.checked);
  save({ petVisible: petToggle.checked });
});

petStateSelect.addEventListener('change', () => {
  manualState = petStateSelect.value;
  if (manualState !== 'auto') setState(manualState);
  save({ petState: manualState });
});

petStatusToggle.addEventListener('change', () => {
  petLabel.style.display = petStatusToggle.checked ? 'block' : 'none';
  save({ petStatusVisible: petStatusToggle.checked });
});

// Theme toggle (dark/light)
function applyTheme(t) {
  document.documentElement.setAttribute('data-cairn-theme', t);
  localStorage.setItem('cairn-dev-theme', t);
  document.querySelectorAll('.ds-theme-btn').forEach(b => {
    const active = b.getAttribute('data-theme') === t;
    b.style.background = active ? 'var(--accent-bg, rgba(91,154,255,0.08))' : 'none';
    b.style.color = active ? 'var(--accent, #5b9aff)' : 'var(--text-secondary, #8888a0)';
  });
}
document.querySelectorAll('.ds-theme-btn').forEach(b => {
  b.addEventListener('click', () => applyTheme(b.getAttribute('data-theme')));
});

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const I18N = {
  en: { title: 'Dev Settings', pet: 'Desktop Pet', lang: 'Language', status: 'Show Pet Status' },
  zh: { title: '\u5f00\u53d1\u8bbe\u7f6e', pet: '\u684c\u5ba0', lang: '\u8bed\u8a00', status: '\u663e\u793a\u684c\u5ba0\u72b6\u6001' },
  ja: { title: '\u958b\u767a\u8a2d\u5b9a', pet: '\u30c7\u30b9\u30af\u30c8\u30c3\u30d7\u30da\u30c3\u30c8', lang: '\u8a00\u8a9e', status: '\u30da\u30c3\u30c8\u30b9\u30c6\u30fc\u30bf\u30b9\u8868\u793a' },
};
function applyLang(lang) {
  const t = I18N[lang] || I18N.en;
  panel.querySelector('.ds-title').textContent = t.title;
  panel.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
}

langSelect.addEventListener('change', () => {
  const lang = langSelect.value;
  save({ language: lang });
  applyLang(lang);
});

// ---------------------------------------------------------------------------
// Restore saved settings
// ---------------------------------------------------------------------------
const s = load();
if (s.petVisible === false) { petToggle.checked = false; petEl.classList.add('hidden'); }
if (s.petStatusVisible) { petStatusToggle.checked = true; petLabel.style.display = 'block'; }
else { petLabel.style.display = 'none'; }
if (s.petState && s.petState !== 'auto') {
  manualState = s.petState;
  petStateSelect.value = s.petState;
  setState(s.petState);
}
if (s.language) { langSelect.value = s.language; applyLang(s.language); }

// Restore theme — must match what serve.mjs already set in <head>
const savedTheme = localStorage.getItem('cairn-dev-theme') || 'dark';
applyTheme(savedTheme);

// ---------------------------------------------------------------------------
// Todolist unification (design preview parity)
//
// panel.js renders 3 source variants with different button text:
//   mentor_todo / user_todo  →  "Approve →"
//   agent_proposal           →  "派给 ▾"
//
// Design system says: one unified list, one "Go →" button, source becomes
// secondary grey label. We rewrite the DOM after panel.js renders.
// (Code-side simplification deferred per user direction.)
// ---------------------------------------------------------------------------
function rewriteTodolist() {
  document.querySelectorAll('.cockpit-todo-action-btn').forEach(btn => {
    if (btn.dataset.rewritten === 'yes') return;
    const txt = (btn.textContent || '').trim();
    // Don't touch buttons in "in flight" states (dispatching... / ✓ dispatched / ✗ error)
    if (txt.startsWith('✓') || txt.startsWith('✗') || txt.includes('...')) return;
    btn.textContent = 'Go →';
    btn.dataset.rewritten = 'yes';
  });
  // Demote source pill: smaller, gray, lowercased.
  document.querySelectorAll('.cockpit-todo-source-pill').forEach(pill => {
    if (pill.dataset.demoted === 'yes') return;
    // Keep only the source word, drop emoji + agent id, lowercase
    const raw = (pill.textContent || '').trim();
    let src = '';
    if (raw.includes('mentor')) src = 'mentor';
    else if (raw.includes('you')) src = 'you';
    else src = (raw.replace(/^\W+\s*/, '').split(/\s+/)[0] || 'agent').slice(0, 8);
    pill.textContent = src;
    pill.dataset.demoted = 'yes';
  });
}
// Watch DOM for todolist changes (panel.js re-renders every poll)
const todoObserver = new MutationObserver(() => rewriteTodolist());
const todoTarget = document.body;
todoObserver.observe(todoTarget, { childList: true, subtree: true });
rewriteTodolist();

// ---------------------------------------------------------------------------
// Inject per-session checkpoints into session cards (design preview parity).
// Conceptually: checkpoints belong to sessions, not the whole project.
// We fetch checkpoints from the mock state and attach them by agent_id match.
// (Code-side: would change cockpit-state to nest checkpoints under sessions.)
// ---------------------------------------------------------------------------
async function injectSessionCheckpoints() {
  try {
    // Get fresh cockpit state from the mock (single source of truth)
    const projectId = (await window.cairn.getSelectedProject()) || 'proj-cairn';
    const state = await window.cairn.getCockpitState(projectId, {});
    if (!state || !state.checkpoints || !state.sessions) return;
    // Group checkpoints by agent_id
    const byAgent = {};
    for (const cp of state.checkpoints) {
      const k = cp.agent_id || '';
      (byAgent[k] = byAgent[k] || []).push(cp);
    }
    // Find each session row and inject its checkpoints
    document.querySelectorAll('.cockpit-session-row').forEach(row => {
      if (row.dataset.cpInjected === 'yes') return;
      const agentId = row.getAttribute('data-agent-id') || '';
      const cps = byAgent[agentId] || [];
      if (cps.length === 0) return;
      const wrap = document.createElement('div');
      wrap.className = 'session-checkpoints';
      wrap.innerHTML =
        '<div class="session-checkpoints-label">↻ ' + cps.length + ' checkpoint' + (cps.length > 1 ? 's' : '') + '</div>' +
        cps.map(c => {
          const sha = (c.git_head || c.checkpoint_id || c.id || '').slice(-7);
          const lbl = c.label || ('before commit ' + sha);
          const ago = relTime(c.created_at);
          return '<div class="session-checkpoint-row">' +
            '<span class="session-checkpoint-sha">' + escapeText(sha) + '</span>' +
            '<span class="session-checkpoint-label">' + escapeText(lbl) + '</span>' +
            '<span class="session-checkpoint-ts">' + ago + '</span>' +
            '<button class="session-checkpoint-btn">Rewind</button>' +
          '</div>';
        }).join('');
      row.appendChild(wrap);
      row.dataset.cpInjected = 'yes';
      // Click handler stops propagation so checkpoint clicks don't open timeline
      wrap.addEventListener('click', e => e.stopPropagation());
    });
  } catch (_) {}
}

function relTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts;
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.round(sec / 60) + 'm ago';
  return Math.round(sec / 3600) + 'h ago';
}
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Re-inject whenever sessions list re-renders
const sessionObserver = new MutationObserver(() => injectSessionCheckpoints());
const sessionListEl = () => document.getElementById('cockpit-sessions-list');
function startSessionWatcher() {
  const el = sessionListEl();
  if (el) {
    sessionObserver.observe(el, { childList: true, subtree: false });
    injectSessionCheckpoints();
  } else {
    setTimeout(startSessionWatcher, 500);
  }
}
startSessionWatcher();
// Also re-run periodically since panel.js re-renders every 1s
setInterval(injectSessionCheckpoints, 1500);

})();
