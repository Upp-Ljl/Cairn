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
// Tab switching (Day 1 = inert; Run Log / Tasks render Day 2)
// ---------------------------------------------------------------------------

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
    const [summary, dbPath] = await Promise.all([
      window.cairn.getProjectSummary(),
      window.cairn.getDbPath(),
    ]);
    renderHeader(dbPath);
    renderSummary(summary);
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
