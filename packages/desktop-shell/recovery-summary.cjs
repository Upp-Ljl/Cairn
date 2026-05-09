'use strict';

/**
 * Recovery surface (UI hardening — round 2).
 *
 * Cairn's kernel layer has had checkpoint / rewind primitives since
 * W1, but the panel never surfaced them — users couldn't tell whether
 * a project was recoverable. This module derives a Recovery Card
 * payload from the existing `checkpoints` rows (read-only) and
 * composes a copy-pasteable advisory prompt the user can hand to a
 * coding agent for an inspection-and-rewind workflow.
 *
 * Hard product boundary (PRODUCT.md §1.3 #4 / §6.4.5):
 *   - The panel does NOT execute rewind.
 *   - The panel exposes copy-prompt actions only.
 *   - The prompt itself instructs the agent to "inspect the
 *     checkpoint and, if appropriate, rewind to it" and explicitly
 *     forbids executing rewind without confirming the boundary.
 *
 * Pure module — no I/O.
 */

const STR_TITLE_MAX  = 200;
const STR_LABEL_MAX  = 80;

const RECENT_READY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h: "good" threshold

// ---------------------------------------------------------------------------
// Project-level recovery summary
// ---------------------------------------------------------------------------

/**
 * Build the Recovery Card payload for a project.
 *
 * @param {object[]} checkpoints  rows from queryProjectScopedCheckpoints
 *                                (already sorted ready_at DESC)
 * @param {object} [opts]         { now }
 * @returns {{
 *   confidence: 'good' | 'limited' | 'none',
 *   confidence_reason: string,
 *   counts: { ready:number, pending:number, corrupted:number, total:number },
 *   last_ready: object|null,
 *   safe_anchors: object[],
 *   latest_task_checkpoint: object|null,
 *   ts: number,
 * }}
 */
function deriveProjectRecovery(checkpoints, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const list = Array.isArray(checkpoints) ? checkpoints : [];

  const counts = { ready: 0, pending: 0, corrupted: 0, total: 0 };
  const ready = [];
  const pending = [];
  for (const c of list) {
    if (!c || !c.id) continue;
    counts.total++;
    const s = (c.snapshot_status || '').toUpperCase();
    if (s === 'READY')           { counts.ready++;     ready.push(c); }
    else if (s === 'PENDING')    { counts.pending++;   pending.push(c); }
    else if (s === 'CORRUPTED')  { counts.corrupted++; }
  }

  const lastReady = ready.length ? ready[0] : null;
  const lastReadyAt = lastReady && (lastReady.ready_at || lastReady.created_at);
  const lastReadyAgeMs = lastReadyAt ? Math.max(0, now - lastReadyAt) : null;

  let confidence;
  let confidence_reason;
  if (counts.total === 0) {
    confidence = 'none';
    confidence_reason = 'No checkpoints recorded for this project. Ask an agent (or the kernel layer) to create one before risky work.';
  } else if (lastReady && lastReadyAgeMs != null && lastReadyAgeMs <= RECENT_READY_WINDOW_MS) {
    confidence = 'good';
    confidence_reason = `Recent READY checkpoint available (${counts.ready} ready / ${counts.total} total).`;
  } else if (counts.ready > 0) {
    confidence = 'limited';
    confidence_reason = `Only older READY checkpoints (${counts.ready} ready / ${counts.total} total). Newer state may be unrecoverable.`;
  } else if (counts.pending > 0) {
    confidence = 'limited';
    confidence_reason = `Only PENDING checkpoints (${counts.pending} / ${counts.total} total). Snapshots haven't materialized yet.`;
  } else {
    confidence = 'none';
    confidence_reason = `${counts.corrupted} corrupted checkpoint(s); no usable anchor.`;
  }

  // Safe anchors: top 3 READY, then top 1 PENDING (so the user sees
  // pending-soon-to-be-ready). Each anchor stripped of size noise the
  // panel doesn't need.
  const safe_anchors = [];
  for (const c of ready.slice(0, 3)) safe_anchors.push(_anchorView(c));
  if (pending.length > 0 && safe_anchors.length < 4) {
    safe_anchors.push(_anchorView(pending[0]));
  }

  // Latest *task* checkpoint: the freshest checkpoint with a non-null
  // task_id (which all of them have for project-scoped lists, by
  // construction). Surface its task intent so the Recovery Card can
  // say "Latest task checkpoint: T-001 RUNNING — auth refactor".
  const latest = list[0] || null;
  const latest_task_checkpoint = latest ? {
    task_id:    latest.task_id,
    task_intent: clip(latest.task_intent, STR_TITLE_MAX),
    task_state:  latest.task_state,
    checkpoint: _anchorView(latest),
  } : null;

  return {
    confidence,
    confidence_reason,
    counts,
    last_ready: lastReady ? _anchorView(lastReady) : null,
    safe_anchors,
    latest_task_checkpoint,
    ts: now,
  };
}

function _anchorView(c) {
  return {
    id:               c.id,
    id_short:         (c.id || '').slice(0, 12),
    label:            clip(c.label, STR_LABEL_MAX) || null,
    status:           c.snapshot_status || null,
    git_head:         c.git_head ? String(c.git_head).slice(0, 7) : null,
    size_bytes:       Number.isFinite(c.size_bytes) ? c.size_bytes : null,
    created_at:       c.created_at || null,
    ready_at:         c.ready_at || null,
    task_id:          c.task_id || null,
    task_intent:      clip(c.task_intent, STR_TITLE_MAX) || null,
    task_state:       c.task_state || null,
  };
}

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------------------
// Recovery prompt (advisory copy-pasteable text)
// ---------------------------------------------------------------------------
//
// Hard rules for the prompt text (smoke verifies these):
//   - never imperative-execute ("run rewind", "do rewind now")
//   - always include a confirmation step ("inspect first",
//     "confirm boundary", "do not push without authorization")
//   - never include API keys, raw stdout/stderr, transcripts
//   - never claim Cairn judges whether to rewind

