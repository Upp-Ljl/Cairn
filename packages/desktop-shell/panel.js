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

// ---------------------------------------------------------------------------
// Goal Card renderer (Goal Mode v1)
// ---------------------------------------------------------------------------
//
// User-authored goal headline for the active project. Cairn does NOT
// infer goals — this surface is purely a thin editor on top of
// `~/.cairn/projects.json`. The goal becomes downstream input for
// LLM Interpretation but originates here.

let lastGoal = null;

function renderGoalCard(goal) {
  lastGoal = goal || null;
  const cardEl   = document.getElementById('goal-card');
  const emptyEl  = document.getElementById('goal-empty-line');
  const filledEl = document.getElementById('goal-filled');
  if (!cardEl) return;

  if (!goal) {
    cardEl.classList.add('goal-empty');
    emptyEl.hidden = false;
    filledEl.hidden = true;
    return;
  }
  cardEl.classList.remove('goal-empty');
  emptyEl.hidden = true;
  filledEl.hidden = false;

  document.getElementById('goal-title').textContent = goal.title || '(untitled)';
  const meta = [];
  if (Array.isArray(goal.success_criteria) && goal.success_criteria.length) {
    meta.push(`${goal.success_criteria.length} criteria`);
  }
  if (Array.isArray(goal.non_goals) && goal.non_goals.length) {
    meta.push(`${goal.non_goals.length} non-goals`);
  }
  if (goal.updated_at) meta.push(`updated ${relTimeMs(goal.updated_at)}`);
  document.getElementById('goal-meta').textContent = meta.length ? `· ${meta.join(' · ')}` : '';

  const out = document.getElementById('goal-outcome');
  if (goal.desired_outcome) {
    out.textContent = goal.desired_outcome;
    out.hidden = false;
  } else {
    out.textContent = '';
    out.hidden = true;
  }
}

function setupGoalCard() {
  const setLink   = document.getElementById('goal-set-link');
  const editLink  = document.getElementById('goal-edit-link');
  const clearLink = document.getElementById('goal-clear-link');
  if (setLink)   setLink.addEventListener('click', () => openGoalEditModal(null));
  if (editLink)  editLink.addEventListener('click', () => openGoalEditModal(lastGoal));
  if (clearLink) clearLink.addEventListener('click', async () => {
    if (!selectedProject) return;
    const proceed = window.confirm('Clear the goal for this project? (the registry entry stays; only the goal is removed)');
    if (!proceed) return;
    await window.cairn.clearProjectGoal(selectedProject.id);
    poll().catch(() => {});
  });
}

function openGoalEditModal(existing) {
  if (!selectedProject) return;
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  titleEl.textContent = existing ? 'Edit goal' : 'Set goal';
  // Inline form. Plain inputs — no framework, matches the rest of
  // the panel. Multi-line criteria / non-goals: one item per line.
  bodyEl.innerHTML =
    `<div class="goal-form">` +
      `<label>Title <span class="goal-form-hint">(required, 1 line)</span></label>` +
      `<input id="goal-form-title" type="text" maxlength="200" />` +
      `<label>Desired outcome <span class="goal-form-hint">(1-3 sentences)</span></label>` +
      `<textarea id="goal-form-outcome" rows="3" maxlength="2000"></textarea>` +
      `<label>Success criteria <span class="goal-form-hint">(one per line; verifiable)</span></label>` +
      `<textarea id="goal-form-criteria" rows="4"></textarea>` +
      `<label>Non-goals <span class="goal-form-hint">(one per line; out-of-scope reminders)</span></label>` +
      `<textarea id="goal-form-nongoals" rows="3"></textarea>` +
      `<div class="goal-form-actions">` +
        `<button id="goal-form-save" type="button">Save</button>` +
      `</div>` +
    `</div>`;
  overlay.classList.add('open');

  // Pre-fill from existing.
  if (existing) {
    document.getElementById('goal-form-title').value    = existing.title || '';
    document.getElementById('goal-form-outcome').value  = existing.desired_outcome || '';
    document.getElementById('goal-form-criteria').value = (existing.success_criteria || []).join('\n');
    document.getElementById('goal-form-nongoals').value = (existing.non_goals || []).join('\n');
  }

  document.getElementById('goal-form-save').addEventListener('click', async () => {
    const title = document.getElementById('goal-form-title').value.trim();
    if (!title) {
      const err = document.getElementById('footer');
      err.textContent = 'goal title required';
      err.classList.add('bad');
      setTimeout(() => {
        err.textContent = 'read-only · polling 1s · Cairn project control surface';
        err.classList.remove('bad');
      }, 3000);
      return;
    }
    const outcome  = document.getElementById('goal-form-outcome').value;
    const criteria = document.getElementById('goal-form-criteria').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const nonGoals = document.getElementById('goal-form-nongoals').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    const res = await window.cairn.setProjectGoal(selectedProject.id, {
      title, desired_outcome: outcome,
      success_criteria: criteria, non_goals: nonGoals,
    });
    if (res && res.ok) {
      closeModal();
      poll().catch(() => {});
    } else {
      const err = document.getElementById('footer');
      err.textContent = `setProjectGoal failed: ${(res && res.error) || 'unknown'}`;
      err.classList.add('bad');
    }
  });

  // Focus the title field so the user can start typing immediately.
  setTimeout(() => {
    const t = document.getElementById('goal-form-title');
    if (t) t.focus();
  }, 50);
}

// ---------------------------------------------------------------------------
// Project Rules card renderer (governance v1)
// ---------------------------------------------------------------------------
//
// User-authored policy for one project. Falls back to a default
// ruleset so the card never goes blank — the default has its own
// "(default)" tag so users see which template is rendered.

let lastRulesEnvelope = null; // { rules, is_default }

function renderRulesCard(envelope) {
  lastRulesEnvelope = envelope || null;
  const defaultTag = document.getElementById('rules-default-tag');
  const countsEl   = document.getElementById('rules-counts');
  const previewEl  = document.getElementById('rules-preview');
  const clearLink  = document.getElementById('rules-clear-link');
  if (!countsEl) return;

  if (!envelope) {
    defaultTag.hidden = true;
    countsEl.textContent = '';
    previewEl.textContent = '';
    clearLink.hidden = true;
    return;
  }
  const { rules, is_default } = envelope;
  defaultTag.hidden = !is_default;
  clearLink.hidden  = is_default; // can't clear the default

  const sections = [
    ['CS',     rules.coding_standards],
    ['TEST',   rules.testing_policy],
    ['REPORT', rules.reporting_policy],
    ['PRE-PR', rules.pre_pr_checklist],
    ['NON-G',  rules.non_goals],
  ];
  countsEl.innerHTML = sections.map(([label, list]) =>
    `<span class="pv-section">${label} <span style="color:#aab">${list.length}</span></span>`
  ).join('');

  // Compact preview: 1-2 representative items so the card has signal.
  const repr = [];
  if (rules.coding_standards.length) repr.push({ k: 'CS',    v: rules.coding_standards[0] });
  if (rules.pre_pr_checklist.length) repr.push({ k: 'PRE-PR', v: rules.pre_pr_checklist[0] });
  if (rules.non_goals.length)        repr.push({ k: 'NON-G', v: rules.non_goals[0] });
  previewEl.innerHTML = repr.slice(0, 2).map(r =>
    `<div><span class="pv-head">${r.k}</span> ${escapeHtml(r.v)}</div>`
  ).join('');
}

function setupRulesCard() {
  const editLink  = document.getElementById('rules-edit-link');
  const clearLink = document.getElementById('rules-clear-link');
  if (editLink) editLink.addEventListener('click', () => openRulesEditModal(lastRulesEnvelope));
  if (clearLink) clearLink.addEventListener('click', async () => {
    if (!selectedProject) return;
    const proceed = window.confirm('Clear this project\'s rules and revert to the default ruleset?');
    if (!proceed) return;
    await window.cairn.clearProjectRules(selectedProject.id);
    poll().catch(() => {});
  });
}

function openRulesEditModal(envelope) {
  if (!selectedProject) return;
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  const isDefault = !!(envelope && envelope.is_default);
  titleEl.textContent = isDefault ? 'Set project rules' : 'Edit project rules';
  // Plain inline form — five textareas, one per section. We tell the
  // user what each section means; no DSL.
  bodyEl.innerHTML =
    `<div class="goal-form">` +
      `<label>Coding standards <span class="goal-form-hint">(one per line; advisory only)</span></label>` +
      `<textarea id="rules-form-cs" rows="3"></textarea>` +
      `<label>Testing policy <span class="goal-form-hint">(one per line)</span></label>` +
      `<textarea id="rules-form-test" rows="3"></textarea>` +
      `<label>Reporting policy <span class="goal-form-hint">(one per line)</span></label>` +
      `<textarea id="rules-form-report" rows="3"></textarea>` +
      `<label>Pre-PR checklist <span class="goal-form-hint">(one per line; advisory)</span></label>` +
      `<textarea id="rules-form-prepr" rows="4"></textarea>` +
      `<label>Non-goals <span class="goal-form-hint">(one per line; out-of-scope reminders)</span></label>` +
      `<textarea id="rules-form-nong" rows="3"></textarea>` +
      `<div class="goal-form-actions">` +
        `<button id="rules-form-save" type="button">Save</button>` +
      `</div>` +
    `</div>`;
  overlay.classList.add('open');

  const r = (envelope && envelope.rules) || {};
  document.getElementById('rules-form-cs').value     = (r.coding_standards || []).join('\n');
  document.getElementById('rules-form-test').value   = (r.testing_policy   || []).join('\n');
  document.getElementById('rules-form-report').value = (r.reporting_policy || []).join('\n');
  document.getElementById('rules-form-prepr').value  = (r.pre_pr_checklist || []).join('\n');
  document.getElementById('rules-form-nong').value   = (r.non_goals        || []).join('\n');

  document.getElementById('rules-form-save').addEventListener('click', async () => {
    function ll(id) {
      return document.getElementById(id).value
        .split('\n').map(s => s.trim()).filter(Boolean);
    }
    const res = await window.cairn.setProjectRules(selectedProject.id, {
      coding_standards: ll('rules-form-cs'),
      testing_policy:   ll('rules-form-test'),
      reporting_policy: ll('rules-form-report'),
      pre_pr_checklist: ll('rules-form-prepr'),
      non_goals:        ll('rules-form-nong'),
    });
    if (res && res.ok) {
      closeModal();
      poll().catch(() => {});
    } else {
      const footer = document.getElementById('footer');
      footer.textContent = `setProjectRules failed: ${(res && res.error) || 'unknown'}`;
      footer.classList.add('bad');
      setTimeout(() => {
        footer.textContent = 'read-only · polling 1s · Cairn project control surface';
        footer.classList.remove('bad');
      }, 4000);
    }
  });
}

// ---------------------------------------------------------------------------
// Goal Interpretation renderer (Goal Mode v1, advisory)
// ---------------------------------------------------------------------------
//
// The card is hidden when there's no goal AND no cached interpretation
// — interpretation without a goal anchor is unhelpful. The Refresh
// link is the only path that actually triggers an LLM call.

let lastInterpretation = null;
let interpretationLoading = false;

function renderInterpretation(interp) {
  lastInterpretation = interp || null;
  const card = document.getElementById('interp-card');
  if (!card) return;
  // Hide entirely when we have nothing useful (no goal AND no cached
  // result). The "set goal first" empty state lives on the Goal Card.
  if (!interp) {
    card.hidden = (!lastGoal);
    if (!lastGoal) return;
    // No interpretation cached yet but goal exists: render a one-line
    // call-to-action so the user knows it's available.
    card.hidden = false;
    document.getElementById('interp-mode-chip').textContent = 'INTERP';
    document.getElementById('interp-mode-chip').className = 'interp-mode';
    document.getElementById('interp-meta').textContent = 'click Refresh to compute';
    document.getElementById('interp-summary').textContent = '';
    document.getElementById('interp-risks').hidden = true;
    document.getElementById('interp-next').hidden = true;
    return;
  }
  card.hidden = false;
  const modeChip = document.getElementById('interp-mode-chip');
  modeChip.textContent = (interp.mode || 'deterministic').toUpperCase();
  modeChip.className = 'interp-mode' + (interp.mode === 'llm' ? ' llm' : '');

  const meta = [];
  if (interp.model) meta.push(interp.model);
  if (interp.generated_at) meta.push(relTimeMs(interp.generated_at));
  if (interp.error_code) meta.push(`fallback: ${interp.error_code}`);
  document.getElementById('interp-meta').textContent = meta.join(' · ');

  document.getElementById('interp-summary').textContent = interp.summary || '';

  const risksEl = document.getElementById('interp-risks');
  if (Array.isArray(interp.risks) && interp.risks.length) {
    risksEl.hidden = false;
    risksEl.innerHTML = interp.risks.map(r => (
      `<div class="risk">` +
        `<span class="risk-dot ${escapeHtml(r.severity || 'watch')}">●</span>` +
        `<span class="risk-title">${escapeHtml(r.title || r.kind || '')}</span>` +
        (r.detail ? `<span class="risk-detail">${escapeHtml(r.detail)}</span>` : '') +
      `</div>`
    )).join('');
  } else {
    risksEl.hidden = true;
    risksEl.innerHTML = '';
  }

  const nextEl = document.getElementById('interp-next');
  if (Array.isArray(interp.next_attention) && interp.next_attention.length) {
    nextEl.hidden = false;
    nextEl.innerHTML =
      `<div style="color:#888;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">NEXT ATTENTION</div>` +
      interp.next_attention.map(s => (
        `<div class="item">` +
          `<span style="color:#557">·</span>` +
          `<span>${escapeHtml(s)}</span>` +
        `</div>`
      )).join('');
  } else {
    nextEl.hidden = true;
    nextEl.innerHTML = '';
  }
}

