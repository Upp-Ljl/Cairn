/**
 * CDP-driven panel ↔ IPC ↔ handler ↔ launcher ↔ fixture integration smoke.
 *
 * **LEGACY** (2026-05-14): tests the legacy view-project + mentor-pane
 * Mode A advisory chat flow. The cockpit redesign (v0.2.0) supersedes
 * this — clicking a project card now opens view-cockpit + M2 Mentor
 * module instead of view-project + mentor-pane. This smoke remains as
 * a regression net for the env-gated legacy code path
 * (CAIRN_DESKTOP_ENABLE_MUTATIONS=1) but is SKIPPED in the default
 * sweep unless `CAIRN_RUN_LEGACY_SMOKE=1` is set. New integration smoke
 * for the cockpit redesign is via smoke-cockpit-state + smoke-cockpit-
 * todolist + smoke-cockpit-dispatch + smoke-cockpit-lane (no CDP needed —
 * pure module-layer dogfood).
 *
 * Catches field-name / schema / spawn-context drift between panel.js,
 * preload.cjs, main.cjs, mentor-handler.cjs, and worker-launcher.cjs
 * — the class of bugs that manual GUI verification found during A2-fix (34b6b06).
 *
 * Requires: Node 24 (native WebSocket), Electron in node_modules.
 * Uses: CAIRN_DESKTOP_ENABLE_MUTATIONS=1, fixture-mentor provider.
 * Sandbox: isolates ~/.cairn by overriding USERPROFILE / HOME.
 */

if (process.env.CAIRN_RUN_LEGACY_SMOKE !== '1') {
  console.log('==> smoke-panel-mentor-integration: SKIPPED (legacy view-project + mentor-pane Mode A path; set CAIRN_RUN_LEGACY_SMOKE=1 to run)');
  process.exit(0);
}

import { spawn, execSync }  from 'node:child_process';
import fs                   from 'node:fs';
import os                   from 'node:os';
import path                 from 'node:path';
import { fileURLToPath }    from 'node:url';

