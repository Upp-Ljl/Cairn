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
// Renderers
// ---------------------------------------------------------------------------

function renderHeader(dbPath) {
  document.getElementById('workspace-label').textContent =
    `workspace: ${shortBasename(dbPath)}`;
  document.getElementById('db-path').textContent =
    `DB: ${dbPath || '(unknown)'}`;
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
// Menu (Switch DB, Open Legacy Inspector)
// ---------------------------------------------------------------------------

function setupMenu() {
  const btn = document.getElementById('menu-btn');
  const pop = document.getElementById('menu-pop');
  const switchDb = document.getElementById('menu-switch-db');
  const openLegacy = document.getElementById('menu-open-legacy');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop.classList.toggle('open');
  });
  document.addEventListener('click', () => pop.classList.remove('open'));

  switchDb.addEventListener('click', async () => {
    pop.classList.remove('open');
    const res = await window.cairn.setDbPath();
    if (res && res.ok) {
      // Force an immediate poll with the new path
      poll().catch(() => {});
    } else if (res && res.error) {
      const footer = document.getElementById('footer');
      footer.textContent = `setDbPath failed: ${res.error}`;
      footer.classList.add('bad');
      setTimeout(() => {
        footer.textContent = 'read-only · polling 1s · Cairn project control surface';
        footer.classList.remove('bad');
      }, 4000);
    }
  });

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
    // Always-on data
    const summaryP = window.cairn.getProjectSummary();
    const dbPathP  = window.cairn.getDbPath();

    // Active-tab data (fetched in parallel; inactive tab keeps last render
    // so switching to it shows previous data instantly while the next
    // poll refreshes).
    const eventsP = activeTab === 'runlog'
      ? window.cairn.getRunLogEvents()
      : Promise.resolve(null);
    const tasksP = activeTab === 'tasks'
      ? window.cairn.getTasksList()
      : Promise.resolve(null);

    // Refresh selected-task detail (if any) in parallel so inline
    // expansion reflects fresh blocker/outcome state.
    const detailP = selectedTaskId
      ? window.cairn.getTaskDetail(selectedTaskId)
      : Promise.resolve(null);

    const [summary, dbPath, events, tasks, detail] = await Promise.all([
      summaryP, dbPathP, eventsP, tasksP, detailP,
    ]);

    renderHeader(dbPath);
    renderSummary(summary);

    if (events) renderRunLog(events);
    if (tasks) {
      lastTasks = tasks;
      // Detail may have changed; refresh before render so inline shows fresh.
      if (selectedTaskId) selectedTaskDetail = detail;
      renderTasks(lastTasks);
    } else if (selectedTaskId) {
      // We're on Run Log tab but a previously-selected task is still
      // expanded under Tasks. Update the detail in case Tasks tab gets
      // reopened.
      selectedTaskDetail = detail;
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
poll();
setInterval(poll, 1000);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.close();
});
