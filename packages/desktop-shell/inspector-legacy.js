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

// Mutations are gated on whether the preload bridge actually exposes
// resolveConflict. When CAIRN_DESKTOP_ENABLE_MUTATIONS=1 the main process
// registers the IPC handler and preload wires window.cairn.resolveConflict;
// otherwise it's absent and the Resolve button is hidden. Default state =
// read-only.
const MUTATIONS_ENABLED = typeof window !== 'undefined'
  && window.cairn
  && typeof window.cairn.resolveConflict === 'function';

function renderConflicts(rows) {
  const el = document.getElementById('conflicts-list');
  if (!rows.length) { el.innerHTML = '<span class="empty">no open conflicts</span>'; return; }
  el.innerHTML = rows.map(r => {
    const resolveBtn = MUTATIONS_ENABLED
      ? ` <button class="resolve-btn" data-id="${r.id}">Resolve</button> <span class="resolve-status"></span>`
      : '';
    return `<div class="row" data-conflict-id="${r.id}"><span class="pill pill-open">OPEN</span>#${r.id} ${r.conflict_type} — ${r.agent_a} ↔ ${r.agent_b} — ${trunc(r.summary, 60)} <kbd>${rel(r.detected_at)}</kbd>${resolveBtn}</div>`;
  }).join('');

  if (!MUTATIONS_ENABLED) return;

  el.querySelectorAll('.resolve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      btn.disabled = true;
      const statusEl = btn.nextElementSibling;
      const res = await window.cairn.resolveConflict(id);
      if (res.ok) {
        statusEl.textContent = 'Resolved!';
        statusEl.style.color = '#7f7';
        setTimeout(() => poll(), 800);
      } else {
        statusEl.textContent = res.error || 'failed';
        statusEl.style.color = '#f77';
        btn.disabled = false;
      }
    });
  });
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

// ---------------------------------------------------------------------------
// Day 5 — Three-Stage Loop card
// ---------------------------------------------------------------------------
//
// Renders one row per candidate from project-candidates.cjs, grouped
// by status. Stage chips (S/W/R) reflect source_iteration_id /
// worker_iteration_id / review_iteration_id presence; verdict chip
// for REVIEWED rows comes from extractReviewVerdict({ candidate_id }).
// Action buttons (Pick / Accept / Reject / Roll back) are gated on
// MUTATIONS_ENABLED and route through window.cairn.* mutations.
//
// Pick is *not* wired here today — it requires the user to also
// pick a worker provider (claude-code / codex / fixture-worker), and
// the existing panel's Managed Loop card already owns provider
// selection. For Day 5 the Pick button shows a status hint and does
// not trigger a launch from the Inspector. Accept / Reject /
// Roll back are wired.

const STATUS_ORDER = ['PROPOSED', 'PICKED', 'WORKING', 'REVIEWED', 'ACCEPTED', 'REJECTED', 'ROLLED_BACK'];
let tsActionBusy = false;

function escHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function tsStageDot(stage, state) {
  const cls = state === 'done' ? 'ts-stage done'
            : state === 'inprog' ? 'ts-stage inprog'
            : 'ts-stage';
  return `<span class="${cls}" title="${stage}">${stage}</span>`;
}

function tsStagesFor(c) {
  // S — Scout proposed it (always done if the row exists; PROPOSED+ have source_iteration_id)
  const s = c.source_iteration_id ? 'done' : 'gray';
  // W — Worker
  let w = 'gray';
  if (c.status === 'PICKED') w = 'inprog';
  else if (c.status === 'WORKING' || c.status === 'REVIEWED'
        || c.status === 'ACCEPTED' || c.status === 'ROLLED_BACK') w = 'done';
  // R — Review
  let r = 'gray';
  if (c.review_iteration_id) {
    if (c.status === 'WORKING') r = 'inprog'; // shouldn't happen — defensive
    else if (c.status === 'REVIEWED' || c.status === 'ACCEPTED' || c.status === 'ROLLED_BACK') r = 'done';
  }
  return `${tsStageDot('S', s)}${tsStageDot('W', w)}${tsStageDot('R', r)}`;
}

