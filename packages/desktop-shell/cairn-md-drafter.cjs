'use strict';

/**
 * cairn-md-drafter — Cairn-side haiku fallback for first-time CAIRN.md.
 *
 * When a user adds a project in the panel ("＋ Add project…") and no
 * CAIRN.md exists yet, this module asks haiku to draft one from
 * artifacts the user already produced (no user input required):
 *   - CLAUDE.md head      — local project conventions
 *   - README.md head      — pitch / positioning
 *   - package.json fields — name + description + scripts
 *   - git log -20         — what's actually being built
 *   - top-level listing   — project shape
 *
 * Per 2026-05-14-bootstrap-grill plan A4: this is the HARD FLOOR —
 * always produces a CAIRN.md so the daemon never blocks on attached
 * CC. If a CC session is attached, A2 dispatches a refinement request
 * via `agent_inbox` carrying this draft as input — CC can replace or
 * keep it.
 *
 * Output: writes CAIRN.md directly to <projectRoot>/CAIRN.md and
 * returns { ok, source: 'haiku' | 'fallback', content, signals_used }.
 * On haiku failure (no provider / timeout / parse / format-validate
 * fail) → falls back to the install.ts CAIRN_MD_TEMPLATE scaffold,
 * marked source='fallback'.
 *
 * Anti-framing (per A5): the prompt explicitly tells haiku it is
 * writing a Project Director's job description for Mentor, NOT a
 * Senior Engineer's job description for itself; NOT plan-mode output.
 *
 * No new dependencies. Uses existing cockpit-llm-helpers.runHelper.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const helpers = require('./cockpit-llm-helpers.cjs');

const SIGNAL_BYTE_BUDGETS = Object.freeze({
  claudeMd: 4000,
  readme: 3000,
  packageJson: 1500,
  gitLog: 1500,
  dirListing: 1500,
});

// Format-validate Whole sentence: 20-200 chars, capital start,
// terminated by . / ! / ? / 。 / ！/ ？ etc.
const WHOLE_RE = /^[A-Z一-鿿].{18,198}[.!?。！？]$/u;

// ---------------------------------------------------------------------------
// Signal gathering — pure read; no fs writes
// ---------------------------------------------------------------------------

function _readHead(absPath, byteBudget) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const buf = fs.readFileSync(absPath);
    if (buf.length <= byteBudget) return buf.toString('utf8');
    return buf.subarray(0, byteBudget).toString('utf8') + '\n…[truncated]';
  } catch (_e) { return null; }
}

function _readPackageJson(projectRoot) {
  const p = path.join(projectRoot, 'package.json');
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return {
      name: typeof j.name === 'string' ? j.name : null,
      description: typeof j.description === 'string' ? j.description : null,
      scripts: j.scripts && typeof j.scripts === 'object' ? Object.keys(j.scripts) : [],
      dependencies: j.dependencies ? Object.keys(j.dependencies) : [],
      devDependencies: j.devDependencies ? Object.keys(j.devDependencies) : [],
    };
  } catch (_e) { return null; }
}

function _readGitLog(projectRoot, limit) {
  try {
    const out = execFileSync('git', ['log', '--oneline', '-' + limit], {
      cwd: projectRoot,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      encoding: 'utf8',
    });
    return out.trim();
  } catch (_e) { return null; }
}

function _readDirListing(projectRoot, max) {
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.'))
      .slice(0, max)
      .map(d => d.isDirectory() ? d.name + '/' : d.name);
    return entries.join('\n');
  } catch (_e) { return null; }
}

/**
 * Collect signals from the project. Pure read.
 *
 * @param {string} projectRoot
 * @returns {object} { claudeMd?, readme?, packageJson?, gitLog?, dirListing? }
 */
function gatherSignals(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') return {};
  return {
    claudeMd: _readHead(path.join(projectRoot, 'CLAUDE.md'), SIGNAL_BYTE_BUDGETS.claudeMd),
    readme: _readHead(path.join(projectRoot, 'README.md'), SIGNAL_BYTE_BUDGETS.readme),
    packageJson: _readPackageJson(projectRoot),
    gitLog: _readGitLog(projectRoot, 20),
    dirListing: _readDirListing(projectRoot, 50),
  };
}

// ---------------------------------------------------------------------------
// Prompt construction — anti-framing baked in (per A5)
// ---------------------------------------------------------------------------