function setupInterpretationCard() {
  const link = document.getElementById('interp-refresh-link');
  if (!link) return;
  link.addEventListener('click', async () => {
    if (!selectedProject) return;
    if (interpretationLoading) return;
    interpretationLoading = true;
    const meta = document.getElementById('interp-meta');
    if (meta) meta.textContent = 'refreshing…';
    try {
      const res = await window.cairn.refreshGoalInterpretation(selectedProject.id, {});
      if (res && res.ok) {
        renderInterpretation(res.result);
      } else {
        const footer = document.getElementById('footer');
        footer.textContent = `interpretation refresh failed: ${(res && res.error) || 'unknown'}`;
        footer.classList.add('bad');
      }
    } finally {
      interpretationLoading = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Pre-PR Gate renderer (advisory only)
// ---------------------------------------------------------------------------
//
// Cairn does NOT decide whether a PR is good. The card surfaces the
// deterministic rules' output (status + checklist + risks). LLM
// optionally rewrites tone — never status. Hidden until the user
// clicks Refresh.

let lastPrePrGate = null;
let prePrGateLoading = false;

function renderPrePrGate(gate) {
  lastPrePrGate = gate || null;
  const card = document.getElementById('pre-pr-card');
  if (!card) return;
  if (!gate) {
    // Stay hidden when nothing computed yet — the user hasn't asked.
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const statusEl = document.getElementById('pre-pr-status');
  statusEl.textContent = (gate.status || 'unknown').replace(/_/g, ' ').toUpperCase();
  statusEl.className = 'pre-pr-status ' + (gate.status || 'unknown');

  const meta = [];
  if (gate.mode) meta.push(gate.mode);
  if (gate.model) meta.push(gate.model);
  if (gate.error_code) meta.push(`fallback: ${gate.error_code}`);
  document.getElementById('pre-pr-meta').textContent = meta.join(' · ');

  const summaryEl = document.getElementById('pre-pr-summary');
  if (gate.summary) {
    summaryEl.hidden = false;
    summaryEl.textContent = gate.summary;
  } else {
    summaryEl.hidden = true;
    summaryEl.textContent = '';
  }

  const checklistEl = document.getElementById('pre-pr-checklist');
  if (Array.isArray(gate.checklist) && gate.checklist.length) {
    checklistEl.hidden = false;
    checklistEl.innerHTML =
      `<div class="head">CHECKLIST (advisory)</div>` +
      `<ul>` + gate.checklist.map(s => `<li>${escapeHtml(s)}</li>`).join('') + `</ul>`;
  } else {
    checklistEl.hidden = true;
    checklistEl.innerHTML = '';
  }

  const risksEl = document.getElementById('pre-pr-risks');
  if (Array.isArray(gate.risks) && gate.risks.length) {
    risksEl.hidden = false;
    risksEl.innerHTML =
      `<div class="head">RISKS</div>` +
      `<ul>` + gate.risks.map(r => (
        `<li class="risk-item ${escapeHtml(r.severity || 'watch')}">` +
          escapeHtml(r.title || r.kind || '') +
          (r.detail ? `<div class="detail">${escapeHtml(r.detail)}</div>` : '') +
        `</li>`
      )).join('') + `</ul>`;
  } else {
    risksEl.hidden = true;
    risksEl.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// Goal Loop Prompt Pack renderer (advisory; copy-pasteable; not auto-sent)
// ---------------------------------------------------------------------------

let lastPromptPack = null;
let promptPackLoading = false;

function renderPromptPack(pack) {
  lastPromptPack = pack || null;
  const card = document.getElementById('prompt-pack-card');
  if (!card) return;
  if (!pack) { card.hidden = true; return; }
  card.hidden = false;
  const meta = [];
  if (pack.mode) meta.push(pack.mode);
  if (pack.model) meta.push(pack.model);
  if (pack.error_code) meta.push(`fallback: ${pack.error_code}`);
  if (pack.generated_at) meta.push(relTimeMs(pack.generated_at));
  document.getElementById('prompt-pack-meta').textContent = meta.join(' · ');
  document.getElementById('prompt-pack-text').value = pack.prompt || '';
}

function setupPromptPack() {
  const gen   = document.getElementById('pre-pr-prompt-pack-link');
  const copy  = document.getElementById('prompt-pack-copy');
  const close = document.getElementById('prompt-pack-close');
  if (gen) gen.addEventListener('click', async () => {
    if (!selectedProject) return;
    if (promptPackLoading) return;
    promptPackLoading = true;
    const meta = document.getElementById('prompt-pack-meta');
    const card = document.getElementById('prompt-pack-card');
    if (card) card.hidden = false;
    if (meta) meta.textContent = 'generating…';
    try {
      const res = await window.cairn.generatePromptPack(selectedProject.id, {});
      if (res && res.ok) {
        renderPromptPack(res.result);
      } else {
        const footer = document.getElementById('footer');
        footer.textContent = `prompt-pack failed: ${(res && res.error) || 'unknown'}`;
        footer.classList.add('bad');
      }
    } finally {
      promptPackLoading = false;
    }
  });
  if (copy) copy.addEventListener('click', async () => {
    if (!lastPromptPack || !lastPromptPack.prompt) return;
    try {
      await navigator.clipboard.writeText(lastPromptPack.prompt);
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy prompt'; }, 1200);
    } catch (_e) { /* clipboard unavailable */ }
  });
  if (close) close.addEventListener('click', () => {
    document.getElementById('prompt-pack-card').hidden = true;
  });
}

function setupPrePrGateCard() {
  const refresh = document.getElementById('pre-pr-refresh-link');
  const copy    = document.getElementById('pre-pr-copy-link');
  if (refresh) refresh.addEventListener('click', async () => {
    if (!selectedProject) return;
    if (prePrGateLoading) return;
    prePrGateLoading = true;
    const meta = document.getElementById('pre-pr-meta');
    if (meta) meta.textContent = 'evaluating…';
    try {
      const res = await window.cairn.refreshPrePrGate(selectedProject.id, {});
      if (res && res.ok) {
        renderPrePrGate(res.result);
      } else {
        const footer = document.getElementById('footer');
        footer.textContent = `pre-PR refresh failed: ${(res && res.error) || 'unknown'}`;
        footer.classList.add('bad');
      }
    } finally {
      prePrGateLoading = false;
    }
  });
  if (copy) copy.addEventListener('click', async () => {
    if (!lastPrePrGate || !Array.isArray(lastPrePrGate.checklist)) return;
    const text = lastPrePrGate.checklist.map((s, i) => `${i + 1}. ${s}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy checklist'; }, 1200);
    } catch (_e) { /* clipboard unavailable */ }
  });
}

// ---------------------------------------------------------------------------
// Recovery Card renderer (UI hardening — checkpoint visibility)
// ---------------------------------------------------------------------------
//
// Surfaces Cairn's checkpoint primitive to the user. Confidence badge,
// last READY anchor, and a "copy recovery prompt" action. Anchors
// list expands inline. Cairn does NOT execute rewind from the panel.

let lastRecovery = null;
let recoveryExpanded = false;

function renderRecoveryCard(recovery) {
  lastRecovery = recovery || null;
  const card = document.getElementById('recovery-card');
  if (!card) return;
  // Hide when no project is selected OR there are zero checkpoints
  // AND no goal/anchor signal that might warrant a "create one" hint.
  // For now: hide if total=0 AND confidence=none — a project that's
  // never had a checkpoint shouldn't take screen space.
  if (!recovery || (recovery.counts.total === 0 && recovery.confidence === 'none')) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const confEl = document.getElementById('recovery-confidence');
  confEl.textContent = recovery.confidence.toUpperCase();
  confEl.className = 'recovery-confidence ' + recovery.confidence;

  document.getElementById('recovery-counts').textContent =
    `${recovery.counts.ready} ready · ${recovery.counts.pending} pending · ${recovery.counts.corrupted} corrupted (${recovery.counts.total} total)`;

  const lastReadyEl = document.getElementById('recovery-last-ready');
  if (recovery.last_ready) {
    const r = recovery.last_ready;
    const labelPart = r.label
      ? `<span style="color:#ddd">"${escapeHtml(r.label)}"</span> `
      : '';
    const headPart = r.git_head ? ` <span style="color:#888">@${escapeHtml(r.git_head)}</span>` : '';
    const ageTxt = r.ready_at ? relTimeMs(r.ready_at) : (r.created_at ? relTimeMs(r.created_at) : '?');
    const taskPart = r.task_intent
      ? ` for <span style="color:#aab">${escapeHtml(r.task_intent.slice(0, 60))}</span>`
      : '';
    lastReadyEl.innerHTML =
      `Last READY anchor: ${labelPart}<code>${escapeHtml(r.id_short)}</code>${headPart} · ` +
      `<span style="color:#666">${escapeHtml(ageTxt)}</span>${taskPart}`;
    lastReadyEl.hidden = false;
  } else {
    lastReadyEl.hidden = true;
    lastReadyEl.innerHTML = '';
  }

  const anchorsEl = document.getElementById('recovery-anchors');
  if (recoveryExpanded && Array.isArray(recovery.safe_anchors) && recovery.safe_anchors.length) {
    anchorsEl.hidden = false;
    anchorsEl.innerHTML = recovery.safe_anchors.map(a => {
      const labelTxt = a.label ? `<span class="label">${escapeHtml(a.label)}</span> ` : '';
      const ageTxt = a.ready_at ? relTimeMs(a.ready_at) : (a.created_at ? relTimeMs(a.created_at) : '?');
      return (
        `<div class="anchor-row">` +
          `<span class="anchor-status ${escapeHtml(a.status || '?')}">${escapeHtml(a.status || '?')}</span>` +
          `<span class="anchor-id">${labelTxt}<code>${escapeHtml(a.id_short)}</code></span>` +
          `<span class="anchor-head">${a.git_head ? '@' + escapeHtml(a.git_head) : '—'}</span>` +
          `<span class="anchor-time">${escapeHtml(ageTxt)}</span>` +
        `</div>`
      );
    }).join('');
    document.getElementById('recovery-toggle-link').textContent = 'hide anchors';
  } else {
    anchorsEl.hidden = true;
    anchorsEl.innerHTML = '';
    document.getElementById('recovery-toggle-link').textContent = 'show anchors';
  }
}

function setupRecoveryCard() {
  const copyLink   = document.getElementById('recovery-copy-prompt-link');
  const toggleLink = document.getElementById('recovery-toggle-link');
  if (copyLink) copyLink.addEventListener('click', async () => {
    if (!selectedProject) return;
    let res;
    try {
      res = await window.cairn.getRecoveryPrompt(selectedProject.id, {});
    } catch (e) {
      res = { ok: false, error: e && e.message };
    }
    if (res && res.ok && res.prompt) {
      try {
        await navigator.clipboard.writeText(res.prompt);
        const original = copyLink.textContent;
        copyLink.textContent = 'copied';
        setTimeout(() => { copyLink.textContent = original; }, 1200);
      } catch (_e) { /* clipboard unavailable */ }
    } else {
      const footer = document.getElementById('footer');
      footer.textContent = `recovery prompt failed: ${(res && res.error) || 'unknown'}`;
      footer.classList.add('bad');
      setTimeout(() => {
        footer.textContent = 'read-only · polling 1s · Cairn project control surface';
        footer.classList.remove('bad');
      }, 4000);
    }
  });
  if (toggleLink) toggleLink.addEventListener('click', () => {
    recoveryExpanded = !recoveryExpanded;
    renderRecoveryCard(lastRecovery);
  });
}

// ---------------------------------------------------------------------------
// Managed Loop card — Cairn-managed external repo workflow
// ---------------------------------------------------------------------------
//
// Read-mostly card; user-driven. Every button performs ONE deterministic
// step in the loop:
//   register → start iteration → generate worker prompt → copy prompt →
//   collect evidence → review → copy next prompt seed.
//
// "Attach report" lives inline with the textarea so pasting + attaching
// is a single visual gesture.

let managedExpanded = false;
let managedLastRecord = null;
let managedLastIteration = null;
let managedLastPrompt = null;
let managedLastReview = null;
let managedBusy = false;
// Worker state — set by setup, refreshed by poll
let managedProviders = null;
let managedSelectedProvider = null;
let managedActiveRun = null;
let managedRunPollTimer = null;

function setManagedBusy(busy) {
  managedBusy = !!busy;
  const ids = ['managed-btn-register', 'managed-btn-start', 'managed-btn-prompt',
               'managed-btn-evidence', 'managed-btn-review',
               'managed-attach-report-link'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (managedBusy) el.setAttribute('disabled', 'true');
    else el.removeAttribute('disabled');
  }
}

function renderManagedCard(record, latestIteration) {
  managedLastRecord = record || null;
  managedLastIteration = latestIteration || null;
  const card = document.getElementById('managed-card');
  if (!card) return;
  if (!selectedProject) { card.hidden = true; return; }
  card.hidden = false;

  const status = document.getElementById('managed-status');
  const meta   = document.getElementById('managed-meta');
  const profile = document.getElementById('managed-profile');
  const latest  = document.getElementById('managed-latest');

  // Status chip + line
  if (record && record.profile) {
    status.textContent = 'managed';
    status.className = 'managed-status managed';
    const p = record.profile;
    const bits = [];
    if (p.package_manager) bits.push(p.package_manager);
    if (p.languages && p.languages.length) bits.push(p.languages.slice(0, 3).join('+'));
    if (record.default_branch) bits.push('@' + record.default_branch);
    meta.textContent = bits.join(' · ');
  } else if (record) {
    status.textContent = 'no profile';
    status.className = 'managed-status needs';
    meta.textContent = record.profile_error || 'profile_error';
  } else {
    status.textContent = 'unmanaged';
    status.className = 'managed-status';
    meta.textContent = 'click "register" to track this repo with Cairn';
  }

  const body = document.getElementById('managed-body');
  body.hidden = !managedExpanded;
  document.getElementById('managed-toggle-link').textContent = managedExpanded ? 'collapse ▾' : 'expand ▸';

  // Profile detail
  if (record && record.profile) {
    const p = record.profile;
    const lines = [];
    lines.push(`<div>repo: <code>${escapeHtml(record.repo_url || record.local_path || '(none)')}</code></div>`);
    if (p.test_commands && p.test_commands.length) {
      lines.push(`<div>test: <code>${escapeHtml(p.test_commands.join(' | '))}</code></div>`);
    }
    if (p.build_commands && p.build_commands.length) {
      lines.push(`<div>build: <code>${escapeHtml(p.build_commands.join(' | '))}</code></div>`);
    }
    if (p.lint_commands && p.lint_commands.length) {
      lines.push(`<div>lint: <code>${escapeHtml(p.lint_commands.join(' | '))}</code></div>`);
    }
    if (p.docs && p.docs.length) {
      lines.push(`<div>docs: ${escapeHtml(p.docs.join(', '))}</div>`);
    }
    profile.innerHTML = lines.join('');
  } else if (record) {
    profile.innerHTML = `<div class="placeholder">profile unavailable: <code>${escapeHtml(record.profile_error || 'unknown')}</code> — re-run register after fixing the local path.</div>`;
  } else {
    profile.innerHTML = `<div class="placeholder">not registered as managed yet — click <code>register</code> below.</div>`;
  }

  // Latest iteration line
  if (latestIteration) {
    const i = latestIteration;
    const bits = [`round <code>${escapeHtml(i.id)}</code>`, `status: <code>${escapeHtml(i.status)}</code>`];
    if (i.review_status) bits.push(`review: <code>${escapeHtml(i.review_status)}</code>`);
    if (i.worker_report_id) bits.push('report attached');
    if (i.evidence_summary) bits.push(`changes: ${i.evidence_summary.changed_file_count || 0}`);
    latest.innerHTML = bits.join(' · ');
  } else {
    latest.innerHTML = `<div class="placeholder">no iteration yet — click "start iteration" once the project is managed.</div>`;
  }

  // Button enablement
  const has = !!(record && record.profile);
  const haveOpenIter = !!(latestIteration && latestIteration.status !== 'reviewed' && latestIteration.status !== 'archived');
  const reg     = document.getElementById('managed-btn-register');
  const start   = document.getElementById('managed-btn-start');
  const prompt  = document.getElementById('managed-btn-prompt');
  const copyP   = document.getElementById('managed-btn-copy-prompt');
  const ev      = document.getElementById('managed-btn-evidence');
  const rev     = document.getElementById('managed-btn-review');
  const seed    = document.getElementById('managed-btn-copy-seed');
  if (reg)    reg.removeAttribute('disabled');
  if (start)  start[has ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (prompt) prompt[has && haveOpenIter ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (copyP)  copyP[managedLastPrompt ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (ev)     ev[has && haveOpenIter ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (rev)    rev[has && haveOpenIter ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (seed)   seed[managedLastReview && managedLastReview.next_prompt_seed ? 'removeAttribute' : 'setAttribute']('disabled', 'true');

  // Render persisted prompt textarea if we have one in this session
  if (managedLastPrompt) {
    document.getElementById('managed-prompt-area').hidden = false;
    document.getElementById('managed-prompt-text').value = managedLastPrompt.prompt || '';
  }
  // Render persisted review summary
  if (managedLastReview) {
    const rs = document.getElementById('managed-review-summary');
    rs.hidden = false;
    const cls = ({
      blocked: 'blocked', needs_evidence: 'needs', continue: 'continue',
      ready_for_review: 'ready', unknown: '',
    })[managedLastReview.status] || '';
    rs.innerHTML = `<div><span class="managed-status ${cls}">${escapeHtml(managedLastReview.status)}</span> ${escapeHtml(managedLastReview.summary || '')}</div>`;
    if (managedLastReview.next_attention && managedLastReview.next_attention.length) {
      rs.innerHTML += `<div style="margin-top:3px;">next attention:</div>`;
      rs.innerHTML += '<ul style="margin:2px 0 0 16px; padding:0;">' +
        managedLastReview.next_attention.slice(0, 5).map(a => `<li>${escapeHtml(a)}</li>`).join('') + '</ul>';
    }
    if (managedLastReview.next_prompt_seed) {
      const sa = document.getElementById('managed-seed-area');
      sa.hidden = false;
      document.getElementById('managed-seed-text').value = managedLastReview.next_prompt_seed;
    }
  }

  renderManagedWorkerArea();
}

// Render the worker controls (providers, status, tail). Called from
// renderManagedCard at the bottom of the card render path. Buttons
// stay inert until the panel has detected providers AND the
// project is registered as managed AND there's an open iteration.
function renderManagedWorkerArea() {
  const providersHost = document.getElementById('managed-worker-providers');
  if (!providersHost) return;
  const has = !!(managedLastRecord && managedLastRecord.profile);
  const iter = managedLastIteration;
  const haveOpenIter = !!(iter && iter.status !== 'reviewed' && iter.status !== 'archived');

  // Providers row
  if (managedProviders === null) {
    providersHost.innerHTML = '<span class="placeholder">probing CLI providers…</span>';
  } else {
    const parts = [];
    for (const p of managedProviders) {
      const checked = managedSelectedProvider === p.id;
      const cls = ['managed-provider'];
      if (!p.available) cls.push('unavailable');
      if (checked) cls.push('selected');
      const note = p.available
        ? ''
        : `<span style="margin-left:4px;color:#a66;font-size:0.85em;">${escapeHtml(p.id === 'codex' ? 'Codex CLI not found in PATH' : 'not found in PATH')}</span>`;
      parts.push(
        `<label class="${cls.join(' ')}">` +
          `<input type="radio" name="managed-provider" value="${escapeHtml(p.id)}" ${checked ? 'checked' : ''} ${p.available ? '' : 'disabled'}>` +
          `${escapeHtml(p.displayName)}` +
          note +
        `</label>`
      );
    }
    providersHost.innerHTML = parts.join('');
    // Wire change handlers (idempotent — DOM nodes are recreated each render)
    providersHost.querySelectorAll('input[name="managed-provider"]').forEach(el => {
      el.addEventListener('change', (e) => {
        managedSelectedProvider = e.target.value;
        renderManagedWorkerArea();
      });
    });
  }

  // Disclosure
  const disclosure = document.getElementById('managed-worker-disclosure');
  const selProv = managedSelectedProvider && (managedProviders || []).find(p => p.id === managedSelectedProvider);
  if (selProv && selProv.available && managedLastRecord && managedLastRecord.local_path) {
    disclosure.hidden = false;
    disclosure.textContent =
      `will start ${selProv.displayName} in ${managedLastRecord.local_path} — it can read and modify files`;
  } else {
    disclosure.hidden = true;
  }

  // Active run status
  const statusNode = document.getElementById('managed-worker-status');
  if (managedActiveRun) {
    statusNode.hidden = false;
    const r = managedActiveRun;
    const elapsed = r.started_at && (r.ended_at || Date.now()) - r.started_at;
    const mm = Math.floor((elapsed || 0) / 60000);
    const ss = Math.floor(((elapsed || 0) % 60000) / 1000);
    const time = mm + ':' + (ss < 10 ? '0' : '') + ss;
    const cls = ({ running: 'running', exited: 'managed', failed: 'blocked', stopped: 'needs', queued: 'needs', unknown: '' })[r.status] || '';
    statusNode.innerHTML =
      `<span class="managed-status ${cls}">${escapeHtml(r.status)}</span>` +
      ` · ${escapeHtml(r.provider || '?')}` +
      ` · ${time}` +
      ` · run <code>${escapeHtml(r.run_id || '?')}</code>` +
      (r.exit_code != null ? ` · exit ${r.exit_code}` : '');
  } else {
    statusNode.hidden = true;
  }

  // Buttons
  const open  = document.getElementById('managed-btn-open-worker');
  const stop  = document.getElementById('managed-btn-stop-worker');
  const tail  = document.getElementById('managed-btn-tail-worker');
  const extr  = document.getElementById('managed-btn-extract');
  const canOpen = has && haveOpenIter && !!selProv && selProv.available && !(managedActiveRun && managedActiveRun.status === 'running');
  const canStop = managedActiveRun && managedActiveRun.status === 'running';
  const canTail = !!managedActiveRun;
  const canExtract = managedActiveRun && (managedActiveRun.status === 'exited' || managedActiveRun.status === 'failed' || managedActiveRun.status === 'stopped' || managedActiveRun.status === 'unknown');
  if (open) open[canOpen ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (stop) stop[canStop ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (tail) tail[canTail ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
  if (extr) extr[canExtract ? 'removeAttribute' : 'setAttribute']('disabled', 'true');
}

function reportFooterError(msg) {
  const footer = document.getElementById('footer');
  if (!footer) return;
  footer.textContent = msg;
  footer.classList.add('bad');
  setTimeout(() => {
    footer.textContent = 'read-only · polling 1s · Cairn project control surface';
    footer.classList.remove('bad');
  }, 4000);
}

function setupManagedCard() {
  const toggle = document.getElementById('managed-toggle-link');
  if (toggle) toggle.addEventListener('click', () => {
    managedExpanded = !managedExpanded;
    renderManagedCard(managedLastRecord, managedLastIteration);
  });

  document.getElementById('managed-btn-register').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.registerManagedProject(selectedProject.id, {});
      if (!res || !res.ok) {
        reportFooterError(`register failed: ${(res && res.error) || 'unknown'}`);
      } else {
        managedExpanded = true;
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-start').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    setManagedBusy(true);
    try {
      const goal = await window.cairn.getProjectGoal(selectedProject.id);
      const res = await window.cairn.startManagedIteration(selectedProject.id, {
        goal_id: goal && goal.id || null,
      });
      if (!res || !res.ok) reportFooterError(`start iteration failed: ${(res && res.error) || 'unknown'}`);
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-prompt').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.generateManagedWorkerPrompt(selectedProject.id, {});
      if (res && res.ok && res.result) {
        managedLastPrompt = res.result;
        document.getElementById('managed-prompt-area').hidden = false;
        document.getElementById('managed-prompt-text').value = res.result.prompt || '';
      } else {
        reportFooterError(`prompt generation failed: ${(res && res.error) || 'unknown'}`);
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-copy-prompt').addEventListener('click', async () => {
    if (!managedLastPrompt || !managedLastPrompt.prompt) return;
    try {
      await navigator.clipboard.writeText(managedLastPrompt.prompt);
      const btn = document.getElementById('managed-btn-copy-prompt');
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy prompt'; }, 1200);
    } catch (_e) { /* clipboard unavailable */ }
  });

  document.getElementById('managed-attach-report-link').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    const text = document.getElementById('managed-report-text').value;
    if (!text || !text.trim()) { reportFooterError('paste a report first'); return; }
    setManagedBusy(true);
    try {
      const res = await window.cairn.attachManagedWorkerReport(selectedProject.id, { text });
      if (!res || !res.ok) {
        reportFooterError(`attach report failed: ${(res && res.error) || 'unknown'}`);
      } else {
        document.getElementById('managed-report-text').value = '';
        const link = document.getElementById('managed-attach-report-link');
        link.textContent = 'attached';
        setTimeout(() => { link.textContent = 'attach'; }, 1200);
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-evidence').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.collectManagedEvidence(selectedProject.id, {});
      if (!res || !res.ok) {
        reportFooterError(`collect evidence failed: ${(res && res.error) || 'unknown'}`);
      } else {
        const ev = res.evidence;
        const sum = res.summary;
        const node = document.getElementById('managed-evidence-summary');
        node.hidden = false;
        const bits = [];
        if (ev.branch) bits.push(`branch <code>${escapeHtml(ev.branch)}</code>`);
        if (ev.git_short) bits.push(`HEAD <code>${escapeHtml(ev.git_short)}</code>`);
        bits.push(`dirty: ${ev.dirty}`);
        bits.push(`changed: ${(ev.changed_files || []).length}`);
        if (ev.last_commit && ev.last_commit.subject) bits.push(`last: <code>${escapeHtml(ev.last_commit.subject)}</code>`);
        node.innerHTML = bits.join(' · ');
        if (sum && sum.error_codes && sum.error_codes.length) {
          node.innerHTML += `<div style="color:#f99;margin-top:2px;">errors: ${escapeHtml(sum.error_codes.join(', '))}</div>`;
        }
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-review').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.reviewManagedIteration(selectedProject.id, { forceDeterministic: true });
      if (!res || !res.ok) {
        reportFooterError(`review failed: ${(res && res.error) || 'unknown'}`);
      } else {
        managedLastReview = res.verdict;
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-copy-seed').addEventListener('click', async () => {
    if (!managedLastReview || !managedLastReview.next_prompt_seed) return;
    try {
      await navigator.clipboard.writeText(managedLastReview.next_prompt_seed);
      const btn = document.getElementById('managed-btn-copy-seed');
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy next prompt seed'; }, 1200);
    } catch (_e) { /* clipboard unavailable */ }
  });

  // ---- Worker launch wiring ----

  // One-time provider detection at startup. Renderer is sandboxed, so
  // we re-fetch on demand via window.cairn.detectWorkerProviders.
  (async () => {
    try {
      managedProviders = await window.cairn.detectWorkerProviders();
      // Pre-select the first available provider (claude-code wins
      // when both are present, then codex, then fixture-echo).
      const order = ['claude-code', 'codex', 'fixture-echo'];
      for (const id of order) {
        const p = (managedProviders || []).find(pp => pp.id === id);
        if (p && p.available) { managedSelectedProvider = id; break; }
      }
      renderManagedWorkerArea();
    } catch (_e) {
      managedProviders = [];
      renderManagedWorkerArea();
    }
  })();

  document.getElementById('managed-btn-open-worker').addEventListener('click', async () => {
    if (!selectedProject || managedBusy) return;
    if (!managedSelectedProvider) { reportFooterError('select a worker provider first'); return; }
    if (!managedLastPrompt || !managedLastPrompt.prompt) {
      reportFooterError('generate a worker prompt first'); return;
    }
    setManagedBusy(true);
    try {
      const res = await window.cairn.launchManagedWorker(selectedProject.id, {
        provider: managedSelectedProvider,
        prompt: managedLastPrompt.prompt,
      });
      if (!res || !res.ok) {
        reportFooterError(`open worker failed: ${(res && res.error) || 'unknown'}`);
      } else {
        managedActiveRun = res.run;
        renderManagedWorkerArea();
        startManagedRunPoll(res.run_id);
      }
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-stop-worker').addEventListener('click', async () => {
    if (!managedActiveRun || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.stopWorkerRun(managedActiveRun.run_id);
      if (!res || !res.ok) reportFooterError(`stop failed: ${(res && res.error) || 'unknown'}`);
      // poll loop will refresh status
    } finally { setManagedBusy(false); }
  });

  document.getElementById('managed-btn-tail-worker').addEventListener('click', async () => {
    if (!managedActiveRun) return;
    const res = await window.cairn.tailWorkerRun(managedActiveRun.run_id, 16384);
    if (res && res.ok) {
      const ta = document.getElementById('managed-worker-tail-area');
      ta.hidden = false;
      document.getElementById('managed-worker-tail').value = res.text || '(empty)';
    }
  });

  document.getElementById('managed-btn-extract').addEventListener('click', async () => {
    if (!selectedProject || !managedActiveRun || managedBusy) return;
    setManagedBusy(true);
    try {
      const res = await window.cairn.extractWorkerReport(selectedProject.id, { run_id: managedActiveRun.run_id });
      if (!res || !res.ok) {
        reportFooterError(`extract failed: ${(res && res.error) || 'unknown'} — paste report manually`);
      } else {
        const btn = document.getElementById('managed-btn-extract');
        btn.textContent = 'extracted';
        setTimeout(() => { btn.textContent = 'extract report'; }, 1200);
      }
    } finally { setManagedBusy(false); }
  });
}

// Poll the active worker run's status until it exits. Polling is
// only active when a run was launched THIS panel session — we don't
// auto-poll persisted runs from prior sessions.
function startManagedRunPoll(runId) {
  if (managedRunPollTimer) {
    clearInterval(managedRunPollTimer);
    managedRunPollTimer = null;
  }
  let consecutiveErrors = 0;
  managedRunPollTimer = setInterval(async () => {
    try {
      const run = await window.cairn.getWorkerRun(runId);
      if (!run) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          clearInterval(managedRunPollTimer);
          managedRunPollTimer = null;
        }
        return;
      }
      consecutiveErrors = 0;
      managedActiveRun = run;
      renderManagedWorkerArea();
      if (run.status !== 'running' && run.status !== 'queued') {
        clearInterval(managedRunPollTimer);
        managedRunPollTimer = null;
      }
    } catch (_e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        clearInterval(managedRunPollTimer);
        managedRunPollTimer = null;
      }
    }
  }, 1000);
}

// ---------------------------------------------------------------------------
// Project Pulse renderer — read-only signal surface (Phase 3 / Goal pre-work)
// ---------------------------------------------------------------------------
//
// Cairn does NOT decide what the agent should do next. The strip
// answers "what should the user pay attention to right now?" only.
// Copy is reviewed against PRODUCT.md §1.3 #4 / §7 principle 2.

let pulseExpanded = false;

function pulseLevelLabel(lv) {
  return ({ ok: 'OK', watch: 'WATCH', attention: 'ATTENTION' })[lv] || lv.toUpperCase();
}

function renderPulse(pulse) {
  const stripEl = document.getElementById('pulse');
  if (!stripEl) return;
  if (!pulse) {
    stripEl.classList.add('pulse-hidden');
    return;
  }
  // Hide entirely when there's nothing meaningful to show — an `ok`
  // pulse with no signals is just visual noise. Only render when
  // pulse_level != ok OR there's at least one info signal.
  const sigs = Array.isArray(pulse.signals) ? pulse.signals : [];
  const level = pulse.pulse_level || 'ok';
  if (level === 'ok' && sigs.length === 0) {
    stripEl.classList.add('pulse-hidden');
    return;
  }
  stripEl.classList.remove('pulse-hidden');
  stripEl.classList.remove('pulse-ok', 'pulse-watch', 'pulse-attention');
  stripEl.classList.add('pulse-' + level);

  const dotEl = document.getElementById('pulse-dot');
  dotEl.classList.remove('ok', 'watch', 'attention');
  dotEl.classList.add(level);

  document.getElementById('pulse-level').textContent = pulseLevelLabel(level);
  const top = (pulse.next_attention && pulse.next_attention[0]) || sigs[0] || null;
  document.getElementById('pulse-headline').textContent = top
    ? top.title
    : 'no issues to surface';

  const detailEl = document.getElementById('pulse-signals');
  if (pulseExpanded && sigs.length > 0) {
    detailEl.hidden = false;
    detailEl.innerHTML = sigs.map(s => (
      `<div class="sig">` +
        `<span class="sig-dot ${escapeHtml(s.severity)}">●</span>` +
        `<span class="sig-title">${escapeHtml(s.title)}</span>` +
        (s.detail ? `<span class="sig-detail">${escapeHtml(s.detail)}</span>` : '') +
      `</div>`
    )).join('');
  } else {
    detailEl.hidden = true;
    detailEl.innerHTML = '';
  }

  // Re-bind click-to-toggle (idempotent — strip is the same DOM node).
  if (!stripEl._wired) {
    stripEl.addEventListener('click', () => {
      pulseExpanded = !pulseExpanded;
      poll().catch(() => {});
    });
    stripEl._wired = true;
  }
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

  // L2 active-agents cell: show the agent_activity headline (live /
  // recent / inactive / dead). The per-source MCP / Claude / Codex
  // split is still rendered on the L1 card and on the project detail
  // panel, so the L2 summary stays focused on "what should I look at
  // first?". When no agent_activity field is present (very old payload)
  // we fall back to MCP count alone.
  const sAgents = document.getElementById('s-agents');
  const aa = summary.agent_activity || null;
  const fam = aa ? aa.by_family : null;
  if (fam) {
    sAgents.classList.remove('zero', 'warn', 'alert');
    const liveCls   = fam.live   === 0 ? 'zero' : '';
    const recentCls = fam.recent === 0 ? 'zero' : '';
    const inactCls  = 'zero';
    const deadHtml = fam.dead
      ? `<span style="color:#445;padding:0 4px">·</span>` +
        `<span class="alert">${fam.dead} dead</span>` : '';
    sAgents.innerHTML =
      `<span class="${liveCls}">${fam.live} live</span>` +
      `<span style="color:#445;padding:0 4px">·</span>` +
      `<span class="${recentCls}">${fam.recent} recent</span>` +
      `<span style="color:#445;padding:0 4px">·</span>` +
      `<span class="${inactCls}">${fam.inactive} inactive</span>` +
      deadHtml;
  } else {
    setSummaryCell(sAgents, summary.agents_active || 0);
  }

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

function renderCheckpointsSection(checkpoints, taskId) {
  if (checkpoints == null) {
    return `<div class="ckpt-section"><div class="head">recovery anchors</div><div style="color:#666">loading…</div></div>`;
  }
  if (!checkpoints.length) {
    // Make the absence-of-recovery clear, not a silent "0".
    return `<div class="ckpt-section">` +
             `<div class="head">recovery anchors</div>` +
             `<div style="color:#888;font-size:0.92em">No checkpoints recorded for this task — there's nothing to rewind to. Ask an agent to create one before risky work.</div>` +
           `</div>`;
  }
  // Identify the latest READY anchor — that's the "safe rewind point"
  // surface. Mark it visually so the user sees which one to use first.
  const latestReadyIdx = checkpoints.findIndex(c => (c.snapshot_status || '').toUpperCase() === 'READY');
  const safeAnchorBanner = latestReadyIdx >= 0
    ? `<div style="color:#7e7;font-size:0.85em;margin-bottom:3px">Latest safe anchor: ` +
      `<code>${escapeHtml(checkpoints[latestReadyIdx].id.slice(0, 12))}</code>` +
      (checkpoints[latestReadyIdx].label ? ` (${escapeHtml(checkpoints[latestReadyIdx].label)})` : '') +
      `</div>`
    : `<div style="color:#ec8;font-size:0.85em;margin-bottom:3px">No READY anchor yet — pending or corrupted only.</div>`;

  const rows = checkpoints.map((c, idx) => {
    const head = c.git_head ? String(c.git_head).slice(0, 7) : '—';
    const isSafe = idx === latestReadyIdx;
    const labelTxt = c.label
      ? `<span class="label">${escapeHtml(c.label)}</span> · ${escapeHtml(c.id.slice(0, 12))}`
      : escapeHtml(c.id.slice(0, 12));
    const safeMark = isSafe
      ? ` <span style="color:#7e7;font-size:0.78rem">SAFE</span>`
      : '';
    const ts = relTimeMs(c.ready_at || c.created_at);
    return (
      `<div class="ckpt">` +
        `<span class="ckpt-status ${escapeHtml(c.snapshot_status)}">${escapeHtml(c.snapshot_status)}</span>` +
        `<span class="ckpt-id" title="${escapeHtml(c.id)}">${labelTxt} <span style="color:#666">@${escapeHtml(head)}</span>${safeMark}</span>` +
        `<span class="ckpt-meta">${escapeHtml(ts)} · ${escapeHtml(fmtBytes(c.size_bytes))}</span>` +
        `<button class="ckpt-copy" data-ckpt-id="${escapeHtml(c.id)}" type="button">copy id</button>` +
      `</div>`
    );
  }).join('');
  // Per-task recovery prompt action — copies a scoped advisory prompt
  // the user can paste to a coding agent. Cairn does NOT execute the
  // rewind; the prompt explicitly tells the agent to inspect first.
  const promptAction = taskId
    ? `<div style="margin-top:4px"><a class="ckpt-recover-prompt" data-task-id="${escapeHtml(taskId)}" style="color:#7af;cursor:pointer;font-size:0.85em">copy recovery prompt for this task</a></div>`
    : '';
  return `<div class="ckpt-section">` +
           `<div class="head">recovery anchors (${checkpoints.length})</div>` +
           safeAnchorBanner +
           rows +
           promptAction +
         `</div>`;
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
      renderCheckpointsSection(checkpoints, t && t.task_id) +
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
      if (ev.target.closest('.ckpt-recover-prompt')) return;
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

  // Per-task recovery prompt (advisory; cairn does NOT execute rewind).
  el.querySelectorAll('.ckpt-recover-prompt').forEach(link => {
    link.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!selectedProject) return;
      const taskId = link.getAttribute('data-task-id');
      let res;
      try {
        res = await window.cairn.getRecoveryPrompt(selectedProject.id, { task_id: taskId });
      } catch (e) {
        res = { ok: false, error: e && e.message };
      }
      if (res && res.ok && res.prompt) {
        try {
          await navigator.clipboard.writeText(res.prompt);
          const original = link.textContent;
          link.textContent = 'copied';
          setTimeout(() => { link.textContent = original; }, 1200);
        } catch (_e) {}
      }
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
        `<span class="sess-id"><code>${escapeHtml(sess.agent_id)}</code> <span class="at-type">@${escapeHtml(sess.agent_type)}</span> <span class="sess-source s-mcp">MCP</span></span>` +
        `<span class="sess-meta">${escapeHtml(heartbeatTxt)}</span>` +
      `</div>` +
      `<div class="sess-line2">${renderCapChips(sess.capabilities)}</div>` +
      `<div class="sess-line3">${renderOwnsTasks(sess.owns_tasks)}</div>` +
      (actions.length ? `<div class="sess-actions">${actions.join('')}</div>` : '') +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Claude Code session rows (Real Agent Presence step 2)
// ---------------------------------------------------------------------------
//
// Different shape than MCP rows. Renderer is intentionally a separate
// function rather than overloading renderSessionRow, because:
//   - Claude rows have no agent_id / agent_type / owns_tasks /
//     capabilities — those are MCP-specific.
//   - The state vocabulary differs (busy/idle/stale/dead/unknown vs
//     ACTIVE/STALE/DEAD/OTHER), and conflating them in one function
//     would force the reader to keep two parallel mental models.
//   - Claude rows are read-only with no Cairn agent_id, so neither
//     "filter Tasks tab" nor "Add to project…" actions apply.

function shortPathInProject(absPath, projectRoot) {
  if (!absPath) return '?';
  // Cosmetic: normalize separators in the user-facing string only.
  const norm  = absPath.replace(/\\/g, '/');
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, '/');
    const rootCmp = (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent || ''))
      ? root.toLowerCase() : root;
    const normCmp = (typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent || ''))
      ? norm.toLowerCase() : norm;
    if (normCmp === rootCmp) return '· (project root)';
    if (normCmp.startsWith(rootCmp + '/')) return '·/' + norm.slice(root.length + 1);
  }
  // No project context — fall back to the trailing two segments.
  const parts = norm.split('/').filter(Boolean);
  return parts.length <= 2 ? norm : '…/' + parts.slice(-2).join('/');
}

function renderClaudeSessionRow(row, opts) {
  const projectRoot = opts && opts.projectRoot;
  const allowRegister = !!(opts && opts.allowRegisterFromCwd);
  // status (lowercase) → display badge state (uppercase).
  const display = (row.status || 'unknown').toUpperCase(); // BUSY | IDLE | STALE | DEAD | UNKNOWN
  const sid = row.session_id ? row.session_id.slice(0, 8) : '?';
  const cwdShort = shortPathInProject(row.cwd, projectRoot);
  const ageTxt = row.updated_at ? relTimeMs(row.updated_at) : '?';
  // Show raw_status as a hint when we promoted to stale/dead, e.g.
  // "STALE (was busy)".
  const rawHint = row.raw_status ? ` <span style="color:#666">(was ${escapeHtml(row.raw_status)})</span>` : '';
  const pidTxt = row.pid != null ? `pid ${row.pid}` : 'no pid';
  const verTxt = row.version ? ` · ${escapeHtml(row.version)}` : '';
  const reasonTxt = row.stale_reason && (display === 'STALE' || display === 'DEAD')
    ? ` <span style="color:#666">[${escapeHtml(row.stale_reason)}]</span>`
    : '';
  // Register-from-cwd action only renders in Unassigned context AND
  // only when the row carries a cwd. No cwd → nothing to register.
  const registerLink = (allowRegister && row.cwd)
    ? `<div class="sess-actions">` +
        `<a data-act="register-project" data-cwd="${escapeHtml(row.cwd)}">` +
        `Register project from this cwd…</a>` +
      `</div>`
    : '';
  return (
    `<div class="sess" data-claude-pid="${escapeHtml(String(row.pid || ''))}">` +
      `<div class="sess-line1">` +
        `<span class="sess-state s-${escapeHtml(display)}">${escapeHtml(display)}</span>` +
        `<span class="sess-id"><code>claude:${escapeHtml(sid)}</code> ${rawHint}<span class="sess-source s-claude">Claude Code</span></span>` +
        `<span class="sess-meta">${escapeHtml(ageTxt)}</span>` +
      `</div>` +
      `<div class="sess-line2" style="margin-left:78px">` +
        `<code>${escapeHtml(cwdShort)}</code>` +
      `</div>` +
      `<div class="sess-line3" style="margin-left:78px">` +
        `${escapeHtml(pidTxt)}${verTxt}${reasonTxt}` +
      `</div>` +
      registerLink +
    `</div>`
  );
}

function renderClaudeSessionsBlock(rows, opts) {
  if (!rows || !rows.length) return '';
  // Group: BUSY / IDLE / STALE / DEAD/UNKNOWN — same dramaturgy as MCP.
  const groups = { BUSY: [], IDLE: [], STALE: [], OTHER: [] };
  for (const r of rows) {
    const st = (r.status || 'unknown').toUpperCase();
    if      (st === 'BUSY')  groups.BUSY.push(r);
    else if (st === 'IDLE')  groups.IDLE.push(r);
    else if (st === 'STALE') groups.STALE.push(r);
    else                     groups.OTHER.push(r);
  }
  let out = `<div class="sess-group-title">CLAUDE CODE SESSIONS (${rows.length})</div>`;
  for (const k of ['BUSY', 'IDLE', 'STALE', 'OTHER']) {
    if (!groups[k].length) continue;
    out += groups[k].map(r => renderClaudeSessionRow(r, opts)).join('');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex session-log rows (Real Agent Presence step 3)
// ---------------------------------------------------------------------------
//
// Parallel structure to Claude rows but distinct in two important ways:
//   - Status vocabulary is recent / inactive / unknown — never busy/idle.
//     The Codex session_meta does not publish a current-status field
//     and the rollout file carries no pid, so we cannot defend a
//     stronger claim than "we saw the file get written recently".
//   - The row carries an `originator` (e.g. "Codex Desktop" vs "Codex
//     CLI") and a `source_app` ("vscode" when launched from there).
//     We surface the originator as a dim line-2 hint so users can
//     distinguish a Desktop window from a one-off CLI invocation.

function renderCodexSessionRow(row, opts) {
  const projectRoot = opts && opts.projectRoot;
  const allowRegister = !!(opts && opts.allowRegisterFromCwd);
  const display = (row.status || 'unknown').toUpperCase(); // RECENT | INACTIVE | UNKNOWN
  const sid = row.session_id ? row.session_id.slice(0, 8) : '?';
  const cwdShort = shortPathInProject(row.cwd, projectRoot);
  const ageTxt = row.updated_at ? relTimeMs(row.updated_at) : '?';
  const orig = row.originator
    ? `<span style="color:#888">${escapeHtml(row.originator)}</span>`
    : `<span style="color:#555">(no originator)</span>`;
  const verTxt = row.version ? ` · ${escapeHtml(row.version)}` : '';
  const appTxt = row.source_app ? ` · ${escapeHtml(row.source_app)}` : '';
  const reasonTxt = row.stale_reason && display === 'UNKNOWN'
    ? ` <span style="color:#666">[${escapeHtml(row.stale_reason)}]</span>`
    : '';
  const registerLink = (allowRegister && row.cwd)
    ? `<div class="sess-actions">` +
        `<a data-act="register-project" data-cwd="${escapeHtml(row.cwd)}">` +
        `Register project from this cwd…</a>` +
      `</div>`
    : '';
  return (
    `<div class="sess" data-codex-sid="${escapeHtml(row.session_id || '')}">` +
      `<div class="sess-line1">` +
        `<span class="sess-state s-${escapeHtml(display)}">${escapeHtml(display)}</span>` +
        `<span class="sess-id"><code>codex:${escapeHtml(sid)}</code> <span class="sess-source s-codex">Codex</span></span>` +
        `<span class="sess-meta">${escapeHtml(ageTxt)}</span>` +
      `</div>` +
      `<div class="sess-line2" style="margin-left:78px">` +
        `<code>${escapeHtml(cwdShort)}</code>` +
      `</div>` +
      `<div class="sess-line3" style="margin-left:78px">` +
        `${orig}${verTxt}${appTxt}${reasonTxt}` +
      `</div>` +
      registerLink +
    `</div>`
  );
}

function renderCodexSessionsBlock(rows, opts) {
  if (!rows || !rows.length) return '';
  // Group: RECENT / INACTIVE / UNKNOWN. No DEAD bucket — adapter never
  // produces it for Codex.
  const groups = { RECENT: [], INACTIVE: [], UNKNOWN: [] };
  for (const r of rows) {
    const st = (r.status || 'unknown').toUpperCase();
    if (groups[st]) groups[st].push(r);
    else            groups.UNKNOWN.push(r);
  }
  let out = `<div class="sess-group-title">CODEX SESSIONS (${rows.length})</div>`;
  for (const k of ['RECENT', 'INACTIVE', 'UNKNOWN']) {
    if (!groups[k].length) continue;
    out += groups[k].map(r => renderCodexSessionRow(r, opts)).join('');
  }
  return out;
}

let lastSessions = [];
// AgentActivity expansion state — survives polls so a click stays open.
let expandedActivityId = null;

// ---------------------------------------------------------------------------
// Agent Activity Layer renderer (Layer v1)
// ---------------------------------------------------------------------------
//
// Consumes the unified activity[] feed from main.cjs (built by
// agent-activity.cjs). Renders one row per activity, grouped by
// state_family. Each row keeps its source chip (MCP / Claude Code /
// Codex) so visual boundaries are preserved — Cairn shows distinct
// signal sources, never one homogenized list.

// Human family-group titles (UI hardening — round 3). Activity Monitor
// uses "Working" / "Ready" / "Idle" — same vibe.
function familyTitle(fam) {
  return ({
    live:     'Working now',
    recent:   'Recent',
    inactive: 'Inactive',
    dead:     'Dead',
    unknown:  'Unknown',
  })[fam] || fam.toUpperCase();
}

function familyAlertness(fam) {
  if (fam === 'dead') return 'alert';
  return '';
}

function appChipClass(app) {
  return ({
    'mcp':         's-mcp',
    'claude-code': 's-claude',
    'codex':       's-codex',
  })[app] || '';
}

function attributionChip(a) {
  if (!a.attribution_label) return '';
  // Compact form for the chip; full sentence is in detail card.
  const compact = ({
    'reported by Cairn MCP':     'MCP-reported',
    'manually assigned':         'manual',
    'matched by project folder': 'project folder',
  })[a.attribution_label] || a.attribution_label;
  return `<span class="sess-attr" title="${escapeHtml(a.attribution_label)}">${escapeHtml(compact)}</span>`;
}

// Detail card: technical fields. Shown only on click — primary view
// reads as plain English.
function renderActivityDetail(a) {
  const rows = [];
  const kv = (k, v) => v != null && v !== ''
    ? `<div class="kv"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`
    : '';
  rows.push(kv('Source',     a.source_label || a.source));
  rows.push(kv('Confidence', a.confidence_label || a.confidence));
  rows.push(kv('Attribution', a.attribution_label || '(unassigned)'));
  rows.push(kv('State',      a.human_state_label));
  if (a.state_explanation) {
    rows.push(`<div class="kv"><span class="k">Why this state</span><span class="v" style="color:#aab">${escapeHtml(a.state_explanation)}</span></div>`);
  }
  rows.push(kv('Working folder', a.cwd || '(none)'));
  rows.push(kv('Last activity', a.last_activity_at ? relTimeMs(a.last_activity_at) : '?'));
  rows.push(kv('Session id', a.session_id));
  rows.push(kv('Agent id',   a.agent_id));
  rows.push(kv('PID',        a.pid));
  rows.push(kv('Version',    a.version));
  if (a.app === 'mcp' && a.detail) {
    rows.push(kv('Agent type',    a.detail.agent_type));
    rows.push(kv('Raw status',    a.detail.raw_status));
    rows.push(kv('Heartbeat TTL', a.detail.heartbeat_ttl ? a.detail.heartbeat_ttl + 'ms' : null));
    if (Array.isArray(a.detail.capabilities) && a.detail.capabilities.length) {
      const caps = a.detail.capabilities.slice(0, 6).map(c => escapeHtml(c)).join(', ');
      rows.push(`<div class="kv"><span class="k">Capabilities</span><span class="v">${caps}${a.detail.capabilities.length > 6 ? ' …' : ''}</span></div>`);
    }
    if (a.detail.owns_tasks) {
      const o = a.detail.owns_tasks;
      rows.push(kv('Owns tasks', `R${o.RUNNING} / B${o.BLOCKED} / WR${o.WAITING_REVIEW} / D${o.DONE} / F${o.FAILED}`));
    }
  } else if (a.app === 'claude-code' && a.detail) {
    rows.push(kv('Raw status', a.detail.raw_status));
    rows.push(kv('Reason',     a.detail.stale_reason));
    rows.push(kv('Started',    a.detail.started_at ? relTimeMs(a.detail.started_at) : null));
  } else if (a.app === 'codex' && a.detail) {
    rows.push(kv('Originator', a.detail.originator));
    rows.push(kv('Source app', a.detail.source_app));
    rows.push(kv('Reason',     a.detail.stale_reason));
    rows.push(kv('Started',    a.detail.started_at ? relTimeMs(a.detail.started_at) : null));
  }
  return `<div class="act-detail">${rows.filter(Boolean).join('')}</div>`;
}

function renderActivityRow(a, opts) {
  const allowFilter = !!(opts && opts.allowFilter);
  const allowRegister = !!(opts && opts.allowRegisterFromCwd);
  const projectRoot = opts && opts.projectRoot;
  const cwdShort = shortPathInProject(a.cwd, projectRoot);
  const ageTxt = a.last_activity_at ? relTimeMs(a.last_activity_at) : '?';
  const expanded = (expandedActivityId === a.id);

  // Friendly state badge — uses the human label, not the raw state.
  // Lookup by (uppercased) raw state still drives badge color so
  // existing CSS rules apply. We map to a capitalized human label
  // for the visible text.
  const stateClass = (a.state || 'unknown').toUpperCase();
  const humanState = a.human_state_label || 'Unknown';

  const displayLabel = a.display_label
    || `${(a.app_label || a.app)} · ${(a.short_label || '')}`;

  const actions = [];
  if (allowFilter && a.app === 'mcp' && a.agent_id) {
    actions.push(`<a data-act="filter-tasks" data-agent="${escapeHtml(a.agent_id)}">filter Tasks tab →</a>`);
  }
  if (allowRegister && a.cwd) {
    actions.push(`<a data-act="register-project" data-cwd="${escapeHtml(a.cwd)}">Register project from this folder…</a>`);
  }

  const detailHtml = expanded ? renderActivityDetail(a) : '';

  // Secondary line: short, plain English. No raw pid / source path.
  // The user clicks through if they need those.
  const cwdLine = a.cwd
    ? `<div class="sess-line2"><code>${escapeHtml(cwdShort)}</code></div>`
    : '';
  const attrChip = attributionChip(a);

  return (
    `<div class="sess${expanded ? ' selected' : ''}" data-activity-id="${escapeHtml(a.id)}">` +
      `<div class="sess-line1">` +
        `<span class="sess-state s-${escapeHtml(stateClass)}">${escapeHtml(humanState)}</span>` +
        `<span class="sess-id">${escapeHtml(displayLabel)} ${attrChip}</span>` +
        `<span class="sess-meta">${escapeHtml(ageTxt)}</span>` +
      `</div>` +
      cwdLine +
      detailHtml +
      (actions.length ? `<div class="sess-actions">${actions.join('')}</div>` : '') +
    `</div>`
  );
}

const FAMILY_ORDER = ['live', 'recent', 'inactive', 'dead', 'unknown'];

function renderActivityBlock(activities, opts) {
  if (!activities || !activities.length) return '';
  const groups = { live: [], recent: [], inactive: [], dead: [], unknown: [] };
  for (const a of activities) {
    const f = a.state_family in groups ? a.state_family : 'unknown';
    groups[f].push(a);
  }
  let out = '';
  for (const fam of FAMILY_ORDER) {
    const list = groups[fam];
    if (!list.length) continue;
    const cls = familyAlertness(fam);
    out += `<div class="sess-group-title${cls ? ' ' + cls : ''}">${familyTitle(fam)} (${list.length})</div>`;
    out += list.map(a => renderActivityRow(a, opts)).join('');
  }
  return out;
}

function wireActivityClicks(rootEl, opts) {
  // Row click → toggle expansion.
  rootEl.querySelectorAll('.sess[data-activity-id]').forEach(row => {
    row.addEventListener('click', ev => {
      // Don't capture clicks on inline action links.
      if (ev.target.closest('.sess-actions a')) return;
      const id = row.getAttribute('data-activity-id');
      expandedActivityId = (expandedActivityId === id) ? null : id;
      // Re-render the same view to flush expanded state.
      poll().catch(() => {});
    });
  });

  // Filter Tasks tab (MCP rows in Sessions tab).
  rootEl.querySelectorAll('.sess-actions a[data-act="filter-tasks"]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.stopPropagation();
      const agent = a.getAttribute('data-agent');
      selectedAgentId = agent;
      setActiveTab('tasks');
    });
  });

  // Register project from cwd (Unassigned rows).
  if (opts && opts.allowRegisterFromCwd) {
    rootEl.querySelectorAll('.sess-actions a[data-act="register-project"]').forEach(a => {
      a.addEventListener('click', ev => {
        ev.stopPropagation();
        const cwd = a.getAttribute('data-cwd');
        if (!cwd) return;
        handleRegisterFromCwdClick(cwd);
      });
    });
  }
}

function renderSessions(payload) {
  const el = document.getElementById('sessions-list');
  if (!payload || !payload.available) {
    el.innerHTML = '<div class="placeholder">no agent activity data — DB not connected</div>';
    return;
  }
  // Prefer the unified activities feed; legacy sessions/claude/codex
  // arrays remain populated on `payload` for backward-compat readers
  // but are no longer the canonical view.
  const activities = Array.isArray(payload.activities) ? payload.activities : [];
  lastSessions = payload.sessions || [];
  if (!activities.length) {
    el.innerHTML = (
      '<div class="placeholder">No agents seen in this project yet.<br>'
      + 'Open Claude Code, Codex, or a Cairn-MCP-enabled runner inside this project\'s folder and they\'ll show up here.'
      + '</div>'
    );
    return;
  }
  const projectRoot = selectedProject ? selectedProject.project_root : null;
  const summary = payload.activity_summary || null;
  let html = '';
  if (summary) {
    const f = summary.by_family;
    html += (
      `<div class="sess-group-title" style="display:flex;justify-content:space-between">` +
        `<span>AGENT ACTIVITY (${summary.total})</span>` +
        `<span style="color:#888;font-weight:normal">` +
          `${f.live} live · ${f.recent} recent · ${f.inactive} inactive` +
          (f.dead ? ` · ${f.dead} dead` : '') +
          (f.unknown ? ` · ${f.unknown} unknown` : '') +
        `</span>` +
      `</div>`
    );
  }
  html += renderActivityBlock(activities, { projectRoot, allowFilter: true });
  el.innerHTML = html;
  wireActivityClicks(el);
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
  const summary = detail.activity_summary || null;
  const f = summary ? summary.by_family : null;
  const activityHeadline = f
    ? `${f.live} live · ${f.recent} recent · ${f.inactive} inactive`
      + (f.dead ? ` · ${f.dead} dead` : '')
    : `agents ${detail.agents.length}`;
  countsEl.innerHTML  =
    `<b>${activityHeadline}</b>` +
    `<span class="sep">·</span>tasks ${detail.tasks}` +
    `<span class="sep">·</span>blockers ${detail.blockers}` +
    `<span class="sep">·</span>outcomes ${detail.outcomes}` +
    `<span class="sep">·</span>checkpoints ${detail.checkpoints}` +
    `<span class="sep">·</span>conflicts ${detail.conflicts}` +
    `<span class="sep">·</span>dispatches ${detail.dispatches}`;

  // Activity-driven rendering: one unified row list, grouped by family.
  // Per-row "Register project from this cwd…" action is enabled in the
  // Unassigned context (rows that already carry a cwd; MCP rows
  // typically don't).
  const activities = Array.isArray(detail.activities) ? detail.activities : [];
  if (!activities.length && !detail.agents.length) {
    listEl.innerHTML = '<div class="placeholder">Nothing unassigned right now — every agent in this DB is matched to a registered project.</div>';
    return;
  }
  // Header banner so users see "these agents are not in any project,
  // here\'s how to fix it" instead of just an opaque list.
  const banner =
    `<div style="padding:6px 12px;color:#aab;font-size:0.88em;background:#181818;border-bottom:1px solid #1e1e1e">` +
      `These agents are not assigned to any project. ` +
      `For Claude Code / Codex rows, click <b>Register project from this folder…</b> to mint a project. ` +
      `For Cairn MCP rows, click <b>Add to project…</b> to attach them to an existing project.` +
    `</div>`;
  // Render the unified list. MCP rows still need the "Add to project…"
  // action (manual hint attribution for legacy / pre-v2 rows). Claude /
  // Codex rows need "Register project from this cwd…" to mint a new
  // project entry. Both come from the same row map below.
  let html = banner + renderActivityBlock(activities, {
    projectRoot: null,
    allowFilter: false,
    allowRegisterFromCwd: true,
  });
  // MCP rows in the Unassigned bucket still benefit from the legacy
  // "Add to project…" picker when the user wants to attach a row to an
  // existing project via hint (e.g. a historical row whose agent_id
  // doesn't carry capability tags). We append the action link to MCP
  // activity rows after render.
  listEl.innerHTML = html;
  wireActivityClicks(listEl, { allowRegisterFromCwd: true });

  // Layer "Add to project…" alongside the per-row action set, but only
  // for MCP rows (Claude / Codex have no agent_id to hint with).
  const mcpRows = listEl.querySelectorAll('.sess[data-activity-id^="mcp:"]');
  mcpRows.forEach(row => {
    const id = row.getAttribute('data-activity-id');
    const agentId = id.replace(/^mcp:/, '');
    const actions = row.querySelector('.sess-actions');
    const link = `<a data-act="add-to-project" data-agent="${escapeHtml(agentId)}">Add to project…</a>`;
    if (actions) {
      actions.insertAdjacentHTML('beforeend', ' ' + link);
    } else {
      row.insertAdjacentHTML('beforeend', `<div class="sess-actions">${link}</div>`);
    }
  });
  listEl.querySelectorAll('.sess-actions a[data-act="add-to-project"]').forEach(a => {
    a.addEventListener('click', ev => {
      ev.stopPropagation();
      const agent = a.getAttribute('data-agent');
      openAddAgentToProjectModal(agent);
    });
  });
}

/**
 * "Register project from this cwd" click handler. Confirms the
 * canonicalized target with the user (prevents accidental clicks from
 * polluting the registry), then calls the IPC channel and refreshes.
 *
 * The Unassigned bucket the user is currently viewing scopes the
 * db_path: if they're drilling into the bucket for ~/.cairn/cairn.db,
 * the new project goes into that DB. Without that pin, multi-DB users
 * would land on whichever DB the IPC layer picked as default, which
 * may not be the one they were looking at.
 */
async function handleRegisterFromCwdClick(cwd) {
  const dbPath = selectedUnassignedDbPath || null;
  // Single confirmation step. We want this near-frictionless ("一键")
  // but not silent — the user just clicked an action that mutates the
  // registry, so a one-line "register?" prompt is the floor.
  const proceed = window.confirm(
    `Register a new Cairn project at:\n\n${cwd}\n\n` +
    `(canonicalized to git toplevel if applicable; cwd ⊆ project_root attribution)`
  );
  if (!proceed) return;

  let res;
  try {
    res = await window.cairn.registerProjectFromCwd(cwd, dbPath);
  } catch (e) {
    res = { ok: false, error: e && e.message };
  }

  const footer = document.getElementById('footer');
  if (res && res.ok) {
    footer.textContent = `registered project "${res.entry.label}" at ${res.entry.project_root}`;
    footer.classList.remove('bad');
    setTimeout(() => {
      footer.textContent = 'read-only · polling 1s · Cairn project control surface';
    }, 4000);
    poll().catch(() => {});
    return;
  }

  // Friendly errors: already_registered carries the existing entry so
  // the user knows the cwd isn't going unregistered, just consolidated.
  if (res && res.error === 'already_registered' && res.entry) {
    footer.textContent =
      `already registered as "${res.entry.label}" — refresh to see it on the project list`;
    footer.classList.add('bad');
    setTimeout(() => {
      footer.textContent = 'read-only · polling 1s · Cairn project control surface';
      footer.classList.remove('bad');
    }, 4000);
    poll().catch(() => {});
    return;
  }
  footer.textContent = `register failed: ${(res && res.error) || 'unknown'}`;
  footer.classList.add('bad');
  setTimeout(() => {
    footer.textContent = 'read-only · polling 1s · Cairn project control surface';
    footer.classList.remove('bad');
  }, 4000);
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
// Worker Reports renderer (Phase 3)
// ---------------------------------------------------------------------------
//
// Reports come from the user pasting an agent's structured summary
// into the Add modal, OR from a friendly agent calling the
// add-worker-report IPC. The Reports tab lists the most recent ones,
// newest-first; click a row to expand its sections inline.

let lastReports = [];
const expandedReportIds = new Set();

function renderReports(reports) {
  lastReports = Array.isArray(reports) ? reports : [];
  const el = document.getElementById('reports-list');
  if (!lastReports.length) {
    el.innerHTML = '<div class="placeholder">no reports yet — paste an agent\'s "what I did / what\'s left / blockers" summary via Add report.</div>';
    return;
  }
  el.innerHTML = lastReports.map(r => renderReportCard(r)).join('');
  el.querySelectorAll('.report').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-report-id');
      if (expandedReportIds.has(id)) expandedReportIds.delete(id);
      else expandedReportIds.add(id);
      renderReports(lastReports);
    });
  });
}

function renderReportCard(r) {
  const expanded = expandedReportIds.has(r.id);
  const sourceChip = r.source_app
    ? `<span class="report-source">${escapeHtml(r.source_app)}</span>` : '';
  const needsHumanChip = r.needs_human
    ? `<span class="report-needs-human">needs human</span>` : '';
  const counts =
    `done ${r.completed.length} · ` +
    `remaining ${r.remaining.length} · ` +
    `blockers ${r.blockers.length} · ` +
    `next ${r.next_steps.length}`;
  const sections = expanded
    ? renderReportSections(r)
    : '';
  return (
    `<div class="report" data-report-id="${escapeHtml(r.id)}">` +
      `<div class="report-line1">` +
        `<span class="report-title">${escapeHtml(r.title)}</span>` +
        sourceChip +
        needsHumanChip +
        `<span class="report-meta">${escapeHtml(relTimeMs(r.created_at))}</span>` +
      `</div>` +
      `<div class="report-counts">${counts}</div>` +
      sections +
    `</div>`
  );
}

function renderReportSections(r) {
  const blocks = [];
  function bullets(arr) {
    return '<ul>' + arr.map(x => `<li>${escapeHtml(x)}</li>`).join('') + '</ul>';
  }
  if (r.completed.length) {
    blocks.push(`<div class="report-section"><div class="head">COMPLETED</div>${bullets(r.completed)}</div>`);
  }
  if (r.remaining.length) {
    blocks.push(`<div class="report-section"><div class="head">REMAINING</div>${bullets(r.remaining)}</div>`);
  }
  if (r.blockers.length) {
    blocks.push(`<div class="report-section"><div class="head">BLOCKERS</div>${bullets(r.blockers)}</div>`);
  }
  if (r.next_steps.length) {
    blocks.push(`<div class="report-section"><div class="head">NEXT STEPS</div>${bullets(r.next_steps)}</div>`);
  }
  if (Array.isArray(r.related_task_ids) && r.related_task_ids.length) {
    blocks.push(
      `<div class="report-section"><div class="head">RELATED TASKS</div>` +
      r.related_task_ids.map(t => `<code style="margin-right:6px">${escapeHtml(t)}</code>`).join('') +
      `</div>`
    );
  }
  return blocks.join('');
}

function setupReportsTab() {
  const addLink   = document.getElementById('reports-add-link');
  const clearLink = document.getElementById('reports-clear-link');
  if (addLink)   addLink.addEventListener('click', () => openAddReportModal());
  if (clearLink) clearLink.addEventListener('click', async () => {
    if (!selectedProject) return;
    const proceed = window.confirm('Clear ALL worker reports for this project? (the file is removed; cannot be undone)');
    if (!proceed) return;
    await window.cairn.clearWorkerReports(selectedProject.id);
    poll().catch(() => {});
  });
}

function openAddReportModal() {
  if (!selectedProject) return;
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl  = document.getElementById('modal-body');
  titleEl.textContent = 'Add worker report';
  bodyEl.innerHTML =
    `<div class="goal-form">` +
      `<label>Paste the agent's summary <span class="goal-form-hint">(markdown sections recognized: Completed / Remaining / Blockers / Next steps)</span></label>` +
      `<textarea id="report-form-text" rows="14" placeholder="# Title here\nsource: claude-code\n\n## Completed\n- did A\n\n## Blockers\n- waiting for X\n\nneeds_human: yes"></textarea>` +
      `<div class="goal-form-actions">` +
        `<button id="report-form-save" type="button">Save</button>` +
      `</div>` +
    `</div>`;
  overlay.classList.add('open');
  setTimeout(() => {
    const t = document.getElementById('report-form-text');
    if (t) t.focus();
  }, 50);

  document.getElementById('report-form-save').addEventListener('click', async () => {
    const text = document.getElementById('report-form-text').value;
    if (!text || !text.trim()) {
      const err = document.getElementById('footer');
      err.textContent = 'paste something into the report body first';
      err.classList.add('bad');
      setTimeout(() => {
        err.textContent = 'read-only · polling 1s · Cairn project control surface';
        err.classList.remove('bad');
      }, 3000);
      return;
    }
    const res = await window.cairn.addWorkerReport(selectedProject.id, { text });
    if (res && res.ok) {
      closeModal();
      poll().catch(() => {});
    } else {
      const err = document.getElementById('footer');
      err.textContent = `addWorkerReport failed: ${(res && res.error) || 'unknown'}`;
      err.classList.add('bad');
    }
  });
}

// ---------------------------------------------------------------------------
// Coordination tab renderer (kernel primitives — scratchpad, conflicts,
// coordination signals)
// ---------------------------------------------------------------------------
//
// Three sections in one tab:
//   1. Top coordination signals (with copy-prompt actions per row)
//   2. Handoff context = scratchpad entries
//   3. Conflicts
//
// Cairn never auto-resolves / dispatches / rewinds. Every action is
// "copy <kind> prompt" pointing at the user's own coding agent.

let lastCoordSignals = null;
let lastScratchpad = [];
let lastConflicts = [];

function renderCoordSignalsList(coord) {
  lastCoordSignals = coord || null;
  const el = document.getElementById('coord-signals-list');
  if (!el) return;
  if (!coord || !coord.signals || !coord.signals.length) {
    el.innerHTML = '<div class="placeholder">No coordination signals yet — fresh project or quiet period.</div>';
    return;
  }
  el.innerHTML = coord.signals.map(s => {
    const sev = s.severity || 'info';
    const action = s.prompt_action
      ? renderSignalActionLink(s)
      : '';
    return (
      `<div class="coord-signal">` +
        `<span class="coord-signal-sev ${escapeHtml(sev)}">${escapeHtml(sev.toUpperCase())}</span>` +
        `<span class="coord-signal-text">${escapeHtml(s.title)}` +
          (s.detail ? `<span class="detail">${escapeHtml(s.detail)}</span>` : '') +
        `</span>` +
        `<span class="coord-signal-action">${action}</span>` +
      `</div>`
    );
  }).join('');
  // Wire each signal's action.
  el.querySelectorAll('.coord-signal-action a[data-act]').forEach(a => {
    a.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const act = a.getAttribute('data-act');
      const taskId = a.getAttribute('data-task-id') || null;
      const conflictId = a.getAttribute('data-conflict-id') || null;
      await handleCoordAction(act, { task_id: taskId, conflict_id: conflictId });
    });
  });
}

function renderSignalActionLink(s) {
  const r = s.related || {};
  switch (s.prompt_action) {
    case 'copy_handoff_prompt':
      return `<a data-act="copy_handoff_prompt" data-task-id="${escapeHtml(r.task_id || '')}">copy handoff</a>`;
    case 'copy_recovery_prompt':
      return `<a data-act="copy_recovery_prompt" data-task-id="${escapeHtml(r.task_id || '')}">copy recovery</a>`;
    case 'copy_review_prompt':
      return `<a data-act="copy_review_prompt" data-task-id="${escapeHtml(r.task_id || '')}">copy review</a>`;
    case 'copy_conflict_prompt':
      return `<a data-act="copy_conflict_prompt" data-conflict-id="${escapeHtml(r.conflict_id || '')}">copy conflict</a>`;
    default: return '';
  }
}

async function handleCoordAction(action, related) {
  if (!selectedProject) return;
  const r = related || {};
  let res;
  try {
    if (action === 'copy_handoff_prompt') {
      res = await window.cairn.getHandoffPrompt(selectedProject.id, { task_id: r.task_id || null });
    } else if (action === 'copy_recovery_prompt') {
      res = await window.cairn.getRecoveryPrompt(selectedProject.id, { task_id: r.task_id || null });
    } else if (action === 'copy_review_prompt') {
      res = await window.cairn.getReviewPrompt(selectedProject.id, r.task_id || null);
    } else if (action === 'copy_conflict_prompt') {
      res = await window.cairn.getConflictPrompt(selectedProject.id, r.conflict_id || null);
    }
  } catch (e) { res = { ok: false, error: e && e.message }; }
  if (res && res.ok && res.prompt) {
    try { await navigator.clipboard.writeText(res.prompt); }
    catch (_e) { /* clipboard unavailable */ }
    flashFooter(`copied ${action.replace('copy_', '').replace('_prompt', '')} prompt`);
  } else {
    flashFooter(`prompt failed: ${(res && res.error) || 'unknown'}`, true);
  }
}

function flashFooter(msg, bad) {
  const footer = document.getElementById('footer');
  footer.textContent = msg;
  if (bad) footer.classList.add('bad'); else footer.classList.remove('bad');
  setTimeout(() => {
    footer.textContent = 'read-only · polling 1s · Cairn project control surface';
    footer.classList.remove('bad');
  }, 3000);
}

function renderScratchpadList(rows) {
  lastScratchpad = Array.isArray(rows) ? rows : [];
  const el = document.getElementById('coord-scratchpad-list');
  if (!el) return;
  if (!lastScratchpad.length) {
    el.innerHTML = '<div class="placeholder">No shared context recorded yet. Ask an agent to write a worker report or scratchpad note before handoff.</div>';
    return;
  }
  el.innerHTML = lastScratchpad.map(sp => {
    const ageTxt = sp.updated_at ? relTimeMs(sp.updated_at) : '?';
    const sizeTxt = sp.value_size != null ? `${sp.value_size}B` : '—';
    const taskBit = sp.task_id
      ? `task ${escapeHtml(sp.task_id)}${sp.task_intent ? ' · ' + escapeHtml(sp.task_intent.slice(0, 60)) : ''}${sp.task_state ? ' · ' + escapeHtml(sp.task_state) : ''}`
      : 'no task';
    const previewBit = sp.value_preview
      ? `<div class="coord-scratch-preview">${escapeHtml(sp.value_preview)}</div>`
      : '';
    return (
      `<div class="coord-scratch" data-key="${escapeHtml(sp.key)}">` +
        `<div class="coord-scratch-head">` +
          `<span class="coord-scratch-key">${escapeHtml(sp.key)}</span>` +
          `<span class="coord-scratch-meta">${escapeHtml(ageTxt)}</span>` +
          `<span class="coord-scratch-size">${escapeHtml(sizeTxt)}</span>` +
        `</div>` +
        `<div class="coord-scratch-task">${taskBit}</div>` +
        previewBit +
        `<div class="coord-scratch-actions">` +
          `<a data-act="copy-key">copy key</a>` +
          (sp.value_preview ? `<a data-act="copy-preview">copy preview</a>` : '') +
        `</div>` +
      `</div>`
    );
  }).join('');

  el.querySelectorAll('.coord-scratch').forEach(card => {
    card.querySelectorAll('a[data-act]').forEach(a => {
      a.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const act = a.getAttribute('data-act');
        const key = card.getAttribute('data-key');
        const sp = lastScratchpad.find(x => x.key === key);
        if (!sp) return;
        const text = act === 'copy-key' ? sp.key : (sp.value_preview || '');
        try {
          await navigator.clipboard.writeText(text);
          const orig = a.textContent;
          a.textContent = 'copied';
          setTimeout(() => { a.textContent = orig; }, 1200);
        } catch (_e) {}
      });
    });
  });
}