function tsButtonsFor(c) {
  if (!MUTATIONS_ENABLED) return '';
  const id = c.id;
  const buttons = [];
  if (c.status === 'PROPOSED') {
    buttons.push(`<button class="ts-action-btn" disabled title="Pick is wired in the panel's Managed Loop card; provider selector lives there.">Pick</button>`);
    buttons.push(`<button class="ts-action-btn" data-act="reject" data-id="${id}">Reject</button>`);
  } else if (c.status === 'PICKED' || c.status === 'WORKING') {
    buttons.push(`<button class="ts-action-btn" data-act="reject" data-id="${id}">Reject</button>`);
  } else if (c.status === 'REVIEWED') {
    buttons.push(`<button class="ts-action-btn" data-act="accept" data-id="${id}">Accept</button>`);
    buttons.push(`<button class="ts-action-btn" data-act="reject" data-id="${id}">Reject</button>`);
    buttons.push(`<button class="ts-action-btn" data-act="rollback" data-id="${id}" title="Marks state only; run git checkout -- <files> manually to revert worker's diff">Roll back</button>`);
  }
  // Multi-Cairn v0: Publish/Unpublish button for share-eligible
  // statuses. Shown only when CAIRN_SHARED_DIR is active. PROPOSED
  // and REVIEWED are the meaningful publish points — you publish a
  // candidate so teammates can see it before you accept, OR after
  // review so they see the verdict.
  const publishEligible = (c.status === 'PROPOSED' || c.status === 'REVIEWED');
  if (mcStatus.enabled && publishEligible) {
    const already = mcMyPublishedIds.has(c.id);
    if (already) {
      buttons.push(`<button class="mc-publish-btn published" data-act="unpublish" data-id="${id}" title="Withdraw from team outbox (writes a tombstone event)">🗑 Unpublish</button>`);
    } else {
      buttons.push(`<button class="mc-publish-btn" data-act="publish" data-id="${id}" title="Append a snapshot to ${escHtml(mcStatus.shared_dir || '')}/published-candidates.jsonl">📤 Publish</button>`);
    }
  }
  return buttons.join('');
}

let tsLastVerdicts = new Map();   // candidate_id -> { verdict, reason } cache
let tsActiveProjectId = null;
// Multi-Cairn v0 state — refreshed every poll.
let mcStatus = { enabled: false, node_id: null, shared_dir: null };
let mcMyPublishedIds = new Set();   // ids THIS node has published

async function fetchVerdictsFor(projectId, reviewedRows) {
  // Only re-fetch verdict for rows we don't have a cached value for.
  for (const c of reviewedRows) {
    if (tsLastVerdicts.has(c.id)) continue;
    try {
      const v = await window.cairn.extractReviewVerdict(projectId, { candidate_id: c.id });
      if (v && v.ok) tsLastVerdicts.set(c.id, { verdict: v.verdict, reason: v.reason });
      else tsLastVerdicts.set(c.id, { verdict: null, reason: v && v.error || 'verdict_unavailable' });
    } catch (_e) {
      tsLastVerdicts.set(c.id, { verdict: null, reason: 'verdict_fetch_failed' });
    }
  }
}

