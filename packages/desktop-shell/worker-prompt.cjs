'use strict';

/**
 * Worker Prompt Pack — Three-Stage Loop / Day 3.
 *
 * Wraps the standard Managed Loop prompt with a Worker-specific
 * hard-rules block. The Worker round is the one stage where Cairn
 * explicitly authorizes the agent to MODIFY files in the managed
 * repo — bounded to the picked candidate's description. Everything
 * else (commits, pushes, installs, scope creep) is still off the
 * table.
 *
 * Each candidate kind gets a different system tone:
 *   - bug_fix:      conservative; minimum diff
 *   - missing_test: tests only; no implementation edits unless
 *                   trivially needed for testability
 *   - refactor:     behavior-preserving
 *   - doc:          documentation only; no code files
 *   - other:        generic
 *
 * Source-of-truth for two literals downstream code consumes:
 *   WORKER_REPORT_HEADER   — same string the launcher's extractor
 *                            scans for; exported here so prompt and
 *                            parser can never drift.
 *   CANDIDATE_ECHO_PREFIX  — the line the worker must echo at the
 *                            top of `### Completed`. Day 4 review
 *                            uses this to verify the worker handled
 *                            the candidate that was picked.
 *
 * No I/O. Pure composition over managed-loop-prompt.cjs.
 */

const managedLoopPrompt = require('./managed-loop-prompt.cjs');

const WORKER_REPORT_HEADER  = '## Worker Report';
const CANDIDATE_ECHO_PREFIX = 'cairn-candidate-id:';

const KIND_TONES = Object.freeze({
  bug_fix:
    'KIND TONE: bug_fix — this is a bug-fix round. Be conservative. '
    + 'Produce the MINIMUM diff that fixes the bug. Add a regression '
    + 'test if one is reasonable; do NOT broaden scope.',
  missing_test:
    'KIND TONE: missing_test — this round adds tests only. Do NOT '
    + 'modify implementation files unless a trivial signature change '
    + 'is required for testability, and explain it in Worker Report.',
  refactor:
    'KIND TONE: refactor — behavior MUST NOT change. No new feature, '
    + 'no logic change. If you cannot keep behavior identical, stop '
    + 'and report blockers instead.',
  doc:
    'KIND TONE: doc — documentation only. Do NOT touch code files. '
    + 'Limit edits to .md / docs/ / comments at the very top of code '
    + 'files when explicitly requested.',
  other:
    'KIND TONE: other — proceed conservatively. Touch only files '
    + 'directly required by the candidate description.',
});

function clip(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Build the Worker hard-rules block for a specific candidate. The
 * candidate id + description are spliced in so the rules block names
 * the exact target — no ambiguity about which candidate the worker
 * is on.
 */
function buildWorkerHardRules(candidate) {
  const c = candidate || {};
  const kind = (c.candidate_kind && KIND_TONES[c.candidate_kind]) ? c.candidate_kind : 'other';
  const tone = KIND_TONES[kind];
  const id   = clip(c.id, 80) || '(missing)';
  const desc = clip(c.description, 240) || '(missing)';
  return [
    '# CAIRN WORKER — ONE-CANDIDATE ROUND',
    '',
    'You are launched by Cairn to implement ONE candidate improvement.',
    'Cairn parses your output deterministically; follow the format',
    'exactly or your work cannot be reviewed.',
    '',
    'You are picking up the following candidate:',
    '  ' + CANDIDATE_ECHO_PREFIX + ' ' + id,
    '  description:    ' + desc,
    '  candidate_kind: ' + kind,
    '',
    tone,
    '',
    'STRICT RULES — violating any means stop and emit a Worker Report',
    'explaining why:',
    '',
    '1. You MAY modify, create, or delete files inside this repository,',
    '   but ONLY files directly required by the candidate description.',
    '2. DO NOT run `git commit`, `git add`, `git push`, `git rebase`,',
    '   `git reset`, `git stash`. Leave changes in the working tree;',
    '   the user decides whether to commit.',
    '3. DO NOT run `npm/bun/pnpm/yarn install` or any installer.',
    '4. DO NOT run dev servers or long-lived watchers. Running tests',
    '   for THIS candidate is allowed.',
    '5. DO NOT modify Cairn itself.',
    '',
    'OUTPUT FORMAT — end your response with EXACTLY this block.',
    'The first line under `### Completed` MUST echo the candidate id',
    'verbatim (Cairn uses this to verify you worked on the picked one):',
    '',
    WORKER_REPORT_HEADER,
    '### Completed',
    '- ' + CANDIDATE_ECHO_PREFIX + ' ' + id,
    '- <one or two bullets describing what you actually changed>',
    '### Remaining',
    '- <follow-up work the next round could pick up>',
    '### Blockers',
    '- <any, or leave empty>',
    '### Next',
    '- <one bullet for the next round>',
    '',
    '# CAIRN-BUILT CONTEXT (advisory)',
    '',
  ].join('\n');
}

/**
 * Compose the full Worker prompt: HARD_RULES + Cairn-built managed
 * context + standard goal/rules/non-goals scaffolding.
 *
 * Returns the same shape as generateManagedPrompt plus:
 *   is_worker:    true
 *   mode:         'worker'
 *   candidate_id: from the picked candidate
 *
 * Required: opts.candidate must include { id, description, candidate_kind }.
 *
 * Privacy: candidate.source_run_id is intentionally NOT consumed
 * here — the worker should not be encouraged to grep the Scout's
 * tail log to second-guess the user's pick.
 */
function generateWorkerPrompt(input, opts) {
  const o = opts || {};
  const candidate = o.candidate;
  if (!candidate || !candidate.id || !candidate.description) {
    throw new Error('generateWorkerPrompt: opts.candidate { id, description } is required');
  }
  const base = managedLoopPrompt.generateManagedPrompt(input, Object.assign({}, o, {
    forceDeterministic: o.forceDeterministic !== false,
    candidate: undefined, // do not leak candidate to base prompt internals
  }));
  const hardRules = buildWorkerHardRules(candidate);
  const prompt = hardRules + base.prompt;
  return Object.assign({}, base, {
    prompt,
    is_worker: true,
    mode: 'worker',
    candidate_id: candidate.id,
    sections: Object.assign({}, base.sections, {
      worker_hard_rules: hardRules,
    }),
  });
}

module.exports = {
  WORKER_REPORT_HEADER,
  CANDIDATE_ECHO_PREFIX,
  KIND_TONES,
  buildWorkerHardRules,
  generateWorkerPrompt,
};