function renderConflictsList(rows) {
  lastConflicts = Array.isArray(rows) ? rows : [];
  const el = document.getElementById('coord-conflicts-list');
  if (!el) return;
  if (!lastConflicts.length) {
    el.innerHTML = '<div class="placeholder">No conflicts.</div>';
    return;
  }
  el.innerHTML = lastConflicts.map(c => {
    const ageTxt = c.detected_at ? relTimeMs(c.detected_at) : '?';
    const partyB = c.agent_b ? ` ↔ ${escapeHtml(c.agent_b)}` : '';
    const pathBit = (c.paths && c.paths.length)
      ? `<div class="coord-conflict-paths">paths: ${c.paths.slice(0, 4).map(p => `<code>${escapeHtml(p)}</code>`).join(' · ')}${c.paths.length > 4 ? ` +${c.paths.length - 4} more` : ''}</div>`
      : '';
    const summaryBit = c.summary
      ? `<div class="coord-conflict-paths" style="color:#aab">${escapeHtml(c.summary)}</div>`
      : '';
    const isOpen = c.status === 'OPEN' || c.status === 'PENDING_REVIEW';
    const actions = isOpen
      ? `<div class="coord-conflict-actions">` +
          `<a data-act="copy_conflict_prompt" data-conflict-id="${escapeHtml(c.id)}">copy conflict prompt</a>` +
          (c.paths && c.paths.length ? `<a data-act="copy-paths" data-conflict-id="${escapeHtml(c.id)}">copy affected paths</a>` : '') +
        `</div>`
      : '';
    return (
      `<div class="coord-conflict" data-conflict-id="${escapeHtml(c.id)}">` +
        `<div class="coord-conflict-head">` +
          `<span class="coord-conflict-status ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>` +
          `<span class="coord-conflict-title">${escapeHtml(c.conflict_type)} — ${escapeHtml(c.agent_a)}${partyB}</span>` +
          `<span class="coord-conflict-meta">${escapeHtml(ageTxt)}</span>` +
        `</div>` +
        summaryBit +
        pathBit +
        actions +
      `</div>`
    );
  }).join('');

  el.querySelectorAll('.coord-conflict-actions a[data-act]').forEach(a => {
    a.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const act = a.getAttribute('data-act');
      const conflictId = a.getAttribute('data-conflict-id');
      if (act === 'copy_conflict_prompt') {
        await handleCoordAction('copy_conflict_prompt', { conflict_id: conflictId });
      } else if (act === 'copy-paths') {
        const c = lastConflicts.find(x => x.id === conflictId);
        if (c && Array.isArray(c.paths)) {
          try { await navigator.clipboard.writeText(c.paths.join('\n')); }
          catch (_e) {}
          flashFooter('copied affected paths');
        }
      }
    });
  });
}