function tsRenderRow(c) {
  const isTerminal = c.status === 'ACCEPTED' || c.status === 'REJECTED' || c.status === 'ROLLED_BACK';
  const cls = isTerminal ? 'ts-row terminal' : 'ts-row';
  const idShort = (c.id || '').slice(0, 10);
  const desc = trunc(c.description || '', 100);
  const stages = tsStagesFor(c);
  const buttons = tsButtonsFor(c);
  // Day 6 — boundary violations indicator next to W chip and a manual
  // [Verify] button when the worker has actually run.
  const violations = Array.isArray(c.boundary_violations) ? c.boundary_violations : [];
  const workerRan = !!c.worker_iteration_id;
  let bvIcon = '';
  if (workerRan && violations.length > 0) {
    const tip = `Worker changed ${violations.length} file(s) outside the inferred candidate scope: ${trunc(violations.join(', '), 200)}`;
    bvIcon = ` <span class="ts-bv-icon" data-bv="1" data-cid="${escHtml(c.id)}" title="${escHtml(tip)}">⚠</span>`;
  }
  const verifyBtn = workerRan
    ? ` <button class="ts-verify-btn" data-act="verify-boundary" data-id="${escHtml(c.id)}">Verify</button>`
    : '';
  let verdictHtml = '';
  if (c.status === 'REVIEWED' || c.status === 'ACCEPTED' || c.status === 'REJECTED' || c.status === 'ROLLED_BACK') {
    const v = tsLastVerdicts.get(c.id);
    if (v && v.verdict) {
      verdictHtml = ` <span class="ts-verdict ${escHtml(v.verdict)}">${escHtml(v.verdict)}</span>`;
      if (v.reason) verdictHtml += `<div class="ts-reason">${escHtml(trunc(v.reason, 120))}</div>`;
    }
  }
  // REVIEWED rows with violations get an explicit accept-warning line.
  let bvWarn = '';
  if (workerRan && violations.length > 0 && c.status === 'REVIEWED') {
    bvWarn = `<div class="ts-bv-warn">Boundary violations detected — check before accepting.</div>`;
  }
  return `<div class="${cls}" data-cid="${escHtml(c.id)}">`
       + `${stages}${bvIcon}${verifyBtn} <span class="ts-kind">${escHtml(c.candidate_kind || 'other')}</span>`
       + `${escHtml(desc)}<span class="ts-id">${escHtml(idShort)}</span>`
       + `<span style="float:right">${buttons}</span>`
       + verdictHtml
       + bvWarn
       + `</div>`;
}

function tsGroupAndRender(rows) {
  const groups = new Map();
  for (const s of STATUS_ORDER) groups.set(s, []);
  for (const c of rows) (groups.get(c.status) || groups.get('PROPOSED')).push(c);
  const parts = [];
  if (!MUTATIONS_ENABLED) {
    parts.push('<div class="ts-mut-warn">Read-only view — start with CAIRN_DESKTOP_ENABLE_MUTATIONS=1 to show Accept / Reject / Roll back.</div>');
  }
  let any = false;
  for (const s of STATUS_ORDER) {
    const list = groups.get(s) || [];
    if (!list.length) continue;
    any = true;
    parts.push(`<div class="ts-header">${escHtml(s)} (${list.length})</div>`);
    for (const c of list) parts.push(tsRenderRow(c));
  }
  if (!any) parts.push('<span class="ts-empty">no candidates yet — run a Scout round in the panel\'s Managed Loop card.</span>');
  document.getElementById('ts-list').innerHTML = parts.join('');
  if (MUTATIONS_ENABLED) wireTsButtons();
}

