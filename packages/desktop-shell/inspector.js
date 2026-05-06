function rel(ts) {
  if (!ts) return '?';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function trunc(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function renderAgents(rows) {
  const el = document.getElementById('agents-list');
  if (!rows.length) { el.innerHTML = '<span class="empty">no active agents</span>'; return; }
  el.innerHTML = rows.map(r =>
    `<div class="row"><span class="pill pill-active">ACTIVE</span><b>${r.agent_id}</b> (${r.agent_type}) — last hb ${rel(r.last_heartbeat)}</div>`
  ).join('');
}

function renderConflicts(rows) {
  const el = document.getElementById('conflicts-list');
  if (!rows.length) { el.innerHTML = '<span class="empty">no open conflicts</span>'; return; }
  el.innerHTML = rows.map(r =>
    `<div class="row"><span class="pill pill-open">OPEN</span>#${r.id} ${r.conflict_type} — ${r.agent_a} ↔ ${r.agent_b} — ${trunc(r.summary, 60)} <kbd>${rel(r.detected_at)}</kbd></div>`
  ).join('');
}

function renderDispatches(rows) {
  const el = document.getElementById('dispatches-list');
  if (!rows.length) { el.innerHTML = '<span class="empty">no dispatches</span>'; return; }
  el.innerHTML = rows.map(r =>
    `<div class="row"><span class="pill pill-pending">${r.status}</span>#${r.id} ${trunc(r.nl_intent, 60)} <kbd>${rel(r.created_at)}</kbd></div>`
  ).join('');
}

function renderLanes(rows) {
  const el = document.getElementById('lanes-list');
  if (!rows.length) { el.innerHTML = '<span class="empty">no active lanes</span>'; return; }
  el.innerHTML = rows.map(r =>
    `<div class="row"><b>${r.state}</b> lane #${r.id} task=${r.task_id || '—'} <kbd>${rel(r.created_at)}</kbd></div>`
  ).join('');
}

function renderSummary(state) {
  const parts = [];
  if (!state.available) { parts.push('db unavailable'); }
  else {
    if (state.agents_active) parts.push(`${state.agents_active} agent(s)`);
    if (state.conflicts_open) parts.push(`${state.conflicts_open} conflict(s)`);
    if (state.dispatch_pending) parts.push(`${state.dispatch_pending} pending dispatch`);
    if (state.lanes_held_for_human) parts.push(`${state.lanes_held_for_human} held`);
    if (state.lanes_reverting) parts.push(`${state.lanes_reverting} reverting`);
    if (!parts.length) parts.push('idle');
  }
  document.getElementById('summary-text').textContent = parts.join(' · ');
}

async function poll() {
  const [state, agents, conflicts, dispatches, lanes] = await Promise.all([
    window.cairn.getState(),
    window.cairn.getActiveAgents(),
    window.cairn.getOpenConflicts(),
    window.cairn.getRecentDispatches(),
    window.cairn.getActiveLanes(),
  ]);
  renderSummary(state);
  renderAgents(agents);
  renderConflicts(conflicts);
  renderDispatches(dispatches);
  renderLanes(lanes);
}

poll();
setInterval(poll, 1000);

document.getElementById('close-btn').addEventListener('click', () => window.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });
