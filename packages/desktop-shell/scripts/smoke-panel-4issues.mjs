#!/usr/bin/env node
/**
 * smoke-panel-4issues.mjs — locks 4 issues 鸭总 caught 2026-05-14:
 *   1. AGENT_WORKING shown when no RUNNING task (just process registered)
 *   2. ESC always jumped to projects list — should pop view history
 *   3. L2 timeline drill-down empty state was unhelpful
 *   4. M2 module said "Todolist" — should be "Mentor 建议 / Agent 自荐 / 你的备忘"
 *
 * Sandboxed HOME per registry-pollution lesson.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Sandbox first.
const _realHome = os.homedir();
const _realProjectsJson = path.join(_realHome, '.cairn', 'projects.json');
const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-p4-smoke-'));
fs.mkdirSync(path.join(_tmpDir, '.cairn'), { recursive: true });
process.env.HOME = _tmpDir;
process.env.USERPROFILE = _tmpDir;
const _mtimeBefore = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
process.on('exit', () => {
  const _mtimeAfter = fs.existsSync(_realProjectsJson) ? fs.statSync(_realProjectsJson).mtimeMs : null;
  if (_mtimeBefore !== _mtimeAfter) {
    console.error('FATAL: smoke wrote to REAL ~/.cairn/projects.json');
    process.exit(3);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dsRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const cockpit = require(path.join(dsRoot, 'cockpit-state.cjs'));
const panelJsSrc = fs.readFileSync(path.join(dsRoot, 'panel.js'), 'utf8');
const panelHtmlSrc = fs.readFileSync(path.join(dsRoot, 'panel.html'), 'utf8');

let asserts = 0, fails = 0;
const failures = [];
function ok(c, l) {
  asserts++;
  if (c) process.stdout.write(`  ok    ${l}\n`);
  else { fails++; failures.push(l); process.stdout.write(`  FAIL  ${l}\n`); }
}
function header(t) { process.stdout.write(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}\n`); }
function section(t) { process.stdout.write(`\n[${t}]\n`); }

header('smoke-panel-4issues');

// ---------------------------------------------------------------------------
section('1 deriveAutopilotStatus requires RUNNING task for AGENT_WORKING');
{
  // Goal set + agent ACTIVE + 0 tasks running → should be AGENT_IDLE (not WORKING)
  const r1 = cockpit.deriveAutopilotStatus({
    goal: 'g',
    agents: [{ agent_id: 'a1', status: 'ACTIVE' }],
    escalationsPending: 0,
    progress: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 0 },
  });
  ok(r1 === cockpit.AUTOPILOT_STATUS.AGENT_IDLE,
     `active agent + 0 tasks → AGENT_IDLE (got ${r1})`);

  // Goal set + 1 RUNNING task + agent ACTIVE → AGENT_WORKING
  const r2 = cockpit.deriveAutopilotStatus({
    goal: 'g',
    agents: [{ agent_id: 'a1', status: 'ACTIVE' }],
    escalationsPending: 0,
    progress: { tasks_running: 1, tasks_blocked: 0, tasks_waiting_review: 0 },
  });
  ok(r2 === cockpit.AUTOPILOT_STATUS.AGENT_WORKING,
     `1 RUNNING task → AGENT_WORKING (got ${r2})`);

  // 0 RUNNING but 1 BLOCKED → still WORKING (it's active work)
  const r3 = cockpit.deriveAutopilotStatus({
    goal: 'g',
    agents: [{ agent_id: 'a1', status: 'ACTIVE' }],
    escalationsPending: 0,
    progress: { tasks_running: 0, tasks_blocked: 1, tasks_waiting_review: 0 },
  });
  ok(r3 === cockpit.AUTOPILOT_STATUS.AGENT_WORKING,
     `1 BLOCKED task → AGENT_WORKING (got ${r3})`);

  // 1 WAITING_REVIEW → WORKING
  const r4 = cockpit.deriveAutopilotStatus({
    goal: 'g',
    agents: [{ agent_id: 'a1', status: 'ACTIVE' }],
    escalationsPending: 0,
    progress: { tasks_running: 0, tasks_blocked: 0, tasks_waiting_review: 1 },
  });
  ok(r4 === cockpit.AUTOPILOT_STATUS.AGENT_WORKING,
     `1 WAITING_REVIEW → AGENT_WORKING (got ${r4})`);

  // No agent at all → IDLE
  const r5 = cockpit.deriveAutopilotStatus({
    goal: 'g',
    agents: [],
    escalationsPending: 0,
    progress: { tasks_running: 1 },
  });
  ok(r5 === cockpit.AUTOPILOT_STATUS.AGENT_IDLE,
     `task exists but no agent → AGENT_IDLE (got ${r5})`);

  // No goal → NO_GOAL (preserved)
  const r6 = cockpit.deriveAutopilotStatus({
    goal: null,
    agents: [{ status: 'ACTIVE' }],
    escalationsPending: 0,
    progress: { tasks_running: 1 },
  });
  ok(r6 === cockpit.AUTOPILOT_STATUS.NO_GOAL, 'no goal → NO_GOAL');
}

// ---------------------------------------------------------------------------
section('2 view history stack — ESC pops to previous view');
{
  // Structural assertions only (full integration needs Electron).
  ok(/viewHistory\s*=\s*\[\]/.test(panelJsSrc), 'viewHistory array declared');
  ok(/function pushHistory/.test(panelJsSrc), 'pushHistory function defined');
  ok(/function popHistory/.test(panelJsSrc), 'popHistory function defined');
  ok(/setView pushes the previous|history can return to it/.test(panelJsSrc) ||
     /Save current view to history so ESC/.test(panelJsSrc),
     'setView docs history push');
  ok(/popHistory\(\)/.test(panelJsSrc), 'ESC handler calls popHistory()');
  // Check the old broken pattern is gone — ESC should NOT unconditionally
  // jump to projects when there's history.
  const oldBareJump = /if \(currentView === 'project' \|\| currentView === 'cockpit'\) \{\s*window\.cairn\.selectProject\(null\)\.then\(\(\) => setView\('projects', null\)\);\s*\} else if \(currentView === 'unassigned'\) \{\s*setView\('projects'/;
  ok(!oldBareJump.test(panelJsSrc),
     'old "always jump to projects on ESC" pattern is gone');
  // Bounded history (no unbounded leak)
  ok(/viewHistory\.length > 16/.test(panelJsSrc) || /shift\(\)/.test(panelJsSrc),
     'history is bounded (no unbounded growth)');
}

// ---------------------------------------------------------------------------
section('3 timeline empty state explains kernel auto-instrument vs agent self-report');
{
  // Render fn empty branch should mention the kernel fallback so 鸭总 knows
  // "empty" = "agent literally hasn't done anything yet".
  ok(/这个 session 还没有可显示的工作脉络|kernel auto-instrument/.test(panelJsSrc),
     'empty state mentions kernel auto-instrument or 工作脉络');
  ok(/cairn\.task\.\*/.test(panelJsSrc),
     'empty state mentions task tools as the auto-trigger path');
  ok(/cairn-aware/.test(panelJsSrc), 'empty state mentions cairn-aware skill');
  // Confirm the bare unhelpful copy is gone
  ok(!/^.*agent hasn't written timeline records.*<\/div>.*$/s.test(
       (panelJsSrc.match(/listEl\.innerHTML\s*=\s*['"`].*?['"`]/g) || []).join('\n')),
     'bare "agent hasn\'t written records" copy replaced');
}

// ---------------------------------------------------------------------------
section('4 M2 module renamed to Mentor 建议 (not Todolist)');
{
  // HTML title check
  ok(/💡\s*Mentor 建议|Mentor 建议.*Agent 自荐|Mentor suggestions/.test(panelHtmlSrc),
     'panel.html shows "Mentor 建议" / "Agent 自荐" / similar');
  // Old "📋 Todolist" should be gone
  ok(!/📋\s*Todolist/.test(panelHtmlSrc), 'old "📋 Todolist" title is gone');
  // Empty state should be Chinese-friendly + mention Mentor
  ok(/还没有建议|Mentor 看到|出现在这里/.test(panelHtmlSrc),
     'panel.html empty state mentions Mentor / suggestion language');
  // panel.js render branch likewise
  ok(/还没有建议|Mentor 看到/.test(panelJsSrc),
     'panel.js empty state mentions Mentor suggestion');
}

// ---------------------------------------------------------------------------
// Subagent审查 (sonnet) found 4 more bugs in the first round; assertions
// below were added 2026-05-14 second-round to lock those fixes too.
// ---------------------------------------------------------------------------

section('5 panel.html #tl-list static content is NOT the old unhelpful copy');
{
  // Subagent caught: panel.html had `<div class="placeholder">no events yet — agent hasn't written timeline records</div>`
  // as the INITIAL static content of #tl-list, separate from the JS render
  // path. Even with JS empty-state fixed, users saw the static stale text
  // until first render completed.
  const tlListBlock = /tl-list[\s\S]*?<\/div>\s*<\/div>/.exec(panelHtmlSrc);
  ok(tlListBlock !== null, 'panel.html has #tl-list block');
  if (tlListBlock) {
    const block = tlListBlock[0];
    ok(!/no events yet.*agent hasn't written/.test(block),
       'static #tl-list does NOT contain the old stale copy');
  }
}

section('6 ESC handler dismisses cockpit-help-overlay before popping history');
{
  // Subagent caught: ESC with '?' help open both closed help AND went back
  ok(/cockpit-help-overlay[\s\S]*?contains\('open'\)[\s\S]*?return/.test(panelJsSrc),
     'ESC handler checks cockpit-help-overlay.classList.contains("open") + returns early');
  // Order matters: help-overlay check must come BEFORE popHistory()
  const escBlock = /document\.addEventListener\('keydown'[\s\S]*?\}\);/.exec(panelJsSrc);
  ok(escBlock !== null, 'ESC handler block found');
  if (escBlock) {
    const helpIdx = escBlock[0].indexOf('cockpit-help-overlay');
    const popIdx = escBlock[0].indexOf('popHistory()');
    ok(helpIdx > 0 && popIdx > 0 && helpIdx < popIdx,
       'help-overlay check ordered BEFORE popHistory call');
  }
}

section('7 setView pushes history when same view but different meta');
{
  // Subagent caught: cockpit(A) → cockpit(B) skipped history push under
  // `if (currentView !== name)` guard
  ok(/sameViewSameMeta|prevMetaId\s*===\s*nextMetaId/.test(panelJsSrc),
     'setView compares prevMetaId vs nextMetaId for same-view nav');
  // The old guard pattern `if (currentView !== name) { pushHistory }` alone is gone
  const oldGuard = /if \(currentView !== name\) \{\s*const prevMeta\s*=\s*currentView/;
  ok(!oldGuard.test(panelJsSrc),
     'old "currentView !== name" exclusive guard is gone');
}

section('8 ESC popHistory restore clears selectedAgentId (no stale filter)');
{
  // Subagent caught: ESC manual-restore didn't reset selectedAgentId
  // which setView() does at line 136.
  const popBlock = /const prev = popHistory[\s\S]*?if \(prev\)\s*\{[\s\S]*?\}\s*else if/.exec(panelJsSrc);
  ok(popBlock !== null, 'ESC popHistory restore block found');
  if (popBlock) {
    ok(/selectedAgentId\s*=\s*null/.test(popBlock[0]),
       'ESC restore clears selectedAgentId');
  }
}

section('9 help overlay copy reflects renamed Todolist + new ESC semantics');
{
  // Subagent caught: cockpit-help-overlay still said "Todolist" and
  // "Esc 返回 projects 列表" (both stale post-rename and post-ESC fix)
  // Strip HTML comments first so regex only matches USER-VISIBLE text.
  const visibleHtml = panelHtmlSrc.replace(/<!--[\s\S]*?-->/g, '');
  // Code comments inside <script> / <style> not in scope here — we're
  // grepping for natural-language strings rendered to user.
  ok(!/<strong>②\s*Mentor<\/strong>[^<]*Todolist/.test(visibleHtml),
     'help overlay M2 line no longer says "Todolist" (was: "状态 + Todolist...")');
  ok(/Mentor 建议/.test(visibleHtml) && /Agent 自荐/.test(visibleHtml) && /你的备忘/.test(visibleHtml),
     'panel.html mentions Mentor 建议 + Agent 自荐 + 你的备忘');
  ok(/回上一层|回上一页|previous view/i.test(panelHtmlSrc),
     'overlay ESC text updated for new history-aware semantics');
  ok(!/Esc.*返回 projects 列表/.test(panelHtmlSrc) || /回上一层/.test(panelHtmlSrc),
     'old "Esc 返回 projects 列表" wording is replaced');
}

// ---------------------------------------------------------------------------
header(`${asserts - fails}/${asserts} assertions passed (${fails} failed)`);
if (fails) {
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.exit(0);
