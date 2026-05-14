'use strict';

/**
 * mode-a-auto-answer.cjs — Mode A aggressive Rule D auto-answer.
 *
 * Per plan §2.3 / CEO 2026-05-14命题: "即使用户的 cc 没有这样的规则，
 * cairn 也能够确保 cc 在任务完成前能够不断".
 *
 * When a Mode A task BLOCKED with a question, instead of waiting for a
 * human, the Mentor tries to answer it itself based on:
 *   1. A known-answer pattern table (precise yes/no, choose-from, etc.)
 *   2. CAIRN.md `authority` hints from the project profile (when
 *      profile.authority.choices includes a matching prefix)
 *   3. A deterministic fallback that tells the agent to proceed with
 *      best judgment per the goal.
 *
 * Every answer is tagged `answered_by: 'mode-a-auto:H<rule>'` so the
 * user can audit later which auto-answers fired. The kernel keeps the
 * original question intact + writes answer + answered_at + answered_by
 * via the existing blockers schema (migration 009).
 *
 * Read/write contract:
 *   - WRITES blockers row (status PENDING→ANSWERED) — this is a
 *     kernel-state mutation. cockpit-dispatch already does similar
 *     (writes dispatch_requests on Tier-A button). Mode A auto-answer
 *     is the same tier: a Mentor-driven mutation, not a panel button.
 *     Audited via answered_by tag.
 *   - Does NOT touch the task itself — the agent (CC / Cursor) is
 *     responsible for reading the answer + transitioning BLOCKED →
 *     RUNNING via the normal cairn.task primitives.
 *
 * NOT in MA-2d:
 *   - LLM polish (deferred to MA-2e when an LLM helper is wired)
 *   - Per-question retry budget (one auto-answer per blocker; if the
 *     same question re-raises, mentor-tick will fire again)
 */

const cairnLog = require('./cairn-log.cjs');

/**
 * Yes/no detector — very narrow. Triggers only when the question
 * starts with one of: should/can/may/will/is/are/do/does/did + a single
 * sentence ending in '?'. Default = 'yes' (the optimistic path that
 * keeps CC moving). Returns null if not a yes/no.
 */
const YESNO_PREFIXES = /^(should|can|may|will|is|are|do|does|did|shall|would|could)\b/i;
function detectYesNo(question) {
  if (typeof question !== 'string') return null;
  const q = question.trim();
  if (!q.endsWith('?')) return null;
  if (!YESNO_PREFIXES.test(q)) return null;
  // Reject multi-sentence questions — those usually have nuance.
  if ((q.match(/[.!?]/g) || []).length > 1) return null;
  return {
    rule: 'yesno',
    answer: 'yes',
    reasoning: 'yes/no question, defaulting to yes; pivot if the goal would be violated',
  };
}

/**
 * "Either / any / default / your choice" detector — when the question
 * explicitly invites the answerer to pick any. e.g.
 *   "Which library should I use, any preference?"
 *   "Should I use option A or B?"   ← caught by choose-from below
 */
const ANY_PATTERNS = /(any preference|either|your choice|whatever|either option|whichever)/i;
function detectAny(question) {
  if (typeof question !== 'string') return null;
  if (!ANY_PATTERNS.test(question)) return null;
  return {
    rule: 'any',
    answer: 'pick the option that best aligns with the project goal; either is acceptable',
    reasoning: 'question explicitly opens choice',
  };
}

/**
 * "A or B" detector — exact two-choice questions. Default = the FIRST
 * option (a deterministic, debuggable choice). The agent can pivot if
 * runtime evidence contradicts.
 */
// Matches both "option A or B" (concise) and "approach 1 or approach 2"
// (verbose) shapes. Repeats the noun-phrase prefix on the second arm
// optionally so we don't miss the verbose form.
const CHOOSE_FROM_RE = /\b(?:option|choice|approach|pattern)\s+(?:a|1|one)\s+or\s+(?:(?:option|choice|approach|pattern)\s+)?(?:b|2|two)\b/i;
function detectChooseFrom(question) {
  if (typeof question !== 'string') return null;
  if (!CHOOSE_FROM_RE.test(question)) return null;
  return {
    rule: 'choose-from',
    answer: 'go with option A (deterministic default); pivot if you find a goal-violating consequence',
    reasoning: '"A or B" prompt; defaulting to A',
  };
}

/**
 * Profile-based answer — looks up profile.authority[*] for a question
 * keyword match. profile shape (mentor-project-profile.cjs):
 *   { authority: { choices: [{ keyword, decision, reason }], ... } }
 * Very loose match (lowercase substring). When multiple match, picks
 * the first.
 */
function detectFromProfile(question, profile) {
  if (typeof question !== 'string' || !profile) return null;
  const choices = profile.authority && Array.isArray(profile.authority.choices) ? profile.authority.choices : [];
  if (choices.length === 0) return null;
  const q = question.toLowerCase();
  for (const c of choices) {
    if (!c || typeof c.keyword !== 'string' || !c.decision) continue;
    if (q.includes(c.keyword.toLowerCase())) {
      return {
        rule: 'profile',
        answer: c.decision,
        reasoning: `CAIRN.md authority match on "${c.keyword}"${c.reason ? ': ' + c.reason : ''}`,
      };
    }
  }
  return null;
}