function wireTsButtons() {
  // Verify button — always wired (read-only handler, not gated on
  // MUTATIONS_ENABLED). Re-renders after running.
  document.querySelectorAll('#ts-list button.ts-verify-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (tsActionBusy || !tsActiveProjectId) return;
      const id = btn.getAttribute('data-id');
      tsActionBusy = true;
      btn.disabled = true;
      let res;
      try { res = await window.cairn.verifyWorkerBoundary(tsActiveProjectId, { candidate_id: id }); }
      catch (e) { res = { ok: false, error: e && e.message || 'ipc_error' }; }
      tsActionBusy = false;
      const row = btn.closest('.ts-row');
      if (row) {
        const old = row.querySelector('.ts-bv-popover');
        if (old) old.remove();
        const pop = document.createElement('div');
        pop.className = 'ts-bv-popover';
        if (res && res.ok) {
          if (res.heuristic_notes === 'no_scope_inferred') {
            pop.innerHTML = `<b>verify ok:</b> no scope inferred from description (kind=other or abstract); skipped writing boundary_violations.`;
          } else {
            pop.innerHTML = `<b>verify ok:</b> in_scope=${res.in_scope.length}, out_of_scope=${res.out_of_scope.length}<br>`
              + `<i>heuristic:</i> ${escHtml(res.heuristic_notes || '')}<br>`
              + (res.out_of_scope.length
                  ? '<b>violations:</b> ' + res.out_of_scope.map(s => '<code>' + escHtml(s) + '</code>').join(', ')
                  : '<b>violations:</b> none');
          }
        } else {
          pop.innerHTML = `<b>verify failed:</b> ${escHtml((res && res.error) || 'unknown')}`;
          pop.style.color = '#f99';
        }
        row.appendChild(pop);
      }
      // Re-poll so the row picks up the new boundary_violations.
      pollThreeStage();
    });
  });
  // ⚠ icon click — toggles a popover with the full list.
  document.querySelectorAll('#ts-list .ts-bv-icon[data-bv="1"]').forEach(icon => {
    icon.addEventListener('click', async () => {
      const id = icon.getAttribute('data-cid');
      if (!id || !tsActiveProjectId) return;
      const row = icon.closest('.ts-row');
      if (!row) return;
      const existing = row.querySelector('.ts-bv-popover');
      if (existing) { existing.remove(); return; }
      const c = await window.cairn.getCandidate(tsActiveProjectId, id).catch(() => null);
      if (!c) return;
      const pop = document.createElement('div');
      pop.className = 'ts-bv-popover';
      pop.innerHTML = `<b>boundary_violations (${c.boundary_violations.length}):</b><br>`
        + c.boundary_violations.map(s => '<code>' + escHtml(s) + '</code>').join('<br>');
      row.appendChild(pop);
    });
  });
  // Multi-Cairn v0 — publish / unpublish buttons. Mirror the
  // accept/reject error surface (inline ts-bv-popover-style row).
  document.querySelectorAll('#ts-list button.mc-publish-btn[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (tsActionBusy || !tsActiveProjectId) return;
      if (!MUTATIONS_ENABLED) return; // belt-and-suspenders; preload also hides the fn
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      tsActionBusy = true;
      btn.disabled = true;
      let res;
      try {
        if (act === 'publish')   res = await window.cairn.publishCandidateToTeam(tsActiveProjectId, id);
        if (act === 'unpublish') res = await window.cairn.unpublishCandidateFromTeam(tsActiveProjectId, id);
      } catch (e) {
        res = { ok: false, error: e && e.message || 'ipc_error' };
      }
      tsActionBusy = false;
      if (res && res.ok) {
        await pollThreeStage();
      } else {
        btn.disabled = false;
        const row = btn.closest('.ts-row');
        if (row) {
          const r = document.createElement('div');
          r.className = 'ts-reason';
          r.style.color = '#f99';
          r.textContent = 'publish failed: ' + ((res && res.error) || 'unknown');
          row.appendChild(r);
        }
      }
    });
  });
  document.querySelectorAll('#ts-list button.ts-action-btn[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (tsActionBusy) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (!tsActiveProjectId || !id) return;
      if (act === 'rollback') {
        const proceed = window.confirm(
          'This marks the candidate as ROLLED_BACK in Cairn.\n\n'
          + "The worker's working-tree changes will NOT be reverted.\n"
          + 'Run git checkout -- <files> manually if you want to discard them.\n\nContinue?'
        );
        if (!proceed) return;
      }
      tsActionBusy = true;
      btn.disabled = true;
      let res;
      try {
        if (act === 'accept')   res = await window.cairn.acceptCandidate(tsActiveProjectId, id);
        if (act === 'reject')   res = await window.cairn.rejectCandidate(tsActiveProjectId, id);
        if (act === 'rollback') res = await window.cairn.rollBackCandidate(tsActiveProjectId, id);
      } catch (e) {
        res = { ok: false, error: e && e.message || 'ipc_error' };
      }
      tsActionBusy = false;
      if (res && res.ok) {
        // re-poll on next tick will re-render
        await pollThreeStage();
      } else {
        btn.disabled = false;
        // surface error in the row's reason slot
        const row = btn.closest('.ts-row');
        if (row) {
          const r = document.createElement('div');
          r.className = 'ts-reason';
          r.style.color = '#f99';
          r.textContent = (res && res.error) || 'action_failed';
          row.appendChild(r);
        }
      }
    });
  });
}