function recoveryPromptForProject(input) {
  const o = input || {};
  const projectLabel = clip(o.project_label, STR_TITLE_MAX) || '(this project)';
  const summary = o.summary || null;
  const lines = [];

  lines.push(`You are a coding agent helping a user inspect Cairn's recovery anchors for ${projectLabel}.`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT execute rewind. Your job is to look, not to act.`);
  lines.push('');
  lines.push('# Current recovery state (from Cairn)');
  if (!summary) {
    lines.push('No recovery summary available. Refuse to rewind without one.');
  } else {
    lines.push(`Confidence: ${summary.confidence.toUpperCase()} — ${summary.confidence_reason}`);
    lines.push(`Counts: ${summary.counts.ready} READY · ${summary.counts.pending} PENDING · ${summary.counts.corrupted} CORRUPTED (${summary.counts.total} total).`);
    if (summary.last_ready) {
      const r = summary.last_ready;
      const labelPart = r.label ? `"${r.label}"` : '(no label)';
      const headPart = r.git_head ? ` @${r.git_head}` : '';
      lines.push(`Last READY anchor: ${r.id_short} ${labelPart}${headPart} for task ${r.task_id || '(none)'}.`);
    }
    if (summary.safe_anchors && summary.safe_anchors.length > 1) {
      lines.push('Other safe anchors:');
      for (const a of summary.safe_anchors.slice(1)) {
        lines.push(`  - ${a.id_short} ${a.label ? `"${a.label}" ` : ''}${a.git_head ? `@${a.git_head} ` : ''}(${a.status})`);
      }
    }
  }
  lines.push('');
  lines.push('# What to do');
  lines.push('1. Inspect the latest READY anchor. Report what it covers (paths, git_head, label).');
  lines.push('2. Compare it against the user\'s current goal. Note any gap.');
  lines.push('3. Recommend whether a rewind is appropriate. Do NOT execute the rewind without confirming the boundary with the user.');
  lines.push('4. If you do rewind, use Cairn\'s rewind primitives (cairn.rewind.preview / cairn.rewind.to). Never stash or force-push as a substitute.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not execute rewind without first showing the preview to the user.');
  lines.push('- Do not infer the user\'s intent from previous transcripts; ask if uncertain.');
  lines.push('- Treat Cairn\'s recovery summary as advisory; if it disagrees with what you observe, surface the disagreement, do not silently override.');

  return lines.join('\n');
}

function recoveryPromptForTask(input) {
  const o = input || {};
  const projectLabel = clip(o.project_label, STR_TITLE_MAX) || '(this project)';
  const taskId       = clip(o.task_id, STR_LABEL_MAX) || '(unknown task)';
  const taskIntent   = clip(o.task_intent, STR_TITLE_MAX) || '(no intent)';
  const taskState    = clip(o.task_state, 40) || '?';
  const ckpt         = o.checkpoint || null;
  const lines = [];

  lines.push(`You are a coding agent helping a user inspect a Cairn task checkpoint for ${projectLabel}.`);
  lines.push(`Task: ${taskId} (${taskState}) — ${taskIntent}`);
  lines.push(`Cairn is a project control surface (read-only); it does NOT execute rewind. Your job is to look, not to act.`);
  lines.push('');
  lines.push('# Anchor');
  if (!ckpt) {
    lines.push('No checkpoint provided. Refuse to rewind without one.');
  } else {
    const labelPart = ckpt.label ? `"${ckpt.label}"` : '(no label)';
    const headPart  = ckpt.git_head ? ` @${ckpt.git_head}` : '';
    lines.push(`Checkpoint id: ${ckpt.id_short} ${labelPart}${headPart}`);
    lines.push(`Status: ${ckpt.status || '?'}`);
    if (ckpt.created_at) lines.push(`Created at: ${new Date(ckpt.created_at).toISOString()}`);
    if (ckpt.ready_at)   lines.push(`Ready at:   ${new Date(ckpt.ready_at).toISOString()}`);
  }
  lines.push('');
  lines.push('# What to do');
  lines.push(`1. Inspect this checkpoint via Cairn's read tools (cairn.checkpoint.list / cairn.rewind.preview).`);
  lines.push('2. Compare its scope against the task\'s current state. Report any drift.');
  lines.push('3. Recommend rewind only if it actually recovers the work the user wants. Do NOT execute rewind without confirming the boundary.');
  lines.push('4. If rewind is appropriate, use cairn.rewind.to with the user\'s explicit approval. Never use git stash / git reset --hard / force-push as a substitute.');
  lines.push('');
  lines.push('# Hard rules');
  lines.push('- Do not push, merge, or force any branch unless the user explicitly authorizes.');
  lines.push('- Do not execute rewind without showing the preview first.');
  lines.push('- Treat the checkpoint label as a hint, not a contract — verify with the preview.');

  return lines.join('\n');
}

module.exports = {
  deriveProjectRecovery,
  recoveryPromptForProject,
  recoveryPromptForTask,
  RECENT_READY_WINDOW_MS,
};
