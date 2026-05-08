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

let currentView = 'projects'; // 'projects' | 'project' | 'unassigned'
/** @type {{id:string,label:string,project_root:string,db_path:string}|null} */
let selectedProject = null;
/** @type {string|null} db_path the user is drilling into in the Unassigned view */
let selectedUnassignedDbPath = null;
/** @type {string|null} agent_id the Tasks tab is filtered to (set from Sessions tab) */
let selectedAgentId = null;

function setView(name, meta) {
  // A view switch means the L2 task drill-down is no longer valid:
  // task_ids belong to a particular project's DB attribution, so a
  // selection from project A must not bleed into project B (or into
  // the L1 list, where the next entry will repopulate it from a
  // possibly-different project anyway). Same applies to the agent
  // filter chip and the Unassigned drill-down: each L2 entry starts
  // with a clean slate.
  const nextProjectId = (name === 'project' && meta) ? meta.id : null;
  const prevProjectId = selectedProject ? selectedProject.id : null;
  if (name !== 'project' || nextProjectId !== prevProjectId) {
    clearTaskSelection();
    selectedAgentId = null;
  }
  // Always reset the Unassigned drill-down pointer when leaving the view.
  if (name !== 'unassigned') {
    selectedUnassignedDbPath = null;
  }
  currentView = name;
  if (name === 'project') {
    selectedProject = meta || null;
  } else if (name === 'unassigned') {
    selectedUnassignedDbPath = (meta && meta.db_path) || null;
    selectedProject = null;
  } else {
    selectedProject = null;
  }
  document.getElementById('view-projects-list').hidden = (name !== 'projects');
  document.getElementById('view-project').hidden       = (name !== 'project');
  document.getElementById('view-unassigned').hidden    = (name !== 'unassigned');
  // Back-button menu item visible in any non-L1 view.
  const backBtn = document.getElementById('menu-back-to-projects');
  if (backBtn) backBtn.hidden = (name === 'projects');
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
  } else if (currentView === 'unassigned') {
    wl.textContent = 'Unassigned';
    dp.textContent = selectedUnassignedDbPath
      ? `DB: ${shortBasename(selectedUnassignedDbPath)}`
      : '';
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
/** @type {Array|null} fetched on detail expand */
let selectedTaskCheckpoints = null;
/** @type {Set<string>} task_ids whose subtree is expanded in the L2 tree */
let expandedTaskIds = new Set();

function clearTaskSelection() {
  selectedTaskId = null;
  selectedTaskDetail = null;
  selectedTaskCheckpoints = null;
  // Tree-expansion state is also project-scoped (task_ids only have
  // meaning within one DB attribution) — reset on project switch.
  expandedTaskIds = new Set();
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function renderCheckpointsSection(checkpoints) {
  if (checkpoints == null) {
    return `<div class="ckpt-section"><div class="head">checkpoints</div><div style="color:#666">loading…</div></div>`;
  }
  if (!checkpoints.length) {
    return `<div class="ckpt-section"><div class="head">checkpoints</div><div style="color:#666">none recorded</div></div>`;
  }
  const rows = checkpoints.map(c => {
    const head = c.git_head ? String(c.git_head).slice(0, 7) : '—';
    const labelTxt = c.label
      ? `<span class="label">${escapeHtml(c.label)}</span> · ${escapeHtml(c.id.slice(0, 12))}`
      : escapeHtml(c.id.slice(0, 12));
    const ts = relTimeMs(c.ready_at || c.created_at);
    return (
      `<div class="ckpt">` +
        `<span class="ckpt-status ${escapeHtml(c.snapshot_status)}">${escapeHtml(c.snapshot_status)}</span>` +
        `<span class="ckpt-id" title="${escapeHtml(c.id)}">${labelTxt} <span style="color:#666">@${escapeHtml(head)}</span></span>` +
        `<span class="ckpt-meta">${escapeHtml(ts)} · ${escapeHtml(fmtBytes(c.size_bytes))}</span>` +
        `<button class="ckpt-copy" data-ckpt-id="${escapeHtml(c.id)}" type="button">copy id</button>` +
      `</div>`
    );
  }).join('');
  return `<div class="ckpt-section"><div class="head">checkpoints (${checkpoints.length})</div>${rows}</div>`;
}

function renderTaskDetail(detail, checkpoints) {
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
      renderCheckpointsSection(checkpoints) +
    `</div>`
  );
}

function renderTasksFilterChip() {
  const el = document.getElementById('tasks-filter-chip');
  if (!el) return;
  if (!selectedAgentId) { el.innerHTML = ''; return; }
  el.innerHTML =
    `<div class="filter-chip">` +
      `<span>filter · agent <code>${escapeHtml(selectedAgentId)}</code></span>` +
      `<a id="tasks-filter-clear">clear</a>` +
    `</div>`;
  const clr = document.getElementById('tasks-filter-clear');
  if (clr) clr.addEventListener('click', () => {
    selectedAgentId = null;
    renderTasksFilterChip();
    renderTasks(lastTasks);
  });
}

function buildTaskTree(tasks) {
  // Returns { roots, childMap }. Roots = tasks whose parent is NULL or
  // whose parent isn't present in the filtered set (so a child whose
  // parent was filtered out by selectedAgentId becomes its own root).
  const idSet = new Set(tasks.map(t => t.task_id));
  const childMap = new Map();
  const roots = [];
  for (const t of tasks) {
    const parent = t.parent_task_id;
    if (!parent || !idSet.has(parent)) {
      roots.push(t);
    } else {
      if (!childMap.has(parent)) childMap.set(parent, []);
      childMap.get(parent).push(t);
    }
  }
  return { roots, childMap, idSet };
}

function renderTaskMiniPills(t) {
  const pills = [];
  if (t.blockers_open > 0) {
    pills.push(`<span class="pill warn">B×${t.blockers_open}</span>`);
  } else if (t.blockers_total > 0) {
    pills.push(`<span class="pill">b×${t.blockers_total}</span>`);
  }
  if (t.outcome_status) {
    const cls =
      t.outcome_status === 'PASS' ? 'ok' :
      (t.outcome_status === 'FAIL' || t.outcome_status === 'TERMINAL_FAIL') ? 'error' :
      t.outcome_status === 'PENDING' ? 'warn' : '';
    pills.push(`<span class="pill ${cls}">${escapeHtml(t.outcome_status)}</span>`);
  }
  if (t.checkpoints_total > 0) {
    pills.push(`<span class="pill">ckpt×${t.checkpoints_total}</span>`);
  }
  if (!pills.length) return '';
  return `<span class="tk-mini-pills">${pills.join('')}</span>`;
}

function renderTaskRow(t, depth, hasChildren) {
  const isSelected = (t.task_id === selectedTaskId);
  const stateCls = `s-${t.state}`;
  const expanded = expandedTaskIds.has(t.task_id);
  const chev = hasChildren
    ? `<span class="tk-chev" data-chev="${escapeHtml(t.task_id)}">${expanded ? '▼' : '▶'}</span>`
    : `<span class="tk-chev leaf">·</span>`;
  const agent = t.created_by_agent_id
    ? `<span style="color:#88a">${escapeHtml(t.created_by_agent_id.slice(0, 16))}</span>`
    : `<span style="color:#555">unattributed</span>`;
  const indent = depth > 0
    ? `style="padding-left:${12 + depth * 16}px"`
    : '';
  const detailHtml = isSelected
    ? renderTaskDetail(selectedTaskDetail, selectedTaskCheckpoints)
    : '';
  return (
    `<div class="tk${isSelected ? ' selected' : ''}" data-task-id="${escapeHtml(t.task_id)}" ${indent}>` +
      `<div class="tk-line">` +
        chev +
        `<span class="tk-state ${stateCls}">${escapeHtml(t.state)}</span>` +
        `<span class="tk-intent">${escapeHtml(t.intent || '')} ${agent}${renderTaskMiniPills(t)}</span>` +
        `<span class="tk-meta">${relTimeMs(t.updated_at)}</span>` +
      `</div>` +
      detailHtml +
    `</div>`
  );
}

function flattenTreeForRender(roots, childMap, depth, acc) {
  for (const t of roots) {
    const children = childMap.get(t.task_id) || [];
    acc.push({ task: t, depth, hasChildren: children.length > 0 });
    if (children.length > 0 && expandedTaskIds.has(t.task_id)) {
      flattenTreeForRender(children, childMap, depth + 1, acc);
    }
  }
  return acc;
}

/**
 * @param {{available?:boolean, hints_empty?:boolean, tasks?:Array}|Array|null} payload
 */
function renderTasks(payload) {
  const el = document.getElementById('tasks-list');
  renderTasksFilterChip();

  const isPayload = payload && !Array.isArray(payload) && typeof payload === 'object';
  const tasksRaw = isPayload ? (payload.tasks || []) : (payload || []);
  const hintsEmpty = isPayload ? !!payload.hints_empty : false;

  if (hintsEmpty) {
    el.innerHTML =
      '<div class="placeholder">' +
      'this project has no agent_id_hints yet — click <b>Unassigned</b> on the projects list and use<br>' +
      '<b>Add to project…</b> on a session to attribute it here.' +
      '</div>';
    return;
  }

  let view = tasksRaw;
  if (selectedAgentId) {
    view = view.filter(t => t.created_by_agent_id === selectedAgentId);
  }
  if (!view.length) {
    if (selectedAgentId) {
      el.innerHTML = `<div class="placeholder">no tasks for agent <code>${escapeHtml(selectedAgentId)}</code> in this project</div>`;
    } else {
      el.innerHTML = '<div class="placeholder">no tasks yet — start an MCP session and call cairn.task.create</div>';
    }
    return;
  }

  const tree = buildTaskTree(view);
  const flat = flattenTreeForRender(tree.roots, tree.childMap, 0, []);
  el.innerHTML = flat.map(r => renderTaskRow(r.task, r.depth, r.hasChildren)).join('');

  // Chevron toggles tree expand without opening the detail card.
  el.querySelectorAll('.tk-chev[data-chev]').forEach(c => {
    c.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = c.getAttribute('data-chev');
      if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
      else expandedTaskIds.add(id);
      renderTasks(lastTasks);
    });
  });

  // Row click opens / closes the inline detail card.
  el.querySelectorAll('.tk').forEach(row => {
    row.addEventListener('click', async ev => {
      // Don't double-fire when chevron / detail children were clicked.
      if (ev.target.closest('.tk-chev[data-chev]')) return;
      if (ev.target.closest('.ckpt-copy')) return;
      const id = row.getAttribute('data-task-id');
      if (selectedTaskId === id) {
        selectedTaskId = null;
        selectedTaskDetail = null;
        selectedTaskCheckpoints = null;
      } else {
        selectedTaskId = id;
        selectedTaskDetail = null;
        selectedTaskCheckpoints = null; // will populate after IPC reply
        // Auto-expand the subtree so the user sees children alongside detail.
        expandedTaskIds.add(id);
        try {
          const [d, ckpts] = await Promise.all([
            window.cairn.getTaskDetail(id),
            window.cairn.getTaskCheckpoints(id),
          ]);
          // Make sure this is still the selection by the time we resolve
          // (a fast user might have clicked another row in the meantime).
          if (selectedTaskId === id) {
            selectedTaskDetail = d;
            selectedTaskCheckpoints = ckpts || [];
          }
        } catch (_e) {
          if (selectedTaskId === id) {
            selectedTaskDetail = null;
            selectedTaskCheckpoints = [];
          }
        }
      }
      renderTasks(lastTasks);
    });
  });

  // Copy-checkpoint-id buttons (read-only — no DB writes).
  el.querySelectorAll('.ckpt-copy').forEach(btn => {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const id = btn.getAttribute('data-ckpt-id');
      try {
        await navigator.clipboard.writeText(id);
        const orig = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1200);
      } catch (_e) { /* clipboard may be unavailable */ }
    });
  });
}