// Coordination hero strip on L2 — top 3 signals + jump-to-tab action.
let coordStripExpanded = false;

function renderCoordinationStrip(coord) {
  const strip = document.getElementById('coord-strip');
  if (!strip) return;
  if (!coord || !coord.signals || coord.signals.length === 0) {
    strip.hidden = true;
    return;
  }
  // For coordination_level === 'ok' with only `info` signals (e.g.
  // recovery_available), keep the strip subtle but visible — the
  // user benefits from knowing they have anchors.
  strip.hidden = false;
  const level = coord.coordination_level || 'ok';
  strip.classList.remove('coord-ok', 'coord-watch', 'coord-attention');
  strip.classList.add('coord-' + level);
  document.getElementById('coord-strip-dot').className = 'coord-strip-dot ' + level;
  document.getElementById('coord-strip-level').textContent = level.toUpperCase();
  // Headline: top 1 signal title or "no issues to coordinate".
  const top = coord.signals[0] || null;
  document.getElementById('coord-strip-headline').textContent =
    top ? top.title : 'no issues to coordinate';

  const detailEl = document.getElementById('coord-strip-top');
  if (coordStripExpanded) {
    detailEl.hidden = false;
    detailEl.innerHTML = coord.signals.slice(0, 3).map(s => {
      const sev = s.severity || 'info';
      const action = s.prompt_action ? renderSignalActionLink(s) : '';
      return (
        `<div class="strip-row">` +
          `<span class="strip-dot ${escapeHtml(sev)}">●</span>` +
          `<span class="strip-title">${escapeHtml(s.title)}</span>` +
          `<span class="strip-action">${action}</span>` +
        `</div>`
      );
    }).join('');
    detailEl.querySelectorAll('.strip-action a[data-act]').forEach(a => {
      a.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const act = a.getAttribute('data-act');
        const taskId = a.getAttribute('data-task-id') || null;
        const conflictId = a.getAttribute('data-conflict-id') || null;
        await handleCoordAction(act, { task_id: taskId, conflict_id: conflictId });
      });
    });
  } else {
    detailEl.hidden = true;
    detailEl.innerHTML = '';
  }

  if (!strip._wired) {
    document.getElementById('coord-strip-show-all').addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Click "show all" jumps to the Coordination tab AND expands the
      // inline preview so the strip stays glance-able afterwards.
      coordStripExpanded = true;
      setActiveTab('coord');
      poll().catch(() => {});
    });
    document.getElementById('coord-strip-line').addEventListener('click', (ev) => {
      // Clicking anywhere else on the strip toggles the inline preview.
      if (ev.target.closest('#coord-strip-show-all')) return;
      coordStripExpanded = !coordStripExpanded;
      poll().catch(() => {});
    });
    strip._wired = true;
  }
}