/**
 * Fallback — always returns a generic "proceed with best judgment"
 * answer so the loop never stops on a blocker in Mode A. Last resort.
 */
function detectFallback(question, goalTitle) {
  return {
    rule: 'fallback',
    answer: goalTitle
      ? `proceed with your best judgment toward the goal: "${goalTitle}". document the assumption in scratchpad so I can review.`
      : `proceed with your best judgment. document the assumption in scratchpad so I can review.`,
    reasoning: 'no specific pattern matched; defaulting to generic continuation',
  };
}

/**
 * Decide an auto-answer for a single OPEN blocker. Returns a result
 * object the caller writes to the blockers row.
 */
function decideAutoAnswer(blocker, ctx) {
  const question = blocker && blocker.question;
  const profile = ctx && ctx.profile;
  const goalTitle = ctx && ctx.goalTitle;
  const detectors = [
    () => detectFromProfile(question, profile),  // highest precedence — explicit user authority
    () => detectChooseFrom(question),
    () => detectAny(question),
    () => detectYesNo(question),
    () => detectFallback(question, goalTitle),
  ];
  for (const d of detectors) {
    try {
      const r = d();
      if (r) return r;
    } catch (e) {
      cairnLog.error('mode-a-auto-answer', 'detector_threw', {
        message: (e && e.message) || String(e),
      });
    }
  }
  // Unreachable — fallback always returns; keep as safety net.
  return null;
}

/**
 * Side-effecting: write the answer back to the blockers row. Mutates
 * status OPEN → ANSWERED + answer text + answered_by + answered_at.
 * Idempotent: re-running on an already-ANSWERED row is a no-op.
 */
function writeAnswer(db, blockerId, decision, now) {
  if (!db || !blockerId || !decision) return { ok: false, reason: 'invalid_input' };
  const ts = now || Date.now();
  try {
    const cur = db.prepare('SELECT status FROM blockers WHERE blocker_id = ?').get(blockerId);
    if (!cur) return { ok: false, reason: 'blocker_not_found' };
    if (cur.status !== 'OPEN') return { ok: false, reason: 'not_open', status: cur.status };
    const answeredBy = `mode-a-auto:${decision.rule}`;
    db.prepare(`
      UPDATE blockers
      SET status = 'ANSWERED', answer = ?, answered_by = ?, answered_at = ?
      WHERE blocker_id = ? AND status = 'OPEN'
    `).run(decision.answer, answeredBy, ts, blockerId);
    cairnLog.info('mode-a-auto-answer', 'blocker_auto_answered', {
      blocker_id: blockerId,
      rule: decision.rule,
      answered_by: answeredBy,
    });
    return { ok: true, answered_by: answeredBy };
  } catch (e) {
    cairnLog.error('mode-a-auto-answer', 'write_failed', {
      blocker_id: blockerId,
      message: (e && e.message) || String(e),
    });
    return { ok: false, reason: 'write_threw', error: (e && e.message) || String(e) };
  }
}

/**
 * Per-project tick — call from mentor-tick when mode === 'A'. Reads
 * all OPEN blockers for this project's tasks + auto-answers each.
 * Returns counts.
 */
function runOnceForProject(deps) {
  const { db, tables, project, agentIds, profile, goalTitle } = deps || {};
  if (!db || !project) return { action: 'noop', answered: 0 };
  const hasTables = tables && typeof tables.has === 'function';
  if (hasTables && (!tables.has('tasks') || !tables.has('blockers'))) {
    return { action: 'noop', answered: 0, reason: 'tables_missing' };
  }
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { action: 'noop', answered: 0, reason: 'no_agent_hints' };
  }
  let openBlockers = [];
  try {
    const placeholders = '(' + agentIds.map(() => '?').join(',') + ')';
    openBlockers = db.prepare(`
      SELECT b.blocker_id, b.task_id, b.question, b.status
      FROM blockers b
      JOIN tasks t ON t.task_id = b.task_id
      WHERE b.status = 'OPEN'
        AND t.created_by_agent_id IN ${placeholders}
    `).all(...agentIds);
  } catch (e) {
    cairnLog.error('mode-a-auto-answer', 'query_failed', {
      project_id: project.id,
      message: (e && e.message) || String(e),
    });
    return { action: 'error', answered: 0 };
  }
  if (openBlockers.length === 0) {
    return { action: 'noop', answered: 0, reason: 'no_open_blockers' };
  }
  let answered = 0;
  for (const b of openBlockers) {
    const decision = decideAutoAnswer(b, { profile, goalTitle });
    if (!decision) continue;
    const res = writeAnswer(db, b.blocker_id, decision, deps.nowFn ? deps.nowFn() : Date.now());
    if (res.ok) answered++;
  }
  return { action: 'ran', answered, total_seen: openBlockers.length };
}

module.exports = {
  detectYesNo,
  detectAny,
  detectChooseFrom,
  detectFromProfile,
  detectFallback,
  decideAutoAnswer,
  writeAnswer,
  runOnceForProject,
};
