'use strict';

/**
 * Scout Prompt Pack — Three-Stage Loop / Day 2.
 *
 * Wraps the standard Managed Loop prompt with a Scout-specific
 * hard-rules block. The rules constrain the worker to a read-only
 * round whose only deliverable is a `## Scout Candidates` block
 * listing up to 5 candidate improvements.
 *
 * The downstream parser (`worker-launcher.extractScoutCandidatesFromText`)
 * scans for the LAST occurrence of SCOUT_CANDIDATES_HEADER, so this
 * file is the source-of-truth for that string. If you change the
 * header here, the parser regex still matches because it accepts
 * any whitespace between the words.
 *
 * No I/O. Pure composition over managed-loop-prompt.cjs.
 */

const managedLoopPrompt = require('./managed-loop-prompt.cjs');

const SCOUT_CANDIDATES_HEADER = '## Scout Candidates';

const SCOUT_KIND_VALUES = ['missing_test', 'refactor', 'doc', 'bug_fix', 'other'];

const SCOUT_HARD_RULES = [
  '# CAIRN SCOUT — READ-ONLY ROUND',
  '',
  'You are launched by Cairn for a one-shot Scout pass. Your only',
  'deliverable is a list of candidate improvements that a future',
  'round could pick up. Cairn parses your output deterministically;',
  'follow the format exactly or your output will be rejected.',
  '',
  'STRICT RULES — violating any means stop immediately and emit a',
  SCOUT_CANDIDATES_HEADER + ' block explaining why no candidates were produced:',
  '',
  '1. DO NOT modify, create, or delete any file in this repository.',
  '2. DO NOT run `git commit`, `git add`, `git push`, `git rebase`, `git reset`.',
  '3. DO NOT run `npm/bun/pnpm/yarn install` or any installer.',
  '4. DO NOT run tests, builds, or dev servers (you may LIST them).',
  '5. ONLY use Read / Glob / Grep / LS / Bash for read-only inspection.',
  '6. Keep the response under ~30 lines of substance before the candidates block.',
  '',
  'OUTPUT FORMAT — end your response with EXACTLY this block (and',
  'nothing after it). One line per candidate. Order safest first.',
  'Maximum 5 candidates. Each description ≤ 200 chars.',
  '',
  SCOUT_CANDIDATES_HEADER,
  '- [missing_test] short description of a coverage gap (e.g. "src/lib/foo.ts has no test")',
  '- [doc] short description of a missing or wrong doc',
  '- [bug_fix] short description of a small isolated bug',
  '- [refactor] short description of a small low-risk refactor',
  '- [other] anything else, but prefer the four kinds above',
  '',
  'Recognized kinds (closed set): ' + SCOUT_KIND_VALUES.map(k => '`' + k + '`').join(', ') + '.',
  'Anything outside that set will be coerced to `other`.',
  '',
  '# YOUR TASK',
  '',
  'Inspect this repository for ONE round and propose up to 5',
  'candidate improvements that future rounds could pick up. Each',
  'candidate must be small, isolated, and testable. Skip anything',
  'that would require a refactor across many files.',
  '',
  '# CAIRN-BUILT CONTEXT (advisory)',
  '',
].join('\n');

/**
 * Compose the full Scout prompt: HARD_RULES + Cairn-built managed
 * context + standard goal/rules/non-goals scaffolding.
 *
 * Returns the same shape as generateManagedPrompt (`prompt`,
 * `sections`, `evidence_ids`, `is_managed`, …) plus:
 *   - is_scout: true
 *   - mode: 'scout'
 *
 * @param {object} input  — same shape as generateManagedPrompt
 * @param {object} [opts] — same shape as generateManagedPrompt
 */
function generateScoutPrompt(input, opts) {
  const o = opts || {};
  const base = managedLoopPrompt.generateManagedPrompt(input, Object.assign({}, o, {
    forceDeterministic: o.forceDeterministic !== false,
  }));
  const prompt = SCOUT_HARD_RULES + base.prompt;
  return Object.assign({}, base, {
    prompt,
    is_scout: true,
    mode: 'scout',
    sections: Object.assign({}, base.sections, {
      scout_hard_rules: SCOUT_HARD_RULES,
    }),
  });
}

module.exports = {
  SCOUT_CANDIDATES_HEADER,
  SCOUT_KIND_VALUES,
  SCOUT_HARD_RULES,
  generateScoutPrompt,
};