function setupCoordinationTab() {
  const handoffLink = document.getElementById('coord-handoff-prompt-link');
  if (handoffLink) handoffLink.addEventListener('click', async () => {
    if (!selectedProject) return;
    let res;
    try {
      res = await window.cairn.getHandoffPrompt(selectedProject.id, { include_context: true });
    } catch (e) { res = { ok: false, error: e && e.message }; }
    if (res && res.ok && res.prompt) {
      try { await navigator.clipboard.writeText(res.prompt); } catch (_e) {}
      flashFooter('copied handoff prompt');
    } else {
      flashFooter(`handoff prompt failed: ${(res && res.error) || 'unknown'}`, true);
    }
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
    runlog:   document.getElementById('view-runlog'),
    tasks:    document.getElementById('view-tasks'),
    sessions: document.getElementById('view-sessions'),
    reports:  document.getElementById('view-reports'),
    coord:    document.getElementById('view-coord'),
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
  // Agents row shows MCP and Claude counts side by side when any Claude
  // session attributes here. Format: "agents MCP X (+Y stale) · Claude B/I"
  // — dropping the Claude segment entirely when claude_total is 0 keeps
  // the card uncluttered for users without Claude.
  // Activity-layer headline (Phase 2): the L1 card leads with the
  // unified counts in product language. Per-source split keeps showing
  // below as a secondary line so power users still see what the
  // composition is. The legacy claude_*/codex_* fields are still
  // populated by main.cjs for that breakdown.
  const aa = s.agent_activity || null;
  const fam = aa ? aa.by_family : null;
  let agentsCell;
  if (fam) {
    agentsCell =
      `agents ` +
      `${countCell(fam.live, fam.live > 0 ? '' : 'idle')} live` +
      `<span class="sep">·</span>${countCell(fam.recent, fam.recent > 0 ? '' : 'idle')} recent` +
      `<span class="sep">·</span>${countCell(fam.inactive, 'idle')} inactive` +
      (fam.dead ? `<span class="sep">·</span>${countCell(fam.dead, 'alert')} dead` : '');
  } else {
    // Legacy fallback for any caller that hasn't migrated yet.
    agentsCell = `agents MCP ${countCell(s.agents_active, 'idle')}`;
  }
  // Per-source split as a quieter second line — keeps source identity
  // visible without burying the headline.
  const claudeTotal = s.claude_total || 0;
  const codexTotal  = s.codex_total  || 0;
  const sourceParts = [`MCP ${s.agents_active || 0}`];
  if (claudeTotal > 0)  sourceParts.push(`Claude ${(s.claude_busy || 0) + (s.claude_idle || 0)}`);
  if (codexTotal > 0)   sourceParts.push(`Codex ${(s.codex_recent || 0)}`);
  const sourceSplit = aa
    ? `<div style="color:#666;font-size:0.85em;margin-top:1px">by source: ${sourceParts.join(' · ')}</div>`
    : '';
  const counts =
    agentsCell +
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
      sourceSplit +
      `<div class="pcard-actions">` +
        `<a data-action="rename" data-project-id="${escapeHtml(p.id)}">rename</a>` +
        `<a data-action="remove" data-project-id="${escapeHtml(p.id)}">remove</a>` +
      `</div>` +
    `</div>`
  );
}

function renderUnassignedCard(u) {
  const total = u.total_rows || 0;
  const aa = u.agent_activity || null;
  const fam = aa ? aa.by_family : null;
  let agentsCell;
  if (fam) {
    agentsCell =
      `agents ${countCell(fam.live, fam.live > 0 ? '' : 'idle')} live` +
      `<span class="sep">·</span>${countCell(fam.recent, fam.recent > 0 ? '' : 'idle')} recent` +
      `<span class="sep">·</span>${countCell(fam.inactive, 'idle')} inactive` +
      (fam.dead ? `<span class="sep">·</span>${countCell(fam.dead, 'alert')} dead` : '');
  } else {
    agentsCell = `agents MCP ${u.agents || 0}`;
  }
  const sub =
    agentsCell +
    `<span class="sep">·</span>tasks ${u.tasks}` +
    `<span class="sep">·</span>block ${u.blockers}` +
    `<span class="sep">·</span>outcome ${u.outcomes}` +
    `<span class="sep">·</span>ckpt ${u.checkpoints}` +
    `<span class="sep">·</span>conflict ${u.conflicts}` +
    `<span class="sep">·</span>disp ${u.dispatches}`;
  // Per-source breakdown remains visible as a quieter second line.
  const claudeTotal = u.claude_total || 0;
  const codexTotal  = u.codex_total  || 0;
  const sourceParts = [`MCP ${u.agents || 0}`];
  if (claudeTotal > 0) sourceParts.push(`Claude ${(u.claude_busy || 0) + (u.claude_idle || 0)}`);
  if (codexTotal > 0)  sourceParts.push(`Codex ${(u.codex_recent || 0)}`);
  const sourceSplit = aa
    ? `<div style="color:#666;font-size:0.85em;margin-top:1px;margin-left:24px">by source: ${sourceParts.join(' · ')}</div>`
    : '';
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
      sourceSplit +
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
      const pulseP   = window.cairn.getProjectPulse();
      const goalP    = selectedProject
        ? window.cairn.getProjectGoal(selectedProject.id)
        : Promise.resolve(null);
      const rulesP   = selectedProject
        ? window.cairn.getEffectiveProjectRules(selectedProject.id)
        : Promise.resolve(null);
      const interpP  = selectedProject
        ? window.cairn.getGoalInterpretation(selectedProject.id)
        : Promise.resolve(null);
      const gateP    = selectedProject
        ? window.cairn.getPrePrGate(selectedProject.id)
        : Promise.resolve(null);
      const packP    = selectedProject
        ? window.cairn.getPromptPack(selectedProject.id)
        : Promise.resolve(null);
      const recoveryP = selectedProject
        ? window.cairn.getProjectRecovery(selectedProject.id)
        : Promise.resolve(null);
      const managedRecordP = selectedProject
        ? window.cairn.getManagedProjectProfile(selectedProject.id)
        : Promise.resolve(null);
      const managedItersP = selectedProject
        ? window.cairn.listManagedIterations(selectedProject.id, 1)
        : Promise.resolve(null);
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
      const reportsP = activeTab === 'reports' && selectedProject
        ? window.cairn.listWorkerReports(selectedProject.id, 50)
        : Promise.resolve(null);
      // Coordination tab fetches three things in parallel; we always
      // fetch coordination signals so the L2 coordination strip
      // (Phase 4 hero strip) can show top signals even when the tab
      // is not visible.
      const coordSignalsP = selectedProject
        ? window.cairn.getCoordinationSignals(selectedProject.id)
        : Promise.resolve(null);
      const coordScratchP = activeTab === 'coord' && selectedProject
        ? window.cairn.getProjectScratchpad(selectedProject.id, 30)
        : Promise.resolve(null);
      const coordConflictsP = activeTab === 'coord' && selectedProject
        ? window.cairn.getProjectConflicts(selectedProject.id, 30)
        : Promise.resolve(null);
      const detailP = selectedTaskId
        ? window.cairn.getTaskDetail(selectedTaskId)
        : Promise.resolve(null);
      const ckptsP = selectedTaskId
        ? window.cairn.getTaskCheckpoints(selectedTaskId)
        : Promise.resolve(null);

      const [summary, pulse, goal, rules, interp, gate, pack, recovery, managedRecord, managedIters, coordSig, coordScratch, coordConflicts, _dbPath, events, tasks, sessions, reports, detail, ckpts] = await Promise.all([
        summaryP, pulseP, goalP, rulesP, interpP, gateP, packP, recoveryP,
        managedRecordP, managedItersP,
        coordSignalsP, coordScratchP, coordConflictsP,
        dbPathP, eventsP, tasksP, sessionsP, reportsP, detailP, ckptsP,
      ]);

      renderHeaderForView();
      renderGoalCard(goal);
      renderRulesCard(rules);
      renderInterpretation(interp);
      renderPrePrGate(gate);
      renderPromptPack(pack);
      renderRecoveryCard(recovery);
      renderManagedCard(managedRecord, (managedIters && managedIters[0]) || null);
      renderCoordinationStrip(coordSig);
      renderPulse(pulse);
      renderSummary(summary);
      // Coordination tab body — always render signals so the tab is
      // not blank when first opened; scratchpad / conflicts only
      // render when the tab is active to save IPC.
      renderCoordSignalsList(coordSig);
      if (coordScratch) renderScratchpadList(coordScratch);
      if (coordConflicts) renderConflictsList(coordConflicts);

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
      if (reports) renderReports(reports);
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
setupGoalCard();
setupRulesCard();
setupInterpretationCard();
setupPrePrGateCard();
setupPromptPack();
setupRecoveryCard();
setupManagedCard();
setupReportsTab();
setupCoordinationTab();
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