function buildPrompt(signals, opts) {
  const o = opts || {};
  const pkgPart = signals.packageJson
    ? `package.json:\n  name: ${signals.packageJson.name || '(none)'}\n  description: ${signals.packageJson.description || '(none)'}\n  scripts: ${(signals.packageJson.scripts || []).slice(0, 20).join(', ')}\n  deps: ${(signals.packageJson.dependencies || []).slice(0, 20).join(', ')}`
    : 'package.json: (none)';

  const system = [
    'You are drafting CAIRN.md — the per-project policy file Cairn Mentor',
    "reads to decide whether a runtime event is its call or the user's.",
    '',
    'CRITICAL FRAMING (read first; this changes what you write):',
    "  You are writing a PROJECT DIRECTOR's job description for Mentor — not",
    "  a Senior Engineer's job description for yourself. Mentor coordinates",
    '  agents. Mentor does NOT write code; Mentor does NOT plan implementation',
    '  steps; Mentor is NOT Claude Code\'s plan-mode output.',
    '',
    'The "## Whole" line is the project\'s stable complete-form sentence — what',
    'this project BECOMES when "done." Not what it does right now. Not this',
    'week\'s task. The user\'s North Star. ONE sentence, 20-200 chars, capital',
    'start, period end.',
    '',
    'The "## Goal" line is the CURRENT sub-Whole milestone — what we are',
    'driving toward right now. ONE sentence. Can drift; Whole stays.',
    '',
    'OUTPUT FORMAT: ONLY a single JSON object, no prose, no markdown fence:',
    '  {',
    '    "whole":       "<one sentence, 20-200 chars, ends with . ! or ?>",',
    '    "goal":        "<one sentence, current sub-Whole milestone>",',
    '    "is":          ["<phrase>", ...],',
    '    "is_not":      ["<phrase>", ...],',
    '    "authority": {',
    '      "auto":      ["<reversible / low-stakes>", ...],',
    '      "announce":  ["<reversible but worth knowing>", ...],',
    '      "escalate":  ["<irreversible / strategic / business>", ...]',
    '    },',
    '    "constraints":   ["<cross-cutting rule>", ...],',
    '    "known_answers": [{"pattern":"<substring>","answer":"<canonical>"}, ...]',
    '  }',
    '',
    'Rules:',
    "  - Every authority bullet should serve the Whole sentence — if it doesn't, don't write it.",
    "  - Use the project's package.json scripts to infer escalate items (e.g. an 'npm publish' or",
    "    'release' script → 🛑 escalate). Don't invent risks the project doesn't expose.",
    '  - 4-8 auto bullets, 2-4 announce bullets, 5-10 escalate bullets is the sweet spot.',
    '  - Non-developer-friendly phrasing — avoid jargon when an everyday word works.',
    "  - If signal is too thin to draft confidently, leave that section's array empty.",
  ].join('\n');

  const userParts = [];
  if (signals.claudeMd)   userParts.push(`CLAUDE.md (head):\n${signals.claudeMd}\n---`);
  if (signals.readme)     userParts.push(`README.md (head):\n${signals.readme}\n---`);
  if (signals.packageJson || true) userParts.push(`${pkgPart}\n---`);
  if (signals.gitLog)     userParts.push(`Recent commits (git log --oneline -20):\n${signals.gitLog}\n---`);
  if (signals.dirListing) userParts.push(`Top-level listing (max 50):\n${signals.dirListing}`);
  if (userParts.length === 0) userParts.push('(no project signals available — produce a minimal generic CAIRN.md)');

  const user = userParts.join('\n');
  return { system, user };
}

// ---------------------------------------------------------------------------
// JSON output validation
// ---------------------------------------------------------------------------

