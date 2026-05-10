'use strict';

/**
 * Review Prompt Pack — Three-Stage Loop / Day 4.
 *
 * The Review stage is a read-only round whose only deliverable is a
 * deterministic verdict block. The reviewer agent looks at:
 *   - the candidate description (what was supposed to happen)
 *   - the worker's actual diff (what landed)
 *   - the worker's own report (what the worker said it did)
 * and answers: pass / fail / needs_human, with a one-sentence reason.
 *
 * Cairn does NOT decide candidate terminal state from this verdict.
 * The verdict is advisory data the user reads in the Day 5 panel
 * before clicking ACCEPT / REJECT / ROLLED_BACK manually.
 *
 * Source-of-truth for two literals:
 *   REVIEW_VERDICT_HEADER — '## Review Verdict'
 *   VERDICT_VALUES        — closed set; the parser (worker-launcher.cjs)
 *                           uses the same set for validation.
 */

const managedLoopPrompt = require('./managed-loop-prompt.cjs');
const workerPromptModule = require('./worker-prompt.cjs');

const REVIEW_VERDICT_HEADER = '## Review Verdict';
const VERDICT_VALUES = ['pass', 'fail', 'needs_human'];
const CANDIDATE_ECHO_PREFIX = workerPromptModule.CANDIDATE_ECHO_PREFIX; // 'cairn-candidate-id:'

const MAX_DIFF_EMBED = 16 * 1024;
const MAX_REASON_LEN = 200;

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function renderWorkerReportSection(report) {
  if (!report) return '(no Worker Report attached to this round)';
  const sec = (label, list) => {
    if (!Array.isArray(list) || list.length === 0) return `${label}:\n  (none)`;
    return `${label}:\n` + list.slice(0, 10).map(x => '  - ' + x).join('\n');
  };
  return [
    sec('Completed', report.completed),
    sec('Remaining', report.remaining),
    sec('Blockers',  report.blockers),
    sec('Next',      report.next_steps),
  ].join('\n\n');
}

function buildReviewHardRules(candidate, workerDiffText, workerDiffTruncated, workerReport) {
  const c = candidate || {};
  const id   = clip(c.id, 80) || '(missing)';
  const desc = clip(c.description, 240) || '(missing)';
  const kind = c.candidate_kind || 'other';
  let diff = (typeof workerDiffText === 'string') ? workerDiffText : '';
  if (diff.length > MAX_DIFF_EMBED) diff = diff.slice(0, MAX_DIFF_EMBED) + '\n...[diff truncated for prompt]';
  const truncatedNote = workerDiffTruncated
    ? '[NOTE: diff truncated to 16KB; see worker run dir for full output]\n'
    : '';
  const lines = [
    '# CAIRN REVIEW — READ-ONLY VERDICT ROUND',
    '',
    'You are launched by Cairn to review ONE candidate the user picked,',
    'and the diff a previous Worker run produced for it. Your only',
    'deliverable is a verdict block. Cairn parses your output',
    'deterministically; follow the format exactly.',
    '',
    'You are NOT a second Worker. Do not redo the work. Do not propose',
    'a different fix. Read what the Worker did; judge whether it',
    'addresses the candidate; emit one verdict.',
    '',
    'STRICT RULES — violating any means stop and emit a verdict block',
    'with verdict=needs_human and a reason explaining why:',
    '',
    '1. DO NOT modify, create, or delete any file in this repository.',
    '2. DO NOT run `git commit`, `git add`, `git push`, `git rebase`,',
    '   `git reset`, `git stash`. The Worker\'s diff stays in the',
    '   working tree; the user decides whether to commit or roll back.',
    '3. DO NOT run `npm/bun/pnpm/yarn install` or any installer.',
    '4. DO NOT modify Cairn itself.',
    '5. ONLY use Read / Glob / Grep / LS / Bash for read-only inspection.',
    '',
    'Candidate under review:',
    '  ' + CANDIDATE_ECHO_PREFIX + ' ' + id,
    '  description:    ' + desc,
    '  candidate_kind: ' + kind,
    '',
    '# What worker did',
    '',
    '## Worker diff (git diff --no-color, working tree vs HEAD)',
    truncatedNote +
    (diff ? diff : '(empty diff — worker made no working-tree changes)'),
    '',
    '## Worker Report',
    '',
    renderWorkerReportSection(workerReport),
    '',
    '# Output format',
    '',
    'End your response with EXACTLY this block (and nothing after it).',
    'The cairn-candidate-id line is mandatory; verdict MUST be one of',
    VERDICT_VALUES.map(v => '`' + v + '`').join(' / '),
    '(any other value will be rejected). reason is ONE sentence,',
    '≤ ' + MAX_REASON_LEN + ' chars, no newlines.',
    '',
    REVIEW_VERDICT_HEADER,
    CANDIDATE_ECHO_PREFIX + ' ' + id,
    'verdict: <pass | fail | needs_human>',
    'reason: <one sentence explaining the verdict>',
    '',
    '# CAIRN-BUILT CONTEXT (advisory)',
    '',
  ];
  return lines.join('\n');
}

/**
 * Compose the full Review prompt. Required: opts.candidate,
 * opts.worker_diff_text. Optional: opts.worker_diff_truncated,
 * opts.worker_report.
 */
function generateReviewPrompt(input, opts) {
  const o = opts || {};
  const candidate = o.candidate;
  if (!candidate || !candidate.id || !candidate.description) {
    throw new Error('generateReviewPrompt: opts.candidate { id, description } is required');
  }
  if (typeof o.worker_diff_text !== 'string') {
    throw new Error('generateReviewPrompt: opts.worker_diff_text is required (may be empty string)');
  }
  const base = managedLoopPrompt.generateManagedPrompt(input, Object.assign({}, o, {
    forceDeterministic: o.forceDeterministic !== false,
    candidate: undefined,
  }));
  const hardRules = buildReviewHardRules(
    candidate, o.worker_diff_text, !!o.worker_diff_truncated, o.worker_report || null,
  );
  return Object.assign({}, base, {
    prompt: hardRules + base.prompt,
    is_review: true,
    mode: 'review',
    candidate_id: candidate.id,
    sections: Object.assign({}, base.sections, { review_hard_rules: hardRules }),
  });
}

module.exports = {
  REVIEW_VERDICT_HEADER,
  VERDICT_VALUES,
  CANDIDATE_ECHO_PREFIX,
  MAX_REASON_LEN,
  buildReviewHardRules,
  generateReviewPrompt,
};
