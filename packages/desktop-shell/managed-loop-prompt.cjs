'use strict';

/**
 * Managed Loop Prompt — adapter that maps a managed-project record
 * + iteration + recent reports + evidence into the input shape the
 * existing goal-loop-prompt-pack consumes.
 *
 * Two reasons to keep this thin:
 *   1. goal-loop-prompt-pack is a stable, well-tested module. We
 *      don't want to change its contract for managed mode.
 *   2. The "managed" framing is just an extra section appended to
 *      the prompt — the rest (goal / rules / non_goals / floor
 *      checklist) is identical to the in-repo goal loop.
 *
 * No I/O. Caller composes the inputs, this adapter glues them.
 */

const promptPack = require('./goal-loop-prompt-pack.cjs');

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Build the "managed context block" that gets injected into the
 * prompt as an extra header section. This is the only difference from
 * the in-repo goal loop: the agent is told this is a managed external
 * repo, with a stated local path, package manager, and detected
 * commands.
 *
 * Privacy: we include the BASENAME of the local path (not full path)
 * so the prompt doesn't leak a user-specific home directory layout.
 * Repo URL is included verbatim because the user typed it.
 */
function buildManagedContextBlock(record, iterationId) {
  const r = record || {};
  const profile = r.profile || {};
  const pathBase = r.local_path ? r.local_path.replace(/\\/g, '/').split('/').filter(Boolean).pop() : '(unknown)';
  const lines = [];
  lines.push(`Repo: ${clip(r.repo_url || '(local-only)', 200)}`);
  lines.push(`Local path basename: ${clip(pathBase, 80)}`);
  if (r.default_branch) lines.push(`Default branch: ${clip(r.default_branch, 80)}`);
  if (profile.package_manager) lines.push(`Package manager: ${profile.package_manager}`);
  if (profile.languages && profile.languages.length) {
    lines.push(`Languages: ${profile.languages.slice(0, 6).join(', ')}`);
  }
  if (profile.test_commands && profile.test_commands.length) {
    lines.push(`Detected test commands:`);
    for (const c of profile.test_commands.slice(0, 3)) lines.push(`  - ${c}`);
  }
  if (profile.build_commands && profile.build_commands.length) {
    lines.push(`Detected build commands:`);
    for (const c of profile.build_commands.slice(0, 3)) lines.push(`  - ${c}`);
  }
  if (profile.lint_commands && profile.lint_commands.length) {
    lines.push(`Detected lint commands:`);
    for (const c of profile.lint_commands.slice(0, 3)) lines.push(`  - ${c}`);
  }
  if (profile.docs && profile.docs.length) {
    lines.push(`Docs to skim: ${profile.docs.slice(0, 5).join(', ')}`);
  }
  if (iterationId) lines.push(`Cairn iteration id: ${clip(iterationId, 40)}`);
  return lines.join('\n');
}

/**
 * Wrap deterministicPack output with a managed-context preamble.
 *
 * We intentionally do NOT pass the managed context to the LLM rewrite
 * step — the LLM should not be tempted to hallucinate test commands
 * or rename detected scripts. The deterministic block is appended
 * last and is verbatim.
 */
function generateManagedPrompt(input, opts) {
  const o = opts || {};
  const det = promptPack.deterministicPack(input, { now: o.now, title: o.title });
  const managedRecord = o.managed_record;
  const managedBlock = buildManagedContextBlock(managedRecord, o.iteration_id);

  // Splice: inject `# Managed project` section between Goal and
  // Context summary. Caller can reorder by passing `block_position:'top'`.
  const inject = ['', '# Managed project', managedBlock, ''];
  const lines = det.prompt.split('\n');
  const goalIdx = lines.indexOf('# Goal');
  const ctxIdx = lines.indexOf('# Context summary');
  let merged;
  if (goalIdx >= 0 && ctxIdx > goalIdx) {
    merged = lines.slice(0, ctxIdx).concat(inject).concat(lines.slice(ctxIdx));
  } else {
    merged = inject.concat(lines);
  }

  return Object.assign({}, det, {
    prompt: merged.join('\n'),
    sections: Object.assign({}, det.sections, { managed_context: managedBlock }),
    is_managed: true,
    managed: {
      project_id:    managedRecord && managedRecord.project_id,
      repo_url:      managedRecord && managedRecord.repo_url,
      iteration_id:  o.iteration_id || null,
    },
  });
}

module.exports = {
  buildManagedContextBlock,
  generateManagedPrompt,
};