function _validateDraft(j) {
  if (!j || typeof j !== 'object') return { ok: false, reason: 'not_an_object' };
  if (typeof j.whole !== 'string' || !j.whole.trim()) return { ok: false, reason: 'whole_missing' };
  if (!WHOLE_RE.test(j.whole)) return { ok: false, reason: 'whole_format', value: j.whole };
  if (typeof j.goal !== 'string' || !j.goal.trim()) return { ok: false, reason: 'goal_missing' };
  if (!j.authority || typeof j.authority !== 'object') return { ok: false, reason: 'authority_missing' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderDraftToMarkdown(j, projectName) {
  const lines = [];
  lines.push(`# ${projectName || '<Project Name>'}`);
  lines.push('');
  lines.push('> Per-project policy file for Cairn Mentor. This first draft was');
  lines.push('> generated by Cairn\'s haiku from your repo signals. Edit freely;');
  lines.push('> Cairn re-reads on file change. Schema: docs/CAIRN-md-spec.md.');
  lines.push('>');
  lines.push('> Cairn renders a "what\'s in flight" line in the panel from live');
  lines.push('> tasks + processes — do not edit progress / status here.');
  lines.push('');
  lines.push('## Whole');
  lines.push('');
  lines.push(j.whole);
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(j.goal);
  lines.push('');
  lines.push('## What this project IS / IS NOT');
  lines.push('');
  for (const item of (j.is || [])) lines.push(`- IS: ${item}`);
  for (const item of (j.is_not || [])) lines.push(`- IS NOT: ${item}`);
  lines.push('');
  lines.push('## Mentor authority (decision delegation)');
  lines.push('');
  const a = j.authority || {};
  for (const item of (a.auto || []))     lines.push(`- ✅ ${item}`);
  for (const item of (a.announce || [])) lines.push(`- ⚠️ ${item}`);
  for (const item of (a.escalate || [])) lines.push(`- 🛑 ${item}`);
  lines.push('');
  lines.push('## Project constraints');
  lines.push('');
  for (const item of (j.constraints || [])) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Known answers');
  lines.push('');
  for (const ka of (j.known_answers || [])) {
    if (ka && ka.pattern && ka.answer) lines.push(`- ${ka.pattern} => ${ka.answer}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## For Cairn-aware coding agents');
  lines.push('');
  lines.push('If you are a coding agent working in this repo with Cairn attached,');
  lines.push('before raising a blocker (`cairn.task.block`), first write a brief to');
  lines.push('scratchpad key `agent_brief/<your-agent-id>` with shape:');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "version": 1,');
  lines.push('  "agent_id": "<your-cairn-session-agent-id>",');
  lines.push('  "task_id": "<current task_id if any>",');
  lines.push('  "summary": "what you\'re trying to do right now (≤ 150 words)",');
  lines.push('  "stuck_on": "what\'s blocking you (≤ 80 words)",');
  lines.push('  "options_considered": ["option A", "option B"],');
  lines.push('  "lean": "your current preference + why",');
  lines.push('  "written_at": <Date.now()>');
  lines.push('}');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public: draftCairnMd
// ---------------------------------------------------------------------------

/**
 * Draft CAIRN.md for a new project. Always returns a usable result.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot           absolute path to project
 * @param {string} [opts.projectName]         label for the H1 (defaults to basename)
 * @param {string} [opts.scaffoldTemplate]    fallback markdown if haiku fails
 * @param {(input, opts) => Promise<object>} [opts.runHelper]  injection for tests
 * @param {boolean} [opts.write=true]         write the file to disk
 * @param {number} [opts.maxTokens=900]
 * @param {number} [opts.timeoutMs=20000]
 * @returns {Promise<{ok, source, content, validation, signals_used, written?}>}
 */
async function draftCairnMd(opts) {
  const o = opts || {};
  if (!o.projectRoot || typeof o.projectRoot !== 'string') {
    return { ok: false, source: 'error', error: 'projectRoot_required' };
  }
  const projectName = o.projectName || path.basename(o.projectRoot);
  const signals = gatherSignals(o.projectRoot);
  const signalsUsed = Object.fromEntries(
    Object.entries(signals).map(([k, v]) => [k, v != null && v !== ''])
  );

  const runHelper = o.runHelper || helpers.runHelper;
  const prompts = buildPrompt(signals, o);

  let content = null;
  let source = 'fallback';
  let validation = null;

  try {
    const r = await runHelper(prompts, {
      maxTokens: o.maxTokens || 900,
      temperature: 0.2,
      timeoutMs: o.timeoutMs || 20000,
    });
    if (r && r.ok && typeof r.content === 'string') {
      const text = r.content.trim();
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          const parsed = JSON.parse(text.slice(first, last + 1));
          validation = _validateDraft(parsed);
          if (validation.ok) {
            content = renderDraftToMarkdown(parsed, projectName);
            source = 'haiku';
          }
        } catch (e) {
          validation = { ok: false, reason: 'json_parse_failed', detail: e && e.message ? e.message : String(e) };
        }
      } else {
        validation = { ok: false, reason: 'no_json_in_output' };
      }
    } else {
      validation = {
        ok: false,
        reason: r && r.reason ? r.reason : 'helper_failed',
        detail: r && r.detail ? r.detail : null,
      };
    }
  } catch (e) {
    validation = { ok: false, reason: 'helper_threw', detail: e && e.message ? e.message : String(e) };
  }

  if (content == null) {
    // Fallback: use the scaffold template the install CLI writes.
    // Caller (install-bridge) typically passes its template; if not,
    // produce a minimal scaffold here.
    content = o.scaffoldTemplate || (
      `# ${projectName}\n\n` +
      '> Per-project policy file for Cairn Mentor. The haiku drafter could not\n' +
      `> produce a confident first draft (reason: ${validation && validation.reason ? validation.reason : 'unknown'}).\n` +
      '> Edit this file — schema reference: docs/CAIRN-md-spec.md.\n\n' +
      '## Whole\n\n<one sentence — the project\'s stable complete form>\n\n' +
      '## Goal\n\n<one sentence — current sub-Whole milestone>\n\n' +
      '## What this project IS / IS NOT\n\n- IS: \n- IS NOT: \n\n' +
      '## Mentor authority (decision delegation)\n\n- ✅ \n- ⚠️ \n- 🛑 npm publish\n- 🛑 force-push to main\n- 🛑 LICENSE edit\n\n' +
      '## Project constraints\n\n- \n\n' +
      '## Known answers\n\n- <substring> => <answer>\n'
    );
  }

  let written = false;
  if (o.write !== false && content) {
    try {
      const dst = path.join(o.projectRoot, 'CAIRN.md');
      fs.writeFileSync(dst, content, 'utf8');
      written = true;
    } catch (e) {
      // file write failed; return content anyway so caller can show it
      return { ok: false, source, content, validation, signals_used: signalsUsed, error: 'write_failed', detail: e && e.message ? e.message : String(e) };
    }
  }

  return { ok: true, source, content, validation, signals_used: signalsUsed, written };
}

module.exports = {
  SIGNAL_BYTE_BUDGETS,
  WHOLE_RE,
  gatherSignals,
  buildPrompt,
  renderDraftToMarkdown,
  draftCairnMd,
  // exported for tests
  _validateDraft,
};