// ---------------------------------------------------------------------------
// Sessions tab + Unassigned-agent rendering (Day 3)
// ---------------------------------------------------------------------------

function fmtTtl(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  return `${Math.round(sec / 60)}m`;
}

function renderCapChips(caps) {
  if (!caps || !caps.length) return '';
  const shown = caps.slice(0, 4).map(c =>
    `<span class="sess-cap-chip">${escapeHtml(String(c).slice(0, 16))}</span>`).join('');
  const more = caps.length > 4 ? `<span class="sess-cap-chip">+${caps.length - 4}</span>` : '';
  return shown + more;
}

function renderOwnsTasks(o) {
  if (!o) return '';
  const cell = (n, sev) => {
    const cls = (n === 0) ? 'zero' : (sev || '');
    return `<span class="num ${cls}">${n}</span>`;
  };
  return (
    `tasks ${cell(o.RUNNING, '')}` +
    `<span class="sep">/</span>${cell(o.BLOCKED, 'warn')}` +
    `<span class="sep">/</span>${cell(o.WAITING_REVIEW, 'warn')}` +
    `<span class="sep">/</span>${cell(o.DONE, '')}` +
    `<span class="sep">/</span>${cell(o.FAILED, 'alert')}` +
    `<span class="sep" style="padding-left:6px">·</span>` +
    `<span style="color:#666;font-size:0.85em">R/B/WR/D/F</span>`
  );
}