function renderMultiCairnStatusBar() {
  const bar = document.getElementById('mc-status-bar');
  if (!bar) return;
  if (mcStatus.enabled) {
    bar.className = 'mc-status enabled';
    const nodeShort = (mcStatus.node_id || '').slice(0, 8);
    bar.textContent = `Multi-Cairn: enabled (node = ${nodeShort}, shared = ${mcStatus.shared_dir || '?'})`;
  } else {
    bar.className = 'mc-status disabled';
    bar.textContent = 'Multi-Cairn: disabled (set CAIRN_SHARED_DIR to enable team sharing)';
  }
}

function renderTeamCandidates(rows) {
  const section = document.getElementById('mc-team-section');
  const list = document.getElementById('mc-team-list');
  if (!section || !list) return;
  if (!mcStatus.enabled) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (!rows || rows.length === 0) {
    list.innerHTML = '<span class="empty">no team candidates published yet</span>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const snap = r.snapshot || {};
    const nodeShort = (r.node_id || '').slice(0, 6);
    const desc = trunc(snap.description || '', 100);
    const kind = snap.candidate_kind || 'other';
    const status = snap.status || '?';
    const when = rel(r.published_at);
    return `<div class="mc-team-row">`
         + `<span class="mc-team-node">${escHtml(nodeShort)}</span>`
         + `<span class="mc-team-kind">${escHtml(kind)}</span>`
         + `${escHtml(desc)}`
         + `<span class="mc-team-status">${escHtml(status)}</span>`
         + `<span class="mc-team-ts">${escHtml(when)}</span>`
         + `</div>`;
  }).join('');
}

async function pollThreeStage() {
  const meta = document.getElementById('ts-meta');

  // Refresh Multi-Cairn status first — affects how candidate rows
  // render (Publish/Unpublish button visibility).
  try { mcStatus = await window.cairn.getMultiCairnStatus(); }
  catch (_e) { mcStatus = { enabled: false, node_id: null, shared_dir: null }; }
  renderMultiCairnStatusBar();

  let proj;
  try { proj = await window.cairn.getSelectedProject(); } catch (_e) { proj = null; }
  if (!proj) {
    tsActiveProjectId = null;
    meta.textContent = 'no project selected';
    document.getElementById('ts-list').innerHTML = '<span class="ts-empty">select a project in the panel first.</span>';
    renderTeamCandidates([]);
    return;
  }
  tsActiveProjectId = proj.id;
  meta.textContent = `${proj.label} · ${proj.id}`;

  // Refresh THIS node's published-ids set so candidate rows pick the
  // right [Publish] vs [Unpublish] label.
  if (mcStatus.enabled) {
    try {
      const ids = await window.cairn.listMyPublishedCandidateIds(proj.id);
      mcMyPublishedIds = new Set(Array.isArray(ids) ? ids : []);
    } catch (_e) { mcMyPublishedIds = new Set(); }
  } else {
    mcMyPublishedIds = new Set();
  }

  let rows = [];
  try { rows = await window.cairn.listCandidates(proj.id, 100); } catch (_e) { rows = []; }
  const verdictRows = rows.filter(c => c.review_iteration_id);
  if (verdictRows.length) await fetchVerdictsFor(proj.id, verdictRows);
  tsGroupAndRender(rows);

  // Team Candidates section (read-only) — what OTHER nodes have
  // published for this same project.
  if (mcStatus.enabled) {
    let teamRows = [];
    try { teamRows = await window.cairn.listTeamCandidates(proj.id); } catch (_e) { teamRows = []; }
    renderTeamCandidates(teamRows);
  } else {
    renderTeamCandidates([]);
  }
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
  // Three-Stage card has its own poll (separate Promise.all so a slow
  // candidates fetch doesn't block the rest).
  pollThreeStage();
}

poll();
setInterval(poll, 1000);

document.getElementById('close-btn').addEventListener('click', () => window.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });
