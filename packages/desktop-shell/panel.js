'use strict';

/**
 * Cairn project control surface — panel renderer.
 *
 * Day 1 scope: header (workspace + DB) + summary card + tab placeholders.
 * Run Log + Tasks rendering ship Day 2.
 *
 * Read-only. Polls window.cairn.* IPC every 1s. Mutations are not exposed
 * by the preload bridge unless CAIRN_DESKTOP_ENABLE_MUTATIONS=1, and even
 * then this panel intentionally renders no mutation buttons (only the
 * legacy Inspector does, by design — see PRODUCT.md v3 §12 D9).
 */

// ---------------------------------------------------------------------------
// Sanity: refuse to run without the preload bridge
// ---------------------------------------------------------------------------

if (!window.cairn) {
  document.getElementById('footer').textContent =
    'preload bridge missing — window.cairn is undefined';
  document.getElementById('footer').classList.add('bad');
  throw new Error('panel.js: window.cairn missing');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCount(n) {
  if (n == null) return '—';
  return String(n);
}

function setSummaryCell(el, value, severityHint) {
  el.textContent = fmtCount(value);
  el.classList.remove('warn', 'alert', 'zero');
  if (value === 0 || value == null) {
    el.classList.add('zero');
  } else if (severityHint === 'alert') {
    el.classList.add('alert');
  } else if (severityHint === 'warn') {
    el.classList.add('warn');
  }
}

function shortBasename(p) {
  if (!p) return '?';
  // Bash-style "/" + Windows "\" both supported.
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return p;
  // For DB files in ~/.cairn/foo.db the meaningful label is the dirname
  // (workspace usually = parent dir of the .db). Fall back to the .db name.
  const last = parts[parts.length - 1];
  if (last.endsWith('.db') && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last.replace(/\.db$/i, '');
}

function relTime(unixSec) {
  if (!unixSec) return '?';
  const sec = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function relTimeMs(unixMs) {
  if (!unixMs) return '?';
  return relTime(Math.floor(unixMs / 1000));
}

function fmtClockMs(unixMs) {
  if (!unixMs) return '—';
  const d = new Date(unixMs);
  // HH:MM:SS in local time. Run Log has tabular columns; this gives a
  // consistent width without needing absolute dates for recent rows.
  return d.toTimeString().slice(0, 8);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------------------------------------------------------------------------
// View state — Project-Aware (L1 default; L2 when selectedProject is set)
// ---------------------------------------------------------------------------

let currentView = 'projects'; // 'projects' | 'project'
/** @type {{id:string,label:string,project_root:string,db_path:string}|null} */
let selectedProject = null;

function setView(name, projectMeta) {
  currentView = name;
  if (name === 'project') {
    selectedProject = projectMeta || null;
  }
  document.getElementById('view-projects-list').hidden = (name !== 'projects');
  document.getElementById('view-project').hidden       = (name !== 'project');
  // Back-button menu item visible only in project view.
  const backBtn = document.getElementById('menu-back-to-projects');
  if (backBtn) backBtn.hidden = (name !== 'project');
  // Re-render header label
  renderHeaderForView();
  // Force an immediate poll to populate the new view fast.
  poll().catch(() => {});
}

function renderHeaderForView() {
  const wl = document.getElementById('workspace-label');
  const dp = document.getElementById('db-path');
  if (currentView === 'projects') {
    wl.textContent = 'Cairn — Projects';
    dp.textContent = '';
  } else if (currentView === 'project' && selectedProject) {
    wl.textContent = selectedProject.label || '(project)';
    dp.textContent = `DB: ${shortBasename(selectedProject.db_path)}`;
  } else {
    wl.textContent = 'Cairn';
    dp.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderHeader(_dbPath) {
  // Header is now driven by view state, not by a single DB path.
  // Kept as a no-op for callers; the actual update happens in
  // renderHeaderForView (after view switches and on poll).
  renderHeaderForView();
}

function renderSummary(summary) {
  if (!summary || !summary.available) {
    setSummaryCell(document.getElementById('s-agents'), 0);
    setSummaryCell(document.getElementById('s-tasks'), 0);
    setSummaryCell(document.getElementById('s-blockers'), 0);
    setSummaryCell(document.getElementById('s-fail'), 0);
    setSummaryCell(document.getElementById('s-conflicts'), 0);
    setSummaryCell(document.getElementById('s-dispatch'), 0);
    const meta = document.getElementById('summary-meta');
    meta.textContent = summary && summary.db_path
      ? `DB unavailable at ${summary.db_path}`
      : 'DB not connected';
    return;
  }

  setSummaryCell(document.getElementById('s-agents'),
    summary.agents_active);

  // tasks: present three numbers in one cell, color by worst (alert if any FAIL,
  // warn if blocked/review, zero otherwise).
  const tasksEl = document.getElementById('s-tasks');
  tasksEl.textContent = `${summary.tasks_running} / ${summary.tasks_blocked} / ${summary.tasks_waiting_review}`;
  tasksEl.classList.remove('warn', 'alert', 'zero');
  const tasksTotal = summary.tasks_running + summary.tasks_blocked + summary.tasks_waiting_review;
  if (tasksTotal === 0) tasksEl.classList.add('zero');
  else if (summary.tasks_blocked > 0 || summary.tasks_waiting_review > 0) tasksEl.classList.add('warn');

  setSummaryCell(document.getElementById('s-blockers'),
    summary.blockers_open,
    summary.blockers_open > 0 ? 'warn' : null);

  setSummaryCell(document.getElementById('s-fail'),
    summary.outcomes_failed,
    summary.outcomes_failed > 0 ? 'alert' : null);

  setSummaryCell(document.getElementById('s-conflicts'),
    summary.conflicts_open,
    summary.conflicts_open > 0 ? 'alert' : null);

  setSummaryCell(document.getElementById('s-dispatch'),
    summary.dispatches_recent_1h);

  const meta = document.getElementById('summary-meta');
  meta.textContent = `read-only · last poll ${relTime(summary.ts)}`;
}

// ---------------------------------------------------------------------------
// Run Log + Tasks renderers (Day 2)
// ---------------------------------------------------------------------------

function renderRunLog(events) {
  const el = document.getElementById('runlog-list');
  if (!events || !events.length) {
    el.innerHTML = '<div class="placeholder">no events yet — Cairn DB is quiet</div>';
    return;
  }
  el.innerHTML = events.map(ev => {
    const sevClass = `sev-${ev.severity || 'info'}`;
    const tsLabel = fmtClockMs(ev.ts);
    const msg = escapeHtml(ev.message || '');
    const targetHint = ev.task_id
      ? `<span style="color:#557">${escapeHtml(ev.task_id.slice(0, 14))}</span> · `
      : '';
    return (
      `<div class="ev ${sevClass}">` +
        `<span class="ts">${tsLabel}</span>` +
        `<span class="src">${escapeHtml(ev.source)}</span>` +
        `<span class="ty">${escapeHtml(ev.type)}</span>` +
        `<span class="msg">${targetHint}${msg}</span>` +
      `</div>`
    );
  }).join('');
}

// Persistent across polls so inline expansions survive 1s refreshes.
let selectedTaskId = null;
/** @type {Object|null} */
let selectedTaskDetail = null;

function renderTaskDetail(detail) {
  if (!detail) return '<div class="tk-detail">detail unavailable</div>';
  const t = detail.task;
  const blockers = detail.blockers || [];
  const latestOpen = blockers.find(b => b.status === 'OPEN') || null;
  const latestAnswered = blockers.find(b => b.status === 'ANSWERED') || null;
  const latest = latestOpen || latestAnswered || blockers[0] || null;
  const out = detail.outcome;

  const blockerPill = (() => {
    if (detail.blockers_open_count > 0) {
      return `<span class="pill warn">blocker OPEN ×${detail.blockers_open_count}</span>`;
    }
    if (blockers.length > 0) {
      return `<span class="pill">blocker history ×${blockers.length}</span>`;
    }
    return '<span class="pill">no blockers</span>';
  })();

  const outcomePill = (() => {
    if (!out) return '<span class="pill">no outcome</span>';
    const cls =
      out.status === 'PASS' ? 'ok' :
      (out.status === 'FAIL' || out.status === 'TERMINAL_FAIL') ? 'error' :
      out.status === 'PENDING' ? 'warn' : '';
    return `<span class="pill ${cls}">outcome ${out.status} (${detail.outcome_criteria_count} criteria)</span>`;
  })();

  const blockerSummary = latest
    ? `<div class="kv"><span class="k">latest blocker</span><span class="v">${escapeHtml(latest.status)} · ${escapeHtml(latest.question || '')}${latest.answer ? '<br><span style=\"color:#666\">→ ' + escapeHtml(latest.answer) + '</span>' : ''}</span></div>`
    : '';

  const outcomeSummary = out && out.status !== 'PENDING' && out.evaluation_summary
    ? `<div class="kv"><span class="k">last evaluation</span><span class="v">${escapeHtml(out.evaluation_summary)}</span></div>`
    : '';

  return (
    `<div class="tk-detail">` +
      `<div style="margin-bottom:4px">${blockerPill}${outcomePill}</div>` +
      `<div class="kv"><span class="k">task_id</span><span class="v">${escapeHtml(t.task_id)}</span></div>` +
      (t.parent_task_id
        ? `<div class="kv"><span class="k">parent</span><span class="v">${escapeHtml(t.parent_task_id)}</span></div>`
        : '') +
      `<div class="kv"><span class="k">created_by</span><span class="v">${escapeHtml(t.created_by_agent_id || '—')}</span></div>` +
      `<div class="kv"><span class="k">created</span><span class="v">${relTimeMs(t.created_at)}</span></div>` +
      `<div class="kv"><span class="k">updated</span><span class="v">${relTimeMs(t.updated_at)}</span></div>` +
      blockerSummary +
      outcomeSummary +
    `</div>`
  );
}

function renderTasks(tasks) {
  const el = document.getElementById('tasks-list');
  if (!tasks || !tasks.length) {
    el.innerHTML = '<div class="placeholder">no tasks yet — start an MCP session and call cairn.task.create</div>';
    return;
  }
  el.innerHTML = tasks.map(t => {
    const isSelected = (t.task_id === selectedTaskId);
    const stateCls = `s-${t.state}`;
    const detailHtml = isSelected ? renderTaskDetail(selectedTaskDetail) : '';
    const parentLabel = t.parent_task_id ? ` · ⤴ ${escapeHtml(t.parent_task_id.slice(0, 12))}` : '';
    return (
      `<div class="tk${isSelected ? ' selected' : ''}" data-task-id="${escapeHtml(t.task_id)}">` +
        `<div class="tk-line">` +
          `<span class="tk-state ${stateCls}">${escapeHtml(t.state)}</span>` +
          `<span class="tk-intent">${escapeHtml(t.intent || '')}${parentLabel}</span>` +
          `<span class="tk-meta">${relTimeMs(t.updated_at)}</span>` +
        `</div>` +
        detailHtml +
      `</div>`
    );
  }).join('');

  // Wire click handlers (rebuilt every render — cheap with ≤100 rows).
  el.querySelectorAll('.tk').forEach(row => {
    row.addEventListener('click', async () => {
      const id = row.getAttribute('data-task-id');
      if (selectedTaskId === id) {
        // toggle: collapse
        selectedTaskId = null;
        selectedTaskDetail = null;
      } else {
        selectedTaskId = id;
        selectedTaskDetail = null; // show the row immediately, populate on reply
        try {
          selectedTaskDetail = await window.cairn.getTaskDetail(id);
        } catch (_e) { selectedTaskDetail = null; }
      }
      // Re-render Tasks tab once with new selection state.
      renderTasks(lastTasks);
    });
  });
}

// ---------------------------------------------------------------------------
// Tab switching — track active tab so polling fetches only what's visible
// ---------------------------------------------------------------------------

let activeTab = 'runlog';
let lastTasks = [];

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const views = {
    runlog: document.getElementById('view-runlog'),
    tasks:  document.getElementById('view-tasks'),
  };
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.toggle('active', b === btn));
      const target = btn.getAttribute('data-tab');
      Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== target); });
      activeTab = target;
      // Force an immediate poll so the view doesn't sit empty for up to 1s.
      poll().catch(() => {});
    });
  });
}

// ---------------------------------------------------------------------------
// L1 Projects-list renderer
// ---------------------------------------------------------------------------

function healthDot(state) {
  const ch = state === 'alert' ? '●' : state === 'warn' ? '◐' : '○';
  return `<span class="health-dot ${state || 'idle'}">${ch}</span>`;
}

function countCell(n, severity) {
  const cls = (n === 0 || n == null) ? 'zero' : (severity || '');
  return `<span class="${cls}">${n == null ? '—' : n}</span>`;
}

function renderProjectsList(payload) {
  const el = document.getElementById('projects-list-body');
  if (!payload) {
    el.innerHTML = '<div class="placeholder">no data</div>';
    return;
  }
  const projects   = payload.projects   || [];
  const unassigned = payload.unassigned || [];

  if (projects.length === 0 && unassigned.length === 0) {
    el.innerHTML =
      '<div class="pl-empty">no projects registered yet — click <b>＋ Add project…</b> below to get started</div>';
    return;
  }

  // Sort: alert > warn > idle, then by last_activity_at DESC.
  const ordered = projects.slice().sort((a, b) => {
    const order = { alert: 0, warn: 1, idle: 2 };
    const ah = (a.summary && a.summary.health) || 'idle';
    const bh = (b.summary && b.summary.health) || 'idle';
    if (order[ah] !== order[bh]) return order[ah] - order[bh];
    const la = (a.summary && a.summary.last_activity_at) || 0;
    const lb = (b.summary && b.summary.last_activity_at) || 0;
    return lb - la;
  });

  let html = '';
  if (ordered.length > 0) {
    html += `<div class="pl-section-title">PROJECTS (${ordered.length})</div>`;
    for (const p of ordered) html += renderProjectCard(p);
  }
  if (unassigned.length > 0) {
    html += `<div class="pl-section-title">UNASSIGNED (${unassigned.length})</div>`;
    for (const u of unassigned) html += renderUnassignedCard(u);
  }
  el.innerHTML = html;

  // Wire click handlers (on each row, bubble-style).
  el.querySelectorAll('.pcard[data-project-id]').forEach(node => {
    node.addEventListener('click', async ev => {
      // Skip if user clicked an inline action link
      if (ev.target.closest('.pcard-actions a')) return;
      const id = node.getAttribute('data-project-id');
      const proj = ordered.find(p => p.id === id);
      if (!proj) return;
      const res = await window.cairn.selectProject(id);
      if (res && res.ok) {
        setView('project', { id: proj.id, label: proj.label, project_root: proj.project_root, db_path: proj.db_path });
      }
    });
  });

  el.querySelectorAll('.pcard-actions a[data-action]').forEach(a => {
    a.addEventListener('click', async ev => {
      ev.stopPropagation();
      const action = a.getAttribute('data-action');
      const id = a.getAttribute('data-project-id');
      if (action === 'remove') {
        await window.cairn.removeProject(id);
        poll().catch(() => {});
      } else if (action === 'rename') {
        const cur = ordered.find(p => p.id === id);
        const next = prompt('New label:', cur ? cur.label : '');
        if (next != null && next.trim()) {
          await window.cairn.renameProject(id, next.trim());
          poll().catch(() => {});
        }
      }
    });
  });
}

function renderProjectCard(p) {
  const s = p.summary || {};
  const state = s.health || 'idle';
  const dbBasename = shortBasename(p.db_path) + (p.db_path.includes('.cairn') ? ' (.cairn)' : '');
  const counts =
    `agents ${countCell(s.agents_active, 'idle')}` +
    (s.agents_stale ? `(+${s.agents_stale} stale)` : '') +
    `<span class="sep">·</span>` +
    `tasks ${countCell(s.tasks_running, '')} / ${countCell(s.tasks_blocked, 'warn')} / ${countCell(s.tasks_waiting_review, 'warn')}` +
    `<span class="sep">·</span>` +
    `block ${countCell(s.blockers_open, 'warn')}` +
    `<span class="sep">·</span>` +
    `FAIL ${countCell((s.outcomes_failed || 0) + (s.tasks_failed || 0), 'alert')}` +
    `<span class="sep">·</span>` +
    `conflict ${countCell(s.conflicts_open, 'alert')}`;
  const lastAct = s.last_activity_at
    ? relTimeMs(s.last_activity_at)
    : '—';
  const hintLine = (p.agent_id_hints && p.agent_id_hints.length)
    ? `${p.agent_id_hints.length} hint${p.agent_id_hints.length === 1 ? '' : 's'}: ${p.agent_id_hints.slice(0, 2).map(h => h.slice(0, 16)).join(', ')}${p.agent_id_hints.length > 2 ? '…' : ''}`
    : 'no hints — click Add hint in detail view';

  return (
    `<div class="pcard" data-project-id="${escapeHtml(p.id)}">` +
      `<div class="pcard-line1">` +
        healthDot(state) +
        `<span class="pcard-label">${escapeHtml(p.label || '(project)')}</span>` +
        `<span class="pcard-act">${escapeHtml(lastAct)}</span>` +
      `</div>` +
      `<div class="pcard-line2">${escapeHtml(p.project_root || '(unknown)')}</div>` +
      `<div class="pcard-line3">DB: ${escapeHtml(dbBasename)} · ${escapeHtml(hintLine)}</div>` +
      `<div class="pcard-counts">${counts}</div>` +
      `<div class="pcard-actions">` +
        `<a data-action="rename" data-project-id="${escapeHtml(p.id)}">rename</a>` +
        `<a data-action="remove" data-project-id="${escapeHtml(p.id)}">remove</a>` +
      `</div>` +
    `</div>`
  );
}

function renderUnassignedCard(u) {
  const total = u.total_rows || 0;
  const sub =
    `agents ${u.agents}` +
    `<span class="sep">·</span>tasks ${u.tasks}` +
    `<span class="sep">·</span>block ${u.blockers}` +
    `<span class="sep">·</span>outcome ${u.outcomes}` +
    `<span class="sep">·</span>ckpt ${u.checkpoints}` +
    `<span class="sep">·</span>conflict ${u.conflicts}` +
    `<span class="sep">·</span>disp ${u.dispatches}`;
  const lastAct = u.last_activity_at ? relTimeMs(u.last_activity_at) : '—';

  return (
    `<div class="pcard uacard">` +
      `<div class="pcard-line1">` +
        `<span class="health-dot unassigned">◇</span>` +
        `<span class="pcard-label">Unassigned</span>` +
        `<span class="pcard-act">${escapeHtml(lastAct)}</span>` +
      `</div>` +
      `<div class="pcard-line2">DB: ${escapeHtml(u.db_path)}</div>` +
      `<div class="pcard-line3">${total} row${total === 1 ? '' : 's'} not matched by any project's hints</div>` +
      `<div class="pcard-counts">${sub}</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Menu (Add project / Back to projects / Open Legacy Inspector)
// ---------------------------------------------------------------------------

function setupMenu() {
  const btn        = document.getElementById('menu-btn');
  const pop        = document.getElementById('menu-pop');
  const back       = document.getElementById('menu-back-to-projects');
  const addProj    = document.getElementById('menu-add-project');
  const openLegacy = document.getElementById('menu-open-legacy');
  const plAddBtn   = document.getElementById('pl-add-btn');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop.classList.toggle('open');
  });
  document.addEventListener('click', () => pop.classList.remove('open'));

  back.addEventListener('click', async () => {
    pop.classList.remove('open');
    await window.cairn.selectProject(null);
    setView('projects', null);
  });

  async function doAddProject() {
    const res = await window.cairn.addProject({});
    if (res && res.ok) {
      poll().catch(() => {});
    } else if (res && res.error && res.error !== 'cancelled') {
      const footer = document.getElementById('footer');
      footer.textContent = `addProject failed: ${res.error}`;
      footer.classList.add('bad');
      setTimeout(() => {
        footer.textContent = 'read-only · polling 1s · Cairn project control surface';
        footer.classList.remove('bad');
      }, 4000);
    }
  }
  addProj.addEventListener('click', () => {
    pop.classList.remove('open');
    doAddProject();
  });
  if (plAddBtn) plAddBtn.addEventListener('click', doAddProject);

  openLegacy.addEventListener('click', () => {
    pop.classList.remove('open');
    window.cairn.openLegacyInspector();
  });
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function poll() {
  try {
    if (currentView === 'projects') {
      // L1 view — fetch the projects list payload (per-project summaries
      // + Unassigned buckets). Header and summary card are not used.
      const payload = await window.cairn.getProjectsList();
      renderProjectsList(payload);
      renderHeaderForView();
    } else {
      // L2 view — Quick-Slice surface scoped to the active project.
      const summaryP = window.cairn.getProjectSummary();
      const dbPathP  = window.cairn.getDbPath();

      const eventsP = activeTab === 'runlog'
        ? window.cairn.getRunLogEvents()
        : Promise.resolve(null);
      const tasksP = activeTab === 'tasks'
        ? window.cairn.getTasksList()
        : Promise.resolve(null);
      const detailP = selectedTaskId
        ? window.cairn.getTaskDetail(selectedTaskId)
        : Promise.resolve(null);

      const [summary, _dbPath, events, tasks, detail] = await Promise.all([
        summaryP, dbPathP, eventsP, tasksP, detailP,
      ]);

      renderHeaderForView();
      renderSummary(summary);

      if (events) renderRunLog(events);
      if (tasks) {
        lastTasks = tasks;
        if (selectedTaskId) selectedTaskDetail = detail;
        renderTasks(lastTasks);
      } else if (selectedTaskId) {
        selectedTaskDetail = detail;
      }
    }

    // Reset footer if it was showing an error
    const footer = document.getElementById('footer');
    if (footer.classList.contains('bad')) {
      footer.textContent = 'read-only · polling 1s · Cairn project control surface';
      footer.classList.remove('bad');
    }
  } catch (err) {
    const footer = document.getElementById('footer');
    footer.textContent = `poll error: ${err && err.message ? err.message : err}`;
    footer.classList.add('bad');
  }
}

setupTabs();
setupMenu();
setView('projects', null);
poll();
setInterval(poll, 1000);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // Esc on L2 returns to L1; Esc on L1 closes the panel.
    if (currentView === 'project') {
      window.cairn.selectProject(null).then(() => setView('projects', null));
    } else {
      window.close();
    }
  }
});