import {
  connectToTarget,
  waitForTarget,
} from './cdp-client.mjs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const SHELL_DIR    = path.resolve(__dirname, '..');          // packages/desktop-shell
const ELECTRON_BIN = path.join(SHELL_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

// ---------------------------------------------------------------------------
// Tiny assert helper
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, extra = '') {
  if (condition) {
    console.log(`  ok  ${label}`);
    passed++;
  } else {
    const msg = `  FAIL  ${label}${extra ? ' — ' + extra : ''}`;
    console.error(msg);
    failures.push(msg);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// SETUP — sandbox HOME, projects.json, git project_root
// ---------------------------------------------------------------------------

function setupSandbox() {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-panel-smoke-'));
  const cairnDir   = path.join(sandboxDir, '.cairn');
  const projRoot   = path.join(sandboxDir, 'smoke-project-root');
  // Electron on Windows resolves its own userData from APPDATA/LOCALAPPDATA.
  // Create these inside the sandbox so Electron doesn't write to the real user profile.
  fs.mkdirSync(path.join(sandboxDir, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(sandboxDir, 'AppData', 'Local'),   { recursive: true });

  fs.mkdirSync(cairnDir,  { recursive: true });
  fs.mkdirSync(projRoot,  { recursive: true });

  // Minimal git repo in projRoot so git-based signal collection works.
  execSync('git init', { cwd: projRoot, stdio: 'ignore' });
  fs.writeFileSync(path.join(projRoot, 'README.md'), '# panel-smoke test project\n');
  try {
    execSync('git add README.md && git -c user.email=smoke@cairn -c user.name=smoke commit -m "init"', {
      cwd: projRoot, shell: true, stdio: 'ignore',
    });
  } catch { /* if git commit fails due to missing identity, the smoke proceeds anyway */ }

  // Sandbox DB path (will be created by better-sqlite3 on open; stays in sandbox).
  const dbPath = path.join(cairnDir, 'smoke-panel.db');

  // Candidate JSONL — 3 PROPOSED candidates so _isSparseState() returns false
  // and mentor-handler proceeds to fixture-mentor (skipping sparse-state short-circuit).
  // IDs match fixture-mentor's hardcoded evidence_refs (c_bug_001, c_refactor_002, c_test_003).
  const candDir = path.join(cairnDir, 'project-candidates');
  fs.mkdirSync(candDir, { recursive: true });
  const now = Date.now();
  const candidates = [
    { id: 'c_bug_001',      status: 'PROPOSED', description: 'Fix async race in payment flow',         candidate_kind: 'bug_fix',      created_at: now - 3000, updated_at: now - 1000 },
    { id: 'c_refactor_002', status: 'PROPOSED', description: 'Refactor auth module for clarity',       candidate_kind: 'refactor',     created_at: now - 2000, updated_at: now - 900 },
    { id: 'c_test_003',     status: 'PROPOSED', description: 'Add unit tests for outcomes DSL eval',   candidate_kind: 'missing_test', created_at: now - 1000, updated_at: now - 800 },
  ];
  fs.writeFileSync(
    path.join(candDir, 'p_smoke_panel.jsonl'),
    candidates.map(c => JSON.stringify(c)).join('\n') + '\n'
  );

  // projects.json — registry.cjs REGISTRY_VERSION = 2.
  const registry = {
    version: 2,
    projects: [{
      id: 'p_smoke_panel',
      label: 'panel-smoke',
      project_root: projRoot,
      db_path: dbPath,
      agent_id_hints: [],
    }],
  };
  fs.writeFileSync(
    path.join(cairnDir, 'projects.json'),
    JSON.stringify(registry, null, 2)
  );

  return { sandboxDir, cairnDir, projRoot, dbPath };
}

// ---------------------------------------------------------------------------
// ELECTRON LAUNCH helpers
// ---------------------------------------------------------------------------

async function findFreePort(start = 9222) {
  for (let p = start; p < start + 20; p++) {
    try {
      const ac = new AbortController();
      const t  = setTimeout(() => ac.abort(), 300);
      await fetch(`http://127.0.0.1:${p}/json/version`, { signal: ac.signal });
      clearTimeout(t);
      // Something responded → port occupied; try next.
    } catch {
      return p; // ECONNREFUSED / abort → port is free.
    }
  }
  throw new Error('No free CDP port found in range 9222-9241');
}

async function waitForCDPPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`CDP port ${port} did not open within ${timeoutMs}ms`);
}

async function launchElectron(sandboxDir, port) {
  if (!fs.existsSync(ELECTRON_BIN)) {
    throw new Error(`Electron binary not found: ${ELECTRON_BIN}`);
  }
  const electronUserData = path.join(sandboxDir, 'electron-userdata');
  fs.mkdirSync(electronUserData, { recursive: true });

  const child = spawn(
    ELECTRON_BIN,
    ['.', `--remote-debugging-port=${port}`, '--no-sandbox',
     `--user-data-dir=${electronUserData}`],
    {
      cwd: SHELL_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        HOME:         sandboxDir,
        USERPROFILE:  sandboxDir,     // Windows: os.homedir() reads USERPROFILE
        APPDATA:      path.join(sandboxDir, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(sandboxDir, 'AppData', 'Local'),
        CAIRN_DESKTOP_ENABLE_MUTATIONS: '1',
      },
    }
  );
  child.on('error', (e) => { console.error('[electron]', e.message); });
  // Stream stderr/stdout only if VERBOSE=1
  if (process.env.VERBOSE === '1') {
    child.stdout.on('data', d => process.stdout.write('[e:out] ' + d));
    child.stderr.on('data', d => process.stderr.write('[e:err] ' + d));
  }
  return child;
}

// ---------------------------------------------------------------------------
// TEARDOWN
// ---------------------------------------------------------------------------

async function teardown(child, sandboxDir) {
  try { child.kill('SIGTERM'); } catch {}
  // On Windows, SIGTERM may not propagate to child processes of Electron.
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
  } catch { /* process may already be gone */ }
  await new Promise(r => setTimeout(r, 800));

  // Verify sandbox isolation: smoke db should be in sandbox, not in real ~/.cairn.
  const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
  const realStatBefore = global.__realCairnDbStat;
  if (fs.existsSync(realCairnDb)) {
    const statNow = fs.statSync(realCairnDb).mtimeMs;
    assert(
      statNow === realStatBefore,
      'TEARDOWN: real ~/.cairn/cairn.db mtime unchanged (sandbox isolated)',
      `before=${realStatBefore}, after=${statNow}`
    );
  }

  // Clean up sandbox dir (best-effort; leave on failure so CI can inspect).
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Main smoke runner
// ---------------------------------------------------------------------------

let child;
let cdp;
let sandboxDir;

async function main() {
  // Capture real ~/.cairn/cairn.db mtime before anything.
  const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
  global.__realCairnDbStat = fs.existsSync(realCairnDb)
    ? fs.statSync(realCairnDb).mtimeMs
    : -1;

  console.log('==> SETUP');
  const setup = setupSandbox();
  sandboxDir = setup.sandboxDir;
  console.log(`    sandbox: ${sandboxDir}`);

  const port = await findFreePort();
  console.log(`    CDP port: ${port}`);

  console.log('==> LAUNCH Electron');
  child = await launchElectron(sandboxDir, port);
  console.log(`    pid: ${child.pid}`);

  console.log('==> waiting for CDP port…');
  await waitForCDPPort(port, 30000);
  console.log('    port ready');

  console.log('==> waiting for panel.html target…');
  const target = await waitForTarget(port, 'panel.html', 15000);
  console.log(`    target: ${target.url}`);

  console.log('==> connecting CDP session');
  cdp = await connectToTarget(target);
  console.log('    connected');

  // Give panel.js time to boot and run its first poll.
  await new Promise(r => setTimeout(r, 800));

  // =========================================================================
  // PHASE A — Boot assertions
  // =========================================================================
  console.log('\n==> Phase A: boot assertions');

  const cairnType = await cdp.evaluate('typeof window.cairn', { awaitPromise: false });
  assert(cairnType === 'object', 'A.1: typeof window.cairn === "object"', `got: ${cairnType}`);

  const askMentorType = await cdp.evaluate('typeof window.cairn.askMentor', { awaitPromise: false });
  assert(askMentorType === 'function', 'A.2: typeof window.cairn.askMentor === "function" (MUTATIONS_ENABLED exposed)', `got: ${askMentorType}`);

  const mentorPaneExists = await cdp.evaluate('!!document.querySelector("#mentor-pane")', { awaitPromise: false });
  assert(mentorPaneExists === true, 'A.3: #mentor-pane exists in DOM');

  const mentorPaneHidden = await cdp.evaluate('document.getElementById("mentor-pane").hidden', { awaitPromise: false });
  assert(mentorPaneHidden === true, 'A.4: #mentor-pane.hidden === true before project selection');

  const consoleErrorsAtBoot = cdp.consoleErrors;
  assert(consoleErrorsAtBoot.length === 0,
    'A.5: no console.error at boot',
    `got ${consoleErrorsAtBoot.length}: ${consoleErrorsAtBoot.map(e => e.args?.[0]?.value || '?').join('; ')}`
  );

  // =========================================================================
  // PHASE B — Project selection
  // =========================================================================
  console.log('\n==> Phase B: project selection');

  // Wait for the L1 project list to render the fake project card.
  await cdp.waitFor('!!document.querySelector(\'.pcard[data-project-id="p_smoke_panel"]\')', 6000);
  assert(true, 'B.1: .pcard[data-project-id="p_smoke_panel"] rendered in L1 list');

  await cdp.clickSelector('.pcard[data-project-id="p_smoke_panel"]');
  assert(true, 'B.2: clicked project card');

  // setView('project', …) runs synchronously in the renderer on click;
  // poll() is called immediately, which calls renderMentorPane.
  await cdp.waitFor('document.getElementById("view-project").hidden === false', 5000);
  assert(true, 'B.3: #view-project is visible (project view active)');

  // renderMentorPane runs in poll(); with MUTATIONS_ENABLED and a real projectId,
  // it sets pane.hidden = false.
  await cdp.waitFor('document.getElementById("mentor-pane").hidden === false', 5000);
  assert(true, 'B.4: #mentor-pane.hidden === false after project selection');

  // =========================================================================
  // PHASE C — Mentor flow (core regression — catches A2-class bugs)
  // =========================================================================
  console.log('\n==> Phase C: mentor flow');

  // C.1 — Select fixture-mentor provider
  await cdp.clickSelector('input[name="mentor-provider"][value="fixture-mentor"]');
  const providerSelected = await cdp.evaluate(
    'document.querySelector(\'input[name="mentor-provider"][value="fixture-mentor"]\').checked',
    { awaitPromise: false }
  );
  assert(providerSelected === true, 'C.1: fixture-mentor provider selected');

  // C.2 — Fill question textarea
  await cdp.fillTextarea('#mentor-question', 'What should we focus on next?');
  const inputVal = await cdp.evaluate('document.getElementById("mentor-question").value', { awaitPromise: false });
  assert(inputVal === 'What should we focus on next?', 'C.2: textarea filled');

  // C.3 — Click Ask button
  await cdp.clickSelector('#mentor-ask-btn');
  assert(true, 'C.3: Ask button clicked');

  // C.4 — Wait for loading indicator to hide (fixture response received)
  // A hang here means ELECTRON_RUN_AS_NODE missing or fixture spawn failed.
  await cdp.waitFor('document.getElementById("mentor-loading").hidden === true', 15000);
  assert(true, 'C.4: loading indicator hidden (fixture response received; ELECTRON_RUN_AS_NODE ok)');

  // C.5 — Expect exactly 5 mentor items (all fixture items passed schema validation)
  await cdp.waitFor('document.querySelectorAll(".mentor-item").length >= 5', 3000);
  const itemCount = await cdp.evaluate('document.querySelectorAll(".mentor-item").length', { awaitPromise: false });
  assert(itemCount === 5, 'C.5: 5 mentor items rendered (schema validator kept all; Invariant #1 ok)', `got ${itemCount}`);

  // C.6 — No error cards
  const errorCardCount = await cdp.evaluate('document.querySelectorAll(".mentor-error-card").length', { awaitPromise: false });
  assert(errorCardCount === 0, 'C.6: no .mentor-error-card rendered (no field-name mismatch)', `got ${errorCardCount}`);

  // C.7 — Double-check: no user_question_required error text
  const errorTexts = await cdp.evaluate(
    'Array.from(document.querySelectorAll(".mentor-error-card")).map(e=>e.textContent.trim()).join("|")',
    { awaitPromise: false }
  );
  assert(
    !errorTexts.includes('user_question_required'),
    'C.7: no "user_question_required" in error cards (question vs user_question field ok)'
  );

  // C.8 — Each item has all required sub-elements
  const itemDetails = await cdp.evaluate(`
    Array.from(document.querySelectorAll('.mentor-item')).map((item, i) => ({
      i,
      hasKindChip:    !!item.querySelector('.mentor-kind-chip'),
      kindChipText:   (item.querySelector('.mentor-kind-chip') || {}).textContent || '',
      hasDesc:        !!item.querySelector('.mentor-desc'),
      descText:       (item.querySelector('.mentor-desc') || {}).textContent?.trim() || '',
      hasWhyRow:      !!item.querySelector('.mentor-why-row'),
      hasStakeholders: !!item.querySelector('.mentor-stakeholders'),
      hasSh:          (item.querySelectorAll('.mentor-sh-chip').length > 0),
      hasNextAction:  !!item.querySelector('.mentor-next-action'),
      nextActionText: (item.querySelector('.mentor-next-action') || {}).textContent?.trim() || '',
      hasPickBtn:     !!item.querySelector('.mentor-pick-btn'),
    }))
  `, { awaitPromise: false });

  for (const it of itemDetails) {
    assert(it.hasKindChip,    `C.8.${it.i}: item[${it.i}] has .mentor-kind-chip`);
    assert(it.kindChipText.length > 0, `C.8.${it.i}: item[${it.i}] kind chip non-empty`);
    assert(it.hasDesc,        `C.8.${it.i}: item[${it.i}] has .mentor-desc`);
    assert(it.descText.length > 0, `C.8.${it.i}: item[${it.i}] desc non-empty`);
    assert(it.hasWhyRow,      `C.8.${it.i}: item[${it.i}] has .mentor-why-row`);
    assert(it.hasSh,          `C.8.${it.i}: item[${it.i}] has ≥1 .mentor-sh-chip`);
    assert(it.hasNextAction,  `C.8.${it.i}: item[${it.i}] has .mentor-next-action`);
    assert(it.nextActionText.startsWith('→'), `C.8.${it.i}: item[${it.i}] next_action starts with "→"`);
  }

  // C.9 — Items 0-2 have Pick button (fixture: next_action = "pick to start Continuous Iteration" + candidate ref)
  for (let i = 0; i < 3; i++) {
    assert(itemDetails[i].hasPickBtn, `C.9: item[${i}] has .mentor-pick-btn (Mode B handoff)`, `hasPickBtn=${itemDetails[i].hasPickBtn}`);
  }

  // C.10 — Items 3-4 do NOT have Pick button
  for (let i = 3; i < 5; i++) {
    assert(!itemDetails[i].hasPickBtn, `C.10: item[${i}] has NO .mentor-pick-btn`, `hasPickBtn=${itemDetails[i].hasPickBtn}`);
  }

  // =========================================================================
  // PHASE D — Pick handoff to pickCandidateAndLaunchWorker
  // =========================================================================
  // Note: window.cairn is deep-frozen by contextBridge (writable:false,
  // configurable:false). Direct assignment / Object.defineProperty intercept
  // silently fail. Verification uses DOM side-effects instead:
  //   1. Confirm pick button data-mentor-item attribute is set (structural).
  //   2. Expand evidence section → confirm c_bug_001 candidate ref is present.
  //   3. Click pick → handleMentorPickAction fires IPC; sandbox project has no
  //      managed profile so {ok:false} comes back → footer shows "mentor pick".
  console.log('\n==> Phase D: pick handoff');

  // D.1 — Pick button on item[0] has a data-mentor-item attribute
  const pickBtnItemId = await cdp.evaluate(
    `(document.querySelectorAll('.mentor-item')[0].querySelector('.mentor-pick-btn') || {}).dataset?.mentorItem || null`,
    { awaitPromise: false }
  );
  assert(typeof pickBtnItemId === 'string' && pickBtnItemId.length > 0,
    'D.1: pick button has non-empty data-mentor-item attribute', `got: ${pickBtnItemId}`);

  // D.2 — Expand evidence toggle for item[0] then read evidence refs text
  await cdp.evaluate(
    `document.querySelectorAll('.mentor-item')[0].querySelector('.mentor-evidence-toggle')?.click()`,
    { awaitPromise: false }
  );
  await new Promise(r => setTimeout(r, 200));
  const evidenceText = await cdp.evaluate(
    `(document.querySelectorAll('.mentor-item')[0].querySelector('.mentor-evidence-refs') || {}).textContent || ''`,
    { awaitPromise: false }
  );
  assert(
    typeof evidenceText === 'string' && evidenceText.includes('c_bug_001'),
    'D.2: item[0] evidence refs include c_bug_001 (fixture matches; candidate_id verified via DOM)',
    `evidence: ${evidenceText.slice(0, 100)}`
  );

  // D.3 — Click pick button; verify IPC path via footer side-effect.
  // handleMentorPickAction always sets footer.bad on IPC response.
  // Sandbox has no managed profile → pickCandidateAndLaunchWorker returns {ok:false}.
  const footerBefore = await cdp.evaluate(
    'document.getElementById("footer").textContent', { awaitPromise: false }
  );
  await cdp.evaluate(
    `document.querySelectorAll('.mentor-item')[0].querySelector('.mentor-pick-btn').click()`,
    { awaitPromise: false }
  );
  // Wait for footer to change (IPC roundtrip completes and error is shown).
  await cdp.waitFor(
    `document.getElementById("footer").classList.contains("bad")`, 5000
  );
  const footerAfter = await cdp.evaluate(
    'document.getElementById("footer").textContent', { awaitPromise: false }
  );
  assert(
    typeof footerAfter === 'string' && footerAfter.includes('mentor pick'),
    'D.3: footer shows "mentor pick" (handleMentorPickAction ran + IPC completed)',
    `footer: ${footerAfter}`
  );
  assert(footerAfter !== footerBefore, 'D.4: footer changed after pick button click');

  // =========================================================================
  // PHASE E — Refusal xfail (expected current behavior: empty turn, no refusal card)
  // =========================================================================
  console.log('\n==> Phase E: refusal xfail');

  await cdp.evaluate('document.getElementById("mentor-question").value = ""', { awaitPromise: false });
  await cdp.fillTextarea('#mentor-question', 'give me sprint velocity for the team');
  await cdp.clickSelector('#mentor-ask-btn');
  await cdp.waitFor('document.getElementById("mentor-loading").hidden === true', 15000);
  assert(true, 'E.1: refusal question submitted and loading hidden');

  const refusalItemCount = await cdp.evaluate(
    'document.querySelectorAll(".mentor-item.refusal").length',
    { awaitPromise: false }
  );
  if (refusalItemCount > 0) {
    console.log('  xfail E.4 NOW PASSING: refusal card rendered — consider removing xfail marker');
    assert(true, 'E.4 (xfail-now-pass): refusal card rendered correctly');
  } else {
    // Current expected behavior: empty items list, no refusal card.
    console.log(`  xfail E.4 (expected): refusal renders as empty turn (0 refusal items) — correct behavior is a styled refusal card`);
    const allItemsAfterRefusal = await cdp.evaluate('document.querySelectorAll(".mentor-item").length', { awaitPromise: false });
    const noNewErrorCard = await cdp.evaluate('document.querySelectorAll(".mentor-error-card").length === 0', { awaitPromise: false });
    assert(noNewErrorCard, 'E.2: no .mentor-error-card on refusal response (refusal is ok:true + empty items)');
    // The 5 items from phase C are still visible in the earlier turn
    assert(allItemsAfterRefusal >= 5, 'E.3: prior 5 items from phase C still in DOM', `got ${allItemsAfterRefusal}`);
    console.log('  [xfail] E.4 as expected: 0 .mentor-item.refusal; future work should render styled refusal card');
  }

  // =========================================================================
  // PHASE F — Console error sweep (whole-session)
  // =========================================================================
  console.log('\n==> Phase F: console error sweep');
  const totalErrors = cdp.consoleErrors;
  assert(totalErrors.length === 0,
    'F.1: zero console.error / assert across entire smoke session',
    `got ${totalErrors.length}: ${totalErrors.slice(0, 3).map(e => e.args?.[0]?.value || '?').join('; ')}`
  );
}

// ---------------------------------------------------------------------------
// Entry point + cleanup
// ---------------------------------------------------------------------------

main()
  .then(async () => {
    console.log('\n==> TEARDOWN');
    if (cdp) cdp.disconnect();
    if (child && sandboxDir) await teardown(child, sandboxDir);
  })
  .catch(async (err) => {
    console.error('\n[smoke-panel-mentor-integration] UNCAUGHT:', err.message || err);
    if (err.code) console.error('  error code:', err.code);
    failed++;
    failures.push(`UNCAUGHT: ${err.message}`);
    if (cdp) cdp.disconnect();
    if (child && sandboxDir) await teardown(child, sandboxDir).catch(() => {});
  })
  .finally(() => {
    console.log('\n==> RESULTS');
    console.log(`    passed: ${passed}  failed: ${failed}`);
    if (failures.length) {
      console.error('\nFailed assertions:');
      failures.forEach(f => console.error(' ', f));
    }
    const ok = failed === 0;
    console.log(ok ? '\nPASS' : '\nFAIL');
    process.exit(ok ? 0 : 1);
  });
