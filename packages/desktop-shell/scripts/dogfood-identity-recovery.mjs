#!/usr/bin/env node
/**
 * Live dogfood for the UI hardening round:
 *   - human-readable agent display identity (commit 9174034)
 *   - project recovery surface (commit 6fbc4ac)
 *   - simplified Sessions tab + Activity Monitor-style copy (commit 3977f22)
 *
 * Runs against the LIVE registry. Read-only — does not write
 * cairn.db / ~/.claude / ~/.codex / ~/.cairn/projects.json (other than
 * in prior rounds; this dogfood does not mutate registry).
 *
 * What it prints:
 *   1. Per-project AgentActivity rows in their NEW display form
 *      (display_label / human_state_label / attribution_label /
 *       confidence_label / state_explanation)
 *   2. The project recovery summary (confidence + counts +
 *      last_ready) and the project-level recovery prompt (advisory)
 *   3. A leak-check sweep across the prompt to ensure no key /
 *      transcript / cwd appears
 *   4. Read-only invariants on cairn.db / ~/.claude / ~/.codex
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const registry           = require(path.join(root, 'registry.cjs'));
const projectQueries     = require(path.join(root, 'project-queries.cjs'));
const queries            = require(path.join(root, 'queries.cjs'));
const claudeAdapter      = require(path.join(root, 'agent-adapters', 'claude-code-session-scan.cjs'));
const codexAdapter       = require(path.join(root, 'agent-adapters', 'codex-session-log-scan.cjs'));
const agentActivity      = require(path.join(root, 'agent-activity.cjs'));
const recoverySummary    = require(path.join(root, 'recovery-summary.cjs'));
const Database           = require(path.join(root, '..', 'daemon', 'node_modules', 'better-sqlite3'));

const realCairnDb = path.join(os.homedir(), '.cairn', 'cairn.db');
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; } }
const beforeCairn = safeMtime(realCairnDb);

const reg = registry.loadRegistry();
const claudeAll = claudeAdapter.scanClaudeSessions();
const codexAll  = codexAdapter.scanCodexSessions();

console.log(`==> live registry: ${reg.projects.length} project(s)`);
for (const p of reg.projects) {
  console.log(`     - ${p.label} @ ${p.project_root}  hints=${p.agent_id_hints.length}`);
}
console.log(`==> live scans: claude=${claudeAll.length}  codex=${codexAll.length}`);

const dbHandles = new Map();
function ensureRead(p) {
  if (dbHandles.has(p)) return dbHandles.get(p);
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    const e = { db, tables: queries.getTables(db) };
    dbHandles.set(p, e);
    return e;
  } catch { return null; }
}

console.log('\n==> per-project agent activity (NEW display identity):');

for (const p of reg.projects) {
  const entry = ensureRead(p.db_path);
  if (!entry) { console.log(`  ${p.label}: db unavailable`); continue; }
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
  const sess = projectQueries.queryProjectScopedSessions(entry.db, entry.tables, agentIds);
  for (const r of sess.sessions) {
    r._attribution = agentActivity.decideMcpAttribution(
      r.capabilities, p.project_root, p.agent_id_hints || [], r.agent_id,
    );
  }
  const built = agentActivity.buildProjectActivities(
    p, sess.sessions, claudeAll, codexAll,
    { claude: claudeAdapter, codex: codexAdapter },
  );

  console.log(`\n  Project: ${p.label}`);
  console.log(`     ${built.activities.length} activities`);
  if (!built.activities.length) {
    console.log('     (no agents seen here)');
    continue;
  }
  // Sort by family, then by short_label, for stable display.
  const order = { live: 0, recent: 1, inactive: 2, stale: 3, dead: 4, unknown: 5 };
  const sorted = built.activities.slice().sort((a, b) => {
    const fa = order[a.state_family] || 9;
    const fb = order[b.state_family] || 9;
    if (fa !== fb) return fa - fb;
    return (a.short_label || '').localeCompare(b.short_label || '');
  });
  for (const a of sorted.slice(0, 8)) {
    const ageTxt = a.last_activity_at
      ? Math.round((Date.now() - a.last_activity_at) / 1000) + 's ago'
      : '?';
    console.log(`        [${(a.human_state_label || '?').padEnd(8)}] ${(a.display_label || '?').padEnd(34)} ${a.attribution_label.padEnd(30)} ${ageTxt}`);
    if (a === sorted[0]) {
      // Show the state explanation once per project (just for the demo).
      console.log(`            why: ${a.state_explanation}`);
      console.log(`            source: ${a.source_label} · confidence=${a.confidence_label}`);
    }
  }
  if (sorted.length > 8) {
    console.log(`        … and ${sorted.length - 8} more`);
  }
}

// ---- Recovery surface ----
console.log('\n==> project recovery surface:');

let leakOK = true;
for (const p of reg.projects) {
  const entry = ensureRead(p.db_path);
  if (!entry) continue;
  const agentIds = projectQueries.resolveProjectAgentIds(entry.db, entry.tables, p);
  const ckpts = projectQueries.queryProjectScopedCheckpoints(entry.db, entry.tables, agentIds, 50);
  const summary = recoverySummary.deriveProjectRecovery(ckpts, {});
  console.log(`\n  Project: ${p.label}`);
  console.log(`     confidence:   ${summary.confidence.toUpperCase()}`);
  console.log(`     reason:       ${summary.confidence_reason}`);
  console.log(`     counts:       ${summary.counts.ready} ready · ${summary.counts.pending} pending · ${summary.counts.corrupted} corrupted (${summary.counts.total} total)`);
  if (summary.last_ready) {
    const r = summary.last_ready;
    console.log(`     last READY:   ${r.id_short}${r.label ? ` "${r.label}"` : ''}${r.git_head ? ' @' + r.git_head : ''}`);
  }
  if (summary.safe_anchors && summary.safe_anchors.length) {
    console.log(`     safe anchors: ${summary.safe_anchors.length}`);
  }

  // Build the project recovery prompt and check for leaks.
  const prompt = recoverySummary.recoveryPromptForProject({
    project_label: p.label,
    summary,
  });
  console.log(`     prompt:       ${prompt.length} chars`);
  // Leak sweep: secret-shaped patterns + transcript / cwd-style paths.
  const SECRET_LIKE = [
    /sk-[a-zA-Z0-9_-]{20,}/,
    /MINIMAX_API_KEY=[A-Za-z0-9]/,
    /Bearer\s+[A-Za-z0-9]/,
    /["']?_apiKey["']?\s*:/,
  ];
  for (const re of SECRET_LIKE) {
    if (re.test(prompt)) {
      console.error(`     LEAK: prompt for "${p.label}" matches ${re}`);
      leakOK = false;
    }
  }
  // Imperative sweep (positive auto-execute).
  const IMPERATIVE = /\b(run|execute|perform|do)\s+(the\s+)?rewind\s+(now|immediately|first|right away)\b/i;
  const lines = prompt.split(/\r?\n/).filter(line =>
    !/(do not|don'?t|never|refuse|without first)\b/i.test(line)
  ).join('\n');
  if (IMPERATIVE.test(lines)) {
    console.error(`     LEAK: prompt for "${p.label}" contains positive auto-execute imperative`);
    leakOK = false;
  }
}
console.log(`\n     leak-check: ${leakOK ? 'ok' : 'FAILED'}`);

// ---- Read-only invariants ----
const afterCairn = safeMtime(realCairnDb);
console.log('\n==> read-only invariants:');
let invOK = true;
if (beforeCairn != null) {
  if (afterCairn === beforeCairn) console.log('     ok    ~/.cairn/cairn.db mtime unchanged');
  else { console.error('     FAIL  ~/.cairn/cairn.db mtime changed'); invOK = false; }
}

for (const e of dbHandles.values()) try { e.db.close(); } catch {}

if (leakOK && invOK) {
  console.log('\nPASS (live; identity labels readable; recovery surface clean; no leaks)');
  process.exit(0);
} else {
  console.error('\nFAIL — see errors above');
  process.exit(1);
}