function renderSessionRow(sess, opts) {
  const allowFilter   = !!(opts && opts.allowFilter);
  const allowAddTo    = !!(opts && opts.allowAddTo);
  const stateLabel = sess.computed_state; // ACTIVE | STALE | DEAD | OTHER
  const heartbeatTxt = sess.last_heartbeat
    ? `${relTimeMs(sess.last_heartbeat)} (ttl ${fmtTtl(sess.heartbeat_ttl)})`
    : `never (ttl ${fmtTtl(sess.heartbeat_ttl)})`;
  const actions = [];
  if (allowFilter) {
    actions.push(`<a data-act="filter-tasks" data-agent="${escapeHtml(sess.agent_id)}">filter Tasks tab →</a>`);
  }
  if (allowAddTo) {
    actions.push(`<a data-act="add-to-project" data-agent="${escapeHtml(sess.agent_id)}">Add to project…</a>`);
  }
  return (
    `<div class="sess" data-agent="${escapeHtml(sess.agent_id)}">` +
      `<div class="sess-line1">` +
        `<span class="sess-state s-${escapeHtml(stateLabel)}">${escapeHtml(stateLabel)}</span>` +
        `<span class="sess-id"><code>${escapeHtml(sess.agent_id)}</code> <span class="at-type">@${escapeHtml(sess.agent_type)}</span></span>` +
        `<span class="sess-meta">${escapeHtml(heartbeatTxt)}</span>` +
      `</div>` +
      `<div class="sess-line2">${renderCapChips(sess.capabilities)}</div>` +
      `<div class="sess-line3">${renderOwnsTasks(sess.owns_tasks)}</div>` +
      (actions.length ? `<div class="sess-actions">${actions.join('')}</div>` : '') +
    `</div>`
  );
}

let lastSessions = [];

function renderSessions(payload) {
  const el = document.getElementById('sessions-list');
  if (!payload || !payload.available) {
    el.innerHTML = '<div class="placeholder">no sessions data — DB not connected</div>';
    return;
  }
  const sessions = payload.sessions || [];
  lastSessions = sessions;
  if (!sessions.length) {
    el.innerHTML = '<div class="placeholder">no sessions matched this project\'s hints<br>add a hint to start attributing presence rows</div>';
    return;
  }
  // Group: ACTIVE / STALE / OTHER (DEAD or IDLE).
  const groups = { ACTIVE: [], STALE: [], OTHER: [] };
  for (const s of sessions) {
    if (s.computed_state === 'ACTIVE')      groups.ACTIVE.push(s);
    else if (s.computed_state === 'STALE')  groups.STALE.push(s);
    else                                    groups.OTHER.push(s);
  }
  let html = '';
  if (groups.ACTIVE.length) {
    html += `<div class="sess-group-title">ACTIVE (${groups.ACTIVE.length})</div>`;
    html += groups.ACTIVE.map(s => renderSessionRow(s, { allowFilter: true })).join('');
  }
  if (groups.STALE.length) {
    html += `<div class="sess-group-title alert">STALE (${groups.STALE.length})</div>`;
    html += groups.STALE.map(s => renderSessionRow(s, { allowFilter: true })).join('');
  }
  if (groups.OTHER.length) {
    html += `<div class="sess-group-title">DEAD / IDLE (${groups.OTHER.length})</div>`;
    html += groups.OTHER.map(s => renderSessionRow(s, { allowFilter: true })).join('');
  }
  el.innerHTML = html;

  el.querySelectorAll('.sess-actions a[data-act="filter-tasks"]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.stopPropagation();
      const agent = a.getAttribute('data-agent');
      selectedAgentId = agent;
      setActiveTab('tasks');
    });
  });
}

// ---------------------------------------------------------------------------
// Unassigned drill-down + agent → project picker modal (Day 3)
// ---------------------------------------------------------------------------

let lastUnassignedDetail = null;

function renderUnassignedDetail(detail) {
  const titleEl  = document.getElementById('ua-title');
  const dbEl     = document.getElementById('ua-db-path');
  const countsEl = document.getElementById('ua-counts');
  const listEl   = document.getElementById('ua-agents-list');

  if (!detail) {
    titleEl.textContent  = 'Unassigned';
    dbEl.textContent     = selectedUnassignedDbPath || '';
    countsEl.textContent = 'unavailable';
    listEl.innerHTML     = '<div class="placeholder">DB not connected</div>';
    return;
  }
  lastUnassignedDetail = detail;

  titleEl.textContent = `Unassigned · ${detail.total_rows || 0} row${detail.total_rows === 1 ? '' : 's'} not matched by any project's hints`;
  dbEl.textContent    = `DB: ${detail.db_path}`;
  countsEl.innerHTML  =
    `agents <b>${detail.agents.length}</b>` +
    `<span class="sep">·</span>tasks ${detail.tasks}` +
    `<span class="sep">·</span>blockers ${detail.blockers}` +
    `<span class="sep">·</span>outcomes ${detail.outcomes}` +
    `<span class="sep">·</span>checkpoints ${detail.checkpoints}` +
    `<span class="sep">·</span>conflicts ${detail.conflicts}` +
    `<span class="sep">·</span>dispatches ${detail.dispatches}`;

  if (!detail.agents.length) {
    listEl.innerHTML = '<div class="placeholder">no unassigned agents — every presence row in this DB belongs to some registered project</div>';
    return;
  }
  listEl.innerHTML = detail.agents
    .map(s => renderSessionRow(s, { allowAddTo: true }))
    .join('');

  listEl.querySelectorAll('.sess-actions a[data-act="add-to-project"]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.stopPropagation();
      const agent = a.getAttribute('data-agent');
      openAddAgentToProjectModal(agent);
    });
  });
}

async function openAddAgentToProjectModal(agentId) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  titleEl.textContent = `Add ${agentId} to project…`;
  bodyEl.innerHTML = '<div class="modal-empty">loading projects…</div>';
  overlay.classList.add('open');

  let projects = [];
  try {
    const payload = await window.cairn.getProjectsList();
    projects = (payload && payload.projects) || [];
  } catch (_e) { projects = []; }

  if (!projects.length) {
    bodyEl.innerHTML =
      '<div class="modal-empty">no projects registered yet — close this and click <b>＋ Add project…</b> first</div>';
    return;
  }
  bodyEl.innerHTML = projects.map(p => {
    const already = (p.agent_id_hints || []).includes(agentId);
    const label = escapeHtml(p.label || '(project)');
    const root  = escapeHtml(p.project_root || '(unknown)');
    const tag   = already ? ' <span style="color:#7e7">(already a hint)</span>' : '';
    return (
      `<div class="modal-row" data-pid="${escapeHtml(p.id)}">` +
        `<div>${label}${tag}</div>` +
        `<div class="root">${root}</div>` +
      `</div>`
    );
  }).join('');

  bodyEl.querySelectorAll('.modal-row').forEach(row => {
    row.addEventListener('click', async () => {
      const pid = row.getAttribute('data-pid');
      let res;
      try {
        res = await window.cairn.addHint(pid, agentId);
      } catch (e) {
        res = { ok: false, error: e && e.message };
      }
      closeModal();
      if (res && res.ok) {
        // Refresh: L1 list, the unassigned detail (count drops), and
        // the project summary for the active project (if any).
        poll().catch(() => {});
      } else {
        const footer = document.getElementById('footer');
        footer.textContent = `addHint failed: ${(res && res.error) || 'unknown'}`;
        footer.classList.add('bad');
      }
    });
  });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ---------------------------------------------------------------------------
// Tab switching — track active tab so polling fetches only what's visible
// ---------------------------------------------------------------------------

let activeTab = 'runlog';
let lastTasks = [];

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const views = {
    runlog:   document.getElementById('view-runlog'),
    tasks:    document.getElementById('view-tasks'),
    sessions: document.getElementById('view-sessions'),
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

function setActiveTab(tabName) {
  const btn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (btn) btn.click();
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

  // Unassigned cards drill into a detail view scoped to that db_path.
  el.querySelectorAll('.uacard[data-db-path]').forEach(node => {
    node.addEventListener('click', () => {
      const dbPath = node.getAttribute('data-db-path');
      setView('unassigned', { db_path: dbPath });
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
    `<div class="pcard uacard" data-db-path="${escapeHtml(u.db_path)}">` +
      `<div class="pcard-line1">` +
        `<span class="health-dot unassigned">◇</span>` +
        `<span class="pcard-label">Unassigned</span>` +
        `<span class="pcard-act">${escapeHtml(lastAct)}</span>` +
      `</div>` +
      `<div class="pcard-line2">DB: ${escapeHtml(u.db_path)}</div>` +
      `<div class="pcard-line3">${total} row${total === 1 ? '' : 's'} not matched by any project's hints · click to drill in</div>` +
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
  const closeBtn   = document.getElementById('close-btn');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    pop.classList.toggle('open');
  });
  document.addEventListener('click', () => pop.classList.remove('open'));

  // Custom titlebar close button → main slides the panel out and hides it.
  // Never quits; tray + marker remain entry points.
  if (closeBtn) {
    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (window.cairn && window.cairn.hidePanel) window.cairn.hidePanel();
    });
  }

  back.addEventListener('click', async () => {
    pop.classList.remove('open');
    // Project is only "selected" in L2 — clearing on the unassigned view
    // is harmless but unnecessary; do it unconditionally for simplicity.
    await window.cairn.selectProject(null);
    setView('projects', null);
  });

  // Modal close (cancel link + click on backdrop + Esc handled below).
  const overlay = document.getElementById('modal-overlay');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal());
  if (overlay) overlay.addEventListener('click', ev => {
    if (ev.target === overlay) closeModal();
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
    } else if (currentView === 'unassigned') {
      // L1.5 — Unassigned drill-down for one db_path.
      const detail = selectedUnassignedDbPath
        ? await window.cairn.getUnassignedDetail(selectedUnassignedDbPath)
        : null;
      renderHeaderForView();
      renderUnassignedDetail(detail);
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
      const sessionsP = activeTab === 'sessions'
        ? window.cairn.getProjectSessions()
        : Promise.resolve(null);
      const detailP = selectedTaskId
        ? window.cairn.getTaskDetail(selectedTaskId)
        : Promise.resolve(null);
      const ckptsP = selectedTaskId
        ? window.cairn.getTaskCheckpoints(selectedTaskId)
        : Promise.resolve(null);

      const [summary, _dbPath, events, tasks, sessions, detail, ckpts] = await Promise.all([
        summaryP, dbPathP, eventsP, tasksP, sessionsP, detailP, ckptsP,
      ]);

      renderHeaderForView();
      renderSummary(summary);

      if (events) renderRunLog(events);
      if (tasks) {
        lastTasks = tasks;
        if (selectedTaskId) {
          selectedTaskDetail = detail;
          selectedTaskCheckpoints = ckpts || [];
        }
        renderTasks(lastTasks);
      } else if (selectedTaskId) {
        selectedTaskDetail = detail;
        selectedTaskCheckpoints = ckpts || [];
      }
      if (sessions) renderSessions(sessions);
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
    // Modal first: Esc dismisses the picker without leaving the view.
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.classList.contains('open')) {
      closeModal();
      return;
    }
    // Otherwise: any non-L1 view returns to L1; L1 closes the panel.
    if (currentView === 'project') {
      window.cairn.selectProject(null).then(() => setView('projects', null));
    } else if (currentView === 'unassigned') {
      setView('projects', null);
    } else {
      window.close();
    }
  }
});
